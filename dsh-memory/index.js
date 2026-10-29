/**
 * dsh-memory —— 跨会话的持久记忆（用户级事实）。
 *
 * 学谁：Hermes Agent 的 `MEMORY.md` / `USER.md`，Claude Code 的用户级 CLAUDE.md。
 * 做法：把记忆渲染成一段文本，通过官方 `systemPrompt.context()` 注册进**每个会话**
 * 的系统提示；agent 用五个工具维护（list / add / update / remove / search）。
 *
 * 几个刻意的取舍：
 *   - **不做会话内冻结快照**：Hermes 冻结是为了缓存稳定，但 DSH 每次 assemble 本来就会
 *     重新取 context；记忆只在显式 add/update/remove 时变化，频率极低，缓存代价可忽略。
 *     好处是"刚记住的，下一步就生效"。
 *   - **存储预算与注入预算分开**（v1.1）：存储可到 `maxBytes`（默认 8000 字符），
 *     但每轮注入只花 `maxInjectChars`（默认 1200 字符）。`pinned` 的硬规则永远优先全文注入，
 *     其余按"越新越优先"分配全文；装不下的降级成一行索引（id + tag + 摘要），
 *     agent 需要时用 `memory_search` 取全文。这样记忆能长，而每轮 prompt 成本封顶。
 *   - **超预算就拒绝写入**，不自动淘汰：让 agent 明确知道要删哪条，避免悄悄丢用户信息。
 *   - **只存文本**：不写会话日志、不新增事件类型（DSH 的硬约束）。
 *   - 数据落 `config.storeDir`（本机 D:\AI\dsh-data\memory），不落 C 盘。
 *
 * 已知边界：
 *   - 全局一份（不按项目分），这是"用户级记忆"的定位；
 *   - 记忆注入发生在请求装配时，同一轮里刚写的内容对**下一条**模型请求生效；
 *   - 没有自动整理/去重之外的合并（去重只跳过完全相同的文本）；
 *   - `memory_search` 是子串 + 分词计分的轻量检索，不是语义检索（记忆体量小，够用）。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-memory'
export const inject = ['tools', 'systemPrompt', 'workingDirectory']

const DEFAULT_MAX_BYTES = 8000
const BACKUP_KEEP = 10
const DEFAULT_MAX_INJECT_CHARS = 1200
const MAX_TEXT_CHARS = 600
const CONTEXT_ORDER = 900
const INDEX_SUMMARY_CHARS = 44
const RELEVANT_SHARE = 0.3
const MAX_RELEVANT = 2
const RELEVANT_CONFIDENCE = 1.5
const MAX_QUERY_CHARS = 400
const SCOPE_BOOST = 1.4
// v2.3 检索：相关性覆盖率下限（score / 查询 idf 总和，语料规模无关）+ 三因子加权（Generative Agents 思路）
const RELEVANCE_FLOOR = 0.15
const COMPOSITE_IMPORTANCE_WEIGHT = 0.5
const COMPOSITE_RECENCY_WEIGHT = 0.3
const RELEVANT_COMPOSITE_MARGIN = 1.15
const RECENCY_DECAY_PER_HOUR = 0.995
const CANDIDATE_LIMIT = 50
// v2.7：跨域压缩保留主题摘要（原来只剩 <scope> 标签，等于没注入）；写入时给相似邻居提示（A-MEM 的零模型版）
const COMPACT_PEEK_CHARS = 14
const SIMILAR_HINT_FLOOR = 0.62
const MAX_SIMILAR_HINT = 2
const DEFAULT_SCOPE_ROOTS = {
  'plugin-dev': ['D:\\AI\\dsh-bundles'],
  'data-infra': ['D:\\AI\\dsh-data'],
  'dsh-date': ['D:\\AI-date\\dsh-date'],
}

// 顺序 = 信号强度：具体知识型在前，泛化命令式在后。
// 否则「结论是必须走 API」会被泛化的「必须」抢先命中，reason 就失真了。
const CANDIDATE_RULES = [
  { pattern: /记住|记一下|记下/, reason: '显式要求记住' },
  // v2.9：知识型陈述——真正值得沉淀的东西。原来的四条命令式规则只认「记住/以后/别再」，
  // 这类「实测/结论」型知识全被漏掉，候选池长期 0 条。
  { pattern: /已实测|实测过|验证过|已验证|踩过坑|踩坑|复现了/, reason: '实测结论' },
  { pattern: /结论是|结论：|根因|原因是|发现它|确认了/, reason: '结论/归因' },
  { pattern: /以后|下次|今后/, reason: '未来行为约定' },
  { pattern: /别再|不要再|不要用|不要/, reason: '禁止项' },
  { pattern: /一律|永远|必须|务必|规矩|约定/, reason: '硬规则措辞' },
]

const normalizePath = (value) => String(value ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

const IMPORTANCE_BASE = { rule: 8, preference: 6, fact: 4, note: 2 }

/**
 * 工作区级条件注入（v3.0）。
 * 痛点：7 条 pinned 里 m10/m11/m12 三条礼仪规则（178 字）只在两个工作区适用，
 * 却每轮全文注入到所有工作区，占掉超支预算的 74%。scope 粒度不够——它们和本工作区同属 dsh-date。
 * 做法：条目可带 workspaces（绝对路径前缀），当前 cwd 不匹配就整条不注入（仍能被 memory_search 搜到）。
 * 没设 workspaces 的条目行为完全不变（向后兼容）。
 */
export function applicableAt(entry, cwd) {
  const list = Array.isArray(entry?.workspaces) ? entry.workspaces.filter((item) => typeof item === 'string' && item.trim() !== '') : []
  if (list.length === 0) return true
  if (typeof cwd !== 'string' || cwd.trim() === '') return false
  const here = normalizePath(cwd)
  return list.some((item) => {
    const root = normalizePath(item)
    return here === root || here.startsWith(root + '\\')
  })
}
// v2.9 学习进化：被引用够多就该升级（巩固），长期无人用就该降权（遗忘）
const CONSOLIDATE_MIN_USES = 3
const MAX_CANDIDATES_PER_TURN = 2
const CANDIDATE_TTL_DAYS = 7

/**
 * 按 kind 推导 staleAfter（v2.8）。
 * 依据：OpenAI 2026 记忆架构升级里，事实回忆 82.8%、偏好遵循 71.3%，而「跨时间准确性」只有 75.1%
 * ——时间失效是全行业最弱的一环，靠人工记得填 staleAfter 不现实。
 * 取舍：rule / preference 是长期约定，不设（设了反而天天报警）；fact 90 天；note 30 天。
 * 只对新写入生效，存量条目不动（避免一次性给 63 条补上今天的日期）。
 */
export function deriveStaleAfter(kind, base = new Date()) {
  const days = kind === 'fact' ? 90 : kind === 'note' ? 30 : 0
  if (days === 0) return ''
  return new Date(base.getTime() + days * 86400000).toISOString().slice(0, 10)
}

/** 记忆重要度 1-10：显式字段优先，否则按 kind / pinned / 使用次数规则推导（Generative Agents 的 importance 零模型替代）。 */
export function importanceOf(entry) {
  if (Number.isInteger(entry?.importance) && entry.importance >= 1 && entry.importance <= 10) return entry.importance
  const kind = typeof entry?.kind === 'string' ? entry.kind : ''
  let base = IMPORTANCE_BASE[kind] ?? 4
  if (Array.isArray(entry?.tags) && entry.tags.includes('rule')) base = Math.max(base, 8)
  if (entry?.pinned === true) base += 2
  const used = Number.isFinite(entry?.usedCount) ? entry.usedCount : 0
  base += Math.min(2, 1.5 * Math.log1p(used))
  return Math.max(1, Math.min(10, Math.round(base)))
}

/**
 * 有效重要度（v2.9 遗忘曲线）：在 importanceOf 上叠加「多久没被命中」的衰减。
 * 依据：本库实测 26/63 从未被引用——长期无人用的条目不该继续占注入高位。
 * 取舍：pinned / rule 永不衰减（硬约定）；其余按 7 / 30 / 90 天分档降到 0.9 / 0.7 / 0.5。
 * 只影响注入排序，**不改存储值、不删除任何条目**，随时可回滚。
 */
export function effectiveImportance(entry, now = Date.now()) {
  const base = importanceOf(entry)
  if (entry?.pinned === true) return base
  if (entry?.kind === 'rule') return base
  const ref = typeof entry?.lastUsedAt === 'string' && entry.lastUsedAt !== '' ? entry.lastUsedAt : entry?.addedAt
  const stamp = typeof ref === 'string' ? Date.parse(ref) : NaN
  if (!Number.isFinite(stamp)) return base
  const days = (now - stamp) / 86400000
  if (days <= 7) return base
  if (days <= 30) return base * 0.9
  if (days <= 90) return base * 0.7
  return base * 0.5
}

const idfOf = (total, hit) => Math.log(1 + (total - hit + 0.5) / (hit + 0.5))

/** 查询词的 idf 总和：作为「相关覆盖率」的分母，使下限阈值与语料规模无关（小库/大库同一把尺）。 */
export function queryIdfSum(entries, query) {
  const docs = (Array.isArray(entries) ? entries : []).map((entry) =>
    tokenize(`${entry.text} ${Array.isArray(entry.tags) ? entry.tags.join(' ') : entry.tag ?? ''}`),
  )
  const total = docs.length
  if (total === 0) return 0
  let sum = 0
  for (const term of tokenize(query).keys()) {
    const hit = docs.filter((doc) => doc.has(term)).length
    sum += idfOf(total, hit)
  }
  return sum
}

/** 新鲜度 0-1：距上次命中/更新的小时数做 0.995^h 衰减（半衰 ≈ 5.8 天）。 */
export function recencyOf(entry, now = Date.now()) {
  const stamp =
    typeof entry?.lastUsedAt === 'string' && entry.lastUsedAt !== ''
      ? entry.lastUsedAt
      : typeof entry?.updatedAt === 'string' && entry.updatedAt !== ''
        ? entry.updatedAt
        : entry?.addedAt
  const time = Date.parse(String(stamp ?? ''))
  if (!Number.isFinite(time)) return 0.5
  const hours = Math.max(0, (now - time) / 3600000)
  return RECENCY_DECAY_PER_HOUR ** hours
}

/** 按 cwd 前缀映射到 scope 域；对不上返回空串（不做硬过滤，只是不加分）。 */
export function detectScope(cwd, roots) {
  const target = normalizePath(cwd)
  if (target === '') return ''
  const table = roots !== undefined && roots !== null && typeof roots === 'object' ? roots : DEFAULT_SCOPE_ROOTS
  for (const [scope, prefixes] of Object.entries(table)) {
    for (const prefix of Array.isArray(prefixes) ? prefixes : []) {
      const base = normalizePath(prefix)
      if (base !== '' && (target === base || target.startsWith(`${base}\\`))) return scope
    }
  }
  return ''
}

export function bigramSet(value) {
  const set = new Set()
  const clean = String(value ?? '').toLowerCase()
  for (const run of clean.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let index = 0; index + 2 <= run.length; index += 1) set.add(run.slice(index, index + 2))
  }
  for (const word of clean.match(/[a-z0-9][a-z0-9_\-.]{2,}/g) ?? []) set.add(word)
  return set
}

export function textSimilarity(left, right) {
  const a = bigramSet(left)
  const b = bigramSet(right)
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared += 1
  const union = a.size + b.size - shared
  return union === 0 ? 0 : shared / union
}

