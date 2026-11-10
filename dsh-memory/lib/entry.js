/**
 * 条目模型：时效、重要性、作用域。
 *
 * 只管「一条记忆在某一刻算什么状态」，不碰存储与渲染。
 */
import { CURATOR_STALE_GRACE_DAYS, DATE_ONLY, DEFAULT_SCOPE_ROOTS, IMPORTANCE_BASE, KIND_REFERENCE, RECENCY_DECAY_PER_HOUR, REFERENCE_STALE_DAYS } from './constants.js'

/** 只写日期的字段（staleAfter / invalidAt）→ 本地日历日零点的毫秒时间戳；非法返回 NaN。 */
function localDayStart(stamp) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(stamp))
  if (parts === null) return NaN
  return new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), 0, 0, 0, 0).getTime()
}

/** 待复核判据：staleAfter 走本地日历日字符串比较，与 invalidAt 同一口径（本地日）。 */
export function isStaleEntry(entry, today = localDateOf()) {
  if (typeof entry?.staleAfter === 'string' && DATE_ONLY.test(entry.staleAfter) && entry.staleAfter < today) return true
  // v4.5：软期限（softDeadline）到期也算「该复核」——对齐 Graphiti「软期限不算 invalid_at」（edges.py:281-284）。
  // 目标/计划日期过了，不代表事实失效（不隐藏），只降权提示该检查进度，与 invalidAt 硬失效严格区分。
  if (typeof entry?.softDeadline === 'string' && DATE_ONLY.test(entry.softDeadline) && entry.softDeadline < today) return true
  return false
}

/**
 * Hermes 判断机制（对齐 curator.py「use_count==0 是 absence of evidence」）：
 * 一条生效记忆该不该被「自动淘汰」（预算腾挪时归档），给出一个**可排序的信号**，而不是拿「从未命中」一刀切。
 *
 * 信号按可辩护性降序（rank 越小越该先淘汰）：
 *   rank 0  stale —— staleAfter 已过（该复核却没复核），是确定性「到期未验证」信号；
 *   rank 1  never-used —— usedCount=0 只是「没证据」，不是「该淘汰」，只能垫底（且由调用方用 minAge 把关才准参与）；
 *   rank 2  none —— 都不满足，本轮不该动它。
 *
 * 为什么：Hermes 明令「'use=0' is NOT a reason to PRUNE」（curator.py:334-338），
 * 我们旧逻辑把 usedCount=0 当成唯一淘汰信号，正是这条反模式。改用 stale（确定性）优先、never-used（旁证）垫底。
 */
export function eliminationSignal(entry, today = localDateOf()) {
  if (isStaleEntry(entry, today)) {
    return { signal: 'stale', rank: 0, reason: 'staleAfter ' + entry.staleAfter + ' 已过（到期未复核）' }
  }
  if ((entry?.usedCount ?? 0) === 0) {
    return { signal: 'never-used', rank: 1, reason: '从未被检索命中（无证据，仅预算垫底）' }
  }
  return { signal: 'none', rank: 2, reason: '' }
}

/**
 * v4.4 curator 归档判据（纯函数，供维护循环与单测复用）。
 * 对齐 Hermes curator 的「active→stale→archived」确定性迁移，但只做「stale→archived」这一跳：
 *   - active→stale 已由 deriveStaleAfter / isStaleEntry 表达（写入即设 staleAfter，到期即 stale）；
 *   - 这里只判「已经 stale 的，过了宽限期还没人复核也没人用 → 归档」。
 *
 * 活跃豁免：宽限期（CURATOR_STALE_GRACE_DAYS）内 lastUsedAt 被刷新过的条目不归档。
 *   理由：stale 只是「到期该复核」，不是「该扔」；还在被检索命中的事实大概率仍为真，误杀损失大。
 *   没有 lastUsedAt 的（从未命中）回退到 updatedAt / addedAt。
 */
export function curationDecision(entry, today = localDateOf(), now = Date.now()) {
  if (!isStaleEntry(entry, today)) return { archive: false, reason: '' }
  const ref = entry?.lastUsedAt ?? entry?.updatedAt ?? entry?.addedAt
  const stamp = Date.parse(String(ref ?? ''))
  if (Number.isFinite(stamp) && now - stamp < CURATOR_STALE_GRACE_DAYS * 86400000) {
    return { archive: false, reason: 'stale 但宽限期内仍被使用/更新，活跃豁免' }
  }
  return { archive: true, reason: `staleAfter ${entry.staleAfter} 已过且 ${CURATOR_STALE_GRACE_DAYS} 天未使用未复核` }
}

/**
 * v3.20：一条记忆算不算「归档」——被取代（supersededBy）或显式 deprecated。
 * 从 v3.3 起 activeEntries 就是这个口径，这里提成模块级函数，给「归档分文件冷存」复用，
 * 避免两处判断漂移（历史教训：只判 supersededBy 时 deprecated 条目仍算生效，预算虚高）。
 */
export function isArchivedEntry(entry) {
  return (
    (typeof entry?.supersededBy === 'string' && entry.supersededBy !== '') ||
    entry?.status === 'deprecated' ||
    isInvalidEntry(entry)
  )
}

