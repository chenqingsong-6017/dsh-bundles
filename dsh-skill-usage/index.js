/**
 * dsh-skill-usage —— 技能用量统计 + 陈旧标注。
 *
 * 参考 Hermes Agent 的 Curator（用量驱动的技能生命周期），按 DSH 的能力做了两个降级：
 *   - DSH 没有后台定时器也不该偷偷改技能文件，所以这里**只统计 + 标注**，从不删除、
 *     从不改写任何 skill；
 *   - 触发点改成"工具结果"：`tools/result` 观察到 `skill` 工具成功加载时计数。
 *
 * 数据落在 `config.storeDir`（默认 `~/.dsh/dsh-skill-usage/usage.json`）。
 *
 * 两个工具：
 *   - `skill_usage`      查看用量与状态（attention 优先），可选 filter；
 *   - `skill_usage_mark` 标记"已复核"（可带备注），把该技能从 attention 里暂时摘掉。
 *
 * 状态机（阈值可配：staleAfterDays / archiveAfterDays）：
 *   new              目录里有、从没被加载过
 *   active           最近用过（在 staleAfterDays 内）
 *   stale            超过 staleAfterDays 没动
 *   archive-candidate 超过 archiveAfterDays 没动
 *   锚点 = max(lastUsedAt, reviewedAt)（复核等于"提醒我一次，先放一放"）
 *
 * 已知边界：
 *   - 用户用 `/name` 显式调用技能不经过 `skill` 工具，计不到；
 *   - 只统计"当前 profile 的当前目录视图"里能看到的技能名；
 *   - 不做系统提示注入：每步改 prompt 会破坏前缀缓存（Hermes 的教训），需要时让模型
 *     主动调 `skill_usage`。
 */

