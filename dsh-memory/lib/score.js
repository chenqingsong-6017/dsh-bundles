/**
 * 检索打分与注入门槛。
 *
 * BM25 + 内容单元覆盖率 + 两道放行判定；不碰存储。
 */
import { BM25_ALIAS_WEIGHT, BM25_B, BM25_K1, BM25_TAG_WEIGHT, RELEVANCE_FLOOR, RELEVANCE_FLOOR_AGREE, RELEVANCE_SINGLE_WORD_FLOOR_LONG, RELEVANCE_SINGLE_WORD_FLOOR_SHORT, STALE_PENALTY } from './constants.js'
import { isStaleEntry, localDateOf } from './entry.js'
import { text } from './util.js'
import { contentUnitsOf, expandQuery, queryClauses, tokenize } from './text.js'

const idfOf = (total, hit) => Math.log(1 + (total - hit + 0.5) / (hit + 0.5))

/**
 * 查询词的 idf 总和：v2.3–v3.7 的「相关覆盖率」分母（含 unigram，片段会三重计数）。
 * v3.8 起门槛不再用它（改用 relevanceCoverage 的内容单元口径），保留给旧测试与对照分析。
 */
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

/* v4.1（P2.2 前置）：bm25Doc 结果按条目对象缓存。
 * 为什么：benchmark 实测 10000 条时「完整搜索」319ms，其中约 90% 是每轮重新 tokenize + 重建词表 Map；
 * df/idf/长度归一这些**公式**一行不动，只是把这部分重复劳动缓存起来。
 * 失效口径：用 text/tag/tags/aliases/entities 拼出签名，签名变了就重算（WeakMap 跟随条目对象生命周期）。
 * 注意：返回的 terms Map 由缓存共享，调用方（scoreEntries / 排序 / 注入渲染）都只读。 */
const BM25_DOC_CACHE = new WeakMap()

function bm25DocSignature(entry) {
  const tagText = Array.isArray(entry.tags) && entry.tags.length > 0 ? entry.tags.join(' ') : entry.tag ?? ''
  const aliasText = Array.isArray(entry.aliases) ? entry.aliases.join(' ') : ''
  const entityText = Array.isArray(entry.entities) ? entry.entities.join(' ') : ''
  return String(entry.text ?? '') + '\u0000' + tagText + '\u0000' + aliasText + '\u0000' + entityText
}

function buildBm25Doc(entry, signature) {
  const parts = signature.split('\u0000')
  const text = parts[0] ?? ''
  const tagText = parts[1] ?? ''
  const aliasText = parts[2] ?? ''
  const entityText = parts[3] ?? ''
  const terms = tokenize(`${text} ${tagText} ${aliasText} ${entityText}`)
  let length = 0
  for (const count of terms.values()) length += count
  return { entry, terms, length, tagText: tagText.toLowerCase(), aliasTerms: new Set(tokenize(aliasText).keys()) }
}

export function bm25Doc(entry) {
  if (entry === null || typeof entry !== 'object') return buildBm25Doc(entry, '')
  const signature = bm25DocSignature(entry)
  const cached = BM25_DOC_CACHE.get(entry)
  if (cached !== undefined && cached.signature === signature) return cached.doc
  const doc = buildBm25Doc(entry, signature)
  BM25_DOC_CACHE.set(entry, { signature, doc })
  return doc
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
  const today = localDateOf()
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
    // v3.19 时效降权：过了 staleAfter 的条目仍然可检索（不丢信息），但排序压到后面。
    // 依据 arXiv 2610.36308 —— 过时版本干扰是记忆检索的主要错误源（证据预算越大反而越差）。
    if (isStaleEntry(doc.entry, today)) score *= STALE_PENALTY
    return { entry: doc.entry, score }
  })
}

/**
 * 严格打分：只用原查询词，**不加** alias 权重、**不做**同义扩展。
 * v3.8 起**相关性门槛不再用它**（改用 relevanceCoverage 的内容单元口径）；保留给排序对照与单测。
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

/**
 * v3.11 门槛判定（纯函数，便于单测）。
 * 主条件：覆盖率 ≥ floor（0.16，单指标）。
 * 放宽条件：**双信号一致**（覆盖率 top1 == 排序层 top1）+ 至少命中 2 个内容单元 + 覆盖率 ≥ 0.07。
 * 依据：72 正例 / 35 负例实测，单指标 56/72 且 0 负例；放宽到「只要求一致」64/72 但会放过
 * 「电脑为什么会蓝屏」这类单字假命中；再加「≥2 单元」正好 60/72 且负例 0 —— 白赚 4 个真命中。
 */
