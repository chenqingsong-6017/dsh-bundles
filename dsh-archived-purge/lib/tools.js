/**
 * Chat-native control surface for the automatic sweep.
 *
 * The settings page answers "clean these by hand"; these tools answer "what is
 * the automatic sweep doing, and put that one back". Per `plugin-ux.md` the
 * first line of every render is a conclusion a human can read, and the raw
 * counters stay in the payload for machines.
 *
 * `run` is dry by default and needs an explicit `confirm: true` to move bytes;
 * `restore` is the undo that makes the whole feature safe to leave on.
 */
import { runOnce, summary } from './auto.js';
import { restoreEntry } from './quarantine.js';

const text = (value) => ({ type: 'text', text: String(value) });

function megabytes(bytes) {
  return `${((Number(bytes) || 0) / (1024 * 1024)).toFixed(1)} MB`;
}

function clock(value) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return '尚无';
  return new Date(time).toLocaleString('zh-CN', { hour12: false });
}

function describeSkip(reason) {
  const labels = {
    resident: '还在内存里',
    'within-grace': '还没到宽限期',
    'has-schedules': '有定时任务',
    'unknown-age': '读不出活动时间',
    'no-log': '没有日志',
    'activity-unknown': '宿主答不出是否在跑',
    'session-active': '正在跑',
    'already-held': '已在隔离区',
    'run-cap': '本轮条数用满',
    'bytes-budget': '本轮体积用满',
    'over-bytes-budget': '单条超预算',
    'activity-unknown-at-expiry': '到期时问不到活动',
    'active-at-expiry': '到期时正在跑',
  };
  const key = String(reason).split(':')[0];
  return labels[key] ?? key;
}

/** 隔离区那几行。 */
function heldLines(value, held) {
  if (held.length === 0) return ['隔离区：空'];
  const lines = [`隔离区：${held.length} 条 / ${megabytes(value.heldBytes)}，最早 ${held[0].expiresInDays} 天后永久清除`];
  for (const entry of held.slice(0, 5)) {
    lines.push(`- ${entry.title || entry.sessionId} · ${megabytes(entry.bytes)} · ${entry.expiresInDays} 天后清除 · id ${entry.entryId}`);
  }
  if (held.length > 5) lines.push(`- …还有 ${held.length - 5} 条`);
  return lines;
}

/** 本轮预演那几行。 */
function planLines(plan) {
  const skipped = Array.isArray(plan.skipped) ? plan.skipped : [];
  const byReason = new Map();
  for (const item of skipped) {
    const label = describeSkip(item.reason);
    byReason.set(label, (byReason.get(label) ?? 0) + 1);
  }
  const lines = [`本轮查看 ${plan.scanned ?? 0} 条归档会话：现在会隔离 ${plan.held?.length ?? 0} 条`];
  if (byReason.size > 0) {
    lines.push(`暂不动：${[...byReason].map(([label, count]) => `${label} ${count} 条`).join('，')}`);
  }
  return lines;
}

/** One-line conclusion, then the held list, then the per-Session reasons. */
function renderStatus(value) {
  const config = value?.config ?? {};
  const head = value?.enabled
    ? `自动清理开着：每 ${config.intervalHours} 小时一轮，归档 ${config.graceDays} 天未动才隔离，隔离保留 ${config.retainDays} 天后清除`
    : '自动清理已关闭（config.json 的 enabled=false）';
  const lines = [head];
  if (value?.lastRunAt) lines.push(`上次运行 ${clock(value.lastRunAt)}，下次约 ${clock(value.nextRunAt)}`);
  else lines.push('还没跑过第一轮（挂载后 90 秒首跑）');
  lines.push(...heldLines(value, Array.isArray(value?.held) ? value.held : []));
  if (value?.plan) lines.push(...planLines(value.plan));
  return [text(lines.join('\n'))];
}

const STATUS_PARAMETERS = {
  type: 'object',
  properties: {
    plan: { type: 'boolean', description: '也预演一轮（只读，不搬任何文件），看现在会隔离谁、其余为什么不搬。默认 true。' },
  },
  additionalProperties: false,
};

const STATUS_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    enabled: { type: 'boolean' },
    config: { type: 'object' },
    lastRunAt: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    nextRunAt: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    heldBytes: { type: 'number' },
    held: { type: 'array', items: { type: 'object' } },
    plan: { oneOf: [{ type: 'object' }, { type: 'null' }] },
  },
  required: ['ok', 'enabled', 'held'],
  additionalProperties: false,
};