import { writeFileSync, readFileSync, renameSync, mkdirSync, existsSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-skill-usage'
export const inject = ['tools', 'skills']

const DAY_MS = 24 * 60 * 60 * 1000
/**
 * 默认阈值（与 Hermes Curator 同值）。导出给体检脚本复用：判定状态机和阈值必须同一个源，
 * 否则「体检说陈旧、插件说不陈旧」这种两份口径迟早出事（_ops/metric-probes.mjs 直接 import 本模块）。
 */
export const DEFAULT_THRESHOLDS = Object.freeze({ staleAfterDays: 14, archiveAfterDays: 30 })
const MAX_NOTE = 200

const text = (value) => ({ type: 'text', text: value })

/** 统一错误契约：所有抛出的错误都带 code（UPPER_SNAKE），调用方据此分支，不必解析中文文案。 */
function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function storeLocation(overrideDir) {
  const override = typeof overrideDir === 'string' ? overrideDir.trim() : ''
  const base =
    override !== ''
      ? path.resolve(override)
      : process.env.DSH_PROFILE_DIR
        ? path.join(process.env.DSH_PROFILE_DIR, 'dsh-skill-usage')
        : path.join(os.homedir(), '.dsh', 'dsh-skill-usage')
  return { dir: base, file: path.join(base, 'usage.json') }
}

/**
 * 纯函数：给一条记录算状态。导出是为了能在 Node 里单测（不需要跑插件）。
 *
 * 锚点只认「真的动过」的时间：max(lastUsedAt, reviewedAt)。
 * `firstSeenAt` 是插件首扫到该技能的时间，**不参与** stale/archive 判定 ——
 * 否则首装那天登记的整库历史技能会在 14/30 天后集体翻成陈旧，与「真的没用过」混在一起
 * （2026-11-01 误报扫描 #43）。它只作为「从未使用」的旁注返回（firstSeenDays）。
 *
 * @param {{uses?:number, firstSeenAt?:string, lastUsedAt?:string, reviewedAt?:string}} record
 * @param {number} now epoch ms
 * @param {{staleAfterDays:number, archiveAfterDays:number}} thresholds
 */
export function classifyUsage(record, now, thresholds) {
  const lastUsed = typeof record?.lastUsedAt === 'string' ? Date.parse(record.lastUsedAt) : NaN
  const reviewed = typeof record?.reviewedAt === 'string' ? Date.parse(record.reviewedAt) : NaN
  const firstSeen = typeof record?.firstSeenAt === 'string' ? Date.parse(record.firstSeenAt) : NaN
  const firstSeenDays = Number.isFinite(firstSeen) ? Math.max(0, Math.round(((now - firstSeen) / DAY_MS) * 10) / 10) : null
  const candidates = [Number.isFinite(lastUsed) ? lastUsed : -Infinity, Number.isFinite(reviewed) ? reviewed : -Infinity]
  const anchorMs = Math.max(...candidates)

  // 没有「用过/复核过」的锚点：不能拿 firstSeenAt 冒充。从未用过 = new（旁注登记天数），
  // 用过但历史存档里缺 lastUsedAt = unknown（不知道上次用的时间，也不该进 attention）。
  if (!(Number.isFinite(anchorMs) && anchorMs > -Infinity)) {
    if (Number.isFinite(firstSeen)) {
      const uses = Number.isInteger(record?.uses) && record.uses > 0 ? record.uses : 0
      return { state: uses > 0 ? 'unknown' : 'new', days: null, anchoredAt: null, firstSeenDays }
    }
    return { state: 'unknown', days: null, anchoredAt: null, firstSeenDays }
  }

  const anchor = anchorMs
  const days = (now - anchor) / DAY_MS
  const state =
    days >= thresholds.archiveAfterDays
      ? 'archive-candidate'
      : days >= thresholds.staleAfterDays
        ? 'stale'
        : Number.isFinite(lastUsed)
          ? 'active'
          : 'new'
  return { state, days: Math.round(days * 10) / 10, anchoredAt: new Date(anchor).toISOString(), firstSeenDays }
}

/** 技能名归一化：去首尾空白 + 大小写折叠（用于宽容匹配，不改存储里的原名）。 */
export function normalizeSkillKey(value) {
  return String(value ?? '').trim().toLowerCase()
}

/**
 * 把用户输入的名字对到账本里的规范名：先精确、再大小写/空白折叠。
 * 返回空串表示账本里没有这个技能。
 * @param {string} input
 * @param {Iterable<string>} knownNames
 */
export function resolveSkillName(input, knownNames) {
  const trimmed = String(input ?? '').trim()
  if (trimmed === '') return ''
  const names = [...new Set(knownNames)]
  const exact = names.find((known) => known === trimmed)
  if (exact !== undefined) return exact
  const key = normalizeSkillKey(trimmed)
  const folded = names.find((known) => normalizeSkillKey(known) === key)
  return folded ?? ''
}

export function apply(ctx, config) {
  const staleAfterDays =
    Number.isFinite(config?.staleAfterDays) && config.staleAfterDays > 0 ? config.staleAfterDays : DEFAULT_THRESHOLDS.staleAfterDays
  const archiveAfterDays =
    Number.isFinite(config?.archiveAfterDays) && config.archiveAfterDays > 0 ? config.archiveAfterDays : DEFAULT_THRESHOLDS.archiveAfterDays
  const thresholds = { staleAfterDays, archiveAfterDays }

  const tools = ctx.tools
  const skills = ctx.skills
  const { dir: storeDir, file: storeFile } = storeLocation(config?.storeDir)

  /** @type {Map<string, {uses:number, firstSeenAt:string, lastUsedAt?:string, reviewedAt?:string, note?:string}>} */
  const records = new Map()
  /** @type {Map<string, {source?:string, provider?:string, description?:string}>} */
  const catalog = new Map()
  let persistTimer = null
  const stats = { toolResults: 0, skillLoads: 0, skillErrors: 0, lastError: null }

  // ---------- 持久化 ----------
  function serialize() {
    return JSON.stringify({ version: 1, savedAt: new Date().toISOString(), skills: Object.fromEntries(records) })
  }

  function persistNow() {
    try {
      mkdirSync(storeDir, { recursive: true })
      const body = serialize()
      const temp = `${storeFile}.tmp`
      writeFileSync(temp, body, 'utf8')
      try {
        renameSync(temp, storeFile)
      } catch (error) {
        writeFileSync(storeFile, body, 'utf8')
      }
    } catch (error) {
      stats.lastError = `persist: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  function schedulePersist() {
    if (persistTimer !== null) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      persistNow()
    }, 150)
    if (typeof persistTimer === 'object' && persistTimer !== null && 'unref' in persistTimer) persistTimer.unref()
  }

  function loadPersisted() {
    try {
      const parsed = JSON.parse(readFileSync(storeFile, 'utf8'))
      const table = parsed?.skills
      if (!table || typeof table !== 'object') return
      for (const [name, value] of Object.entries(table)) {
        if (!value || typeof value !== 'object') continue
        records.set(name, {
          uses: Number.isInteger(value.uses) && value.uses > 0 ? value.uses : 0,
          firstSeenAt: typeof value.firstSeenAt === 'string' ? value.firstSeenAt : new Date().toISOString(),
          ...(typeof value.lastUsedAt === 'string' ? { lastUsedAt: value.lastUsedAt } : {}),
          ...(typeof value.reviewedAt === 'string' ? { reviewedAt: value.reviewedAt } : {}),
          ...(typeof value.note === 'string' ? { note: value.note } : {}),
        })
      }
    } catch (error) {
      // 没有存档 / 损坏：从空开始
    }
  }

  loadPersisted()

  function ensureRecord(skillName) {
    let record = records.get(skillName)
    if (!record) {
      record = { uses: 0, firstSeenAt: new Date().toISOString() }
      records.set(skillName, record)
    }
    return record
  }

  // ---------- 目录刷新 ----------
  /** 目录刷新：带上调用者的 scope，才能看到 agent preset 自己那一层的技能 */
  async function refreshCatalog(view = {}) {
    try {
      const summaries = await skills.list(view)
      let changed = false
      for (const summary of summaries) {
        if (!summary || typeof summary.name !== 'string') continue
        catalog.set(summary.name, {
          source: summary.source,
          provider: summary.provider,
          description: summary.description,
        })
        if (!records.has(summary.name)) {
          ensureRecord(summary.name)
          changed = true
        }
      }
      if (changed) schedulePersist()
      return summaries.length
    } catch (error) {
      stats.lastError = error instanceof Error ? error.message : String(error)
      return catalog.size
    }
  }

  /** 从 `skill` 工具参数里取技能名（参数键可能变，兜底扫已知技能名） */
  function skillNameFromArgs(args) {
    if (!args || typeof args !== 'object') return undefined
    for (const key of ['name', 'skill', 'skillName', 'skill_name']) {
      const value = args[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    for (const value of Object.values(args)) {
      if (typeof value === 'string' && catalog.has(value.trim())) return value.trim()
    }
    return undefined
  }

  function classifyAll(now) {
    return [...records.entries()]
      .map(([skillName, record]) => {
        const info = catalog.get(skillName) ?? {}
        const result = classifyUsage(record, now, thresholds)
        return {
          name: skillName,
          state: result.state,
          days: result.days,
          firstSeenDays: result.firstSeenDays,
          uses: record.uses,
          lastUsedAt: record.lastUsedAt ?? null,
          reviewedAt: record.reviewedAt ?? null,
          note: record.note ?? null,
          source: info.source ?? null,
          provider: info.provider ?? null,
        }
      })
      .sort((a, b) => {
        const rank = (state) => (state === 'archive-candidate' ? 0 : state === 'stale' ? 1 : state === 'unknown' ? 2 : state === 'new' ? 3 : 4)
        const byRank = rank(a.state) - rank(b.state)
        if (byRank !== 0) return byRank
        return (b.days ?? 0) - (a.days ?? 0)
      })
  }

  // ---------- 事件 ----------
  ctx.effect(() =>
    ctx.on('tools/result', (exec, result) => {
      stats.toolResults += 1
      if (String(exec?.name ?? '') !== 'skill') return
      if (result?.isError === true) {
        stats.skillErrors += 1
        return
      }
      const skillName = skillNameFromArgs(exec?.arguments)
      if (skillName === undefined) {
        stats.lastError = 'skill 工具成功返回，但没能从参数里解析出技能名'
        return
      }
      const record = ensureRecord(skillName)
      record.uses += 1
      record.lastUsedAt = new Date().toISOString()
      stats.skillLoads += 1
      schedulePersist()
    }),
  )

  ctx.effect(() =>
    ctx.on('skills/change', () => {
      void refreshCatalog()
    }),
  )

  // 挂载后先刷一次目录，把现有技能登记进账本（不等待）
  void refreshCatalog()

  ctx.effect(() => () => {
    if (persistTimer !== null) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    persistNow()
  })

  // ---------- 工具 ----------
  ctx.effect(() =>
    tools.register({
      name: 'skill_usage',
      description:
        'Show skill usage: how often each skill was loaded, when it was last used, and which skills are stale or ready to archive. Use it before pruning or reorganizing skills.',
      parameters: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            enum: ['all', 'used', 'unused', 'attention'],
            description: 'all (default) | used (uses > 0) | unused (never loaded) | attention (stale or archive-candidate)',
          },
          limit: { type: 'integer', description: 'Max rows to return (default 40).' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            total: { type: 'integer' },
            counts: {
              type: 'object',
              properties: {
                used: { type: 'integer' },
                unused: { type: 'integer' },
                stale: { type: 'integer' },
                archiveCandidates: { type: 'integer' },
              },
              required: ['used', 'unused', 'stale', 'archiveCandidates'],
              additionalProperties: false,
            },
            thresholds: {
              type: 'object',
              properties: {
                staleAfterDays: { type: 'integer' },
                archiveAfterDays: { type: 'integer' },
              },
              required: ['staleAfterDays', 'archiveAfterDays'],
              additionalProperties: false,
            },
            rows: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  state: { type: 'string' },
                  days: { type: 'number' },
                  firstSeenDays: { type: 'number' },
                  uses: { type: 'integer' },
                  lastUsedAt: { type: 'string' },
                  reviewedAt: { type: 'string' },
                  note: { type: 'string' },
                  source: { type: 'string' },
                },
                required: ['name', 'state', 'uses'],
                additionalProperties: false,
              },
            },
          },
          required: ['total', 'counts', 'thresholds', 'rows'],
          additionalProperties: false,
        },
        render(_args, value) {
          const counts = value?.counts ?? {}
          const rows = Array.isArray(value?.rows) ? value.rows : []
          const label = (state) => {
            if (state === 'active') return '常用'
            if (state === 'new') return '从未用过'
            if (state === 'stale') return '陈旧'
            if (state === 'archive-candidate') return '建议归档'
            return '未知'
          }
          const head = `技能 ${value?.total ?? 0} 个：常用 ${counts.used ?? 0}，从未用过 ${counts.unused ?? 0}，陈旧 ${counts.stale ?? 0}，建议归档 ${counts.archiveCandidates ?? 0}（阈值 ${value?.thresholds?.staleAfterDays ?? '?'} 天 / ${value?.thresholds?.archiveAfterDays ?? '?'} 天）`
          if (rows.length === 0) return [text(`${head}\n没有符合条件的技能。`)]
          const lines = rows.map((row) => {
            const bits = [`【${label(row.state)}】${row.name}`]
            if (row.uses > 0) bits.push(`用过 ${row.uses} 次`)
            if (typeof row.days === 'number' && row.uses > 0) bits.push(`${row.days} 天前用过`)
            if (row.state === 'new' && typeof row.firstSeenDays === 'number') bits.push(`登记于 ${row.firstSeenDays} 天前（从未用过）`)
            if (row.note) bits.push(`备注：${row.note}`)
            return `- ${bits.join(' · ')}`
          })
          return [text(`${head}\n${lines.join('\n')}`)]
        },
      },
      async execute(args, exec) {
        await refreshCatalog(exec?.agent ? { scope: exec.agent } : {})
        const now = Date.now()
        const all = classifyAll(now)
        const filter = typeof args?.filter === 'string' ? args.filter : 'all'
        const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 200) : 40
        const counts = {
          used: all.filter((row) => row.uses > 0).length,
          unused: all.filter((row) => row.uses === 0).length,
          stale: all.filter((row) => row.state === 'stale').length,
          archiveCandidates: all.filter((row) => row.state === 'archive-candidate').length,
        }
        const filtered = all.filter((row) => {
          if (filter === 'used') return row.uses > 0
          if (filter === 'unused') return row.uses === 0
          if (filter === 'attention') return row.state === 'stale' || row.state === 'archive-candidate'
          return true
        })
        return {
          total: all.length,
          counts,
          thresholds,
          rows: filtered.slice(0, limit).map((row) => ({
            name: row.name,
            state: row.state,
            uses: row.uses,
            ...(typeof row.days === 'number' ? { days: row.days } : {}),
            ...(typeof row.firstSeenDays === 'number' ? { firstSeenDays: row.firstSeenDays } : {}),
            ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {}),
            ...(row.reviewedAt ? { reviewedAt: row.reviewedAt } : {}),
            ...(row.note ? { note: row.note } : {}),
            ...(row.source ? { source: row.source } : {}),
          })),
        }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'skill_usage_mark',
      description:
        'Mark a skill as reviewed, optionally with a short note. This snoozes its stale/archive flag until it goes unused for another full threshold period. It never edits or deletes the skill.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact skill name (trimmed; case-insensitive lookup).' },
          note: { type: 'string', description: 'Optional short note (<= 200 chars), e.g. why it is kept.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            state: { type: 'string' },
            reviewedAt: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['name', 'state', 'reviewedAt'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [
            text(
              `已标记复核：${value?.name ?? '?'}（状态 ${value?.state ?? '?'}）${value?.note ? `\n备注：${value.note}` : ''}`,
            ),
          ]
        },
      },
      async execute(args, exec) {
        const skillName = typeof args?.name === 'string' ? args.name.trim() : ''
        if (skillName === '') throw fail('SKILL_USAGE_ARG_MISSING', 'skill_usage_mark 需要 name（技能名，首尾空白与大小写不敏感）。')
        await refreshCatalog(exec?.agent ? { scope: exec.agent } : {})
        const knownNames = [...new Set([...records.keys(), ...catalog.keys()])]
        const resolved = resolveSkillName(skillName, knownNames)
        if (resolved === '') {
          const known = knownNames.sort().slice(0, 12)
          throw fail('SKILL_USAGE_UNKNOWN_SKILL', `未知技能：${skillName}。可用的名字例如：${known.join(', ')}`)
        }
        const record = ensureRecord(resolved)
        record.reviewedAt = new Date().toISOString()
        if (typeof args?.note === 'string' && args.note.trim() !== '') record.note = args.note.trim().slice(0, MAX_NOTE)
        schedulePersist()
        const result = classifyUsage(record, Date.now(), thresholds)
        return {
          name: resolved,
          state: result.state,
          reviewedAt: record.reviewedAt,
          ...(record.note ? { note: record.note } : {}),
        }
      },
    }),
  )

  // ---- skill_usage_status：ready 由「配置合法 + 数据目录真的可写 + 存档可解析」现算 ----
  const probeStoreWritable = () => {
    try {
      if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true })
    } catch (error) {
      return { ok: false, reason: '数据目录无法创建：' + (error?.message ?? 'unknown') }
    }
    // accessSync(W_OK) 在 Windows 上对目录太宽松，直接写一个探针文件再删掉才是真检查。
    const probe = path.join(storeDir, '.status-probe-' + process.pid)
    try {
      writeFileSync(probe, 'ok', 'utf8')
      unlinkSync(probe)
      return { ok: true, reason: '' }
    } catch (error) {
      try {
        unlinkSync(probe)
      } catch (inner) {
        // 探针文件删不掉就留着，下次覆盖
      }
      return { ok: false, reason: '数据目录不可写：' + (error?.message ?? 'unknown') }
    }
  }

  ctx.effect(() =>
    tools.register({
      name: 'skill_usage_status',
      description:
        'Read-only health of the skill usage ledger: whether the store directory is actually writable, whether usage.json parses, how many skills are tracked, and the stale/archive thresholds. Use it when counts look wrong or a mark does not persist.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            ready: { type: 'boolean' },
            unavailableReason: { type: 'string' },
            code: { type: 'string' },
            storeDir: { type: 'string' },
            storeFile: { type: 'string' },
            storeExists: { type: 'boolean' },
            storeBytes: { type: 'integer' },
            storeWritable: { type: 'boolean' },
            records: { type: 'integer' },
            catalogSize: { type: 'integer' },
            skillsService: { type: 'boolean' },
            thresholds: {
              type: 'object',
              properties: { staleAfterDays: { type: 'number' }, archiveAfterDays: { type: 'number' } },
              required: ['staleAfterDays', 'archiveAfterDays'],
              additionalProperties: false,
            },
            toolResults: { type: 'integer' },
            skillLoads: { type: 'integer' },
            skillErrors: { type: 'integer' },
            lastError: { type: 'string' },
            configWarning: { type: 'string' },
          },
          required: [
            'ready',
            'storeDir',
            'storeFile',
            'storeExists',
            'storeWritable',
            'records',
            'catalogSize',
            'skillsService',
            'thresholds',
            'toolResults',
            'skillLoads',
            'skillErrors',
          ],
          additionalProperties: false,
        },
        render(_args, value) {
          if (value?.ready === false) return [text('不可用：' + (value?.unavailableReason || '未知原因'))]
          return [
            text(
              `技能用量可用：账本 ${value?.records ?? 0} 条 / 目录 ${value?.catalogSize ?? 0} 个技能` +
                `（阈值 ${value?.thresholds?.staleAfterDays ?? '?'} 天 / ${value?.thresholds?.archiveAfterDays ?? '?'} 天），` +
                `已计 ${value?.skillLoads ?? 0} 次加载，存档 ${value?.storeFile ?? '?'}。`,
            ),
          ]
        },
      },
      async execute() {
        const problems = []
        let code = ''
        const note = (nextCode, reason) => {
          problems.push(reason)
          if (code === '') code = nextCode
        }

        // 配置非法不改行为（仍按默认阈值跑），但如实报出来。
        const configWarnings = []
        for (const key of ['staleAfterDays', 'archiveAfterDays']) {
          const value = config?.[key]
          if (value !== undefined && !(Number.isFinite(value) && value > 0)) {
            configWarnings.push(`${key} 需要正数，收到 ${JSON.stringify(value)}（已回落到默认值）`)
          }
        }
        if (
          config?.storeDir !== undefined &&
          (typeof config.storeDir !== 'string' || config.storeDir.trim() === '')
        ) {
          note('SKILL_USAGE_CONFIG_INVALID', '配置 storeDir 无效（需要非空字符串），已回落到默认目录')
        }

        let storeExists = false
        let storeBytes = 0
        if (existsSync(storeFile)) {
          storeExists = true
          try {
            storeBytes = statSync(storeFile).size
          } catch (error) {
            note('SKILL_USAGE_STORE_UNREADABLE', '读不到存档：' + (error?.message ?? 'unknown'))
          }
          try {
            const parsed = JSON.parse(readFileSync(storeFile, 'utf8'))
            const table = parsed?.skills
            if (table === null || typeof table !== 'object') {
              note('SKILL_USAGE_STORE_UNREADABLE', '存档形状不合法：缺 skills 表')
            }
          } catch (error) {
            note('SKILL_USAGE_STORE_UNREADABLE', '存档不是合法 JSON：' + (error?.message ?? 'unknown'))
          }
        }

        const writable = probeStoreWritable()
        if (!writable.ok) note('SKILL_USAGE_STORE_UNWRITABLE', writable.reason)

        const ready = problems.length === 0
        return {
          ready,
          unavailableReason: problems.join('；'),
          ...(ready ? {} : { code: code || 'SKILL_USAGE_STORE_UNWRITABLE' }),
          storeDir,
          storeFile,
          storeExists,
          storeBytes,
          storeWritable: writable.ok,
          records: records.size,
          catalogSize: catalog.size,
          skillsService: typeof skills?.list === 'function',
          thresholds,
          toolResults: stats.toolResults,
          skillLoads: stats.skillLoads,
          skillErrors: stats.skillErrors,
          ...(typeof stats.lastError === 'string' && stats.lastError !== '' ? { lastError: stats.lastError } : {}),
          ...(configWarnings.length > 0 ? { configWarning: configWarnings.join('；') } : {}),
        }
      },
    }),
  )
}
