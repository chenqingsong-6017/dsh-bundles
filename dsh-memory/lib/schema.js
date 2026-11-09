/**
 * 条目规范化、schema 迁移与卡片导出。
 *
 * 存储里读出来的任何条目，唯一合法化入口是这里。
 */
import { DATE_ONLY, MAX_ALIASES, MAX_ALIAS_CHARS, MAX_ENTITIES, MAX_ENTITY_CHARS, MAX_SOURCES, SCHEMA_VERSION, SCOPE_SLUG } from './constants.js'
import { localDateOf } from './entry.js'
import { fail, text } from './util.js'

// v3.20：补 archivedAt / archiveReason —— v3.19 的自动归档会写它们，但 normalizeEntry 不认识，
// 结果「load→persist」一轮就把归档时间和原因洗掉（归档历史只剩 status=deprecated 一个标记）。
const OPTIONAL_STRING_FIELDS = [
  'tag',
  'scope',
  'kind',
  'migratedFrom',
  'validFrom',
  'invalidAt',
  'supersededBy',
  'archivedAt',
  'archiveReason',
]

const OPTIONAL_NUMBER_FIELDS = ['usedCount']

// v2.6 信任字段（学 OKF v0.2 / simple-agent-memory）：把「确认的事实」「未证实的猜测」「过期待重验」分开。
// 缺省（旧数据没有这些字段）= 不标注，行为与 v2.5 完全一致，保证向后兼容。
export const MEMORY_STATUS = new Set(['draft', 'stable', 'deprecated'])

export const TRUST_LEGEND =
  '标记含义：❓未证实 = 猜测/未经复核；⏰待重验 = 依赖会变的事实已过复核期；✓已验证 = 有人复核过。'

/**
 * 规范化一条记忆：v1 只有 id/text/tag/pinned，v2 增加 scope/kind/tags/paths/supersededBy/usedCount 等。
 * 关键：**未知字段要保留**，否则 load→persist 一轮就把 v2 字段洗掉了。
 */
/** v3.9：别名清洗（trim / 丢空 / 去重 / 单条 60 字 / 最多 8 条）。normalizeEntry 与去重合并共用同一口径。 */
export function cleanAliases(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const aliases = []
  for (const raw of input) {
    if (typeof raw !== 'string') continue
    const alias = raw.trim().slice(0, MAX_ALIAS_CHARS)
    if (alias === '' || seen.has(alias)) continue
    seen.add(alias)
    aliases.push(alias)
    if (aliases.length >= MAX_ALIASES) break
  }
  return aliases
}

/**
 * v4.1（官方 ADR 的判据）：存储版本高于插件支持版本时**拒绝加载**，不是猜、也不是降级读。
 * 为什么不能照旧用：旧逻辑会按旧字段写回，把高版本的数据静默洗掉（v3.6 别名被旧版本洗掉就是这类事故的最小版）。
 * 错误带 code，调用方据此把「版本太新」和「文件损坏」区分开——前者绝不能改名隔离。
 */
export function schemaTooNewError(from, target) {
  const error = new Error(
    '存储版本 ' + from + ' 高于插件支持的 ' + target + '：请升级 dsh-memory 插件，或把记忆库还原为匹配版本的备份。为避免旧逻辑覆盖新数据，本次拒绝加载。',
  )
  error.code = 'MEMORY_SCHEMA_TOO_NEW'
  error.fromVersion = from
  error.targetVersion = target
  return error
}

/**
 * v4.0（考虑以后）：store schema 迁移。只升不降，老条目形状由 normalizeEntry 补齐，**内容一律不动**。
 * 迁移只写脚本、不手改数据——这是「数据能活过插件重写」的最低保证。
 */
export function migrateState(input, target = SCHEMA_VERSION) {
  const from = Number.isInteger(input?.version) && input.version > 0 ? input.version : 1
  if (from > target) throw schemaTooNewError(from, target)
  if (from === target) return { state: input, from, to: from, changed: false }
  const entries = Array.isArray(input?.entries) ? input.entries.map((entry) => normalizeEntry(entry)) : []
  return { state: { ...input, version: target, entries }, from, to: target, changed: true }
}

/** 键排序的稳定 JSON（P2 迁移回读深比对用：只比内容，不比键序）。 */
export function canonicalJson(value) {
  if (Array.isArray(value)) {
    const parts = []
    for (const item of value) parts.push(canonicalJson(item))
    return '[' + parts.join(',') + ']'
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
    keys.sort()
    const parts = []
    for (const key of keys) parts.push(JSON.stringify(key) + ':' + canonicalJson(value[key]))
    return '{' + parts.join(',') + '}'
  }
  return JSON.stringify(value)
}

