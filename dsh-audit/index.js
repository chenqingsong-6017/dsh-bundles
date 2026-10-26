/**
 * dsh-audit —— agent 操作安全审计（通用场景插件）。
 *
 * 做什么：订阅 DSH 的 `session/event` 追加流，把**每一次有副作用的工具调用**记进
 * 按天切分的 JSONL 审计日志，并给出危险程度分级与摘要。这样「agent 到底动过什么」
 * 不再是靠回忆，而是可以查的账。
 *
 * 为什么不用 checkpoint 的数据：checkpoint 只记「被改过的文件内容」，看不到命令行、
 * 看不到读了哪些敏感文件、也无法独立验证。审计要的是**调用级**证据，所以这里直接
 * 订阅官方事件流（`tool/call`），与 checkpoint 互补而不是重复。
 *
 * 分级：
 *   high   —— 破坏性命令（rm -rf / Remove-Item -Recurse / git reset --hard / DROP TABLE /
 *             关机重启 / 权限修改）、命中敏感路径（.ssh / .env / credentials / 系统目录）、
 *             批量回滚、卸载插件；
 *   medium —— 写入类工具落在普通路径、网络下载/执行脚本、未知第三方工具；
 *   low    —— 其余有副作用的调用。
 * 纯只读工具（read / grep / glob / repo_* 等）默认不记录；**但如果它碰的是敏感路径，照样记 high**。
 *
 * 隐私与安全：
 *   - 参数摘要会**脱敏**（api key / token / password / bearer 等替换成 ***）；
 *   - 绝不记录工具返回内容、prompt、回复正文；
 *   - 数据落 `config.storeDir`（默认 DSH_PROFILE_DIR 或 ~/.dsh/dsh-audit），按天分文件，
 *     超过 `keepDays` 天的文件在下次写入时清理。
 *
 * 已知边界：
 *   - 只记 `tool/call`（调用意图）。被审批拒绝/执行失败仍会留一条记录（审计里这反而是有用的）；
 *   - 不记录纯只读且不敏感的调用（否则日志会被 grep/read 淹没）；
 *   - 事件是 post-commit 的，插件在热路径上只做一次小的 appendFileSync；
 *   - 审计日志本身不做防篡改（要防篡改得配 hash chain 或外部系统）。
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-audit'
export const inject = ['tools']

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_SUMMARY = 200
const MAX_SCAN_FILES = 400
const RANGES = { today: 1, '7d': 7, '30d': 30, all: null }

/** 纯只读工具：默认不记（除非命中敏感路径）。 */
const READ_ONLY_TOOLS = new Set([
  'read',
  'grep',
  'glob',
  'repo_map',
  'repo_outline',
  'repo_find_symbol',
  'memory_list',
  'memory_search',
  'usage_report',
  'usage_status',
  'skill_usage',
  'session_search',
  'session_event_search',
  'session_event_read',
  'audit_report',
  'audit_search',
  'audit_status',
  'working_directory',
  'list_agents',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
  'read_image',
  'verify_status',
  'checkpoint_list',
  'checkpoint_status',
  'checkpoint_diff',
  'terminal_list',
  'terminal_read',
  'job_list',
  'job_output',
  'schedule_list',
  'team_task_list',
  'team_task_get',
  'usage_report',
])

/** 高危命令模式：命中即 high。 */
const HIGH_PATTERNS = [
  { re: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/i, reason: '递归/强制删除' },
  { re: /\bRemove-Item\b[^\n]*-(?:Recurse|Force)/i, reason: '删除（PowerShell 递归/强制）' },
  { re: /\b(?:del|erase)\s+\/[a-zA-Z]*[sq]/i, reason: '批量删除' },
  { re: /\bformat\s+[a-zA-Z]:/i, reason: '格式化磁盘' },
  { re: /git\s+(?:reset\s+--hard|clean\s+-[a-zA-Z]*f|push\s+(?:--force|-f))/i, reason: '破坏性 git 操作' },
  { re: /\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)/i, reason: '破坏性 SQL' },
  { re: /\b(?:shutdown|reboot|Stop-Computer|Restart-Computer|poweroff)\b/i, reason: '关机/重启' },
  { re: /\b(?:chmod\s+777|icacls\b[^\n]*grant|takeown|Set-Acl)/i, reason: '权限修改' },
  { re: /\b(?:mkfs|dd\s+if=|diskpart|bcdedit|reg\s+delete)/i, reason: '磁盘/注册表破坏' },
  { re: /\b(?:curl|wget|Invoke-WebRequest|iwr)\b[^\n]*\|\s*(?:sh|bash|pwsh|powershell|iex)/i, reason: '下载并直接执行' },
]