/** 从用户消息里按规则抽「值得沉淀」的候选事实；纯规则、零模型调用。 */
export function extractCandidates(text) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (raw === '') return []
  // v2.9：先按句切分再逐句判定。原实现把整段消息塞进候选池，那不是原子事实；
  // 且一条消息最多出 MAX_CANDIDATES_PER_TURN 条，防止刷屏。
  const clauses = raw.split(/[。；;！!\n]/).map((item) => item.trim()).filter((item) => item !== '')
  const source = clauses.length > 0 ? clauses : [raw]
  const out = []
  for (const clause of source) {
    if (out.length >= MAX_CANDIDATES_PER_TURN) break
    if (clause.length < 8 || clause.length > 160) continue
    if (/[?？]$/.test(clause)) continue
    // v3.1 污染门：注入块自身的标记/提示语一律不收。剥离失败时这是最后一道防线。
    if (
      clause.includes('📌') ||
      clause.includes('<memory>') ||
      clause.includes('</memory>') ||
      clause.includes('不要逐条复述') ||
      clause.includes('用 memory_search 按 id')
    ) {
      continue
    }
    const hit = CANDIDATE_RULES.find((rule) => rule.pattern.test(clause))
    if (hit === undefined) continue
    const kind = /别再|不要再|不要用|一律|永远|必须|务必|规矩|约定/.test(clause) ? 'rule' : 'fact'
    out.push({ text: clause.slice(0, MAX_TEXT_CHARS), kind, reason: hit.reason })
  }
  return out
}
const MEMORY_HEADER =
  '以下是跨会话记住的用户/项目事实（越靠后越新）。把它们当背景，不要逐条复述；与用户本轮明确指令冲突时，以本轮指令为准。'

const text = (value) => ({ type: 'text', text: value })

function storeLocation(overrideDir) {
  const override = typeof overrideDir === 'string' ? overrideDir.trim() : ''
  const base =
    override !== ''
      ? path.resolve(override)
      : process.env.DSH_PROFILE_DIR
        ? path.join(process.env.DSH_PROFILE_DIR, 'dsh-memory')
        : path.join(os.homedir(), '.dsh', 'dsh-memory')
  return { dir: base, file: path.join(base, 'memory.json') }
}

const OPTIONAL_STRING_FIELDS = ['tag', 'scope', 'kind', 'migratedFrom', 'validFrom', 'supersededBy']
const OPTIONAL_NUMBER_FIELDS = ['usedCount']

// v2.6 信任字段（学 OKF v0.2 / simple-agent-memory）：把「确认的事实」「未证实的猜测」「过期待重验」分开。
// 缺省（旧数据没有这些字段）= 不标注，行为与 v2.5 完全一致，保证向后兼容。
const MEMORY_STATUS = new Set(['draft', 'stable', 'deprecated'])
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const TRUST_LEGEND =
  '标记含义：❓未证实 = 猜测/未经复核；⏰待重验 = 依赖会变的事实已过复核期；✓已验证 = 有人复核过。'

/**
 * 规范化一条记忆：v1 只有 id/text/tag/pinned，v2 增加 scope/kind/tags/paths/supersededBy/usedCount 等。
 * 关键：**未知字段要保留**，否则 load→persist 一轮就把 v2 字段洗掉了。
 */
export function normalizeEntry(input) {
  const out = { id: input.id, text: input.text }
  for (const field of OPTIONAL_STRING_FIELDS) {
    const value = input[field]
    if (typeof value === 'string' && value !== '') out[field] = value
  }
  for (const field of OPTIONAL_NUMBER_FIELDS) {
    const value = input[field]
    if (Number.isFinite(value) && value >= 0) out[field] = value
  }
  if (Number.isFinite(input.importance)) {
    out.importance = Math.max(1, Math.min(10, Math.round(input.importance)))
  }
  if (Array.isArray(input.tags)) {
    const tags = input.tags.filter((tag) => typeof tag === 'string' && tag !== '')
    if (tags.length > 0) out.tags = tags
  }
  if (Array.isArray(input.aliases)) {
    const aliases = input.aliases.map((alias) => (typeof alias === 'string' ? alias.trim() : '')).filter((alias) => alias !== '')
    if (aliases.length > 0) out.aliases = aliases
  }
  if (Array.isArray(input.paths)) {
    const paths = input.paths.filter((item) => typeof item === 'string' && item !== '')
    if (paths.length > 0) out.paths = paths
  }
  if (Array.isArray(input.workspaces)) {
    const workspaces = input.workspaces.filter((item) => typeof item === 'string' && item.trim() !== '')
    if (workspaces.length > 0) out.workspaces = workspaces
  }
  if (MEMORY_STATUS.has(input.status)) out.status = input.status
  if (typeof input.verifiedBy === 'string' && input.verifiedBy !== '') out.verifiedBy = input.verifiedBy
  if (typeof input.verifiedAt === 'string' && input.verifiedAt !== '') out.verifiedAt = input.verifiedAt
  if (typeof input.staleAfter === 'string' && DATE_ONLY.test(input.staleAfter)) out.staleAfter = input.staleAfter
  if (Array.isArray(input.sources)) {
    const sources = input.sources.filter((item) => typeof item === 'string' && item.trim() !== '')
    if (sources.length > 0) out.sources = sources
  }
  if (input.pinned === true) out.pinned = true
  if (typeof input.lastUsedAt === 'string' && input.lastUsedAt !== '') out.lastUsedAt = input.lastUsedAt
  out.addedAt = typeof input.addedAt === 'string' ? input.addedAt : new Date().toISOString()
  out.updatedAt = typeof input.updatedAt === 'string' ? input.updatedAt : new Date().toISOString()
  return out
}

/**
 * 信任标记：❓未证实（status=draft）/ ⏰待重验（staleAfter 早于今天）/ ✓已验证（有 verifiedAt）。
 * 返回空串表示无标记，注入内容与旧版逐字一致。
 */
export function trustMark(entry, today = new Date().toISOString().slice(0, 10)) {
  const marks = []
  if (entry?.status === 'draft') marks.push('❓未证实')
  if (typeof entry?.staleAfter === 'string' && DATE_ONLY.test(entry.staleAfter) && entry.staleAfter < today) marks.push('⏰待重验')
  if (typeof entry?.verifiedAt === 'string' && entry.verifiedAt !== '') marks.push('✓已验证')
  return marks.length > 0 ? marks.join(' ') + ' ' : ''
}

const lineFull = (entry) => `- ${trustMark(entry)}${entry.pinned ? '📌 ' : ''}${entry.text}`

const entryDate = (entry) => {
  const raw = typeof entry.updatedAt === 'string' && entry.updatedAt !== '' ? entry.updatedAt : entry.addedAt
  const stamp = typeof raw === 'string' ? raw.slice(0, 10) : ''
  return /^\d{4}-\d{2}-\d{2}$/.test(stamp) ? stamp : ''
}

const entryTag = (entry) => (Array.isArray(entry.tags) && entry.tags.length > 0 ? entry.tags[0] : entry.tag ?? '')

const lineRelevant = (entry) => {
  const tag = entryTag(entry) ? ` [${entryTag(entry)}]` : ''
  const date = entryDate(entry)
  return `- (${entry.id})${trustMark(entry)}${tag}${date ? ` ${date}` : ''} ${entry.text}`
}

const lineIndexCompact = (entry) => {
  const scope = typeof entry.scope === 'string' && entry.scope !== '' ? entry.scope : (Array.isArray(entry.tags) ? entry.tags[0] : entry.tag) ?? ''
  // v2.7：只留 <scope> 标签等于没注入——模型看不出这条讲什么，也就不会去搜。压到 14 字主题仍可辨识。
  const flat = String(entry.text ?? '').replace(/\s+/g, ' ').trim()
  const peek = flat.length > COMPACT_PEEK_CHARS ? `${flat.slice(0, COMPACT_PEEK_CHARS)}…` : flat
  return `- (${entry.id})${trustMark(entry)}${scope ? ` <${scope}>` : ''} ${peek}`
}

const lineIndex = (entry) => {
  const flat = entry.text.replace(/\s+/g, ' ').trim()
  const summary = flat.length > INDEX_SUMMARY_CHARS ? `${flat.slice(0, INDEX_SUMMARY_CHARS)}…` : flat
  const tag = entryTag(entry) ? ` [${entryTag(entry)}]` : ''
  const date = entryDate(entry)
  return `- (${entry.id})${trustMark(entry)}${tag}${date ? ` ${date}` : ''} ${summary}`
}

/**
 * 渲染成注入系统提示的块；空记忆返回空串（等于不注入）。
 *
 * 不传 options（或 maxInjectChars 非正数）时是**全量渲染**，保持 v1.0 的行为；
 * 传了 maxInjectChars 就按优先级分层：pinned 优先，其余从新到旧，装不下的降级为索引行。
 */