function statusTool(deps) {
  return {
    name: 'archived_purge_status',
    description:
      'Show the automatic archived-session cleanup: whether it is on, when it last ran, what is quarantined and restorable, and a dry-run of what the next round would hold (with the reason for every Session it leaves alone).',
    parameters: STATUS_PARAMETERS,
    output: { schema: STATUS_SCHEMA, render: (_args, value) => renderStatus(value) },
    async execute(args) {
      const base = await summary(deps);
      const view = {
        ok: true,
        enabled: base.enabled,
        config: base.config,
        lastRunAt: base.lastRunAt,
        nextRunAt: base.nextRunAt,
        heldBytes: base.heldBytes,
        held: base.held.map((entry) => ({
          ...entry,
          expiresInDays: Math.max(0, Math.ceil((Number(entry.expiresInMs) || 0) / (24 * 60 * 60 * 1000))),
        })),
        plan: null,
      };
      if (args?.plan !== false) {
        // Dry run: the same decisions the beat makes, nothing moves.
        view.plan = await runOnce(deps, { dryRun: true });
      }
      return view;
    },
  };
}

const RESTORE_PARAMETERS = {
  type: 'object',
  properties: {
    entryId: { type: 'string', description: '隔离条目 id，从 archived_purge_status 的 held[].entryId 取。' },
  },
  required: ['entryId'],
  additionalProperties: false,
};

const RESTORE_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    entryId: { type: 'string' },
    restored: { type: 'array', items: { type: 'string' } },
    skipped: { type: 'array', items: { type: 'object' } },
    message: { type: 'string' },
  },
  required: ['ok'],
  additionalProperties: false,
};

function renderRestore(_args, value) {
  if (!value?.ok) {
    const reasons = (value?.skipped ?? []).map((item) => `${item.from}: ${item.reason}`).join('；');
    return [text(`没法还原${value?.message ? `：${value.message}` : ''}${reasons ? `（${reasons}）` : ''}`)];
  }
  const restored = value.restored ?? [];
  const head = `已还原 ${restored.length} 项到原位`;
  const lines = [head];
  if (value.skipped?.length > 0) {
    lines.push(`另有 ${value.skipped.length} 项没动：${value.skipped.map((item) => item.reason).join('，')}`);
  }
  return [text(lines.join('\n'))];
}

function restoreTool(deps) {
  return {
    name: 'archived_purge_restore',
    description:
      'Put one quarantined archived Session back where it was (files and produced files), undoing the automatic hold before its retention window expires. Never overwrites a path that came back.',
    parameters: RESTORE_PARAMETERS,
    output: { schema: RESTORE_SCHEMA, render: renderRestore },
    async execute(args) {
      const entryId = typeof args?.entryId === 'string' ? args.entryId.trim() : '';
      if (entryId === '' || /[\\/]/.test(entryId)) {
        return { ok: false, message: 'entryId 不合法' };
      }
      const outcome = await restoreEntry(deps.home, entryId);
      return { ...outcome, entryId };
    },
  };
}

const RUN_PARAMETERS = {
  type: 'object',
  properties: {
    confirm: { type: 'boolean', description: 'apply 必须同时给 confirm:true，否则只预演。' },
  },
  additionalProperties: false,
};

const RUN_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    dryRun: { type: 'boolean' },
    scanned: { type: 'integer' },
    held: { type: 'array', items: { type: 'object' } },
    purged: { type: 'array', items: { type: 'object' } },
    reconciled: { type: 'array', items: { type: 'object' } },
    skipped: { type: 'array', items: { type: 'object' } },
    errors: { type: 'array', items: { type: 'object' } },
    bytes: { type: 'number' },
  },
  required: ['ok', 'dryRun'],
  additionalProperties: false,
};

function renderRun(_args, value) {
  const parts = [];
  parts.push(value.dryRun ? '预演完成（没有搬任何文件）' : '这一轮跑完了');
  if ((value.held ?? []).length > 0) parts.push(`隔离 ${value.held.length} 条（${megabytes(value.bytes)}，可在保留期内还原）`);
  if ((value.purged ?? []).length > 0) parts.push(`永久清除 ${value.purged.length} 条`);
  if ((value.reconciled ?? []).length > 0) parts.push(`还原 ${value.reconciled.length} 条（你取消归档的）`);
  if ((value.skipped ?? []).length > 0) parts.push(`跳过 ${value.skipped.length} 条`);
  if ((value.errors ?? []).length > 0) parts.push(`出错 ${value.errors.length} 条`);
  if (parts.length === 1) parts.push('没有需要处理的会话');
  return [text(`${parts.join('；')}。查看详情用 archived_purge_status。`)];
}

function runTool(deps) {
  return {
    name: 'archived_purge_run',
    description:
      'Run one automatic-cleanup round now. Dry by default; moving files into the quarantine requires BOTH apply-like confirmation (confirm:true) — otherwise nothing is touched.',
    parameters: RUN_PARAMETERS,
    output: { schema: RUN_SCHEMA, render: renderRun },
    async execute(args) {
      const apply = args?.confirm === true;
      return runOnce(deps, { dryRun: !apply, force: true });
    },
  };
}

/** Register the three tools; each is its own fiber-aware registration. */
export function registerTools(ctx, tools, deps) {
  if (!tools || typeof tools.register !== 'function') return;
  const specs = [statusTool(deps), restoreTool(deps), runTool(deps)];
  for (const spec of specs) ctx.effect(() => tools.register(spec));
}