/** v4.0：实体标签清洗——去重、截断、限条数。纯字符串，不建实体表。 */
export function cleanEntities(value) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const label = raw.trim().slice(0, MAX_ENTITY_CHARS)
    if (label === '') continue
    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(label)
    if (out.length >= MAX_ENTITIES) break
  }
  return out
}

/**
 * v4.0：来源清洗。约定三种形态（不强制 schema，但渲染与导出按此排序）：
 *   file:line（如 index.js:429）· session:<id> · https://…（URL）
 * 认不出的原样保留——宁可不规范，也不丢证据。
 */
export function cleanSources(value) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const item = raw.trim()
    if (item === '' || seen.has(item)) continue
    seen.add(item)
    out.push(item.slice(0, 400))
    if (out.length >= MAX_SOURCES) break
  }
  return out
}

/** v4.0：scope 规范化——只允许 global 或小写 slug；非法值直接报错（早失败好过脏数据扩散）。 */
export function normalizeScope(value) {
  if (typeof value !== 'string') return ''
  const scope = value.trim().toLowerCase()
  if (scope === '') return ''
  if (scope === 'global') return 'global'
  if (!SCOPE_SLUG.test(scope)) {
    throw fail('MEMORY_SCOPE_INVALID', 'scope 只能是 global 或小写 slug（a-z 开头，可含数字与连字符），收到：' + String(value))
  }
  return scope
}

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
    // v3.9：去重 + 单条截断 + 条数上限。之前不去重也不截断，400 个别名能把库撑到 16 KB 而 usedChars 还报 15（B15）。
    const aliases = cleanAliases(input.aliases)
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
  if (typeof input.softDeadline === 'string' && DATE_ONLY.test(input.softDeadline)) out.softDeadline = input.softDeadline
  if (Array.isArray(input.sources)) {
    const sources = cleanSources(input.sources)
    if (sources.length > 0) out.sources = sources
  }
  if (Array.isArray(input.entities)) {
    const entities = cleanEntities(input.entities)
    if (entities.length > 0) out.entities = entities
  }
  if (input.pinned === true) out.pinned = true
  // v3.23：inject:false = 只检索、不注入（事实/历史类条目用）。缺省等于 true。
  if (input.inject === false) out.inject = false
  if (typeof input.lastUsedAt === 'string' && input.lastUsedAt !== '') out.lastUsedAt = input.lastUsedAt
  // v4.2：procedure 的复用证据必须在白名单里，否则 load→persist 一轮就被洗掉（v3.20 archivedAt 同款坑）。
  if (Number.isInteger(input.verifiedCount) && input.verifiedCount >= 0) out.verifiedCount = input.verifiedCount
  if (typeof input.lastVerifiedAt === 'string' && input.lastVerifiedAt !== '') out.lastVerifiedAt = input.lastVerifiedAt
  out.addedAt = typeof input.addedAt === 'string' ? input.addedAt : new Date().toISOString()
  out.updatedAt = typeof input.updatedAt === 'string' ? input.updatedAt : new Date().toISOString()
  return out
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
    // v3.23：输出 schema 必须同步声明，否则 memory_list 会整条 rejecting（v3.20 踩过同一个坑）。
    inject: { type: 'boolean' },
    lastUsedAt: { type: 'string' },
    addedAt: { type: 'string' },
    updatedAt: { type: 'string' },
    status: { type: 'string' },
    // v3.20 修 v3.19 的漏声明：自动归档会写这两个字段，schema 不声明的话工具层会整条拒绝
    // （实测：库里只要有一条自动归档的记忆，memory_list 直接报 invalid output）。
    archivedAt: { type: 'string' },
    archiveReason: { type: 'string' },
    staleAfter: { type: 'string' },
    verifiedBy: { type: 'string' },
    verifiedAt: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
    paths: { type: 'array', items: { type: 'string' } },
    workspaces: { type: 'array', items: { type: 'string' } },
    aliases: { type: 'array', items: { type: 'string' } },
    // v4.0：实体标签（纯字符串）与失效时刻（对齐双时间戳里可用的那一半）。
    entities: { type: 'array', items: { type: 'string' } },
    invalidAt: { type: 'string' },
    softDeadline: { type: 'string' },
    // v4.2：procedure 的复用证据（Voyager「验证过才入库」；只在 kind=procedure 时写）。
    verifiedCount: { type: 'integer' },
    lastVerifiedAt: { type: 'string' },
  },
  required: ['id', 'text', 'addedAt', 'updatedAt'],
  additionalProperties: false,
}