export function renderMemory(allEntries, options) {
  if (!Array.isArray(allEntries) || allEntries.length === 0) return ''
  // v3.0：工作区条件——workspaces 不匹配当前 cwd 的条目整条不注入（预算不浪费在别处才用得上的规则上）。
  const cwd = typeof options?.cwd === 'string' ? options.cwd : ''
  // 已失效（被 superseded）或标记 deprecated 的条目只留档，不进提示。
  const entries = allEntries.filter(
    (entry) =>
      (typeof entry?.supersededBy !== 'string' || entry.supersededBy === '') &&
      entry?.status !== 'deprecated' &&
      applicableAt(entry, cwd),
  )

  const maxInjectChars =
    Number.isInteger(options?.maxInjectChars) && options.maxInjectChars > 0 ? options.maxInjectChars : 0

  if (!maxInjectChars) {
    const stats = options?.stats
    if (stats !== undefined && stats !== null && typeof stats === 'object') stats.full = entries.map((entry) => entry.id)
    const lines = entries.map(lineFull)
    const legend = entries.some((entry) => trustMark(entry) !== '') ? [TRUST_LEGEND] : []
    return ['<memory>', MEMORY_HEADER, ...legend, ...lines, '</memory>'].join('\n')
  }

  // 预算里先扣掉包装和头部；有信任标记时再把 legend 那一行也扣掉（否则会轻微超预算）
  const hasMarks = entries.some((entry) => trustMark(entry) !== '')
  let used = '<memory>'.length + MEMORY_HEADER.length + '</memory>'.length + 3 + (hasMarks ? TRUST_LEGEND.length + 1 : 0)
  const full = []
  const indexed = []
  const dropped = []

  // 第一优先级：pinned 全文（硬规则永远在场；真装不下也要进诊断行，不静默消失）
  for (const entry of entries.filter((item) => item.pinned)) {
    const cost = lineFull(entry).length + 1
    if (used + cost > maxInjectChars) {
      dropped.push(entry)
      continue
    }
    full.push(entry)
    used += cost
  }

  // 第二优先级：本轮相关（有 query 时）。相关条目给**全文**——多花 3 倍字符，但省掉一次工具调用，
  // 正好覆盖「相关却没进索引」的那批（v1.1 实测有 10 条完全不可见）。
  const relevant = []
  const queryText = typeof options?.query === 'string' ? options.query.trim() : ''
  const currentScope = typeof options?.scope === 'string' ? options.scope : ''
  if (queryText !== '') {
    const scored = scoreEntries(entries.filter((item) => !item.pinned), queryText)
      .map((item) => ({
        entry: item.entry,
        raw: currentScope !== '' && item.entry.scope === currentScope ? item.score * SCOPE_BOOST : item.score,
      }))
      .filter((item) => item.raw > 0.0001)
      .sort((a, b) => b.raw - a.raw)
    const floor = Number.isFinite(options?.relevanceFloor) ? options.relevanceFloor : RELEVANCE_FLOOR
    const topRaw = scored.length > 0 ? scored[0].raw : 0
    // 覆盖率门：top 分数 ÷ 查询 idf 总和。语料无关，弱匹配宁可一条都不给全文（治负例误注入）。
    // ⚠ 分子的 topRaw 必须用**严格分**（不含 alias 加权 / 同义扩展）：
    //   否则「帮我写个 Python 快排」这类无关问题会被同义词抬过门槛 —— 2026-10-29 实测负例误注入 0%→75%。
    const strictScored = scoreEntriesStrict(entries.filter((item) => !item.pinned), queryText)
    const strictTop = strictScored.reduce((max, item) => (item.score > max ? item.score : max), 0)
    const idfTotal = queryIdfSum(entries.filter((item) => !item.pinned), queryText)
    const coverage = idfTotal > 0 ? strictTop / idfTotal : 0
    if (coverage >= floor) {
      const now = Date.now()
      const ranked = scored
        .map((item) => ({
          entry: item.entry,
          // 三因子合成（GA 思路）：相关性归一 + importance + recency；相关性仍是主导项。
          composite:
            item.raw / topRaw +
            COMPOSITE_IMPORTANCE_WEIGHT * (effectiveImportance(item.entry, now) / 10) +
            COMPOSITE_RECENCY_WEIGHT * recencyOf(item.entry, now),
        }))
        .sort((a, b) => b.composite - a.composite)
      const topComposite = ranked[0].composite
      const cap = Math.min(Math.floor(maxInjectChars * RELEVANT_SHARE), maxInjectChars - used)
      let spent = 0
      for (const item of ranked) {
        if (relevant.length >= MAX_RELEVANT) break
        if (relevant.length > 0 && item.composite * RELEVANT_COMPOSITE_MARGIN < topComposite) break
        const cost = lineRelevant(item.entry).length + 1
        if (spent + cost > cap) break
        relevant.push(item.entry)
        spent += cost
        used += cost
      }
    }
  }
  const inRelevant = new Set(relevant.map((entry) => entry.id))

  // 第三优先级：其余出「一行索引」。本域（或 global）给完整摘要，跨域只留 id + 域标签
  // （Cursor 四态里 globs 的降级版本：跨域事实「知道存在、要看再搜」，别把别域细节当本域规则）。
  const rest = entries.filter((item) => !item.pinned && !inRelevant.has(item.id))
  const isCrossScope = (entry) =>
    currentScope !== '' &&
    typeof entry.scope === 'string' &&
    entry.scope !== '' &&
    entry.scope !== currentScope &&
    entry.scope !== 'global'
  const compact = []
  const ordered = [...rest].reverse()
  for (const entry of ordered) {
    if (isCrossScope(entry)) continue
    const cost = lineIndex(entry).length + 1
    if (used + cost > maxInjectChars) {
      dropped.push(entry)
      continue
    }
    indexed.push(entry)
    used += cost
  }
  for (const entry of ordered) {
    if (!isCrossScope(entry)) continue
    const cost = lineIndexCompact(entry).length + 1
    if (used + cost > maxInjectChars) {
      dropped.push(entry)
      continue
    }
    compact.push(entry)
    used += cost
  }

  // 诊断：被挤出预算的条目必须留痕（列出 id，不列正文），否则又是「悄悄丢」。
  const MAX_DIAGNOSTIC_IDS = 24
  const ids = dropped.slice(0, MAX_DIAGNOSTIC_IDS).map((entry) => entry.id)
  let groupText = ''
  if (dropped.length > ids.length) {
    const groups = new Map()
    for (const entry of dropped) {
      const key = entry.scope ?? (Array.isArray(entry.tags) && entry.tags[0]) ?? entry.tag ?? 'other'
      groups.set(key, (groups.get(key) ?? 0) + 1)
    }
    const summary = [...groups.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => `${key} ${count}`).join(' / ')
    groupText = ` …（按 scope：${summary}）`
  }
  const diagnostic =
    dropped.length > 0
      ? `⚠ 另有 ${dropped.length} 条未注入：${ids.join(' ')}${groupText}（用 memory_search 按 id 或关键词取全文）`
      : ''
  const footer = `（全文 ${full.length}${relevant.length > 0 ? ` · 相关 ${relevant.length}` : ''} · 索引 ${indexed.length}${compact.length > 0 ? ` · 跨域 ${compact.length}` : ''}${dropped.length > 0 ? ` · 未注入 ${dropped.length}` : ''}；跨域或更早的记忆用 memory_search 按 id / 关键词取）`

  const statsOut = options?.stats
  if (statsOut !== undefined && statsOut !== null && typeof statsOut === 'object') {
    statsOut.full = full.map((entry) => entry.id)
    statsOut.relevant = relevant.map((entry) => entry.id)
    statsOut.indexed = indexed.map((entry) => entry.id)
    statsOut.compact = compact.map((entry) => entry.id)
    statsOut.dropped = dropped.map((entry) => entry.id)
  }

  return [
    '<memory>',
    MEMORY_HEADER,
    ...(hasMarks ? [TRUST_LEGEND] : []),
    ...full.map(lineFull),
    ...relevant.map(lineRelevant),
    ...indexed.map(lineIndex),
    ...compact.map(lineIndexCompact),
    ...(diagnostic ? [diagnostic] : []),
    footer,
    '</memory>',
  ].join('\n')
}

/** 分词：英文/数字按词，中文按 unigram + bigram（无空格语言只能这样切）。 */
export function tokenize(input) {
  const value = String(input ?? '').toLowerCase()
  const terms = new Map()
  const bump = (term) => terms.set(term, (terms.get(term) ?? 0) + 1)
  for (const word of value.match(/[a-z0-9][a-z0-9_\-.]{1,}/g) ?? []) bump(word)
  for (const run of value.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let index = 0; index < run.length; index += 1) bump(run[index])
    for (let index = 0; index + 2 <= run.length; index += 1) bump(run.slice(index, index + 2))
  }
  return terms
}

const BM25_K1 = 1.2
const BM25_B = 0.75
const BM25_TAG_WEIGHT = 2
/** aliases 是人工写的「跨词面桥」，命中权重应高于 tag（tag 是分类，alias 是等同词）。 */
const BM25_ALIAS_WEIGHT = 2.5
/** 同义词扩展的权重：低于原词，避免扩展词把噪声顶上来。 */
const EXPANSION_WEIGHT = 0.5

function bm25Doc(entry) {
  const tagText = Array.isArray(entry.tags) && entry.tags.length > 0 ? entry.tags.join(' ') : entry.tag ?? ''
  const aliasText = Array.isArray(entry.aliases) ? entry.aliases.join(' ') : ''
  const terms = tokenize(`${entry.text} ${tagText} ${aliasText}`)
  let length = 0
  for (const count of terms.values()) length += count
  return { entry, terms, length, tagText: tagText.toLowerCase(), aliasTerms: new Set(tokenize(aliasText).keys()) }
}

/**
 * 领域同义组：用户提问用一种说法，记忆里存的是另一种说法。
 * 命中任意成员 → 同组其余成员的低权重词加入查询（EXPANSION_WEIGHT）。
 * 只收「高精度」同义，宁可少收，别把噪声词灌进来。
 */
const SYNONYM_GROUPS = [
  ['生效', '重载', 'reload', '跑起来', '应用改动', '装完'],
  ['验证门', '门禁', 'dsh-proof', '收工前', '拦'],
  ['记忆', 'memory', '记忆库'],
  ['坏了', '故障', '崩了', '救', '修复'],
  ['归档', 'archive', '冷存', '备份区'],
  ['评测', 'bench', '跑分', '基准'],
  ['工作区', 'workspace', '项目目录'],
  ['虚拟机', 'virtualbox', 'vbox', 'vm'],
  ['抖音', 'douyin', '短视频'],
  ['桌面图标', 'dock', '图标被接管'],
  ['管理员权限', '提权', 'elevate', 'uac'],
  ['注册表', 'registry', 'hklm', 'hkcu'],
  ['快捷方式', 'lnk', 'shortcut', '快捷图标'],
  ['礼仪', '君臣', '称呼', '自称'],
]

/**
 * 查询扩展：返回「扩展词 → 权重」。单字不扩展（太泛，会灌噪声）。
 * 只做词面层面的桥接，不调模型。
 */
export function expandQuery(query) {
  const text = String(query ?? '').toLowerCase()
  const extra = new Map()
  for (const group of SYNONYM_GROUPS) {
    if (!group.some((word) => text.includes(word.toLowerCase()))) continue
    for (const word of group) {
      for (const term of tokenize(word).keys()) {
        if (term.length < 2) continue
        if ((extra.get(term) ?? 0) < EXPANSION_WEIGHT) extra.set(term, EXPANSION_WEIGHT)
      }
    }
  }
  return extra
}

/**
 * BM25 检索：IDF 压常见词、长度归一压长条目，中文用 unigram+bigram。
 * 加权：aliases 命中 ×2.5（人工写的跨词面桥）> tag 命中 ×2 > 原词 ×1 > 同义扩展词 ×0.5。
 */
export function scoreEntries(entries, query) {
  const docs = (Array.isArray(entries) ? entries : []).map(bm25Doc)
  if (docs.length === 0) return []
  const queryTerms = tokenize(query)
  const expansion = expandQuery(query)
  if (queryTerms.size === 0 && expansion.size === 0) return docs.map((doc) => ({ entry: doc.entry, score: 0 }))
  const weights = new Map()
  for (const term of queryTerms.keys()) weights.set(term, 1)
  for (const [term, weight] of expansion) if (!weights.has(term)) weights.set(term, weight)
  let totalLength = 0
  for (const doc of docs) totalLength += doc.length
  const avgLength = totalLength / docs.length || 1
  const df = new Map()
  for (const term of weights.keys()) df.set(term, docs.filter((doc) => doc.terms.has(term)).length)
  return docs.map((doc) => {
    let score = 0
    for (const [term, weight] of weights) {
      const frequency = doc.terms.get(term) ?? 0
      if (frequency === 0) continue
      const hit = df.get(term) ?? 0
      const idf = Math.log(1 + (docs.length - hit + 0.5) / (hit + 0.5))
      const tagBoost = doc.tagText.includes(term) ? BM25_TAG_WEIGHT : 1
      const aliasBoost = doc.aliasTerms.has(term) ? BM25_ALIAS_WEIGHT : 1
      score += weight * tagBoost * aliasBoost * idf * ((frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / avgLength)))
    }
    return { entry: doc.entry, score }
  })
}

/**
 * 严格打分：只用原查询词，**不加** alias 权重、**不做**同义扩展。
 * 用途：判「这句话跟这条记忆到底相不相关」——扩展词可以帮排序，但绝不能帮它越过相关性门槛，
 * 否则负例（无关问题）会因为同义词被误判相关并注入全文。
 */
