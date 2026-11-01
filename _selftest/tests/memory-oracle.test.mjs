/**
 * dsh-memory scoreEntries 打分排序 oracle + 确定性故障注入。
 *
 * 为什么有它：验证门只查语法/结构；BM25 权重改错（alias / tag / 扩展词 / 时效降权）不会红。
 * 依据：DualPipe 的 reference-implementation equivalence（naive BM25 参考实现逐条对拍）
 *      + smallpond 的确定性数据校验 + 确定性故障注入（坏数据只降级、不抛异常）。
 *
 * 被测：dsh-memory/index.js 的 scoreEntries(entries, query)（index.js:1133-1164）；
 *      tokenize（index.js:1014）与 expandQuery（index.js:1114）当作给定输入。
 * 参考：naiveScore 独立写出 BM25 加权公式，常量对齐 index.js:1069-1075
 *      （k1=1.2 / b=0.75 / tag×2 / alias×2.5 / 扩展×0.2 / 过期×0.55）。
 * 确定性：样本全是字面量；过期样本用 2000-01-01（永远是过去时），无随机、无 now 参与断言值。
 */
import assert from 'node:assert/strict'
import { expandQuery, isStaleEntry, localDateOf, scoreEntries, tokenize } from '../../dsh-memory/index.js'

const started = Date.now()
let passed = 0
const ok = (label) => {
  passed += 1
  console.log('  ✓ ' + label)
}
const close = (left, right, eps = 1e-12) => Math.abs(left - right) <= eps

const BM25 = { k1: 1.2, b: 0.75, tag: 2, alias: 2.5, expansion: 0.2, stale: 0.55 }

/** naive 参考实现：按字节语义复刻 bm25Doc 的字段收集，但公式自己写一遍。 */
function naiveDoc(entry) {
  const tagText = Array.isArray(entry.tags) && entry.tags.length > 0 ? entry.tags.join(' ') : (entry.tag ?? '')
  const aliasText = Array.isArray(entry.aliases) ? entry.aliases.join(' ') : ''
  const entityText = Array.isArray(entry.entities) ? entry.entities.join(' ') : ''
  const terms = tokenize('' + entry.text + ' ' + tagText + ' ' + aliasText + ' ' + entityText)
  let length = 0
  for (const count of terms.values()) length += count
  return { entry, terms, length, tagText: String(tagText).toLowerCase(), aliasTerms: new Set(tokenize(aliasText).keys()) }
}

/** naive 参考实现：BM25（IDF + 长度归一）+ tag/alias/扩展词加权 + 过期降权。 */
function naiveScore(entries, query) {
  const docs = (Array.isArray(entries) ? entries : []).map(naiveDoc)
  if (docs.length === 0) return []
  const queryTerms = tokenize(query)
  const expansion = expandQuery(query)
  if (queryTerms.size === 0 && expansion.size === 0) return docs.map((doc) => ({ entry: doc.entry, score: 0 }))
  const weights = new Map()
  for (const term of queryTerms.keys()) weights.set(term, 1)
  for (const [term, weight] of expansion) if (!weights.has(term)) weights.set(term, weight)
  const totalLength = docs.reduce((sum, doc) => sum + doc.length, 0)
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
      const tagBoost = doc.tagText.includes(term) ? BM25.tag : 1
      const aliasBoost = doc.aliasTerms.has(term) ? BM25.alias : 1
      const tf = (frequency * (BM25.k1 + 1)) / (frequency + BM25.k1 * (1 - BM25.b + (BM25.b * doc.length) / avgLength))
      score += weight * tagBoost * aliasBoost * idf * tf
    }
    if (isStaleEntry(doc.entry, today)) score *= BM25.stale
    return { entry: doc.entry, score }
  })
}

// ---- 1) 固定样本矩阵：7 条条目 × 6 组查询，与 naive 参考实现逐条等价 ----
const MATRIX_DOCS = [
  { id: 'd1', text: 'alpha beta gamma' },
  { id: 'd2', text: 'alpha delta' },
  { id: 'd3', text: 'bravo echo', tags: ['alpha'] },
  { id: 'd4', text: 'foxtrot', aliases: ['alpha'] },
  { id: 'd5', text: 'golf hotel india' },
  { id: 'd6', text: 'alpha juliet', staleAfter: '2000-01-01' },
  { id: 'd7', text: 'kilo lima', entities: ['alpha'] },
]
const MATRIX_QUERIES = ['alpha', 'alpha bravo', 'zeta', '', null, 'how are you']
for (const query of MATRIX_QUERIES) {
  const got = scoreEntries(MATRIX_DOCS, query)
  const want = naiveScore(MATRIX_DOCS, query)
  assert.equal(got.length, want.length, '结果条数不一致 query=' + String(query))
  for (let i = 0; i < got.length; i += 1) {
    assert.equal(got[i].entry, want[i].entry, '返回顺序 / entry 引用被改 query=' + String(query))
    assert.ok(
      close(got[i].score, want[i].score),
      'query=' + String(query) + ' id=' + got[i].entry.id + ' 分数不一致 ' + got[i].score + ' vs ' + want[i].score,
    )
  }
}
ok('固定样本矩阵：6 组查询 × 7 条条目与 naive BM25 参考实现逐条等价')