/** 敏感路径：命中即 high。 */
const SENSITIVE_PATH =
  /(?:[\\/]\.ssh[\\/]|[\\/]\.aws[\\/]|[\\/]\.gnupg[\\/]|id_rsa|id_ed25519|[\\/]\.env(?:\.[a-z0-9]+)?\b|[\\/]\.npmrc\b|[\\/]\.netrc\b|credentials|secrets?[\\/]|[\\/]\.git[\\/]config|C:[\\/]Windows\b|System32|SysWOW64|[\\/]SAM\b|[\\/]\.kube[\\/]config)/i

/** 写入/执行类工具：至少 medium。 */
const SIDE_EFFECT_TOOLS = new Set([
  'write',
  'edit',
  'pwsh',
  'bash',
  'sh',
  'shell',
  'terminal_send',
  'terminal_open',
  'terminal_signal',
  'terminal_close',
  'checkpoint_restore',
  'checkpoint_forget',
  'checkpoint_prune',
  'create_worktree',
  'memory_add',
  'memory_update',
  'memory_remove',
  'skill_usage_mark',
  'job_kill',
  'schedule_create',
  'schedule_update',
  'schedule_delete',
  'interrupt_agent',
  'spawn_teammate',
  'team_task_create',
  'team_task_update',
  'plugin_manager',
  'set_value',
  'click',
  'type_text',
  'press_key',
  'hotkey',
  'drag',
  'scroll',
  'move_cursor',
  'launch_app',
  'kill_app',
  'clipboard_write',
])

/** 脱敏：把常见密钥形态替换成 ***。 */
export function redactSecrets(text) {
  let out = String(text ?? '')
  // Authorization 头整段抹掉（含 Bearer / Basic 后面的令牌本身）
  out = out.replace(/\b(authorization\s*[:=]\s*)([^\r\n,;}]+)/gi, '$1***')
  // 常见 KV 密钥
  out = out.replace(
    /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|client[_-]?secret)\s*[=:]\s*)(["']?)([^\s"',;}]{6,})/gi,
    (_m, prefix, quote) => `${prefix}${quote}***`,
  )
  // 独立令牌形态
  out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-***')
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{10,}\b/g, 'gh***')
  out = out.replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, 'xox***')
  return out
}

/** 从工具参数里挑出最有信息量的一行摘要。 */
export function summarizeCall(toolName, rawArguments) {
  let args = {}
  if (typeof rawArguments === 'string') {
    try {
      args = JSON.parse(rawArguments)
    } catch {
      args = {}
    }
  } else if (rawArguments && typeof rawArguments === 'object') {
    args = rawArguments
  }
  const pick = (...keys) => {
    for (const key of keys) {
      const value = args?.[key]
      if (typeof value === 'string' && value.trim() !== '') return value
    }
    return ''
  }
  let summary =
    pick('command', 'cmd', 'script', 'text', 'file_path', 'path', 'image', 'query', 'url', 'name', 'title') || ''
  if (summary === '') {
    for (const key of ['old_string', 'new_string', 'content']) {
      if (typeof args?.[key] === 'string' && args[key].trim() !== '') {
        summary = args[key]
        break
      }
    }
  }
  if (summary === '') {
    try {
      summary = JSON.stringify(args)
    } catch {
      summary = ''
    }
  }
  summary = redactSecrets(summary).replace(/\s+/g, ' ').trim()
  if (summary.length > MAX_SUMMARY) summary = `${summary.slice(0, MAX_SUMMARY)}…`
  return summary
}