export function scoreEntriesStrict(entries, query) {
  // 文档侧只取 text + tag，**不取 aliases**：aliases 是查询桥，不是原文内容。
  // 早期版本把它们算进文档，导致「怎么生成」这种别名里的「怎么」把「MySQL 索引优化怎么做」判成相关。
  const docs = (Array.isArray(entries) ? entries : []).map((entry) => {
    const tagText = Array.isArray(entry.tags) && entry.tags.length > 0 ? entry.tags.join(' ') : entry.tag ?? ''
    const terms = tokenize(`${entry.text} ${tagText}`)
    let length = 0
    for (const count of terms.values()) length += count
    return { entry, terms, length }
  })
  if (docs.length === 0) return []
  const terms = tokenize(query)
  if (terms.size === 0) return docs.map((doc) => ({ entry: doc.entry, score: 0 }))
  let totalLength = 0
  for (const doc of docs) totalLength += doc.length
  const avgLength = totalLength / docs.length || 1
  const df = new Map()
  for (const term of terms.keys()) df.set(term, docs.filter((doc) => doc.terms.has(term)).length)
  return docs.map((doc) => {
    let score = 0
    for (const term of terms.keys()) {
      const frequency = doc.terms.get(term) ?? 0
      if (frequency === 0) continue
      const hit = df.get(term) ?? 0
      const idf = Math.log(1 + (docs.length - hit + 0.5) / (hit + 0.5))
      score += idf * ((frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / avgLength)))
    }
    return { entry: doc.entry, score }
  })
}

/** 单条打分（兼容旧签名）；传 options.entries 就能用上跨条目的 IDF。 */
export function scoreMemory(entry, query, options) {
  const corpus = Array.isArray(options?.entries) && options.entries.length > 0 ? options.entries : null
  const all = corpus === null ? [entry] : corpus.includes(entry) ? corpus : [...corpus, entry]
  const found = scoreEntries(all, query).find((item) => item.entry === entry)
  return found === undefined ? 0 : found.score
}

/**
 * 条目对外 schema —— **单一真相源**。
 * list / add / update / merge 全部引用它，避免出现「一处加了字段、另一处漏加 → invalid output」。
 * v2.6.1：补 lastUsedAt / validFrom / supersededBy / paths（存量漏项，真实库有 lastUsedAt 时 memory_list 直接报错）。
 */
export const memoryEntrySchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    text: { type: 'string' },
    tag: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    scope: { type: 'string' },
    kind: { type: 'string' },
    importance: { type: 'integer' },
    migratedFrom: { type: 'string' },
    validFrom: { type: 'string' },
    supersededBy: { type: 'string' },
    usedCount: { type: 'integer' },
    pinned: { type: 'boolean' },
    lastUsedAt: { type: 'string' },
    addedAt: { type: 'string' },
    updatedAt: { type: 'string' },
    status: { type: 'string' },
    staleAfter: { type: 'string' },
    verifiedBy: { type: 'string' },
    verifiedAt: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
    paths: { type: 'array', items: { type: 'string' } },
    workspaces: { type: 'array', items: { type: 'string' } },
    aliases: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'text', 'addedAt', 'updatedAt'],
  additionalProperties: false,
}

