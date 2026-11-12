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
 * 工具：
 *   - `skill_usage`      查看用量与状态（attention 优先），可选 filter；`dryRun:true` 只读预演
 *   - `skill_usage_mark` 标记"已复核"（可带备注），把该技能从 attention 里暂时摘掉。
 *
 * 淘汰的三件配套（v1.1.0）：可预演（dryRun，绝不落盘）、可观测（lastCuration 带跳过原因）、
 * 可审计（真归档追加 `storeDir/archive-manifest.jsonl`，>2MiB 轮转成 .1）。
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

import { writeFileSync, readFileSync, appendFileSync, renameSync, mkdirSync, existsSync, statSync, unlinkSync } from 'node:fs'
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
/** 自动归档节拍：每 6 小时。Hermes 有 gateway housekeeping 定时器，DSH 没有，就在插件里自己跑。 */
const CURATOR_INTERVAL_MS = 6 * 60 * 60 * 1000
const MAX_NOTE = 200

const text = (value) => ({ type: 'text', text: value })

/** 统一错误契约：所有抛出的错误都带 code（UPPER_SNAKE），调用方据此分支，不必解析中文文案。 */
function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export function storeLocation(overrideDir) {
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

// 「目录里已经没了」的判定门槛（2026-11-12 事故后的修正）：
// 旧逻辑拿「单次刷新没看见」当 removal，但 DSH 的目录视图是分 scope 的——
// 一次只回 2 个技能的视图会把 catalogAt 推到当下，另外 10 个仍在目录里的技能被误判 not-in-catalog 归档。
// 现在要求「连续缺席 ≥2 次 + 最后一次缺席满 7 天」，且刷新过的目录才算可信。
export const NOT_IN_CATALOG_MIN_MISSES = 2
export const NOT_IN_CATALOG_MISS_DAYS = 7

/**
 * 纯函数：账本条目该不该被自动归档（Curator 动作的唯一判据，导出以便单测）。
 *
 * 与 Hermes Curator 对齐的部分：14/30 天阈值、从不删除（只打 archivedAt，可 restore）、只动自己的账本
 * （技能文件是只读视图，一个字都不碰）。
 * 多出来的两条（因为 DSH 没有 gateway 定时器，必须自己判断得更稳）：
 *   - 「目录里已经没了」= 连续缺席 ≥2 次且满 7 天（单次没看见不算——scope 视图会少报）；
 *   - 目录名单不可信（没刷新过 / 刷新超过 7 天 / 这条从未被见过）时**不归档**，宁可漏也不误伤。
 *
 * @param {{uses?:number,firstSeenAt?:string,lastUsedAt?:string,reviewedAt?:string,catalogSeenAt?:string,catalogMissCount?:number,lastCatalogMissAt?:string,archivedAt?:string}} record
 * @param {number} now epoch ms
 * @param {{staleAfterDays:number,archiveAfterDays:number}} thresholds
 * @param {string|null} catalogAtIso 账本级「最近一次成功目录刷新」时间
 * @returns {{action:'archive'|'none', reason?:string, skip?:'alreadyArchived'|'catalogUntrusted'|'notDue'|'neverUsed'}}
 */
export function decideCuration(record, now, thresholds, catalogAtIso) {
  if (record === null || typeof record !== 'object') return { action: 'none' }
  // 跳过原因回在返回值里：lastCuration 要按同一套判据分桶，
  // 调用方再去猜「为什么没归档」就等于造了第二套口径。
  if (typeof record.archivedAt === 'string' && record.archivedAt !== '') return { action: 'none', skip: 'alreadyArchived' }
  const state = classifyUsage(record, now, thresholds)
  if (state.state !== 'archive-candidate') {
    // new = 从没被加载过（firstSeenAt 不冒充锚点）：这种技能不该按「陈旧」记账，
    // 所以单独一桶，方便看出「账本里躺着的其实是从没用过的」。
    return { action: 'none', skip: state.state === 'new' ? 'neverUsed' : 'notDue' }
  }
  const catAt = typeof catalogAtIso === 'string' ? Date.parse(catalogAtIso) : NaN
  // 目录从未成功刷新 / 刷新结果已过期：本轮不判（宁可漏，不误伤）。
  if (!Number.isFinite(catAt) || now - catAt > NOT_IN_CATALOG_MISS_DAYS * 86400000) return { action: 'none', skip: 'catalogUntrusted' }
  const seenAt = typeof record.catalogSeenAt === 'string' ? Date.parse(record.catalogSeenAt) : NaN
  const misses = Number.isInteger(record.catalogMissCount) && record.catalogMissCount > 0 ? record.catalogMissCount : 0
  // 这条从未在目录里被见过（不同 scope 的 preset 层技能）：不知道 ≠ 没有。
  if (!Number.isFinite(seenAt) && misses === 0) return { action: 'none', skip: 'catalogUntrusted' }
  const missAt = typeof record.lastCatalogMissAt === 'string' ? Date.parse(record.lastCatalogMissAt) : NaN
  const missingLong = misses >= NOT_IN_CATALOG_MIN_MISSES && Number.isFinite(missAt) && now - missAt >= NOT_IN_CATALOG_MISS_DAYS * 86400000
  if (missingLong) return { action: 'archive', reason: 'not-in-catalog' }
  return { action: 'archive', reason: 'stale-' + thresholds.archiveAfterDays + 'd' }
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

// ── v1.2.0：合并建议（只读中间档，对齐 Hermes 的 umbrella consolidation）──
// Hermes 的 curator 有一档「把同类技能并进 umbrella」，但它能改技能文件；DSH 技能目录是只读视图，
// 我们能做的是把「哪几个技能该合并、证据是什么、建议叫什么伞名」算出来，决定权留给人或模型。
// 判据刻意不掺用量：Hermes 明确「use=0 不是跳过合并的理由」，这里同理——聚类只看名称+描述，
// 用量只作旁注（它是「用得多」的证据，不是「该不该合并」的依据）。
//
// 相似度用「重叠系数」(shared / min(|A|,|B|)) 而不是 Jaccard：技能名短，Jaccard 会被词数差压死——
// 实测 cordis-plugin-development 与 cordis-composition-reference 的 Jaccard 只有 0.17，
// 但它们共享的恰恰是主题词 cordis。重叠系数给 0.33，才排得进同一组。
// 0.3 这个默认阈值是本轮实测定的：cordis 三件套两两重合 0.33（共同词只有 cordis），无关技能为 0——刚好卡在中间。
// 第二道闸：出现在超过 60% 技能里的「泛词」先剔除再算重合，避免一个公共词把全库粘成一组。
export const CONSOLIDATION_DEFAULT_THRESHOLD = 0.3
const CONSOLIDATION_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'using', 'use', 'used', 'into', 'when', 'what',
  'how', 'not', 'are', 'was', 'has', 'have', 'can', 'may', 'all', 'any', 'via', 'per',
])