// ---- 2) 权重规则：alias ×2.5 > tag ×2 > 正文 ×1 > 同义扩展 ×0.2 ----
{
  const scoreOf = (docs, query, id) => scoreEntries(docs, query).find((item) => item.entry.id === id).score

  const aliasDocs = [{ id: 'alias', text: 'alpha', aliases: ['zeta'] }, { id: 'plain', text: 'zeta' }]
  assert.ok(scoreOf(aliasDocs, 'zeta', 'alias') > scoreOf(aliasDocs, 'zeta', 'plain'), 'alias 命中应高于正文命中')
  ok('权重规则 1：aliases 命中（×2.5）排在正文命中（×1）之前')

  const tagDocs = [{ id: 'tag', text: 'alpha', tags: ['zeta'] }, { id: 'plain2', text: 'zeta' }]
  assert.ok(scoreOf(tagDocs, 'zeta', 'tag') > scoreOf(tagDocs, 'zeta', 'plain2'), 'tag 命中应高于正文命中')
  ok('权重规则 2：tags 命中（×2）排在正文命中（×1）之前')

  const bothDocs = [{ id: 'alias2', text: 'alpha', aliases: ['zeta'] }, { id: 'tag2', text: 'alpha', tags: ['zeta'] }]
  assert.ok(scoreOf(bothDocs, 'zeta', 'alias2') > scoreOf(bothDocs, 'zeta', 'tag2'), 'alias 命中应高于 tag 命中')
  ok('权重规则 3：aliases ×2.5 > tags ×2')

  const expandDocs = [{ id: 'text-hit', text: 'registry notes' }, { id: 'expansion-hit', text: 'hklm notes' }]
  const textHit = scoreOf(expandDocs, 'registry', 'text-hit')
  const expansionHit = scoreOf(expandDocs, 'registry', 'expansion-hit')
  assert.ok(close(expansionHit / textHit, BM25.expansion, 1e-9), '扩展词权重应恰好是 0.2 倍')
  ok('权重规则 4：同义扩展词权重 0.2（registry 查询下 hklm 命中 = 正文命中的 1/5）')
}

// ---- 3) BM25 结构规则：多词累加、IDF 压常见词 ----
{
  const multi = [
    { id: 'both', text: 'alpha bravo' },
    { id: 'only-alpha', text: 'alpha delta' },
    { id: 'only-bravo', text: 'bravo delta' },
  ]
  const scores = Object.fromEntries(scoreEntries(multi, 'alpha bravo').map((item) => [item.entry.id, item.score]))
  assert.ok(scores.both > scores['only-alpha'], '两个词都命中的分数应更高')
  assert.ok(scores.both > scores['only-bravo'], '两个词都命中的分数应更高')
  assert.ok(close(scores['only-alpha'], scores['only-bravo']), '同长度、同 IDF 的单命中应同分')
  ok('BM25 规则 1：查询多词命中按词累加，单命中同分')

  const idfDocs = [
    { id: 'common', text: 'alpha bravo' },
    { id: 'rare', text: 'alpha zeta' },
    { id: 'c2', text: 'alpha charlie' },
    { id: 'c3', text: 'alpha delta' },
    { id: 'c4', text: 'alpha echo' },
  ]
  const idfScores = Object.fromEntries(scoreEntries(idfDocs, 'alpha zeta').map((item) => [item.entry.id, item.score]))
  assert.ok(idfScores.rare > idfScores.common, '命中稀有词的条目应排在只命中常见词的前面')
  ok('BM25 规则 2：IDF 压常见词（alpha 出现在全部条目，zeta 只出现在 1 条）')
}