export function apply(ctx, config) {
  const maxBytes =
    Number.isInteger(config?.maxBytes) && config.maxBytes > 0 ? Math.min(config.maxBytes, 64 * 1024) : DEFAULT_MAX_BYTES
  const maxInjectChars =
    Number.isInteger(config?.maxInjectChars) && config.maxInjectChars > 0
      ? Math.min(config.maxInjectChars, 32 * 1024)
      : DEFAULT_MAX_INJECT_CHARS
  const { dir: storeDir, file: storeFile } = storeLocation(config?.storeDir)
  const tools = ctx.tools
  const scopeRoots =
    config?.scopeRoots !== undefined && config.scopeRoots !== null && typeof config.scopeRoots === 'object'
      ? config.scopeRoots
      : DEFAULT_SCOPE_ROOTS
  const captureCandidates = config?.captureCandidates !== false
  const relevanceFloor = Number.isFinite(config?.relevanceFloor) ? config.relevanceFloor : undefined
  const candidateFile = path.join(storeDir, 'candidates.json')

  let state = { version: 1, nextId: 1, entries: [] }
  let candidates = { version: 1, nextId: 1, items: [] }
  // 数据安全：解析失败不覆盖，改名留证并进入只读保护态（P0-1）。
  let storeHealth = 'ok'
  let corruptCopy = ''

  const backupDay = () => {
    const date = new Date()
    return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
  }

  function pruneBackups() {
    try {
      if (!existsSync(storeDir)) return
      const prefix = `${path.basename(storeFile)}.bak-`
      const names = readdirSync(storeDir).filter((name) => name.startsWith(prefix))
      if (names.length <= BACKUP_KEEP) return
      const listed = names.map((name) => {
        try {
          return { name, mtime: statSync(path.join(storeDir, name)).mtimeMs }
        } catch (error) {
          return { name, mtime: 0 }
        }
      })
      listed.sort((a, b) => b.mtime - a.mtime)
      for (const item of listed.slice(BACKUP_KEEP)) {
        try {
          unlinkSync(path.join(storeDir, item.name))
        } catch (error) {
          // 删不掉就算了，别影响主流程
        }
      }
    } catch (error) {
      // 备份清理失败不影响记忆读写
    }
  }

  function ensureDailyBackup() {
    if (!existsSync(storeFile)) return
    try {
      const target = `${storeFile}.bak-${backupDay()}`
      if (existsSync(target)) return
      copyFileSync(storeFile, target)
      pruneBackups()
    } catch (error) {
      // 备份失败不阻断写入，但 doctor 会报
    }
  }

  const requireWritable = () => {
    if (storeHealth !== 'corrupt') return
    throw new Error(
      `记忆库损坏保护中：原文件已另存为 ${corruptCopy || storeFile}。人工确认修复（把合法 JSON 改名回 ${storeFile}）并重载插件前，拒绝写入。`,
    )
  }

  function loadCandidates() {
    try {
      const parsed = JSON.parse(readFileSync(candidateFile, 'utf8'))
      const items = Array.isArray(parsed?.items) ? parsed.items : []
      candidates = {
        version: 1,
        nextId: Number.isInteger(parsed?.nextId) && parsed.nextId > 0 ? parsed.nextId : items.length + 1,
        items: items.filter((item) => item && typeof item.text === 'string' && typeof item.id === 'string'),
      }
    } catch (error) {
      // 没有候选池：从空开始
    }
  }

  function persistCandidates() {
    try {
      mkdirSync(storeDir, { recursive: true })
      const body = JSON.stringify(candidates, null, 2)
      const temp = `${candidateFile}.tmp`
      writeFileSync(temp, body, 'utf8')
      try {
        renameSync(temp, candidateFile)
      } catch (error) {
        writeFileSync(candidateFile, body, 'utf8')
      }
      return true
    } catch (error) {
      return false
    }
  }

  function persist() {
    if (storeHealth === 'corrupt') return false
    ensureDailyBackup()
    try {
      mkdirSync(storeDir, { recursive: true })
      const body = JSON.stringify(state, null, 2)
      const temp = `${storeFile}.tmp`
      writeFileSync(temp, body, 'utf8')
      try {
        renameSync(temp, storeFile)
      } catch (error) {
        writeFileSync(storeFile, body, 'utf8')
      }
      return true
    } catch (error) {
      return false
    }
  }

  function load() {
    let raw = ''
    try {
      raw = readFileSync(storeFile, 'utf8')
    } catch (error) {
      return // 没有存档：从空开始
    }
    try {
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
        throw new Error('store shape is not {entries: []}')
      }
      const entries = parsed.entries
      state = {
        nextId: Number.isInteger(parsed?.nextId) && parsed.nextId > 0 ? parsed.nextId : entries.length + 1,
        version: Number.isInteger(parsed?.version) && parsed.version > 0 ? parsed.version : 1,
        entries: entries
          .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.text === 'string')
          .map(normalizeEntry),
      }
    } catch (error) {
      // 损坏：把原文件改名留证，进入只读保护态；绝不静默覆盖。
      storeHealth = 'corrupt'
      try {
        corruptCopy = `${storeFile}.corrupt-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
        renameSync(storeFile, corruptCopy)
      } catch (renameError) {
        corruptCopy = storeFile
      }
    }
  }

  load()
  loadCandidates()

  // v2.9：候选池 TTL——过期未确认的自动标记 expired（保留记录，不删）。
  // 否则候选池只增不减，pending 数永远虚高，「有 N 条待确认」的提醒会变成噪声。
  const expireCandidates = () => {
    const nowMs = Date.now()
    let changed = false
    for (const item of candidates.items) {
      if (item.status === 'pending' && typeof item.expiresAt === 'string' && Date.parse(item.expiresAt) < nowMs) {
        item.status = 'expired'
        changed = true
      }
    }
    if (changed) persistCandidates()
  }
  expireCandidates()

  // v3.3（口径修复）：生效 = 未被 superseded **且** 不是 deprecated。
  // 原来只判 supersededBy，导致 deprecated 条目仍算进 activeEntries → usedChars 预算虚高、
  // memory_review 的 total 比实际注入多 3 条、memory_audit 的 active 也偏大。
  // renderMemory 一直是两者都过滤的，这里对齐它。
  const isActive = (entry) =>
    (typeof entry.supersededBy !== 'string' || entry.supersededBy === '') && entry?.status !== 'deprecated'
  const activeEntries = () => state.entries.filter(isActive)
  const usedChars = () => activeEntries().reduce((sum, entry) => sum + entry.text.length, 0)
  const publicEntry = (entry) => ({ ...entry })
  const renderOnce = (query, stats, scope, cwd) =>
    renderMemory(state.entries, {
      maxInjectChars,
      query,
      ...(typeof scope === 'string' && scope !== '' ? { scope } : {}),
      ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
      ...(relevanceFloor !== undefined ? { relevanceFloor } : {}),
      ...(stats ? { stats } : {}),
    })

  // ---- 使用计数（给冷热/淘汰提供依据）----
  let usageDirty = false
  let lastUsageFlush = 0
  let lastCountedQuery = ''
  const countUsage = (ids) => {
    if (!Array.isArray(ids) || ids.length === 0) return
    const stamp = new Date().toISOString()
    for (const id of ids) {
      const entry = state.entries.find((item) => item.id === id)
      if (entry === undefined) continue
      entry.usedCount = (entry.usedCount ?? 0) + 1
      entry.lastUsedAt = stamp
      usageDirty = true
    }
  }
  const flushUsage = () => {
    if (!usageDirty) return
    persist()
    usageDirty = false
    lastUsageFlush = Date.now()
  }

  // 从运行期上下文取「本条用户消息」当检索查询：官方 AGENTS.md 也走 context.agent.session。
  // text() 必须同步且廉价，所以这里只做内存计算；拿不到会话就退化成「无 query」的纯索引模式。
  const currentQuery = (context) => {
    try {
      const session = context?.agent?.session
      if (session === undefined || typeof session.deriveMessages !== 'function') return ''
      const messages = session.deriveMessages()
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (message?.role !== 'user' || !Array.isArray(message.content)) continue
        const joined = message.content
          .filter((part) => part?.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('\n')
          .trim()
        if (joined !== '') return joined.slice(0, MAX_QUERY_CHARS)
      }
      return ''
    } catch (error) {
      return ''
    }
  }

  const currentScopeOf = (context) => {
    try {
      const session = context?.agent?.session
      if (session === undefined) return ''
      const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : ctx.workingDirectory
      const workingDirectory = service !== undefined && service !== null ? service : ctx.workingDirectory
      const cwd = typeof workingDirectory?.get === 'function' ? workingDirectory.get(session) : ''
      return detectScope(cwd, scopeRoots)
    } catch (error) {
      return ''
    }
  }

  // v3.0：workspaces 条件注入要当前工作目录（scope 粒度不够——同一 scope 下仍有不同工作区）。
  const currentCwdOf = (context) => {
    try {
      const session = context?.agent?.session
      if (session === undefined) return ''
      const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : ctx.workingDirectory
      const workingDirectory = service !== undefined && service !== null ? service : ctx.workingDirectory
      return typeof workingDirectory?.get === 'function' ? workingDirectory.get(session) : ''
    } catch (error) {
      return ''
    }
  }

  const pendingCandidates = () => candidates.items.filter((item) => item.status === 'pending')
  const addCandidate = (text, scope, kind, reason, sessionId) => {
    const value = String(text ?? '').trim()
    if (value === '') return false
    // 已经记过的、或与现有生效记忆高度重合的，不再候选
    for (const entry of activeEntries()) {
      if (entry.text === value || textSimilarity(entry.text, value) >= 0.7) return false
    }
    for (const item of pendingCandidates()) {
      if (item.text === value || textSimilarity(item.text, value) >= 0.7) return false
    }
    if (pendingCandidates().length >= CANDIDATE_LIMIT) return false
    candidates.items.push({
      id: `c${candidates.nextId}`,
      text: value.slice(0, MAX_TEXT_CHARS),
      ...(scope !== '' ? { scope } : {}),
      kind,
      reason,
      status: 'pending',
      ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + CANDIDATE_TTL_DAYS * 86400000).toISOString(),
    })
    candidates.nextId += 1
    persistCandidates()
    return true
  }

  const injectedBlock = (context) => {
    const query = currentQuery(context)
    const scope = currentScopeOf(context)
    const stats = {}
    const block = renderOnce(query, stats, scope, currentCwdOf(context))
    // 同一个 query 只计一次（text() 每个 step 都会被调用）；按分钟节流落盘。
    if (query !== '' && query !== lastCountedQuery) {
      lastCountedQuery = query
      countUsage(stats.relevant)
      if (usageDirty && Date.now() - lastUsageFlush > 60000) flushUsage()
    }
    const pending = pendingCandidates().length
    if (pending === 0) return block
    const reminder = `💡 候选记忆 ${pending} 条待确认（memory_candidates 查看）`
    if (block === '') return ['<memory>', '（记忆库为空）', reminder, '</memory>'].join('\n')
    return block.replace('</memory>', `${reminder}\n</memory>`)
  }
  const listOutput = () => {
    const block = renderOnce('')
    const entries = activeEntries()
    return {
      total: state.entries.length,
      superseded: state.entries.filter(
        (entry) => typeof entry.supersededBy === 'string' && entry.supersededBy !== '',
      ).length,
      archived: state.entries.length - entries.length,
      health: storeHealth,
      ...(corruptCopy !== '' ? { healthNote: corruptCopy } : {}),
      usedChars: usedChars(),
      maxBytes,
      maxInjectChars,
      injectedChars: block.length,
      // v2.8：maxInjectChars 只管正文行，头部/索引/诊断另有固定开销，所以总长会略超——
      // 与其让人猜，不如直接把「是否超」标出来。
      injectedOverBudget: block.length > maxInjectChars,
      entries: state.entries.map(publicEntry),
      block,
    }
  }

  // ---- 注入：每个会话装配系统提示时读取当前记忆（分层，成本封顶） ----
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'dsh-memory',
      order: CONTEXT_ORDER,
      text: (context) => injectedBlock(context),
    }),
  )

  // ---- 工具 ----
  const listSchema = {
    type: 'object',
    properties: {
      total: { type: 'integer' },
      superseded: { type: 'integer' },
      archived: { type: 'integer' },
      health: { type: 'string' },
      healthNote: { type: 'string' },
      usedChars: { type: 'integer' },
      maxBytes: { type: 'integer' },
      maxInjectChars: { type: 'integer' },
      injectedChars: { type: 'integer' },
      injectedOverBudget: { type: 'boolean' },
      entries: { type: 'array', items: memoryEntrySchema },
      block: { type: 'string' },
    },
    required: ['total', 'superseded', 'health', 'usedChars', 'maxBytes', 'maxInjectChars', 'injectedChars', 'entries', 'block'],
    additionalProperties: false,
  }

  const entrySchema = memoryEntrySchema

  const renderList = (_args, value) => {
    const entries = Array.isArray(value?.entries) ? value.entries : []
    const healthWarn =
      value?.health === 'corrupt' ? `\n⚠ 记忆库损坏保护中（原文件已另存：${value?.healthNote ?? '未知'}），写入已禁用，修好后重载插件。` : ''
    const head = `记忆 ${value?.total ?? 0} 条（失效 ${value?.superseded ?? 0} · 归档 ${value?.archived ?? 0}），存储 ${value?.usedChars ?? 0}/${value?.maxBytes ?? 0} 字符，本轮注入 ${value?.injectedChars ?? 0}/${value?.maxInjectChars ?? 0} 字符${value?.injectedOverBudget ? ' ⚠超预算' : ''}${healthWarn}`
    if (entries.length === 0) return [text(`${head}\n（还没有任何记忆。用 memory_add 写入第一条。）`)]
    const lines = entries.map(
      (entry) =>
        `- ${entry.id}${trustMark(entry)}${entry.pinned ? ' 📌' : ''}${(entry.tags?.[0] ?? entry.tag) ? ` [${entry.tags?.[0] ?? entry.tag}]` : ''}${entry.scope ? ` <${entry.scope}>` : ''}${entry.kind ? ` (${entry.kind})` : ''}${entry.supersededBy ? ` [失效→${entry.supersededBy}]` : ''}${entry.status === 'deprecated' ? ' [已废弃]' : ''}${entry.usedCount ? ` 用${entry.usedCount}次` : ''} ${entry.text}`,
    )
    return [text(`${head}\n${lines.join('\n')}`)]
  }

  const applyEntryFlags = (entry, args) => {
    if (args?.pinned === true) entry.pinned = true
    else if (args?.pinned === false) delete entry.pinned
  }

  ctx.effect(() =>
    tools.register({
      name: 'memory_list',
      description:
        'List the persistent memories injected into every session, with ids, tags, pinned flags and the exact injected block. Use it before adding or pruning.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: listSchema,
        render: renderList,
      },
      async execute() {
        return listOutput()
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'memory_search',
      description:
        'Search the persistent memories by keyword and get the full text of matching entries. Use it when the injected <memory> block shows compact index lines instead of full text.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords; space-separated terms are AND-weighted, a whole-string hit scores higher.' },
          limit: { type: 'integer', description: 'Max matches to return (1-20, default 5).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            total: { type: 'integer' },
            matched: { type: 'integer' },
            byId: { type: 'array', items: { type: 'string' } },
            matches: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  tag: { type: 'string' },
                  tags: { type: 'array', items: { type: 'string' } },
                  scope: { type: 'string' },
                  kind: { type: 'string' },
                  importance: { type: 'integer' },
                  pinned: { type: 'boolean' },
                  status: { type: 'string' },
                  staleAfter: { type: 'string' },
                  verifiedAt: { type: 'string' },
                  sources: { type: 'array', items: { type: 'string' } },
                  score: { type: 'number' },
                },
                required: ['id', 'text', 'score'],
                additionalProperties: false,
              },
            },
          },
          required: ['query', 'total', 'matched', 'matches'],
          additionalProperties: false,
        },
        render(_args, value) {
          const matches = Array.isArray(value?.matches) ? value.matches : []
          if (matches.length === 0) {
            return [text(`没有匹配「${value?.query ?? ''}」的记忆（共 ${value?.total ?? 0} 条）。`)]
          }
          const lines = matches.map((item) =>
            `- ${item.id}${trustMark(item)}${item.pinned ? ' 📌' : ''}${(item.tags?.[0] ?? item.tag) ? ` [${item.tags?.[0] ?? item.tag}]` : ''}${item.scope ? ` <${item.scope}>` : ''} ${item.text}`)
          const byId = Array.isArray(value?.byId) && value.byId.length > 0 ? `（按 id 直取 ${value.byId.join('、')}）` : ''
          return [text(`匹配 ${value?.matched ?? 0} / ${value?.total ?? 0} 条${byId}：\n${lines.join('\n')}`)]
        },
      },
      async execute(args) {
        const query = typeof args?.query === 'string' ? args.query.trim() : ''
        if (query === '') throw new Error('memory_search 需要 query。')
        const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 20) : 5
        // v2.7：query 里出现 m\d+ 就按 id 直取。注入块一直写着「用 memory_search 按 id 取全文」，
        // 但 BM25 不认 id——实测搜 m33 命中 0/63。文档与实现不一致，这里补上。
        const idHits = [...new Set(query.match(/m\d+/g) ?? [])]
          .map((id) => state.entries.find((entry) => entry.id === id))
          .filter((entry) => entry !== undefined)
        const scored = scoreEntries(state.entries, query)
          .filter((item) => item.score > 0.0001 && !idHits.some((entry) => entry.id === item.entry.id))
          .sort(
            (a, b) =>
              b.score - a.score ||
              String(b.entry.updatedAt).localeCompare(String(a.entry.updatedAt)),
          )
        if (idHits.length > 0) scored.unshift(...idHits.map((entry) => ({ entry, score: 1e6 })))
        const top = scored.slice(0, limit)
        countUsage(top.map((item) => item.entry.id))
        flushUsage()
        return {
          query,
          total: state.entries.length,
          matched: scored.length,
          ...(idHits.length > 0 ? { byId: idHits.map((entry) => entry.id) } : {}),
          matches: scored.slice(0, limit).map((item) => ({
            id: item.entry.id,
            text: item.entry.text,
            ...(item.entry.tag ? { tag: item.entry.tag } : {}),
            ...(Array.isArray(item.entry.tags) && item.entry.tags.length > 0 ? { tags: item.entry.tags } : {}),
            ...(item.entry.scope ? { scope: item.entry.scope } : {}),
            ...(item.entry.kind ? { kind: item.entry.kind } : {}),
            ...(Number.isInteger(item.entry.importance) ? { importance: item.entry.importance } : {}),
            ...(item.entry.pinned ? { pinned: true } : {}),
            ...(typeof item.entry.status === 'string' ? { status: item.entry.status } : {}),
            ...(typeof item.entry.staleAfter === 'string' ? { staleAfter: item.entry.staleAfter } : {}),
            ...(typeof item.entry.verifiedAt === 'string' ? { verifiedAt: item.entry.verifiedAt } : {}),
            ...(Array.isArray(item.entry.sources) ? { sources: item.entry.sources } : {}),
            score: Math.round(item.score * 1000) / 1000,
          })),
        }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'memory_add',
      description:
        'Persist one durable fact across sessions (user preferences, environment quirks, project conventions). Keep each entry short and self-contained; it costs prompt space. It takes effect from the next model request.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: `The fact to remember (<= ${MAX_TEXT_CHARS} chars).` },
          tag: { type: 'string', description: 'Optional short tag, e.g. "preference", "env", "project".' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags; used for retrieval weighting.' },
          aliases: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional synonyms/aliases the user might use instead of the stored wording (e.g. 生效, reload). They are retrieval-only bridges and are scored higher than tags.',
          },
          scope: {
            type: 'string',
            description: 'Optional scope: global | plugin-dev | data-infra | dsh-date | machine. Unmatched scopes get no boost, never filtered out.',
          },
          kind: { type: 'string', description: 'Optional kind: rule | preference | fact | note.' },
          importance: { type: 'integer', minimum: 1, maximum: 10, description: 'Optional importance 1-10; derived from kind/pinned/usage when omitted.' },
          pinned: {
            type: 'boolean',
            description: 'Pin it so it is always injected in full, even when the injection budget is tight. Use it for hard rules.',
          },
          status: {
            type: 'string',
            enum: ['draft', 'stable', 'deprecated'],
            description: 'Trust state. draft = unconfirmed guess (injected with a "未证实" marker), stable = confirmed, deprecated = superseded history (kept but never injected).',
          },
          staleAfter: {
            type: 'string',
            description: 'YYYY-MM-DD. Set it when the fact depends on something that changes (a version, an API behavior); after that date the entry is injected with a "待重验" marker.',
          },
          sources: {
            type: 'array',
            items: { type: 'string' },
            description: 'Evidence backing the fact: URLs or file paths. Never invent them.',
          },
          workspaces: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute workspace path prefixes this entry applies to (v3.0). When set, the entry is only injected in matching working directories; elsewhere it stays searchable but costs no prompt space.',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            entry: entrySchema,
            deduped: { type: 'boolean' },
            usedChars: { type: 'integer' },
            maxBytes: { type: 'integer' },
            similar: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  similarity: { type: 'number' },
                  text: { type: 'string' },
                },
                required: ['id', 'similarity', 'text'],
                additionalProperties: false,
              },
            },
          },
          required: ['entry', 'deduped', 'usedChars', 'maxBytes'],
          additionalProperties: false,
        },
        render(_args, value) {
          const entry = value?.entry
          const head = value?.deduped ? `已存在相同记忆：${entry?.id}` : `已记住：${entry?.id}${entry?.pinned ? '（已置顶）' : ''}`
          const similar = Array.isArray(value?.similar) ? value.similar : []
          const hint =
            similar.length > 0
              ? `\n⚠ 与已有记忆高度相似，考虑 memory_update 合并，或用 supersede 推翻旧条：\n${similar
                  .map((item) => `  - ${item.id}（相似 ${Math.round(item.similarity * 100) / 100}）${item.text.slice(0, 60)}`)
                  .join('\n')}`
              : ''
          return [text(`${head}\n${entry?.text ?? ''}\n（占用 ${value?.usedChars ?? 0}/${value?.maxBytes ?? 0} 字符，下一条模型请求起生效）${hint}`)]
        },
      },
      async execute(args) {
        requireWritable()
        const raw = typeof args?.text === 'string' ? args.text.trim() : ''
        if (raw === '') throw new Error('memory_add 需要 text。')
        if (raw.length > MAX_TEXT_CHARS) {
          throw new Error(`单条记忆最多 ${MAX_TEXT_CHARS} 字符，当前 ${raw.length}。请拆成多条或精简。`)
        }
        if (args?.status !== undefined && !MEMORY_STATUS.has(args.status)) {
          throw new Error('status 只能是 draft | stable | deprecated，收到：' + String(args.status))
        }
        if (args?.staleAfter !== undefined && args.staleAfter !== '' && !DATE_ONLY.test(String(args.staleAfter))) {
          throw new Error('staleAfter 需要 YYYY-MM-DD 格式。')
        }
        const duplicate = state.entries.find((entry) => entry.text === raw)
        if (duplicate) {
          let changed = false
          if (args?.pinned === true && !duplicate.pinned) {
            duplicate.pinned = true
            changed = true
          }
          if (typeof args?.status === 'string' && duplicate.status !== args.status) {
            duplicate.status = args.status
            changed = true
          }
          if (typeof args?.staleAfter === 'string' && args.staleAfter !== '' && duplicate.staleAfter !== args.staleAfter) {
            duplicate.staleAfter = args.staleAfter
            changed = true
          }
          if (Array.isArray(args?.sources) && args.sources.length > 0) {
            duplicate.sources = args.sources.filter((item) => typeof item === 'string' && item.trim() !== '')
            changed = true
          }
          if (changed) {
            duplicate.updatedAt = new Date().toISOString()
            persist()
          }
          return { entry: publicEntry(duplicate), deduped: true, usedChars: usedChars(), maxBytes }
        }
        if (usedChars() + raw.length > maxBytes) {
          throw new Error(
            `记忆已占用 ${usedChars()} / ${maxBytes} 字符，再加会超预算。先用 memory_list 看看，用 memory_remove 删掉过时的，或 memory_update 精简。`,
          )
        }
        const now = new Date().toISOString()
        const derivedStale =
          typeof args?.staleAfter === 'string' && args.staleAfter !== ''
            ? ''
            : deriveStaleAfter(typeof args?.kind === 'string' ? args.kind.trim() : '')
        const entry = normalizeEntry({
          id: `m${state.nextId}`,
          text: raw,
          ...(typeof args?.tag === 'string' && args.tag.trim() !== '' ? { tag: args.tag.trim() } : {}),
          ...(Array.isArray(args?.tags) ? { tags: args.tags } : {}),
          ...(Array.isArray(args?.aliases) ? { aliases: args.aliases } : {}),
          ...(typeof args?.scope === 'string' ? { scope: args.scope.trim() } : {}),
          ...(typeof args?.kind === 'string' ? { kind: args.kind.trim() } : {}),
          ...(Number.isFinite(args?.importance) ? { importance: args.importance } : {}),
          ...(args?.pinned === true ? { pinned: true } : {}),
          ...(typeof args?.status === 'string' ? { status: args.status } : {}),
          ...(typeof args?.staleAfter === 'string' && args.staleAfter !== '' ? { staleAfter: args.staleAfter } : {}),
          ...(derivedStale !== '' ? { staleAfter: derivedStale } : {}),
          ...(Array.isArray(args?.sources) ? { sources: args.sources } : {}),
          ...(Array.isArray(args?.workspaces) ? { workspaces: args.workspaces } : {}),
          addedAt: now,
          updatedAt: now,
        })
        // v2.7（A-MEM 邻居演化的零模型版）：写入前找出高度相似的在库条目，把判断权交回模型。
        // 只提示、不自动合并——dsh-memory 一贯原则是「给候选不自动改」。
        const similar = activeEntries()
          .filter((item) => item.text !== raw)
          .map((item) => ({ entry: item, similarity: textSimilarity(item.text, raw) }))
          .filter((item) => item.similarity >= SIMILAR_HINT_FLOOR)
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, MAX_SIMILAR_HINT)
        state.nextId += 1
        state.entries.push(entry)
        persist()
        return {
          entry: publicEntry(entry),
          deduped: false,
          usedChars: usedChars(),
          maxBytes,
          ...(similar.length > 0
            ? {
                similar: similar.map((item) => ({
                  id: item.entry.id,
                  similarity: Math.round(item.similarity * 1000) / 1000,
                  text: item.entry.text,
                })),
              }
            : {}),
        }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'memory_update',
      description: 'Replace the text, the tag, or the pinned flag of one existing memory entry.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Entry id from memory_list, e.g. "m1".' },
          text: { type: 'string', description: `New text (<= ${MAX_TEXT_CHARS} chars).` },
          tag: { type: 'string', description: 'Optional new tag; omit to keep the current one.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional new tags; omit to keep the current ones.' },
          aliases: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional new aliases (synonyms) for retrieval; omit to keep the current ones, empty array clears them.',
          },
          scope: { type: 'string', description: 'Optional new scope (global | plugin-dev | data-infra | dsh-date | machine).' },
          kind: { type: 'string', description: 'Optional new kind (rule | preference | fact | note).' },
          importance: { type: 'integer', minimum: 1, maximum: 10, description: 'Optional new importance 1-10.' },
          pinned: { type: 'boolean', description: 'true pins it to always-injected, false unpins.' },
          status: {
            type: 'string',
            enum: ['draft', 'stable', 'deprecated'],
            description: 'New trust state: draft (unconfirmed), stable (confirmed), deprecated (kept as history, never injected).',
          },
          staleAfter: { type: 'string', description: 'YYYY-MM-DD re-check date; empty string clears it.' },
          sources: { type: 'array', items: { type: 'string' }, description: 'New evidence list; empty array clears it.' },
          workspaces: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute workspace path prefixes (v3.0); empty array clears it so the entry applies everywhere again.',
          },
          verified: {
            type: 'boolean',
            description: 'true = mark as just re-checked (records verifiedAt now); false = clear the verification.',
          },
          supersede: {
            type: 'boolean',
            description: 'true keeps history: create a new entry with the new text and mark the old one superseded (not injected anymore).',
          },
        },
        required: ['id', 'text'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { entry: entrySchema, usedChars: { type: 'integer' }, superseded: { type: 'string' } },
          required: ['entry', 'usedChars'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [text(`已更新 ${value?.entry?.id}：\n${value?.entry?.text ?? ''}\n（占用 ${value?.usedChars ?? 0} 字符）`)]
        },
      },
      async execute(args) {
        requireWritable()
        const id = typeof args?.id === 'string' ? args.id.trim() : ''
        const next = typeof args?.text === 'string' ? args.text.trim() : ''
        if (id === '') throw new Error('memory_update 需要 id。')
        if (next === '') throw new Error('memory_update 需要新的 text；要删除请用 memory_remove。')
        if (next.length > MAX_TEXT_CHARS) throw new Error(`单条记忆最多 ${MAX_TEXT_CHARS} 字符。`)
        const entry = state.entries.find((item) => item.id === id)
        if (!entry) throw new Error(`没有这条记忆：${id}。先用 memory_list 查看。`)
        const projected = usedChars() - entry.text.length + next.length
        if (projected > maxBytes) {
          throw new Error(`更新后会到 ${projected} / ${maxBytes} 字符，超预算。请精简或先删掉别的条目。`)
        }
        if (args?.supersede === true) {
          // 时序失效（Graphiti 式）：新条目生效，旧条目留档不删、不再注入。
          const now = new Date().toISOString()
          const replacement = normalizeEntry({
            id: `m${state.nextId}`,
            text: next,
            ...(entry.tag ? { tag: entry.tag } : {}),
            ...(Array.isArray(entry.tags) ? { tags: entry.tags } : {}),
            ...(typeof entry.scope === 'string' ? { scope: entry.scope } : {}),
            ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}),
            ...(Array.isArray(entry.paths) ? { paths: entry.paths } : {}),
            ...(Array.isArray(entry.workspaces) ? { workspaces: entry.workspaces } : {}),
            ...(entry.pinned ? { pinned: true } : {}),
            ...(typeof entry.migratedFrom === 'string' ? { migratedFrom: entry.migratedFrom } : {}),
            ...(Array.isArray(entry.sources) ? { sources: entry.sources } : {}),
            addedAt: now,
            updatedAt: now,
          })
          state.nextId += 1
          entry.supersededBy = replacement.id
          entry.status = 'deprecated'
          entry.updatedAt = now
          state.entries.push(replacement)
          persist()
          return { entry: publicEntry(replacement), usedChars: usedChars(), superseded: entry.id }
        }
        entry.text = next
        if (typeof args?.tag === 'string' && args.tag.trim() !== '') entry.tag = args.tag.trim()
        if (Array.isArray(args?.tags)) {
          const tags = args.tags.filter((tag) => typeof tag === 'string' && tag !== '')
          if (tags.length > 0) entry.tags = tags
          else delete entry.tags
        }
        if (Array.isArray(args?.aliases)) {
          const aliases = args.aliases.map((alias) => (typeof alias === 'string' ? alias.trim() : '')).filter((alias) => alias !== '')
          if (aliases.length > 0) entry.aliases = aliases
          else delete entry.aliases
        }
        if (typeof args?.scope === 'string' && args.scope.trim() !== '') entry.scope = args.scope.trim()
        if (typeof args?.kind === 'string' && args.kind.trim() !== '') entry.kind = args.kind.trim()
        if (Array.isArray(args?.workspaces)) {
          const workspaces = args.workspaces.filter((item) => typeof item === 'string' && item.trim() !== '')
          if (workspaces.length > 0) entry.workspaces = workspaces
          else delete entry.workspaces
        }
        if (Number.isFinite(args?.importance)) entry.importance = Math.max(1, Math.min(10, Math.round(args.importance)))
        if (typeof args?.status === 'string' && !MEMORY_STATUS.has(args.status)) {
          throw new Error('status 只能是 draft | stable | deprecated，收到：' + String(args.status))
        }
        if (typeof args?.staleAfter === 'string' && args.staleAfter !== '' && !DATE_ONLY.test(args.staleAfter)) {
          throw new Error('staleAfter 需要 YYYY-MM-DD（空串表示清除）。')
        }
        applyEntryFlags(entry, args)
        if (typeof args?.status === 'string') entry.status = args.status
        if (typeof args?.staleAfter === 'string') {
          if (args.staleAfter === '') delete entry.staleAfter
          else entry.staleAfter = args.staleAfter
        }
        if (Array.isArray(args?.sources)) {
          const sources = args.sources.filter((item) => typeof item === 'string' && item.trim() !== '')
          if (sources.length > 0) entry.sources = sources
          else delete entry.sources
        }
        if (args?.verified === true) {
          entry.verifiedBy = 'agent'
          entry.verifiedAt = new Date().toISOString()
        } else if (args?.verified === false) {
          delete entry.verifiedBy
          delete entry.verifiedAt
        }
        entry.updatedAt = new Date().toISOString()
        persist()
        return { entry: publicEntry(entry), usedChars: usedChars() }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'memory_remove',
      description: 'Delete one memory entry by id. Use it to prune stale or wrong facts.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Entry id from memory_list.' } },
        required: ['id'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { id: { type: 'string' }, removed: { type: 'boolean' }, total: { type: 'integer' } },
          required: ['id', 'removed', 'total'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [
            text(
              value?.removed
                ? `已删除 ${value?.id}（剩余 ${value?.total ?? 0} 条，下一条模型请求起生效）`
                : `没有这条记忆：${value?.id}`,
            ),
          ]
        },
      },
      async execute(args) {
        requireWritable()
        const id = typeof args?.id === 'string' ? args.id.trim() : ''
        if (id === '') throw new Error('memory_remove 需要 id。')
        const before = state.entries.length
        state.entries = state.entries.filter((entry) => entry.id !== id)
        const removed = state.entries.length !== before
        if (removed) persist()
        return { id, removed, total: state.entries.length }
      },
    }),
  )

  // ---- 维护：合并（历史留档） + 审计（只读） ----
  ctx.effect(() =>
    tools.register({
      name: 'memory_merge',
      description:
        'Merge two or more active memories into one atomic entry. Originals are kept as superseded history and stop being injected.',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: 'At least two active entry ids.' },
          text: { type: 'string', description: 'Merged text; omit to join the originals with 「；」.' },
          tag: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          scope: { type: 'string' },
          kind: { type: 'string' },
          pinned: { type: 'boolean' },
        },
        required: ['ids'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            entry: entrySchema,
            merged: { type: 'array', items: { type: 'string' } },
            usedChars: { type: 'integer' },
          },
          required: ['entry', 'merged', 'usedChars'],
          additionalProperties: false,
        },
        render(_args, value) {
          const entry = value?.entry
          return [text(`已合并 ${(value?.merged ?? []).join(', ')} → ${entry?.id}\n${entry?.text ?? ''}\n（占用 ${value?.usedChars ?? 0} 字符，旧条目留档不再注入）`)]
        },
      },
      async execute(args) {
        requireWritable()
        const ids = Array.isArray(args?.ids) ? args.ids.filter((id) => typeof id === 'string' && id !== '') : []
        if (ids.length < 2) throw new Error('memory_merge 需要至少两个 id。')
        const sources = ids.map((id) => state.entries.find((item) => item.id === id && isActive(item)))
        if (sources.some((entry) => entry === undefined)) throw new Error('有 id 不存在或已失效，先用 memory_list 确认。')
        const first = sources[0]
        const mergedText =
          typeof args?.text === 'string' && args.text.trim() !== ''
            ? args.text.trim()
            : sources.map((entry) => entry.text.trim()).join('；')
        if (mergedText.length > MAX_TEXT_CHARS) {
          throw new Error(`合并后最多 ${MAX_TEXT_CHARS} 字符（当前 ${mergedText.length}），请精简。`)
        }
        const freed = sources.reduce((sum, entry) => sum + entry.text.length, 0)
        if (usedChars() - freed + mergedText.length > maxBytes) {
          throw new Error(`合并后超预算（上限 ${maxBytes} 字符）。请先精简或删掉别的条目。`)
        }
        const now = new Date().toISOString()
        const merged = normalizeEntry({
          id: `m${state.nextId}`,
          text: mergedText,
          ...(typeof args?.tag === 'string' && args.tag.trim() !== '' ? { tag: args.tag.trim() } : first.tag ? { tag: first.tag } : {}),
          ...(Array.isArray(args?.tags) ? { tags: args.tags } : Array.isArray(first.tags) ? { tags: first.tags } : {}),
          ...(typeof args?.scope === 'string' && args.scope.trim() !== '' ? { scope: args.scope.trim() } : typeof first.scope === 'string' ? { scope: first.scope } : {}),
          ...(typeof args?.kind === 'string' && args.kind.trim() !== '' ? { kind: args.kind.trim() } : typeof first.kind === 'string' ? { kind: first.kind } : {}),
          ...(args?.pinned === true || first.pinned === true ? { pinned: true } : {}),
          addedAt: now,
          updatedAt: now,
        })
        state.nextId += 1
        for (const source of sources) {
          source.supersededBy = merged.id
          source.updatedAt = now
        }
        state.entries.push(merged)
        persist()
        return { entry: publicEntry(merged), merged: ids, usedChars: usedChars() }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'memory_audit',
      description:
        'Read-only audit of the memory store: duplicate candidates, stale never-used entries, usage stats, scope distribution and budget. Use it before pruning.',
      parameters: {
        type: 'object',
        properties: {
          similarity: { type: 'number', description: 'Duplicate threshold 0-1 (default 0.6).' },
          staleDays: { type: 'integer', description: 'Stale = never used and untouched for N days (default 30).' },
          limit: { type: 'integer', description: 'Max rows per list (1-20, default 8).' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            total: { type: 'integer' },
            active: { type: 'integer' },
            archived: { type: 'integer' },
            superseded: { type: 'integer' },
            draft: { type: 'integer' },
            recheck: { type: 'integer' },
            byScope: {
              type: 'array',
              items: {
                type: 'object',
                properties: { scope: { type: 'string' }, count: { type: 'integer' } },
                required: ['scope', 'count'],
                additionalProperties: false,
              },
            },
            duplicates: {
              type: 'array',
              items: {
                type: 'object',
                properties: { ids: { type: 'array', items: { type: 'string' } }, similarity: { type: 'number' } },
                required: ['ids', 'similarity'],
                additionalProperties: false,
              },
            },
            stale: {
              type: 'array',
              items: {
                type: 'object',
                properties: { id: { type: 'string' }, days: { type: 'integer' }, scope: { type: 'string' } },
                required: ['id', 'days'],
                additionalProperties: false,
              },
            },
            mostUsed: {
              type: 'array',
              items: {
                type: 'object',
                properties: { id: { type: 'string' }, usedCount: { type: 'integer' } },
                required: ['id', 'usedCount'],
                additionalProperties: false,
              },
            },
            budget: {
              type: 'object',
              properties: {
                usedChars: { type: 'integer' },
                maxBytes: { type: 'integer' },
                injectedChars: { type: 'integer' },
              },
              required: ['usedChars', 'maxBytes', 'injectedChars'],
              additionalProperties: false,
            },
          },
          required: ['total', 'active', 'superseded', 'archived', 'draft', 'recheck', 'byScope', 'duplicates', 'stale', 'mostUsed', 'budget'],
          additionalProperties: false,
        },
        render(_args, value) {
          const duplicates = Array.isArray(value?.duplicates) ? value.duplicates : []
          const stale = Array.isArray(value?.stale) ? value.stale : []
          const mostUsed = Array.isArray(value?.mostUsed) ? value.mostUsed : []
          const byScope = Array.isArray(value?.byScope) ? value.byScope : []
          const lines = [
            `记忆审计：${value?.total ?? 0} 条（生效 ${value?.active ?? 0} / 失效 ${value?.superseded ?? 0}），占用 ${value?.budget?.usedChars ?? 0}/${value?.budget?.maxBytes ?? 0} 字符，本轮注入 ${value?.budget?.injectedChars ?? 0}`,
            `scope 分布：${byScope.map((item) => `${item.scope} ${item.count}`).join(' / ') || '（空）'}`,
            `重复候选 ${duplicates.length} 组：${duplicates.map((item) => `${item.ids.join('~')}(${item.similarity})`).join(' ') || '无'}`,
            `过期候选 ${stale.length} 条：${stale.map((item) => `${item.id}(${item.days}天)`).join(' ') || '无'}`,
            `信任状态：未证实 ${value?.draft ?? 0} 条 / 过期待重验 ${value?.recheck ?? 0} 条`,
            `（未证实条目在注入时带 ❓，过期待重验带 ⏰；复核后用 memory_update verified:true 清除标记）`,
            `最常用：${mostUsed.map((item) => `${item.id}×${item.usedCount}`).join(' ') || '（还没有使用记录）'}`,
          ]
          return [text(lines.join('\n'))]
        },
      },
      async execute(args) {
        const threshold = typeof args?.similarity === 'number' && args.similarity > 0 && args.similarity <= 1 ? args.similarity : 0.6
        const staleDays = Number.isInteger(args?.staleDays) && args.staleDays > 0 ? args.staleDays : 30
        const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 20) : 8
        const active = activeEntries()
        const bigrams = (value) => {
          const set = new Set()
          const clean = String(value).toLowerCase()
          for (const run of clean.match(/[\u4e00-\u9fff]+/g) ?? []) {
            for (let index = 0; index + 2 <= run.length; index += 1) set.add(run.slice(index, index + 2))
          }
          for (const word of clean.match(/[a-z0-9][a-z0-9_\-.]{2,}/g) ?? []) set.add(word)
          return set
        }
        const shapes = active.map((entry) => ({ entry, grams: bigrams(entry.text) }))
        const duplicates = []
        for (let i = 0; i < shapes.length; i += 1) {
          for (let j = i + 1; j < shapes.length; j += 1) {
            let shared = 0
            for (const gram of shapes[i].grams) if (shapes[j].grams.has(gram)) shared += 1
            const union = shapes[i].grams.size + shapes[j].grams.size - shared
            const similarity = union === 0 ? 0 : shared / union
            if (similarity >= threshold) {
              duplicates.push({ ids: [shapes[i].entry.id, shapes[j].entry.id], similarity: Math.round(similarity * 100) / 100 })
            }
          }
        }
        duplicates.sort((a, b) => b.similarity - a.similarity)
        const nowMs = Date.now()
        const stale = active
          .filter((entry) => entry.pinned !== true && (entry.usedCount ?? 0) === 0)
          .map((entry) => ({
            id: entry.id,
            days: Math.max(0, Math.floor((nowMs - Date.parse(String(entry.updatedAt))) / 86400000)),
            ...(typeof entry.scope === 'string' ? { scope: entry.scope } : {}),
          }))
          .filter((item) => Number.isFinite(item.days) && item.days >= staleDays)
          .sort((a, b) => b.days - a.days)
        const scopeCounts = new Map()
        for (const entry of active) {
          const key = typeof entry.scope === 'string' && entry.scope !== '' ? entry.scope : 'unscoped'
          scopeCounts.set(key, (scopeCounts.get(key) ?? 0) + 1)
        }
        const byScope = [...scopeCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([scope, count]) => ({ scope, count }))
        const mostUsed = active
          .filter((entry) => (entry.usedCount ?? 0) > 0)
          .sort((a, b) => (b.usedCount ?? 0) - (a.usedCount ?? 0))
          .slice(0, limit)
          .map((entry) => ({ id: entry.id, usedCount: entry.usedCount ?? 0 }))
        return {
          total: state.entries.length,
          active: active.length,
          superseded: state.entries.filter(
            (entry) => typeof entry.supersededBy === 'string' && entry.supersededBy !== '',
          ).length,
          archived: state.entries.length - active.length,
          draft: active.filter((entry) => entry.status === 'draft').length,
          recheck: active.filter(
            (entry) => typeof entry.staleAfter === 'string' && entry.staleAfter < new Date().toISOString().slice(0, 10),
          ).length,
          byScope,
          duplicates: duplicates.slice(0, limit),
          stale: stale.slice(0, limit),
          mostUsed,
          budget: { usedChars: usedChars(), maxBytes, injectedChars: renderOnce('').length },
        }
      },
    }),
  )

  // ---- 自动沉淀（影子模式）：回合结束时按规则抓候选，只写候选池，不直接入库 ----
      // ---- v2.8 记忆概览：给人看的视图，不是给模型看的 ----
  // 依据：OpenAI 2026 记忆升级的核心不是模型更聪明，而是把条目摊给用户审（「记忆概览页面」），
  // 其内部数据显示「跨时间准确性」仍是最弱一环。memory_audit 是给模型的，缺的是人能一眼扫完的视图。
  const buildReview = () => {
    const today = new Date().toISOString().slice(0, 10)
    const entries = activeEntries()
    const overdue = entries.filter((entry) => typeof entry.staleAfter === 'string' && DATE_ONLY.test(entry.staleAfter) && entry.staleAfter < today)
    const unverified = entries.filter((entry) => entry.status === 'draft')
    const pinned = entries.filter((entry) => entry.pinned)
    const unused = entries.filter((entry) => entry.pinned !== true && (entry.usedCount ?? 0) === 0)
    const consolidate = entries.filter((entry) => entry.pinned !== true && (entry.usedCount ?? 0) >= CONSOLIDATE_MIN_USES)
    const decaying = entries.filter((entry) => effectiveImportance(entry) < importanceOf(entry) * 0.95)
    const scopeCount = new Map()
    for (const entry of entries) {
      const key = typeof entry.scope === 'string' && entry.scope !== '' ? entry.scope : '（未设）'
      scopeCount.set(key, (scopeCount.get(key) ?? 0) + 1)
    }
    const brief = (entry) => {
      const flat = String(entry.text ?? '').replace(/\s+/g, ' ').trim()
      return flat.length > 60 ? flat.slice(0, 60) + '…' : flat
    }
    const section = (title, list, hint) => [
      '## ' + title + '（' + list.length + ' 条）' + (hint ? ' —— ' + hint : ''),
      ...(list.length === 0
        ? ['（无）']
        : list.map((entry) => '- ' + entry.id + (entry.scope ? ' <' + entry.scope + '>' : '') + ' ' + brief(entry))),
      '',
    ]
    const block = renderOnce('')
    const overBudget = block.length > maxInjectChars
    const md = [
      '# 记忆概览',
      '',
      '生成于 ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' · ' + entries.length + ' 条 · 正文 ' + usedChars() + '/' + maxBytes + ' 字符 · 本轮注入 ' + block.length + '/' + maxInjectChars + (overBudget ? '（超 ' + (block.length - maxInjectChars) + '）' : ''),
      '',
      ...section('⏰ 已过期待重验', overdue, 'memory_update 重验，或 supersede 推倒'),
      ...section('❓ 未证实', unverified, 'memory_update 加 verified:true 确认'),
      ...section('🕸 从未被引用', unused, '考虑 memory_remove 或 memory_merge'),
      ...section('📌 硬规则', pinned, '永远全文注入，改动需谨慎'),
      ...section('⭐ 该升级', consolidate, '被引用 ≥3 次：考虑 memory_update pinned:true 或调高 importance'),
      ...section('📉 衰减中', decaying, '长期未被引用，注入优先级已自动降低（存储值不变）'),
      '## 按 scope',
      ...[...scopeCount.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => '- ' + key + ' ' + count),
      '',
    ].join('\n')
    return { entries, overdue, unverified, unused, pinned, block, overBudget, md }
  }

  ctx.effect(() =>
    tools.register({
      name: 'memory_review',
      description: 'Human-readable review of the memory store (overdue / unverified / never-used / hard rules) written to review-latest.md. Use it when the user asks to clean up or audit memory.',
      parameters: {
        type: 'object',
        properties: {
          write: { type: 'boolean', description: 'Write review-latest.md into the memory directory (default true).' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            written: { type: 'boolean' },
            counts: {
              type: 'object',
              properties: {
                total: { type: 'integer' },
                overdue: { type: 'integer' },
                unverified: { type: 'integer' },
                unused: { type: 'integer' },
                pinned: { type: 'integer' },
              },
              required: ['total', 'overdue', 'unverified', 'unused', 'pinned'],
              additionalProperties: false,
            },
            markdown: { type: 'string' },
          },
          required: ['file', 'written', 'counts', 'markdown'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [text(String(value?.markdown ?? '') + '\n（已写入 ' + String(value?.file ?? '') + '：' + (value?.written ? '是' : '否') + '）')]
        },
      },
      async execute(args) {
        const review = buildReview()
        const file = path.join(storeDir, 'review-latest.md')
        let written = false
        if (args?.write !== false && storeHealth === 'ok') {
          try {
            writeFileSync(file, review.md, 'utf8')
            written = true
          } catch (error) {
            written = false
          }
        }
        return {
          file,
          written,
          counts: {
            total: review.entries.length,
            overdue: review.overdue.length,
            unverified: review.unverified.length,
            unused: review.unused.length,
            pinned: review.pinned.length,
          },
          markdown: review.md,
        }
      },
    }),
  )


  ctx.effect(() =>
    ctx.on('agent/turn-stopping', async (payload) => {
      if (!captureCandidates) return
      try {
        const agent = payload?.agent
        const session = agent?.session
        if (session === undefined || typeof session.deriveMessages !== 'function') return
        const messages = session.deriveMessages()
        const lastUser = [...messages]
          .reverse()
          .find((message) => message?.role === 'user' && Array.isArray(message.content))
        if (lastUser === undefined) return
        const text = lastUser.content
          .filter((part) => part?.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join(' ')
          // v3.1：DSH 会把 <memory> 注入块并进 user 消息，不剥掉就会抓自己的提示语
          // （实测抓出「把它们当背景，不要逐条复述」——记忆自我污染，越确认越蠢）。
          .replace(/<memory>[\s\S]*?<\/memory>/g, ' ')
          .trim()
        if (text === '') return
        const scope = currentScopeOf(payload)
        for (const candidate of extractCandidates(text)) {
          addCandidate(candidate.text, scope, candidate.kind, candidate.reason, agent?.id)
        }
      } catch (error) {
        // 沉淀失败不影响回合结束
      }
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'memory_candidates',
      description:
        'Review rule-captured memory candidates (shadow mode, zero model calls): list pending, accept one into memory, reject one, or clear all pending.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'accept', 'reject', 'clear'], description: 'Default list.' },
          id: { type: 'string', description: 'Candidate id, e.g. c3 (required for accept/reject).' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            pending: { type: 'integer' },
            item: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                text: { type: 'string' },
                scope: { type: 'string' },
                kind: { type: 'string' },
                reason: { type: 'string' },
                createdAt: { type: 'string' },
              },
              required: ['id', 'text'],
              additionalProperties: false,
            },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  scope: { type: 'string' },
                  kind: { type: 'string' },
                  reason: { type: 'string' },
                  createdAt: { type: 'string' },
                },
                required: ['id', 'text'],
                additionalProperties: false,
              },
            },
          },
          required: ['action', 'pending'],
          additionalProperties: false,
        },
        render(_args, value) {
          const items = Array.isArray(value?.items) ? value.items : []
          if (value?.action === 'clear') return [text('已清空候选池。')]
          if (value?.item !== undefined) {
            const verb = value.action === 'accept' ? '已入库' : '已丢弃'
            return [text(`${verb}候选 ${value.item.id}：${value.item.text}\n（剩余待确认 ${value.pending} 条）`)]
          }
          if (items.length === 0) return [text('候选池为空（影子模式：回合结束时按规则抓「记住/以后/别再/一律」这类句子）。')]
          const lines = items.map((item) =>
            `- ${item.id}${item.scope ? ` <${item.scope}>` : ''} (${item.kind ?? 'fact'}) ${item.reason ?? ''} ${item.text}`,
          );
          return [text(`待确认候选 ${value?.pending ?? items.length} 条：\n${lines.join('\n')}`)]
        },
      },
      async execute(args) {
        requireWritable()
        const action = typeof args?.action === 'string' ? args.action : 'list'
        const slim = (item) => ({
          id: item.id,
          text: item.text,
          ...(typeof item.scope === 'string' ? { scope: item.scope } : {}),
          ...(typeof item.kind === 'string' ? { kind: item.kind } : {}),
          ...(typeof item.reason === 'string' ? { reason: item.reason } : {}),
          ...(typeof item.createdAt === 'string' ? { createdAt: item.createdAt } : {}),
        })
        if (action === 'clear') {
          candidates.items = []
          persistCandidates()
          return { action, pending: 0 }
        }
        if (action === 'accept' || action === 'reject') {
          const id = typeof args?.id === 'string' ? args.id.trim() : ''
          const item = candidates.items.find((entry) => entry.id === id && entry.status === 'pending')
          if (item === undefined) throw new Error(`没有待确认的候选：${id}。先用 memory_candidates 查看。`)
          if (action === 'reject') {
            item.status = 'rejected'
            persistCandidates()
            return { action, pending: pendingCandidates().length, item: slim(item) }
          }
          if (usedChars() + item.text.length > maxBytes) {
            throw new Error(`记忆已占用 ${usedChars()} / ${maxBytes} 字符，先清理过时条目再接受。`)
          }
          const now = new Date().toISOString()
          const entry = normalizeEntry({
            id: `m${state.nextId}`,
            text: item.text,
            ...(typeof item.scope === 'string' ? { scope: item.scope } : {}),
            ...(typeof item.kind === 'string' ? { kind: item.kind } : {}),
            tags: ['candidate'],
            addedAt: now,
            updatedAt: now,
          })
          state.nextId += 1
          state.entries.push(entry)
          item.status = 'accepted'
          persist()
          persistCandidates()
          return { action, pending: pendingCandidates().length, item: slim(item) }
        }
        return { action: 'list', pending: pendingCandidates().length, items: pendingCandidates().map(slim) }
      },
    }),
  )
}