/**
 * v4.0：一条记忆是否「已失效」——invalidAt 到了。
 * 对齐 Graphiti 双时间戳里真正有用的那一半（valid_from/invalid_to），但不引入任何实体/边：
 * 一条事实「从某天起不再成立」照样能表达，旧条目留档不删（可反查历史）。
 *
 * v4.0.1 口径统一（扫描 #12）：只写 `YYYY-MM-DD` 时按**本地日历日零点**解释，不再按 `T00:00:00Z`。
 * 原来两种口径并存：staleAfter 走本地日（localDateOf 字符串比较）、invalidAt 走 UTC 日；
 * 北京时间 00:00–08:00 期间「当日失效」的条目仍会被注入和检索到（UTC 零点 = 本地 8 点）。
 * 现在两者都以本地日历为准，语义差异只剩一条、且是刻意的：
 *   - invalidAt：**当地日期当天零点起**不再成立（"从哪天起失效"）；
 *   - staleAfter：**到该日期当天为止**仍有效，次日本地零点起才算待重验（"哪天该复核"）。
 * 测试用「本地 00:30」这种构造钉住，不依赖跑测试的钟点。
 */
/** 统一解析「YYYY-MM-DD 或 ISO 时间」为毫秒时间戳；非法/空返回 NaN。DATE_ONLY 走本地日历日零点（与 invalidAt 同口径）。 */
export function parseTimestamp(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') return NaN
  return DATE_ONLY.test(raw) ? localDayStart(raw) : Date.parse(raw)
}

export function isInvalidEntry(entry, now = Date.now()) {
  const stamp = parseTimestamp(entry?.invalidAt)
  return Number.isFinite(stamp) && stamp <= now
}
/**
 * v4.6：一条记忆是否「尚未生效」——validFrom 还没到。
 * bi-temporal 的事件时间起点（对齐 Graphiti/memv 的 valid_at）：
 * 计划/预约/未来才成立的事实，在 validFrom 之前不注入、不检索，到了才「生效」。
 * 与 invalidAt（终点）配对，构成完整事件时间区间 [validFrom, invalidAt)。
 */
export function isNotYetValid(entry, now = Date.now()) {
  const stamp = parseTimestamp(entry?.validFrom)
  return Number.isFinite(stamp) && stamp > now
}

/**
 * v4.6：在 atTime 这个时点，这条事实是否为真（事件时间判据）。
 * 区间 [validFrom, invalidAt)：validFrom 已到（或没设）且 invalidAt 未到（或没设）。
 * 点时间查询（memory_search at_time）与注入/检索过滤共用这一条，避免三处判断漂移。
 */
export function isTrueAt(entry, atTime = Date.now()) {
  return !isNotYetValid(entry, atTime) && !isInvalidEntry(entry, atTime)
}

const normalizePath = (value) => String(value ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

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

/**
 * 按 kind 推导 staleAfter（v2.8）。
 * 依据：OpenAI 2026 记忆架构升级里，事实回忆 82.8%、偏好遵循 71.3%，而「跨时间准确性」只有 75.1%
 * ——时间失效是全行业最弱的一环，靠人工记得填 staleAfter 不现实。
 * 取舍：rule / preference 是长期约定，不设（设了反而天天报警）；fact 90 天；note 30 天。
 * 只对新写入生效，存量条目不动（避免一次性给 63 条补上今天的日期）。
 */
export function deriveStaleAfter(kind, base = new Date()) {
  const days = kind === 'fact' ? 90 : kind === 'note' ? 30 : kind === KIND_REFERENCE ? REFERENCE_STALE_DAYS : 0
  if (days === 0) return ''
  return localDateOf(new Date(base.getTime() + days * 86400000))
}

/**
 * v3.9：日期一律走本地日历。
 * 原来 toISOString().slice(0,10) 取的是 UTC 日期，于是同一条事实「90 天后过期」
 * 会取决于当天几点写：本地 0:30 写得到前一天，9:00 写得到当天（B12）。
 */
export function localDateOf(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
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

/**
 * v4.7：实体索引（图作为派生视图，不是权威存储）。
 * 从 entries 的 entities 标签派生「实体 → 记忆 id 集合」的倒排。零模型、零图库：
 * 实体标签就是节点，记忆就是承载边。taxonomy 的教训：图是索引，不另起权威源。
 */
export function entityIndex(entries) {
  const index = new Map()
  for (const entry of entries) {
    if (!Array.isArray(entry?.entities) || entry.entities.length === 0) continue
    for (const entity of entry.entities) {
      if (typeof entity !== 'string' || entity.trim() === '') continue
      const key = entity.trim()
      if (!index.has(key)) index.set(key, new Set())
      index.get(key).add(entry.id)
    }
  }
  return index
}

/**
 * v4.7：实体共现——给定实体，返回和它出现在同一记忆里的其他实体（按共现频次降序）。
 * 这是「图遍历」的零模型版：不做语义关系，只做「共享记忆」的共现统计。
 * 与 entityIndex 合起来就是「节点 → 邻接」的最小图视图。
 */
export function entityCoccur(entries, target) {
  const result = new Map()
  const targetKey = String(target ?? '').trim()
  if (targetKey === '') return result
  for (const entry of entries) {
    if (!Array.isArray(entry?.entities)) continue
    const entities = [...new Set(entry.entities.map((e) => String(e).trim()).filter((e) => e !== ''))]
    if (!entities.includes(targetKey)) continue
    for (const peer of entities) {
      if (peer === targetKey) continue
      result.set(peer, (result.get(peer) ?? 0) + 1)
    }
  }
  return result
}

/**
 * v4.8：用户画像视图——把「关于用户的稳定事实」按槽位聚合。
 * 零模型版 Memobase typed taxonomy：slot 是主题（identity/preference/habit/environment/taboo/goal/milestone）。
 * 读路径纯内存聚合、不碰 LLM；返回 { slot: [text, ...] }，按槽位分组。
 */
export function profileView(entries) {
  const result = {}
  for (const entry of entries) {
    if (typeof entry?.slot !== 'string' || entry.slot === '') continue
    if (!Array.isArray(result[entry.slot])) result[entry.slot] = []
    result[entry.slot].push(entry.text)
  }
  return result
}
