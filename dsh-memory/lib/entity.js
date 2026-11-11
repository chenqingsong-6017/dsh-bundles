/**
 * dsh-memory 实体解析 v4.10（entity resolution）
 *
 * 问题：entities 是手动标签，「Alice」和「我的同事 Alice」是两个实体，
 * entityIndex 的倒排被写法差异打散——图长不起来。
 *
 * 前沿对照（Hindsight/Mem0 的写入时实体解析），按本机约束降级：
 * 1. 确定性规范化：剥离中文/英文称谓前缀（我的同事X -> X），空白/标点归一。
 * 2. 显式别名表：state.entityAliases[canonical] = [alias...]，写入时替换、检索时展开。
 * 3. 疑似重复只提示、不自动合并（相似度/包含关系 -> 候选，agent/人确认后 merge）——
 *    自动合并不确定的东西会误伤（「大肥鱼」!=「大黄鱼」）。
 *
 * 图是派生视图：这些函数只读 entries + aliases，不建第二权威源。
 */

/** 中文称谓前缀（长的优先，剥离后取名字）。 */
const CN_PREFIXES = [
  '我的同事', '我同事', '我的老板', '我老板', '我的老师', '我老师',
  '我的领导', '我领导', '我的朋友', '我朋友', '我的客户', '我客户',
  '我的老大', '我老大', '我的导师', '我导师',
  '同事', '老板', '领导', '老师', '朋友', '客户', '老大', '导师',
]

/** 英文称谓前缀。 */
const EN_PREFIXES = [
  /^my\s+(?:coworker|colleague|boss|manager|friend|teacher|client|mentor)\s+/i,
  /^(?:coworker|colleague|boss|manager|friend|teacher|client|mentor)\s+/i,
]

/**
 * 规范化实体标签：剥掉称谓前缀，去掉首尾空白。
 * @param {unknown} label
 * @returns {string} 规范化后的标签；非字符串/空串返回 ''
 */
export function normalizeEntity(label) {
  if (typeof label !== 'string') return ''
  let s = label.trim()
  if (s === '') return ''
  for (const re of EN_PREFIXES) {
    const next = s.replace(re, '')
    if (next !== s) {
      s = next.trim()
      break
    }
  }
  for (const p of CN_PREFIXES) {
    if (s.startsWith(p) && s.length > p.length) {
      const next = s.slice(p.length).trim()
      if (next !== '') {
        s = next
        break
      }
    }
  }
  return s
}

/**
 * 比较用的归一 key：小写 + 去掉空白/连字符/下划线/点。
 * @param {unknown} label
 * @returns {string}
 */
export function entityKey(label) {
  return normalizeEntity(label).toLowerCase().replace(/[\s\-_.]+/g, '')
}

/**
 * 从别名表建「别名 key -> canonical」映射。
 * @param {Record<string, string[]> | undefined} aliases
 * @returns {Map<string, string>}
 */
export function buildAliasMap(aliases) {
  const map = new Map()
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) return map
  for (const [canonical, list] of Object.entries(aliases)) {
    const canonicalText = String(canonical).trim()
    if (canonicalText === '') continue
    map.set(entityKey(canonicalText), canonicalText)
    if (Array.isArray(list)) {
      for (const alias of list) {
        if (typeof alias !== 'string' || alias.trim() === '') continue
        map.set(entityKey(alias), canonicalText)
      }
    }
  }
  return map
}

/**
 * 写入路径：规范化 + 别名表解析 + 去重。
 * @param {unknown} labels 模型给的实体标签数组
 * @param {Record<string, string[]> | undefined} aliases
 * @returns {string[]} canonical 实体列表
 */
export function resolveEntities(labels, aliases) {
  if (!Array.isArray(labels)) return []
  const aliasMap = buildAliasMap(aliases)
  const out = []
  const seen = new Set()
  for (const raw of labels) {
    if (typeof raw !== 'string') continue
    const norm = normalizeEntity(raw)
    if (norm === '') continue
    const canonical = aliasMap.get(entityKey(norm)) ?? norm
    const key = entityKey(canonical)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(canonical)
  }
  return out
}

/**
 * 检索路径：给定查询标签，展开成「等价 key 集合」（canonical + 所有别名）。
 * @param {unknown} label
 * @param {Record<string, string[]> | undefined} aliases
 * @returns {Set<string>} 归一 key 集合（用于比对 entry.entities）
 */
export function expandEntityKeys(label, aliases) {
  const keys = new Set()
  const norm = normalizeEntity(label)
  if (norm === '') return keys
  keys.add(entityKey(norm))
  const aliasMap = buildAliasMap(aliases)
  const canonical = aliasMap.get(entityKey(norm))
  if (canonical !== undefined) {
    keys.add(entityKey(canonical))
    const list = aliases && Array.isArray(aliases[canonical]) ? aliases[canonical] : []
    for (const alias of list) {
      if (typeof alias === 'string' && alias.trim() !== '') keys.add(entityKey(alias))
    }
  }
  return keys
}