/**
 * v3.16 卡片导出：把一条记忆渲染成 Obsidian 兼容的 Markdown 卡片。
 * 学自 dsh-viya-memory（MIT）的核心长板——记忆应该是人能看见、手改的文件，
 * 而不是只有 agent 才读得到的 JSON。JSON 仍是权威存储（检索 / 预算 / 基准一律不动），
 * 这里只做单向镜像，不参与检索与注入。
 */
/** v4.0：YAML 标量安全引号——路径含反斜杠、URL 含冒号，裸写会被解析坏。 */
function yamlScalar(value) {
  return '"' + String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

export function cardMarkdown(entry, today = localDateOf()) {
  const lines = ['---']
  lines.push('id: ' + entry.id)
  if (typeof entry.kind === 'string' && entry.kind !== '') lines.push('kind: ' + entry.kind)
  if (typeof entry.tag === 'string' && entry.tag !== '') lines.push('tag: ' + entry.tag)
  if (Array.isArray(entry.tags) && entry.tags.length > 0) lines.push('tags: [' + entry.tags.join(', ') + ']')
  if (typeof entry.scope === 'string' && entry.scope !== '') lines.push('scope: ' + entry.scope)
  if (entry.pinned) lines.push('pinned: true')
  if (Number.isInteger(entry.importance)) lines.push('importance: ' + entry.importance)
  if (typeof entry.status === 'string' && entry.status !== '') lines.push('status: ' + entry.status)
  if (typeof entry.staleAfter === 'string' && entry.staleAfter !== '') {
    lines.push('staleAfter: ' + entry.staleAfter)
    if (entry.staleAfter < today) lines.push('recheck: true')
  }
  if (typeof entry.verifiedAt === 'string' && entry.verifiedAt !== '') lines.push('verifiedAt: ' + entry.verifiedAt)
  // v4.2：procedure 的复用证据也要导出（否则换机器就丢了「验证过几次」）。
  if (Number.isInteger(entry.verifiedCount) && entry.verifiedCount > 0) lines.push('verifiedCount: ' + entry.verifiedCount)
  if (typeof entry.lastVerifiedAt === 'string' && entry.lastVerifiedAt !== '') lines.push('lastVerifiedAt: ' + entry.lastVerifiedAt)
  if (typeof entry.supersededBy === 'string' && entry.supersededBy !== '') lines.push('supersededBy: ' + entry.supersededBy)
  if (Number.isInteger(entry.usedCount) && entry.usedCount > 0) lines.push('usedCount: ' + entry.usedCount)
  if (typeof entry.addedAt === 'string' && entry.addedAt !== '') lines.push('created: ' + entry.addedAt.slice(0, 10))
  if (typeof entry.updatedAt === 'string' && entry.updatedAt !== '') lines.push('updated: ' + entry.updatedAt.slice(0, 10))
  if (Array.isArray(entry.aliases) && entry.aliases.length > 0) lines.push('aliases: [' + entry.aliases.join(', ') + ']')
  // v4.0：把「以后」需要的字段一起导出去（sources/entities/invalidAt/workspaces）——
  // 导出物是脱离 DSH 也能读的资产，字段不全等于将来迁移时丢信息。
  if (typeof entry.invalidAt === 'string' && entry.invalidAt !== '') lines.push('invalidAt: ' + entry.invalidAt)
  if (typeof entry.softDeadline === 'string' && entry.softDeadline !== '') lines.push('softDeadline: ' + entry.softDeadline)
  if (Array.isArray(entry.entities) && entry.entities.length > 0) {
    lines.push('entities:')
    for (const entity of entry.entities) lines.push('  - ' + yamlScalar(entity))
  }
  if (Array.isArray(entry.workspaces) && entry.workspaces.length > 0) {
    lines.push('workspaces:')
    for (const workspace of entry.workspaces) lines.push('  - ' + yamlScalar(workspace))
  }
  if (Array.isArray(entry.sources) && entry.sources.length > 0) {
    lines.push('sources:')
    for (const source of entry.sources) lines.push('  - ' + yamlScalar(source))
  }
  lines.push('---', '', String(entry.text ?? ''), '')
  return lines.join('\n')
}

/** 文件名 slug：保留中英文数字，其余压成连字符；太长截断。 */
export function slugOf(input, fallback = 'card') {
  const slug = String(input ?? '')
    .trim()
    .replace(/[^\u4e00-\u9fffA-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
  return slug === '' ? fallback : slug.replace(/-+$/g, '') || fallback
}
