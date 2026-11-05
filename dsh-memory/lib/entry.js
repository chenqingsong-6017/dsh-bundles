/**
 * 条目模型：时效、重要性、作用域。
 *
 * 只管「一条记忆在某一刻算什么状态」，不碰存储与渲染。
 */
import { DATE_ONLY, DEFAULT_SCOPE_ROOTS, IMPORTANCE_BASE, KIND_REFERENCE, RECENCY_DECAY_PER_HOUR, REFERENCE_STALE_DAYS } from './constants.js'

/** 只写日期的字段（staleAfter / invalidAt）→ 本地日历日零点的毫秒时间戳；非法返回 NaN。 */
function localDayStart(stamp) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(stamp))
  if (parts === null) return NaN
  return new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), 0, 0, 0, 0).getTime()
}

/** 待复核判据：staleAfter 走本地日历日字符串比较，与 invalidAt 同一口径（本地日）。 */
export function isStaleEntry(entry, today = localDateOf()) {
  return typeof entry?.staleAfter === 'string' && DATE_ONLY.test(entry.staleAfter) && entry.staleAfter < today
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
export function isInvalidEntry(entry, now = Date.now()) {
  const raw = typeof entry?.invalidAt === 'string' ? entry.invalidAt.trim() : ''
  if (raw === '') return false
  const stamp = DATE_ONLY.test(raw) ? localDayStart(raw) : Date.parse(raw)
  return Number.isFinite(stamp) && stamp <= now
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