/** bigram 相似度（与 harvest/skill-forge 同口径，纯函数可单测）。 */
export function bigramSimilarity(left, right) {
  const a = String(left ?? '')
  const b = String(right ?? '')
  if (a === '' || b === '') return 0
  const setOf = (s) => {
    const set = new Set()
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2))
    return set
  }
  const sa = setOf(a)
  const sb = setOf(b)
  if (sa.size === 0 || sb.size === 0) return 0
  let hit = 0
  for (const gram of sa) if (sb.has(gram)) hit += 1
  return hit / Math.max(sa.size, sb.size)
}

/**
 * 疑似重复实体候选：只提示、不自动合并。
 * 判据：归一 key 相似度 >= threshold，或一方完整包含另一方（且较短一方 >= 2 字符）。
 * @param {Array} entries
 * @param {{ threshold?: number, limit?: number }} [options]
 * @returns {Array<{a: string, b: string, similarity: number, reason: string}>}
 */
export function findAliasCandidates(entries, options = {}) {
  const threshold = typeof options.threshold === 'number' ? options.threshold : 0.85
  const limit = Number.isInteger(options.limit) ? options.limit : 20
  const counts = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!Array.isArray(entry?.entities)) continue
    for (const raw of entry.entities) {
      const norm = normalizeEntity(raw)
      if (norm === '') continue
      const key = entityKey(norm)
      if (key === '') continue
      if (!counts.has(key)) counts.set(key, { label: norm, count: 0 })
      counts.get(key).count += 1
    }
  }
  const keys = [...counts.keys()]
  const candidates = []
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const left = keys[i]
      const right = keys[j]
      const short = Math.min(left.length, right.length)
      if (short < 2) continue
      const sim = bigramSimilarity(left, right)
      // contains 判据要收紧（2026-11-11 真机暴露）：
      // 「Strata」vs「D:\AI\Strata」是同一事物的两种写法（名字 vs 路径）→ 该提示；
      // 「DSH」vs「dsh-memory」、「memory」vs「dsh-memory」是复合词 → 不该提示。
      // 判据：长词去掉短词后，若只剩路径/分隔/标点，才算「同物写法差异」。
      let containReason = ''
      if (left.includes(right) || right.includes(left)) {
        const shorter = left.length <= right.length ? left : right
        const longer = shorter === left ? right : left
        // 同物写法：短词在长词「尾部」，且前缀是路径（含 / \ : 或空白）。
        // 例：「D:\AI\Strata」前缀「D:\AI\」含 \ 与 : → 是写法差异；
        //    「dsh-memory」前缀「dsh-」不含路径字符 → 复合词，不算同物。
        if (longer.endsWith(shorter)) {
          const prefix = longer.slice(0, longer.length - shorter.length)
          if (/[\\/:\s]/.test(prefix)) containReason = 'contains'
        }
      }
      if (sim >= threshold || containReason !== '') {
        candidates.push({
          a: counts.get(left).label,
          b: counts.get(right).label,
          similarity: Math.round(sim * 100) / 100,
          reason: containReason !== '' ? 'contains' : 'similar',
        })
      }
    }
  }
  return candidates.sort((x, y) => y.similarity - x.similarity).slice(0, limit)
}

/**
 * 实体健康度：总数、覆盖条目、Top 实体、疑似重复数。
 * @param {Array} entries
 * @param {Record<string, string[]> | undefined} aliases
 */
export function entityStats(entries, aliases) {
  const list = Array.isArray(entries) ? entries : []
  const index = new Map()
  for (const entry of list) {
    if (!Array.isArray(entry?.entities)) continue
    for (const raw of entry.entities) {
      const norm = normalizeEntity(raw)
      if (norm === '') continue
      // 归一 key：Alice / alice / ALICE 必须算同一实体（v4.10 修）
      const key = entityKey(norm)
      if (!index.has(key)) index.set(key, { label: norm, ids: new Set() })
      index.get(key).ids.add(entry.id)
    }
  }
  const withEntities = list.filter((entry) => Array.isArray(entry?.entities) && entry.entities.length > 0).length
  const aliasCount = aliases && typeof aliases === 'object' && !Array.isArray(aliases)
    ? Object.values(aliases).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0)
    : 0
  return {
    entities: index.size,
    entriesWithEntities: withEntities,
    entries: list.length,
    aliasCount,
    candidates: findAliasCandidates(list, { limit: 10 }).length,
    top: [...index.values()]
      .sort((a, b) => b.ids.size - a.ids.size)
      .slice(0, 10)
      .map((item) => ({ entity: item.label, entries: item.ids.size })),
  }
}