export function gateDecision({ coverage, matchedUnits, matchedDf, unitCount, agreeWithRanking, rankEvidence, floor = RELEVANCE_FLOOR }) {
  const units = Array.isArray(matchedUnits) ? matchedUnits.length : 0
  // v3.12：单单元匹配的「证据不足」护栏。
  // 词级切分让分母变小，单个词的命中就能把覆盖率顶到 0.3 以上 —— 实测负例
  // 「电脑为什么会蓝屏」只命中「电脑」一次（该词在整库只出现 1 条）就到 0.3482，
  // 而「已推荐未批准」那条让「推荐一部好看的电影」只命中「推荐」也到 0.33。
  // 规则：**只命中 1 个单元**、该单元在语料里 df ≤ 1、且覆盖率不到 0.40 → 不放行。
  // 依据：35 条负例里单单元命中的最高覆盖率 0.3482；74 条正例里靠单单元过门的（Hermes 0.435、
  // 两个工作区 0.4013）都在 0.40 以上。
  // 分两档：查询越短，单单元命中越像巧合，要求越高。
  //   短查询（≤2 单元）：0.40 —— 实测正例「技能是怎么生成的」单命中 0.4379 能过，
  //     负例「电脑为什么会蓝屏」单命中 0.3296 被挡住；
  //   长查询（≥3 单元）：0.25 —— 合成负例「推荐一部好看的电影」对上「已推荐未批准」是 0.2321，
  //     被挡住；长句正例里单命中的真实命中都在 0.25 以上（只有 1 条 0.2046 的会掉，见 README v3.12）。
  const queryUnits = Number.isInteger(unitCount) ? unitCount : 99
  const singleWordFloor = queryUnits <= 2 ? RELEVANCE_SINGLE_WORD_FLOOR_SHORT : RELEVANCE_SINGLE_WORD_FLOOR_LONG
  // v3.13：护栏判的是**实际要注入的那条**（排序层 top1）的证据，不是覆盖率 top 的证据。
  // 起因：长句「做新插件之前…」的覆盖率 top 是无关条目（单命中「重复」），而排序 top 正是期望记忆（命中 2 个单元）——
  // 按覆盖率 top 判会把整条查询挡掉。没传 rankEvidence 时退回覆盖率 top（纯函数单测仍按旧口径可测）。
  const rankUnits = Number.isInteger(rankEvidence?.units) ? rankEvidence.units : units
  const rankDf = Array.isArray(rankEvidence?.matchedDf) ? rankEvidence.matchedDf : matchedDf
  // 覆盖率用整体 coverage（与主条件同一个数），只有「命中单元数/df」取排序 top 的 ——
  // 别用 byId：它是另一套归一（实测 Hermes 那条 coverage 0.2757 而 byId 0.1538，会把真命中挡掉）。
  const rankCoverage = coverage
  // v3.13：单单元护栏按「要注入的那条」判，不按覆盖率 top
  if (rankUnits === 1 && Array.isArray(rankDf) && rankDf[0] <= 1 && rankCoverage < singleWordFloor) {
    return { pass: false, relaxed: false }
  }
  if (coverage >= floor) return { pass: true, relaxed: false }
  const relaxed = agreeWithRanking === true && units >= 2 && coverage >= RELEVANCE_FLOOR_AGREE
  return { pass: relaxed, relaxed }
}

/* v4.1（P2.2 前置）：覆盖率层的条目词表同样缓存（口径与 relevanceCoverage 原实现完全一致：text + tag，不含 aliases）。 */
const CONTENT_DOC_CACHE = new WeakMap()

function contentDocSignature(entry) {
  const tagText = Array.isArray(entry.tags) && entry.tags.length > 0 ? entry.tags.join(' ') : entry.tag ?? ''
  return String(entry.text ?? '') + '\u0000' + tagText
}

function buildContentDoc(entry, signature) {
  const parts = signature.split('\u0000')
  const text = parts[0] ?? ''
  const tagText = parts[1] ?? ''
  const terms = new Map()
  let length = 0
  for (const unit of contentUnitsOf(`${text} ${tagText}`)) {
    terms.set(unit, (terms.get(unit) ?? 0) + 1)
    length += 1
  }
  return { entry, terms, length }
}