/**
 * 判定一次工具调用的危险程度。返回 null 表示「不值得记录」。
 * @returns {{risk:'high'|'medium'|'low', reasons:string[]} | null}
 */
export function classifyCall(toolName, rawArguments) {
  const name = typeof toolName === 'string' ? toolName : ''
  const text = typeof rawArguments === 'string' ? rawArguments : JSON.stringify(rawArguments ?? {})
  const reasons = []
  let risk = 'low'

  for (const pattern of HIGH_PATTERNS) {
    if (pattern.re.test(text)) {
      reasons.push(pattern.reason)
      risk = 'high'
    }
  }
  if (SENSITIVE_PATH.test(text)) {
    reasons.push('敏感路径')
    risk = 'high'
  }
  if (name === 'checkpoint_restore' && /"all"\s*:\s*true/.test(text)) {
    reasons.push('批量回滚')
    risk = 'high'
  }
  if (name === 'plugin_manager' && /remove_bundle/.test(text)) {
    reasons.push('卸载插件')
    risk = 'high'
  }
  if (name === 'checkpoint_prune' && /"dryRun"\s*:\s*false/.test(text)) {
    reasons.push('清理审计快照')
    risk = risk === 'high' ? 'high' : 'medium'
  }

  const readOnly = READ_ONLY_TOOLS.has(name)
  if (readOnly) {
    // 只读工具只有碰到敏感路径才值得记
    return risk === 'high' ? { risk, reasons } : null
  }

  if (risk === 'low' && SIDE_EFFECT_TOOLS.has(name)) risk = 'medium'
  if (risk === 'low' && name.startsWith('mcp__')) {
    risk = 'medium'
    reasons.push('第三方工具')
  }
  if (readOnly === false && !SIDE_EFFECT_TOOLS.has(name) && !name.startsWith('mcp__') && reasons.length === 0) {
    // 未知但非只读：按 low 记录（保持审计完整性）
    return { risk: 'low', reasons: ['未分类工具'] }
  }
  return { risk, reasons }
}

/** 本地时区 YYYY-MM-DD。 */
export function dayOf(ms, timeZone) {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    ...(typeof timeZone === 'string' && timeZone !== '' ? { timeZone } : {}),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return fmt.format(d)
}

function storeLocation(overrideDir) {
  const override = typeof overrideDir === 'string' ? overrideDir.trim() : ''
  const base =
    override !== ''
      ? path.resolve(override)
      : process.env.DSH_PROFILE_DIR
        ? path.join(process.env.DSH_PROFILE_DIR, 'dsh-audit')
        : path.join(os.homedir(), '.dsh', 'dsh-audit')
  return { dir: base }
}

const text = (value) => ({ type: 'text', text: value })
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