// ---- 4) 时效降权：过期条目不丢、但分数 ×0.55 ----
{
  const staleDocs = [
    { id: 'fresh', text: 'alpha beta' },
    { id: 'old', text: 'alpha beta', staleAfter: '2000-01-01' },
  ]
  assert.equal(isStaleEntry(staleDocs[1], localDateOf()), true, '样本必须真的被判定为过期')
  const scored = Object.fromEntries(scoreEntries(staleDocs, 'alpha').map((item) => [item.entry.id, item.score]))
  assert.ok(scored.old < scored.fresh, '过期条目应排在新鲜条目之后')
  assert.ok(close(scored.old / scored.fresh, BM25.stale, 1e-12), '过期降权应恰好是 0.55 倍')
  ok('时效降权：staleAfter 已过的条目分数 ×0.55，仍可检索不丢失')
}

// ---- 5) 空输入 / 空查询：返回 [] 或 0 分，不抛异常 ----
{
  assert.deepEqual(scoreEntries([], 'alpha'), [])
  for (const bad of [null, undefined, 'oops', 42, {}]) assert.deepEqual(scoreEntries(bad, 'alpha'), [])
  assert.deepEqual(scoreEntries([{ id: 'x', text: 'alpha' }], 'zeta').map((item) => item.score), [0])
  assert.deepEqual(scoreEntries([{ id: 'x', text: 'alpha' }], 'how are you').map((item) => item.score), [0])
  assert.deepEqual(scoreEntries([{ id: 'x', text: 'alpha' }], null).map((item) => item.score), [0])
  ok('空输入 / 非数组 entries / 无命中 / 纯停用词查询 → 返回 [] 或 0 分，不抛异常')
}

// ---- 6) 确定性故障注入：缺字段 / 坏类型条目只降级，不抛异常 ----
// 覆盖生产实现明确兜住的类型：text 缺失或非字符串会被 String 化，tags/aliases/entities 非数组会被忽略，
// staleAfter 非字符串 / 非日期不参与过期降权。
// 已知缺口（本轮不改插件，只记录）：null / undefined 条目、tag 传非字符串仍会抛 TypeError
// （index.js:1078 读 entry.tags、index.js:1085 tagText.toLowerCase），修复属插件侧改动。
{
  const injected = [
    { id: 'good', text: 'alpha solid' },
    {},
    { id: 'null-text', text: null },
    { id: 'num-text', text: 42 },
    { id: 'array-text', text: ['alpha'] },
    { id: 'str-tags', text: 'alpha', tags: 'not-an-array' },
    { id: 'str-aliases', text: 'alpha', aliases: 'not-an-array', entities: {} },
    { id: 'mixed-tags', text: 'alpha', tags: [null, 123] },
    { id: 'bad-stale', text: 'alpha', staleAfter: 12345 },
    { id: 'bad-stale2', text: 'alpha', staleAfter: 'not-a-date' },
  ]
  let results
  assert.doesNotThrow(() => {
    results = scoreEntries(injected, 'alpha')
  }, '混入坏类型条目后 scoreEntries 不应抛异常')
  assert.equal(results.length, injected.length, '坏条目也要逐条返回结果，不能静默丢')
  for (let i = 0; i < results.length; i += 1) {
    assert.equal(results[i].entry, injected[i], '第 ' + i + ' 条结果应指回原条目对象')
    assert.equal(typeof results[i].score, 'number', '第 ' + i + ' 条分数应是数字')
    assert.ok(Number.isFinite(results[i].score), '第 ' + i + ' 条分数应是有限数（NaN/Infinity 算事故）')
  }
  assert.ok(results[0].score > 0, '混入坏条目后正常条目仍应被正常打分')
  assert.equal(results[1].score, 0, '空对象条目降级为 0 分')
  assert.equal(results[2].score, 0, 'text=null 条目降级为 0 分')
  assert.equal(results[3].score, 0, 'text=数字 条目降级为 0 分')
  ok('故障注入：10 条坏数据混排 → 逐条返回有限分数，正常条目不受伤，不抛异常')

  for (const badQuery of [null, 123, {}, []]) {
    let scored
    assert.doesNotThrow(() => {
      scored = scoreEntries([{ id: 'q', text: 'alpha' }], badQuery)
    }, '查询非字符串不应抛异常')
    assert.equal(scored.length, 1)
    assert.ok(Number.isFinite(scored[0].score), '查询坏类型时应降级为有限分数')
  }
  ok('故障注入：查询传 null / 数字 / 对象 / 数组 → 降级为有限分数，不抛异常')
}

// ---- 7) 确定性：同一输入两次调用结果完全一致 ----
{
  const first = scoreEntries(MATRIX_DOCS, 'alpha bravo')
  const again = scoreEntries(MATRIX_DOCS, 'alpha bravo')
  assert.deepEqual(again, first)
  ok('确定性：同一固定输入两次调用结果完全一致')
}

console.log('\nmemory-oracle: ' + passed + ' 项通过（' + (Date.now() - started) + 'ms）')