function contentDoc(entry) {
  if (entry === null || typeof entry !== 'object') return buildContentDoc(entry, '')
  const signature = contentDocSignature(entry)
  const cached = CONTENT_DOC_CACHE.get(entry)
  if (cached !== undefined && cached.signature === signature) return cached.doc
  const doc = buildContentDoc(entry, signature)
  CONTENT_DOC_CACHE.set(entry, { signature, doc })
  return doc
}

export function relevanceCoverage(entries, query) {
  const list = Array.isArray(entries) ? entries : []
  const clauses = queryClauses(query)
  if (clauses.length > 1) {
    // 分句取最大：每句单独算，谁最相关用谁（并合并 byId，供相关层同尺判断）。
    let best = { coverage: 0, topId: null, matchedUnits: [], matchedDf: [], docMatched: new Map(), byId: new Map() }
    const merged = new Map()
    for (const clause of clauses) {
      const part = relevanceCoverage(list, clause)
      for (const [id, value] of part.byId) merged.set(id, Math.max(merged.get(id) ?? 0, value))
      if (part.coverage > best.coverage) best = { ...part, byId: merged }
    }
    return { ...best, byId: merged }
  }
  const docs = list.map((entry) => contentDoc(entry))
  const queryUnits = [...new Set(contentUnitsOf(query))]
  if (docs.length === 0 || queryUnits.length === 0) return { coverage: 0, topId: null, matchedUnits: [], matchedDf: [], docMatched: new Map() }
  let totalLength = 0
  for (const doc of docs) totalLength += doc.length
  const avgLength = totalLength / docs.length || 1
  const df = new Map()
  let denominator = 0
  for (const unit of queryUnits) {
    const hit = docs.filter((doc) => doc.terms.has(unit)).length
    df.set(unit, hit)
    denominator += idfOf(docs.length, hit)
  }
  let best = 0
  let topId = null
  let matchedUnits = []
  let matchedDf = []
  // v3.13：每条文档各自命中了哪些单元（供护栏按「要注入的那条」判证据，而不是只按覆盖率 top）。
  const docMatched = new Map()
  for (const doc of docs) {
    let score = 0
    const matched = []
    for (const unit of queryUnits) {
      const frequency = doc.terms.get(unit) ?? 0
      if (frequency === 0) continue
      matched.push(unit)
      score +=
        idfOf(docs.length, df.get(unit)) *
        ((frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / avgLength)))
    }
    if (matched.length > 0) docMatched.set(doc.entry.id, { units: matched, matchedDf: matched.map((unit) => df.get(unit) ?? 0) })
    if (score > best) {
      best = score
      topId = doc.entry.id
      matchedUnits = matched
      // v3.12：把命中单元的 df 一起带出去，供 gateDecision 判「单单元证据够不够」。
      matchedDf = matched.map((unit) => df.get(unit) ?? 0)
    }
  }
  // v3.9：分子带 BM25 的 tf 饱和与长度归一，短条目 + 高频词会让比值超过 1（实测 1.42–1.95）。
  // 「覆盖率」语义上不可能超过 100%，这里封顶；对判定没有影响（>1 本来就已经过门）。
  const ratio = denominator > 0 ? best / denominator : 0
  // byId：每条记忆自己的覆盖率，供相关层「同尺」判断（v3.9 / A2）。
  const byId = new Map()
  for (const doc of docs) {
    let own = 0
    for (const unit of queryUnits) {
      const frequency = doc.terms.get(unit) ?? 0
      if (frequency === 0) continue
      own +=
        Math.min(1, (frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / avgLength))) *
        idfOf(docs.length, df.get(unit))
    }
    byId.set(doc.entry.id, denominator > 0 ? Math.min(1, own / denominator) : 0)
  }
  return { coverage: Math.min(1, ratio), topId, matchedUnits, matchedDf, unitCount: queryUnits.length, docMatched, byId }
}

/** 单条打分（兼容旧签名）；传 options.entries 就能用上跨条目的 IDF。 */
export function scoreMemory(entry, query, options) {
  const corpus = Array.isArray(options?.entries) && options.entries.length > 0 ? options.entries : null
  const all = corpus === null ? [entry] : corpus.includes(entry) ? corpus : [...corpus, entry]
  const found = scoreEntries(all, query).find((item) => item.entry === entry)
  return found === undefined ? 0 : found.score
}