export function apply(ctx, config) {
  const timeZone = typeof config?.timeZone === 'string' && config.timeZone.trim() !== '' ? config.timeZone.trim() : undefined
  const keepDays = Number.isInteger(config?.keepDays) && config.keepDays > 0 ? Math.min(config.keepDays, 3650) : 30
  const { dir: storeDir } = storeLocation(config?.storeDir)
  const tools = ctx.tools

  let writing = 0
  let written = 0
  let lastError = ''

  function fileFor(day) {
    return path.join(storeDir, `audit-${day}.jsonl`)
  }

  function ensureDir() {
    try {
      mkdirSync(storeDir, { recursive: true })
      return true
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  function pruneOld(now) {
    let removed = 0
    try {
      for (const name of readdirSync(storeDir)) {
        const match = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)
        if (!match) continue
        const age = (now - Date.parse(`${match[1]}T00:00:00Z`)) / DAY_MS
        if (age > keepDays) {
          try {
            unlinkSync(path.join(storeDir, name))
            removed += 1
          } catch {
            /* 忽略单个文件失败 */
          }
        }
      }
    } catch {
      /* 目录不存在等 */
    }
    return removed
  }

  function record(session, event) {
    const name = event?.data?.name
    const rawArguments = event?.data?.arguments
    const verdict = classifyCall(name, rawArguments)
    if (!verdict) return
    const now = typeof event?.time === 'number' ? event.time : Date.now()
    const entry = {
      ts: new Date(now).toISOString(),
      time: now,
      session: String(session?.header?.id ?? session?.id ?? 'unknown'),
      tool: String(name ?? 'unknown'),
      risk: verdict.risk,
      reasons: verdict.reasons,
      summary: summarizeCall(name, rawArguments),
      ...(typeof session?.header?.cwd === 'string' && session.header.cwd !== '' ? { cwd: session.header.cwd } : {}),
    }
    if (!ensureDir()) return
    writing += 1
    try {
      appendFileSync(fileFor(dayOf(now, timeZone)), `${JSON.stringify(entry)}\n`, 'utf8')
      written += 1
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    } finally {
      writing -= 1
    }
  }

  // ---- 订阅事件流：只关心 tool/call，观察者失败不影响会话 ----
  ctx.effect(() =>
    ctx.on('session/event', (session, event) => {
      try {
        if (event?.type !== 'tool/call') return
        record(session, event)
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }),
  )

  // 启动时清一次过期文件
  ensureDir()
  pruneOld(Date.now())

  function filesForRange(range) {
    if (!existsSync(storeDir)) return []
    const days = RANGES[range] ?? RANGES['7d']
    const cutoff = days === null ? '' : dayOf(Date.now() - (days - 1) * DAY_MS, timeZone)
    const files = []
    try {
      for (const name of readdirSync(storeDir)) {
        const match = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)
        if (!match) continue
        if (cutoff !== '' && match[1] < cutoff) continue
        files.push({ day: match[1], file: path.join(storeDir, name) })
      }
    } catch {
      return []
    }
    return files.sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, MAX_SCAN_FILES)
  }

  function readEntries(range) {
    const out = []
    for (const { file } of filesForRange(range)) {
      let body = ''
      try {
        body = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      for (const line of body.split('\n')) {
        if (!line.trim()) continue
        try {
          out.push(JSON.parse(line))
        } catch {
          /* 跳过坏行 */
        }
      }
    }
    return out
  }

  const emptyCounts = () => ({ total: 0, high: 0, medium: 0, low: 0 })
  const bumpCounts = (target, risk) => {
    target.total += 1
    if (risk === 'high') target.high += 1
    else if (risk === 'medium') target.medium += 1
    else target.low += 1
  }
  const countsSchema = {
    type: 'object',
    properties: {
      total: { type: 'integer' },
      high: { type: 'integer' },
      medium: { type: 'integer' },
      low: { type: 'integer' },
    },
    required: ['total', 'high', 'medium', 'low'],
    additionalProperties: false,
  }
  const itemSchema = {
    type: 'object',
    properties: {
      ts: { type: 'string' },
      session: { type: 'string' },
      tool: { type: 'string' },
      risk: { type: 'string' },
      reasons: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' },
    },
    required: ['ts', 'session', 'tool', 'risk', 'reasons', 'summary'],
    additionalProperties: false,
  }

  ctx.effect(() =>
    tools.register({
      name: 'audit_report',
      description:
        'Summarize recorded agent side-effect calls from the local audit log: counts by day, tool, or risk level, plus the most recent high-risk operations. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          range: { type: 'string', enum: ['today', '7d', '30d', 'all'], description: 'Window to report; defaults to 7d.' },
          groupBy: { type: 'string', enum: ['risk', 'tool', 'day'], description: 'Aggregation key; defaults to risk.' },
          limit: { type: 'integer', description: 'Max rows (1-50, default 12).' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            range: { type: 'string' },
            groupBy: { type: 'string' },
            from: { type: 'string' },
            rows: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  total: { type: 'integer' },
                  high: { type: 'integer' },
                  medium: { type: 'integer' },
                  low: { type: 'integer' },
                },
                required: ['key', 'total', 'high', 'medium', 'low'],
                additionalProperties: false,
              },
            },
            totals: countsSchema,
            recentHigh: { type: 'array', items: itemSchema },
          },
          required: ['range', 'groupBy', 'from', 'rows', 'totals', 'recentHigh'],
          additionalProperties: false,
        },
        render(_args, value) {
          const totals = value?.totals ?? {}
          const rows = Array.isArray(value?.rows) ? value.rows : []
          const highs = Array.isArray(value?.recentHigh) ? value.recentHigh : []
          const head = `${value?.from === 'all' ? '全部历史' : `${value?.from ?? '?'} 起`} · 按${value?.groupBy === 'risk' ? '风险' : value?.groupBy === 'tool' ? '工具' : '天'}`
          const lines = rows.map(
            (row) => `  ${row.key}  ${row.total} 次（高 ${row.high} / 中 ${row.medium} / 低 ${row.low}）`,
          )
          const highLines =
            highs.length > 0
              ? `\n最近高危：\n${highs
                  .map((item) => `  [${item.risk}] ${item.tool} · ${item.summary}${item.reasons.length ? `（${item.reasons.join('、')}）` : ''}`)
                  .join('\n')}`
              : '\n最近高危：（无）'
          return [
            text(
              `${head}\n${lines.length ? lines.join('\n') : '  （该区间没有记录）'}\n合计 ${totals.total ?? 0} 次（高 ${totals.high ?? 0} / 中 ${totals.medium ?? 0} / 低 ${totals.low ?? 0}）${highLines}`,
            ),
          ]
        },
      },
      async execute(args) {
        const range = typeof args?.range === 'string' && args.range in RANGES ? args.range : '7d'
        const groupBy = ['risk', 'tool', 'day'].includes(args?.groupBy) ? args.groupBy : 'risk'
        const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 50) : 12
        const entries = readEntries(range)
        const groups = new Map()
        const totals = emptyCounts()
        for (const entry of entries) {
          const risk = entry.risk === 'high' || entry.risk === 'medium' ? entry.risk : 'low'
          const key = groupBy === 'risk' ? risk : groupBy === 'tool' ? String(entry.tool ?? '?') : dayOf(num(entry.time), timeZone)
          let group = groups.get(key)
          if (!group) {
            group = { key, ...emptyCounts() }
            groups.set(key, group)
          }
          bumpCounts(group, risk)
          bumpCounts(totals, risk)
        }
        const rows = [...groups.values()].sort((a, b) => b.total - a.total).slice(0, limit)
        const recentHigh = entries
          .filter((entry) => entry.risk === 'high')
          .sort((a, b) => num(b.time) - num(a.time))
          .slice(0, 5)
          .map((entry) => ({
            ts: String(entry.ts ?? ''),
            session: String(entry.session ?? ''),
            tool: String(entry.tool ?? ''),
            risk: 'high',
            reasons: Array.isArray(entry.reasons) ? entry.reasons.map(String) : [],
            summary: String(entry.summary ?? ''),
          }))
        return {
          range,
          groupBy,
          from: RANGES[range] === null ? 'all' : dayOf(Date.now() - ((RANGES[range] ?? 7) - 1) * DAY_MS, timeZone),
          rows,
          totals,
          recentHigh,
        }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'audit_search',
      description:
        'Search recorded agent side-effect calls by keyword, tool name, and/or risk level. Returns matching entries newest first. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Case-insensitive substring over tool name, summary, reasons and cwd.' },
          tool: { type: 'string', description: 'Exact tool name filter.' },
          risk: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Only this risk level.' },
          range: { type: 'string', enum: ['today', '7d', '30d', 'all'], description: 'Window to search; defaults to 7d.' },
          limit: { type: 'integer', description: 'Max entries (1-50, default 20).' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            risk: { type: 'string' },
            range: { type: 'string' },
            matched: { type: 'integer' },
            total: { type: 'integer' },
            items: { type: 'array', items: itemSchema },
          },
          required: ['query', 'risk', 'range', 'matched', 'total', 'items'],
          additionalProperties: false,
        },
        render(_args, value) {
          const items = Array.isArray(value?.items) ? value.items : []
          if (items.length === 0) return [text(`没有匹配记录（共 ${value?.total ?? 0} 条，条件：${value?.query || '（空）'}）。`)]
          const lines = items.map(
            (item) =>
              `  ${item.ts.slice(11, 19)} [${item.risk}] ${item.tool}${item.reasons.length ? ` (${item.reasons.join('、')})` : ''} · ${item.summary}`,
          )
          return [text(`匹配 ${value?.matched ?? 0} / ${value?.total ?? 0} 条：\n${lines.join('\n')}`)]
        },
      },
      async execute(args) {
        const range = typeof args?.range === 'string' && args.range in RANGES ? args.range : '7d'
        const query = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : ''
        const toolFilter = typeof args?.tool === 'string' ? args.tool.trim() : ''
        const riskFilter = ['high', 'medium', 'low'].includes(args?.risk) ? args.risk : ''
        const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 50) : 20
        const entries = readEntries(range)
        const matched = entries.filter((entry) => {
          if (toolFilter !== '' && String(entry.tool ?? '') !== toolFilter) return false
          if (riskFilter !== '' && String(entry.risk ?? 'low') !== riskFilter) return false
          if (query === '') return true
          const hay = `${entry.tool ?? ''} ${entry.summary ?? ''} ${(entry.reasons ?? []).join(' ')} ${entry.cwd ?? ''}`.toLowerCase()
          return hay.includes(query)
        })
        return {
          query: typeof args?.query === 'string' ? args.query : '',
          risk: riskFilter,
          range,
          matched: matched.length,
          total: entries.length,
          items: matched
            .sort((a, b) => num(b.time) - num(a.time))
            .slice(0, limit)
            .map((entry) => ({
              ts: String(entry.ts ?? ''),
              session: String(entry.session ?? ''),
              tool: String(entry.tool ?? ''),
              risk: String(entry.risk ?? 'low'),
              reasons: Array.isArray(entry.reasons) ? entry.reasons.map(String) : [],
              summary: String(entry.summary ?? ''),
            })),
        }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'audit_status',
      description:
        'Diagnostics for the audit log: store path, day files, entry count, size, oldest/newest entry, retention and whether the event hook is live.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            storeDir: { type: 'string' },
            files: { type: 'integer' },
            entries: { type: 'integer' },
            bytes: { type: 'integer' },
            oldest: { type: 'string' },
            newest: { type: 'string' },
            keepDays: { type: 'integer' },
            watching: { type: 'boolean' },
            lastError: { type: 'string' },
          },
          required: ['storeDir', 'files', 'entries', 'bytes', 'oldest', 'newest', 'keepDays', 'watching', 'lastError'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [
            text(
              [
                `审计目录：${value?.storeDir ?? '?'}`,
                `文件：${value?.files ?? 0} 天 · 记录 ${value?.entries ?? 0} 条 · ${value?.bytes ?? 0} 字节`,
                `时间范围：${value?.oldest || '—'} ~ ${value?.newest || '—'}`,
                `保留：${value?.keepDays ?? 0} 天`,
                `事件订阅：${value?.watching ? '在线' : '未挂载'}`,
                value?.lastError ? `最近错误：${value.lastError}` : '最近错误：（无）',
              ].join('\n'),
            ),
          ]
        },
      },
      async execute() {
        let files = 0
        let bytes = 0
        let entries = 0
        let oldest = ''
        let newest = ''
        if (existsSync(storeDir)) {
          let names = []
          try {
            names = readdirSync(storeDir)
          } catch {
            names = []
          }
          for (const name of names) {
            if (!/^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue
            files += 1
            const full = path.join(storeDir, name)
            try {
              bytes += statSync(full).size
            } catch {
              /* 忽略 */
            }
            if (oldest === '' || name < oldest) oldest = name
            if (newest === '' || name > newest) newest = name
          }
          entries = readEntries('all').length
        }
        return {
          storeDir,
          files,
          entries,
          bytes: Math.round(bytes),
          oldest: oldest.replace(/^audit-|\.jsonl$/g, ''),
          newest: newest.replace(/^audit-|\.jsonl$/g, ''),
          keepDays,
          watching: true,
          lastError,
        }
      },
    }),
  )
}