/** 把技能名 + 描述切成可比的词集合：拉丁词取长度 ≥3（去停用词），中文取 2-gram。 */
export function skillTokens(value) {
  const tokens = new Set()
  const parts = String(value ?? '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/u)
  for (const part of parts) {
    if (part === '') continue
    if (/^[a-z0-9]+$/.test(part)) {
      if (part.length >= 3 && !CONSOLIDATION_STOPWORDS.has(part)) tokens.add(part)
      continue
    }
    const chars = [...part]
    for (let i = 0; i + 1 < chars.length; i += 1) tokens.add(chars[i] + chars[i + 1])
  }
  return tokens
}

/** 重叠系数：shared / min(|A|,|B|)。0 = 无共同词，1 = 小集合完全被大集合包含。 */
function overlapCoefficient(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / Math.min(a.size, b.size)
}

/**
 * 纯函数：把技能聚成「同主题组」并给每组一个伞名建议。导出以便单测（不跑插件也能验判据）。
 *
 * @param {Array<{name:string, description?:string, uses?:number, lastUsedAt?:string|null, state?:string, archivedAt?:string}>} entries
 * @param {{threshold?:number}} [opts]
 * @returns {{threshold:number, scanned:number, clusters:Array<{umbrellaHint:string, similarity:number, sharedTokens:string[], members:Array<{name:string, uses:number, state:string, lastUsedAt?:string}>}>}}
 */
export function planConsolidation(entries, opts) {
  const threshold = Number.isFinite(opts?.threshold) && opts.threshold > 0 ? Math.min(opts.threshold, 0.9) : CONSOLIDATION_DEFAULT_THRESHOLD
  const rawItems = []
  for (const raw of Array.isArray(entries) ? entries : []) {
    if (!raw || typeof raw.name !== 'string' || raw.name.trim() === '') continue
    if (typeof raw.archivedAt === 'string' && raw.archivedAt !== '') continue
    const tokens = skillTokens(raw.name + ' ' + String(raw.description ?? ''))
    const nameTokens = skillTokens(raw.name)
    if (tokens.size === 0) continue
    rawItems.push({ ...raw, tokens, nameTokens })
  }
  // 文档频次：既是「泛词」判据，也是伞名的排序依据（组内越常见的词越像主题词）。
  const frequency = new Map()
  for (const item of rawItems) for (const token of item.tokens) frequency.set(token, (frequency.get(token) ?? 0) + 1)
  const maxDf = Math.max(3, Math.ceil(rawItems.length * 0.6))
  const items = rawItems.map((item) => ({
    ...item,
    informative: new Set([...item.tokens].filter((token) => (frequency.get(token) ?? 0) <= maxDf)),
    // 名字词单独留着：描述里全是通用词（load/user/app/before），只按描述相似会造假组
    // （2026-11-12 真机：official-plugins 与 personalized-pages 因描述撞词被聚到一起）。
    nameTokens: new Set([...item.nameTokens].filter((token) => (frequency.get(token) ?? 0) <= maxDf)),
  }))
  const parent = items.map((_, index) => index)
  const find = (index) => {
    let root = index
    while (parent[root] !== root) root = parent[root]
    while (parent[index] !== root) {
      const next = parent[index]
      parent[index] = root
      index = next
    }
    return root
  }
  const similarities = new Map()
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      // 硬闸：两个技能必须共享至少一个「名字词」才可能是同一主题；只靠描述撞词不算。
      const sharesName = [...items[i].nameTokens].some((token) => items[j].nameTokens.has(token))
      if (!sharesName) continue
      const sim = overlapCoefficient(items[i].informative, items[j].informative)
      if (sim <= 0 || sim < threshold) continue
      similarities.set(i + ':' + j, sim)
      const a = find(i)
      const b = find(j)
      if (a !== b) parent[b] = a
    }
  }
  const groups = new Map()
  for (let i = 0; i < items.length; i += 1) {
    const root = find(i)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(i)
  }
  const clusters = []
  for (const members of groups.values()) {
    if (members.length < 2) continue
    // 组内两两重合度的均值：用真实边算，不拿阈值当分数，免得所有组看起来一样重要。
    const sims = []
    for (let x = 0; x < members.length; x += 1) {
      for (let y = x + 1; y < members.length; y += 1) {
        const key = members[x] < members[y] ? members[x] + ':' + members[y] : members[y] + ':' + members[x]
        if (similarities.has(key)) sims.push(similarities.get(key))
      }
    }
    const similarity = sims.length === 0 ? 0 : Math.round((sims.reduce((sum, value) => sum + value, 0) / sims.length) * 100) / 100
    // 共同词 = 每个成员都有的词（用剔泛词后的集合）；没有绝对共同词时退回「组内频次 ≥2」的词。
    let shared = [...items[members[0]].informative].filter((token) => members.every((index) => items[index].informative.has(token)))
    if (shared.length === 0) {
      const local = new Map()
      for (const index of members) for (const token of items[index].informative) local.set(token, (local.get(token) ?? 0) + 1)
      shared = [...local.entries()].filter(([, count]) => count >= 2).map(([token]) => token)
    }
    shared.sort((a, b) => (frequency.get(b) ?? 0) - (frequency.get(a) ?? 0) || a.localeCompare(b))
    clusters.push({
      umbrellaHint: shared[0] ?? 'skill',
      similarity,
      sharedTokens: shared.slice(0, 5),
      members: members.map((index) => ({
        name: items[index].name,
        uses: Number.isInteger(items[index].uses) && items[index].uses > 0 ? items[index].uses : 0,
        state: typeof items[index].state === 'string' ? items[index].state : 'unknown',
        ...(typeof items[index].lastUsedAt === 'string' && items[index].lastUsedAt !== '' ? { lastUsedAt: items[index].lastUsedAt } : {}),
      })),
    })
  }
  clusters.sort((a, b) => b.similarity - a.similarity || a.umbrellaHint.localeCompare(b.umbrellaHint))
  return { threshold, scanned: items.length, clusters }
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
  /**
   * 最近一次成功刷新目录的时间（账本级）。体检据此区分「目录里现在还有的技能」与
   * 「账本里残留、目录里已经没了的技能」——后者永远等不到使用记录，不区分会让它们
   * 30 天后集体变成 archive-candidate，逼人每 30 天手动续期一次（2026-11-05 对抗性检查）。
   */
  let catalogAt = null

  // ---------- 持久化 ----------
  function serialize() {
    return JSON.stringify({ version: 1, savedAt: new Date().toISOString(), catalogAt, skills: Object.fromEntries(records) })
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
      if (typeof parsed?.catalogAt === 'string' && parsed.catalogAt !== '') catalogAt = parsed.catalogAt
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
          ...(typeof value.catalogSeenAt === 'string' ? { catalogSeenAt: value.catalogSeenAt } : {}),
          ...(Number.isInteger(value.catalogMissCount) && value.catalogMissCount > 0 ? { catalogMissCount: value.catalogMissCount } : {}),
          ...(typeof value.lastCatalogMissAt === 'string' ? { lastCatalogMissAt: value.lastCatalogMissAt } : {}),
          ...(typeof value.archivedAt === 'string' ? { archivedAt: value.archivedAt } : {}),
          ...(typeof value.archivedReason === 'string' ? { archivedReason: value.archivedReason } : {}),
          ...(Number.isInteger(value.patchCount) && value.patchCount > 0 ? { patchCount: value.patchCount } : {}),
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
      // 空视图不算一次有效刷新：既不推进 catalogAt，也不记缺席（宁可漏，不误伤）。
      if (!Array.isArray(summaries) || summaries.length === 0) return catalog.size
      const seenAt = new Date().toISOString()
      const seenNames = new Set()
      for (const summary of summaries) {
        if (!summary || typeof summary.name !== 'string' || summary.name === '') continue
        seenNames.add(summary.name)
        catalog.set(summary.name, {
          source: summary.source,
          provider: summary.provider,
          description: summary.description,
        })
        // 目录里看到的技能打上时间戳：体检据此区分「目录里还有」与「账本残留」。
        // 看到即清零缺席计数：不同 scope 的视图会轮流漏掉对方，单次没看见不算「没了」。
        const record = ensureRecord(summary.name)
        record.catalogSeenAt = seenAt
        record.catalogMissCount = 0
        delete record.lastCatalogMissAt
      }
      // 只有「见过目录」的记录才累计缺席；从没见过的（preset 层/别的 scope）不进来。
      for (const [skillName, record] of records) {
        if (seenNames.has(skillName)) continue
        if (typeof record.catalogSeenAt !== 'string' || record.catalogSeenAt === '') continue
        record.catalogMissCount = (Number.isInteger(record.catalogMissCount) ? record.catalogMissCount : 0) + 1
        record.lastCatalogMissAt = seenAt
      }
      catalogAt = seenAt
      schedulePersist()
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
          archivedAt: record.archivedAt ?? null,
          archivedReason: record.archivedReason ?? null,
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

  // ---------- 自动归档（Curator） ----------
  /**
   * 自动推进账本生命周期：30 天没动、或目录里已经没了的技能，在这里落 archivedAt。
   * 为什么放在插件里而不是外部脚本：账本活在进程内存里，外部脚本直接改文件会被下一次 persist
   * 覆盖（TOCTOU，2026-11-05 对抗性检查）；同一进程内改内存 + 原子落盘才安全。
   * 从不删除：只打 archivedAt/archivedReason，skill_usage_restore 可恢复。技能文件一个字不碰。
   */
  let curatorTimer = null
  const curatorLog = []
  let lastCuration = null

  const MANIFEST_FILE = path.join(storeDir, 'archive-manifest.jsonl')
  const MANIFEST_MAX_BYTES = 2 * 1024 * 1024

  /**
   * 审计旁路：真归档才追加一行 JSON（字段固定 ts/by/name/reason/days/uses）。
   * 为什么用 JSONL：一行一条，外部脚本 grep / 逐行解析不用先读整个文件。
   * 为什么超过 2MiB 先轮转：无界追加会让审计文件陪账本长成几十 MB，而回看只需要
   * 「当前 + 上一份」——只留 .1 一份历史，够回查又不长成负资产。
   * 为什么吞掉所有错误：审计是旁路不是主流程。写不进去要留痕（stats.lastError），
   * 但绝不能反过来让归档失败——那等于审计把业务毁了。
   */
  function appendArchiveManifest(entries, nowMs) {
    if (entries.length === 0) return
    try {
      mkdirSync(storeDir, { recursive: true })
      let size = 0
      try {
        size = statSync(MANIFEST_FILE).size
      } catch {
        size = 0
      }
      if (size > MANIFEST_MAX_BYTES) {
        const history = MANIFEST_FILE + '.1'
        try {
          renameSync(MANIFEST_FILE, history)
        } catch {
          // Windows 上目标被占用时 rename 会失败：删掉旧历史再试一次；
          // 再失败就跳过轮转继续追加——宁可文件变大，也不丢审计行。
          try {
            unlinkSync(history)
            renameSync(MANIFEST_FILE, history)
          } catch {
            // 轮转失败不阻断归档，审计行照写
          }
        }
      }
      const ts = new Date(nowMs).toISOString()
      const lines = entries.map((item) =>
        JSON.stringify({
          ts,
          by: 'curator',
          name: item.name,
          reason: item.reason,
          days: Number.isFinite(item.days) ? item.days : null,
          uses: Number.isInteger(item.uses) && item.uses > 0 ? item.uses : 0,
        }),
      )
      appendFileSync(MANIFEST_FILE, lines.join('\n') + '\n', 'utf8')
    } catch (error) {
      stats.lastError = 'manifest: ' + (error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * 预演一次 curator：只算不动。runCurator 与 skill_usage { dryRun: true } 共用它，
   * 保证「预演说会归档谁」和「真跑会归档谁」是同一套判据，不另造口径。
   * 跳过原因直接取 decideCuration 的 skip 字段（那来自 classifyUsage 的真实判定），
   * 不在这里按天数二次推断。
   */
  function planCuration(now) {
    const wouldArchive = []
    const skipped = { alreadyArchived: 0, catalogUntrusted: 0, notDue: 0, neverUsed: 0 }
    for (const [skillName, record] of records) {
      const decision = decideCuration(record, now, thresholds, catalogAt)
      if (decision.action === 'archive') {
        const state = classifyUsage(record, now, thresholds)
        wouldArchive.push({
          name: skillName,
          reason: decision.reason,
          days: Number.isFinite(state.days) ? state.days : null,
          uses: Number.isInteger(record.uses) && record.uses > 0 ? record.uses : 0,
        })
        continue
      }
      if (decision.skip !== undefined && Object.hasOwn(skipped, decision.skip)) skipped[decision.skip] += 1
    }
    return { wouldArchive, skipped }
  }

  function runCurator(now = Date.now()) {
    const plan = planCuration(now)
    const at = new Date(now).toISOString()
    if (plan.wouldArchive.length > 0) {
      for (const item of plan.wouldArchive) {
        const record = records.get(item.name)
        if (record === undefined) continue
        record.archivedAt = at
        record.archivedReason = item.reason
      }
      appendArchiveManifest(plan.wouldArchive, now)
      curatorLog.push({ at, archived: plan.wouldArchive })
      if (curatorLog.length > 20) curatorLog.shift()
      schedulePersist()
    }
    // 可观测：只说「归档了几个」等于没信息——没归档的那批因为什么不动，
    // 才是排查「为什么我的技能还在」时真正要看的。
    lastCuration = {
      at,
      archived: plan.wouldArchive.length,
      archivedNames: plan.wouldArchive.map((item) => item.name),
      skipped: plan.skipped,
    }
    return lastCuration
  }

  // 挂载后先刷一次目录，把现有技能登记进账本（不等待）；随后跑一次 curator
  void refreshCatalog().then(() => runCurator()).catch(() => {})
  // 自动归档节拍：每 6 小时一次（不依赖外部计划任务；unref 保证不拖住宿主退出）
  try {
    curatorTimer = setInterval(() => runCurator(), CURATOR_INTERVAL_MS)
    if (typeof curatorTimer === 'object' && curatorTimer !== null && 'unref' in curatorTimer) curatorTimer.unref()
  } catch {
    // 环境不支持定时器：只靠挂载时那一次，报告里会说清
  }

  ctx.effect(() => () => {
    if (curatorTimer !== null) {
      clearInterval(curatorTimer)
      curatorTimer = null
    }
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
            enum: ['all', 'used', 'unused', 'attention', 'archived'],
            description: 'all (default) | used (uses > 0) | unused (never loaded) | attention (stale or archive-candidate) | archived (curator 已归档，可 restore)',
          },
          limit: { type: 'integer', description: 'Max rows to return (default 40).' },
          dryRun: {
            type: 'boolean',
            description:
              'Preview only: report what the curator would archive (wouldArchive) without refreshing the catalog, running the curator, or writing usage.json.',
          },
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
                archived: { type: 'integer' },
              },
              required: ['used', 'unused', 'stale', 'archiveCandidates', 'archived'],
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
                  archivedAt: { type: 'string' },
                  archivedReason: { type: 'string' },
                },
                required: ['name', 'state', 'uses'],
                additionalProperties: false,
              },
            },
            dryRun: { type: 'boolean' },
            dryRunReason: { type: 'string' },
            wouldArchive: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  reason: { type: 'string' },
                  days: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                  uses: { type: 'integer' },
                },
                required: ['name', 'reason', 'days', 'uses'],
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
          const head = `技能 ${value?.total ?? 0} 个：常用 ${counts.used ?? 0}，从未用过 ${counts.unused ?? 0}，陈旧 ${counts.stale ?? 0}，建议归档 ${counts.archiveCandidates ?? 0}，已归档 ${counts.archived ?? 0}（阈值 ${value?.thresholds?.staleAfterDays ?? '?'} 天 / ${value?.thresholds?.archiveAfterDays ?? '?'} 天）`
          const would = Array.isArray(value?.wouldArchive) ? value.wouldArchive : []
          let dryHead = ''
          if (value?.dryRun === true) {
            dryHead = `\n【预演，只读，不落盘】将归档 ${would.length} 个技能`
            if (typeof value.dryRunReason === 'string' && value.dryRunReason !== '') {
              dryHead += `——目录名单不可信（${value.dryRunReason}），这次不做预判`
            }
            for (const item of would) {
              dryHead += `\n- ${item.name}：${item.reason}，${item.days === null ? '时间未知' : `${item.days} 天未动`}，用过 ${item.uses} 次`
            }
          }
          if (rows.length === 0) return [text(`${head}${dryHead}\n没有符合条件的技能。`)]
          const lines = rows.map((row) => {
            const bits = [`【${label(row.state)}】${row.name}`]
            if (row.uses > 0) bits.push(`用过 ${row.uses} 次`)
            if (typeof row.days === 'number' && row.uses > 0) bits.push(`${row.days} 天前用过`)
            if (row.state === 'new' && typeof row.firstSeenDays === 'number') bits.push(`登记于 ${row.firstSeenDays} 天前（从未用过）`)
            if (row.note) bits.push(`备注：${row.note}`)
            return `- ${bits.join(' · ')}`
          })
          return [text(`${head}${dryHead}\n${lines.join('\n')}`)]
        },
      },
      async execute(args, exec) {
        // dry-run 的语义是「先看看会归档谁」，任何副作用都会把预演变成执行：
        // 刷目录会改 catalogSeenAt、跑 curator 会写 archivedAt、落盘会改 usage.json。
        // 所以只读模式下这三件一律不做，返回后 usage.json 必须逐字节不变。
        const dryRun = args?.dryRun === true
        const now = Date.now()
        if (!dryRun) {
          await refreshCatalog(exec?.agent ? { scope: exec.agent } : {})
          runCurator(now)
        }
        const planned = dryRun ? planCuration(now) : null
        const all = classifyAll(now)
        const activeRows = all.filter((row) => !row.archivedAt)
        const archivedRows = all.filter((row) => row.archivedAt)
        const filter = typeof args?.filter === 'string' ? args.filter : 'all'
        const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 200) : 40
        const counts = {
          used: activeRows.filter((row) => row.uses > 0).length,
          unused: activeRows.filter((row) => row.uses === 0).length,
          stale: activeRows.filter((row) => row.state === 'stale').length,
          archiveCandidates: activeRows.filter((row) => row.state === 'archive-candidate').length,
          archived: archivedRows.length,
        }
        const pool = filter === 'archived' ? archivedRows : activeRows
        const filtered = pool.filter((row) => {
          if (filter === 'used') return row.uses > 0
          if (filter === 'unused') return row.uses === 0
          if (filter === 'attention') return row.state === 'stale' || row.state === 'archive-candidate'
          return true
        })
        return {
          total: activeRows.length,
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
            ...(row.archivedAt ? { archivedAt: row.archivedAt } : {}),
            ...(row.archivedReason ? { archivedReason: row.archivedReason } : {}),
          ...(row.catalogMissCount ? { catalogMissCount: row.catalogMissCount } : {}),
          })),
          ...(planned === null
            ? {}
            : {
                dryRun: true,
                wouldArchive: planned.wouldArchive,
                // 目录名单不可信时如实说：wouldArchive 空不是「没有可归档的」，而是「不敢判」。
                // decideCuration 在 catalogAt 缺失时一律不归档，所以这里必然也是空数组。
                ...(catalogAt === null ? { dryRunReason: 'catalog-untrusted' } : {}),
              }),
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
        record.patchCount = (Number.isInteger(record.patchCount) ? record.patchCount : 0) + 1
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

  // ---- skill_usage_restore：把 curator 自动归档的条目放回 active（只动账本，绝不碰技能文件） ----
  ctx.effect(() =>
    tools.register({
      name: 'skill_usage_restore',
      description:
        'Restore a curator-archived skill back to the active ledger (clears archivedAt). Only the ledger record is touched; the skill file is never modified.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact skill name (trimmed; case-insensitive lookup).' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            restored: { type: 'boolean' },
            state: { type: 'string' },
          },
          required: ['name', 'restored', 'state'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [
            text(
              value?.restored
                ? `已恢复：${value?.name}（状态 ${value?.state}）`
                : `未恢复：${value?.name} 不在归档区（当前状态 ${value?.state}）`,
            ),
          ]
        },
      },
      async execute(args, exec) {
        const skillName = typeof args?.name === 'string' ? args.name.trim() : ''
        if (skillName === '') throw fail('SKILL_USAGE_ARG_MISSING', 'skill_usage_restore 需要 name（技能名，首尾空白与大小写不敏感）。')
        await refreshCatalog(exec?.agent ? { scope: exec.agent } : {})
        const knownNames = [...new Set([...records.keys(), ...catalog.keys()])]
        const resolved = resolveSkillName(skillName, knownNames)
        if (resolved === '') {
          const known = knownNames.sort().slice(0, 12)
          throw fail('SKILL_USAGE_UNKNOWN_SKILL', `未知技能：${skillName}。可用的名字例如：${known.join(', ')}`)
        }
        const record = records.get(resolved)
        const archived = typeof record?.archivedAt === 'string' && record.archivedAt !== ''
        if (!archived) {
          return { name: resolved, restored: false, state: classifyUsage(record ?? {}, Date.now(), thresholds).state }
        }
        delete record.archivedAt
        delete record.archivedReason
        // 人工恢复 = 明确要保留：同步刷新复核时间，否则下一次 curator 会立刻把它再归档（restore 等于没做）。
        record.reviewedAt = new Date().toISOString()
        record.patchCount = (Number.isInteger(record.patchCount) ? record.patchCount : 0) + 1
        schedulePersist()
        return { name: resolved, restored: true, state: classifyUsage(record, Date.now(), thresholds).state }
      },
    }),
  )

  // ---- skill_consolidation_plan：只读合并建议（Hermes umbrella consolidation 的降级版）----
  ctx.effect(() =>
    tools.register({
      name: 'skill_consolidation_plan',
      description:
        'Read-only consolidation report: cluster same-topic skills and propose an umbrella name. It never edits, archives, or moves any skill file (the skill catalog is a read-only view); the merge decision stays with the human or model.',
      parameters: {
        type: 'object',
        properties: {
          threshold: { type: 'number', description: 'Word-overlap (overlap coefficient) threshold 0.1–0.9; default 0.3.' },
          limit: { type: 'integer', description: 'Max clusters to return (default 10).' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            scanned: { type: 'integer' },
            directory: { type: 'integer' },
            threshold: { type: 'number' },
            clusters: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  umbrellaHint: { type: 'string' },
                  similarity: { type: 'number' },
                  sharedTokens: { type: 'array', items: { type: 'string' } },
                  members: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        uses: { type: 'integer' },
                        state: { type: 'string' },
                        lastUsedAt: { type: 'string' },
                      },
                      required: ['name', 'uses', 'state'],
                      additionalProperties: false,
                    },
                  },
                },
                required: ['umbrellaHint', 'similarity', 'sharedTokens', 'members'],
                additionalProperties: false,
              },
            },
            note: { type: 'string' },
          },
          required: ['scanned', 'directory', 'threshold', 'clusters', 'note'],
          additionalProperties: false,
        },
        render(_args, value) {
          const clusters = Array.isArray(value?.clusters) ? value.clusters : []
          const head = `合并建议：目录 ${value?.directory ?? 0} 个 / 判定 ${value?.scanned ?? 0} 个（重合阈值 ${value?.threshold ?? '?'}），发现 ${clusters.length} 组同主题`
          if (clusters.length === 0) return [text(`${head}\n没有达到阈值的同主题技能组。`)]
          const lines = clusters.map((cluster) => {
            const names = cluster.members.map((member) => `${member.name}(${member.state}${member.uses > 0 ? '·' + member.uses + '次' : ''})`).join(' / ')
            return `- 建议伞名「${cluster.umbrellaHint}」：${names}（重合 ${cluster.similarity}）`
          })
          return [text(`${head}\n${lines.join('\n')}\n${value?.note ?? ''}`)]
        },
      },
      async execute(args, exec) {
        // 只读：不跑 curator、不落盘、不改任何技能文件；目录用 skills.list() 现读（它本身是只读 API，
        // 不写 catalogSeenAt）——不现读会因挂载时的 scope 视图只看到部分技能，报出假的「没有同主题组」。
        // 必须带调用者的 agent scope：不带 scope 的视图实测只返回 2 个技能（2026-11-12 真机），会漏掉 preset 层的技能。
        const threshold = Number.isFinite(args?.threshold) ? Math.min(0.9, Math.max(0.1, args.threshold)) : CONSOLIDATION_DEFAULT_THRESHOLD
        const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 20) : 10
        const now = Date.now()
        let listed = []
        try {
          listed = await skills.list(exec?.agent ? { scope: exec.agent } : {})
        } catch (error) {
          stats.lastError = 'consolidation: ' + (error instanceof Error ? error.message : String(error))
        }
        // 目录 = 现读结果 ∪ 账本目录快照：现读视图可能因 scope 只回部分（实测无 scope 只回 2 个），
        // 只用现读会漏掉 preset 层技能、报出假的「没有同主题组」；只用快照又不是最新。取并集最稳。
        const byName = new Map()
        for (const [skillName, info] of catalog) byName.set(skillName, { name: skillName, description: info.description ?? '' })
        for (const summary of Array.isArray(listed) ? listed : []) {
          if (!summary || typeof summary.name !== 'string' || summary.name === '') continue
          const known = byName.get(summary.name)
          byName.set(summary.name, { name: summary.name, description: summary.description ?? known?.description ?? '' })
        }
        const directory = [...byName.values()]
        const items = []
        for (const summary of directory) {
          const skillName = summary.name
          const info = catalog.get(skillName) ?? summary
          const record = records.get(skillName) ?? {}
          items.push({
            name: skillName,
            description: info.description ?? '',
            uses: Number.isInteger(record.uses) ? record.uses : 0,
            lastUsedAt: typeof record.lastUsedAt === 'string' ? record.lastUsedAt : null,
            state: classifyUsage(record, now, thresholds).state,
            ...(typeof record.archivedAt === 'string' && record.archivedAt !== '' ? { archivedAt: record.archivedAt } : {}),
          })
        }
        const plan = planConsolidation(items, { threshold })
        return {
          scanned: plan.scanned,
          directory: directory.length,
          threshold: plan.threshold,
          clusters: plan.clusters.slice(0, limit),
          note: '只读报告：不刷目录、不改账本、不动任何技能文件；合不合并由人或模型决定（use=0 既不是不合并的理由，也不是合并的理由）。',
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
            lastCuration: {
              oneOf: [
                {
                  type: 'object',
                  properties: {
                    at: { type: 'string' },
                    archived: { type: 'integer' },
                    archivedNames: { type: 'array', items: { type: 'string' } },
                    skipped: {
                      type: 'object',
                      properties: {
                        alreadyArchived: { type: 'integer' },
                        catalogUntrusted: { type: 'integer' },
                        notDue: { type: 'integer' },
                        neverUsed: { type: 'integer' },
                      },
                      required: ['alreadyArchived', 'catalogUntrusted', 'notDue', 'neverUsed'],
                      additionalProperties: false,
                    },
                  },
                  required: ['at', 'archived', 'archivedNames', 'skipped'],
                  additionalProperties: false,
                },
                { type: 'null' },
              ],
            },
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
            'lastCuration',
          ],
          additionalProperties: false,
        },
        render(_args, value) {
          if (value?.ready === false) return [text('不可用：' + (value?.unavailableReason || '未知原因'))]
          const curation = value?.lastCuration
          const curationLine =
            curation === null || curation === undefined
              ? '\n自动归档：还没跑过（lastCuration=null）。'
              : `\n自动归档 ${curation.at}：归档 ${curation.archived} 个` +
                `（跳过：已归档 ${curation.skipped?.alreadyArchived ?? 0} / 目录不可信 ${curation.skipped?.catalogUntrusted ?? 0} / 未到阈值 ${curation.skipped?.notDue ?? 0} / 从未用过 ${curation.skipped?.neverUsed ?? 0}）。`
          return [
            text(
              `技能用量可用：账本 ${value?.records ?? 0} 条 / 目录 ${value?.catalogSize ?? 0} 个技能` +
                `（阈值 ${value?.thresholds?.staleAfterDays ?? '?'} 天 / ${value?.thresholds?.archiveAfterDays ?? '?'} 天），` +
                `已计 ${value?.skillLoads ?? 0} 次加载，存档 ${value?.storeFile ?? '?'}。` +
                curationLine,
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
          lastCuration: lastCuration ?? null,
        }
      },
    }),
  )
}
