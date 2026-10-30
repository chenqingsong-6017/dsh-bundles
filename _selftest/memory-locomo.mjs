/**
 * memory-locomo.mjs —— 用 LoCoMo（snap-research/locomo）测 dsh-memory 的检索层。
 *
 * 为什么接这个：LoCoMo 是 MemOS / mem0 / Zep 报分数的同一套数据集，
 * 有了它，我们的数字第一次能和外部对齐（虽然口径不同：他们测端到端 F1/LLM-judge，
 * 我们只测检索层的 evidence 命中率，不调模型）。
 *
 * --compare 追加两条朴素基线，用来分账：差距到底来自「我们的打分」还是「数据本身难」。
 *
 * 用法：node _selftest/memory-locomo.mjs [--data <locomo10.json>] [--k 5] [--compare]
 */
import { readFileSync } from 'node:fs'
import { scoreEntries } from '../dsh-memory/index.js'

const argv = process.argv.slice(2)
function arg(name, fallback) {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const DATA = arg('data', 'D:\\AI\\dsh-data\\tmp\\locomo\\data\\locomo10.json')
const K = Number(arg('k', '5'))
const COMPARE = argv.includes('--compare')
const CATEGORY = { 1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop', 5: 'adversarial' }

// ---- 朴素英文 BM25：只用来做对照，不进插件 ----
const STOP = new Set(('a an the and or but if then than that this these those i you he she it we they my your his her its our their is are was were be been being do does did have has had will would can could should may might must not no yes of in on at to for with from by as so such what when where who which how why'.split(' ')))
function rawTerms(text) {
  return (String(text ?? '').toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => t.length > 1 && !STOP.has(t))
}
function rawBm25(entries, query) {
  const docs = entries.map((e) => {
    const arr = rawTerms(e.text)
    const tf = new Map()
    for (const t of arr) tf.set(t, (tf.get(t) ?? 0) + 1)
    return { entry: e, tf, len: arr.length }
  })
  const avg = docs.reduce((s, d) => s + d.len, 0) / (docs.length || 1) || 1
  const q = [...new Set(rawTerms(query))]
  const df = new Map()
  for (const t of q) df.set(t, docs.filter((d) => d.tf.has(t)).length)
  const k1 = 1.2, b = 0.75
  return docs.map((d) => {
    let score = 0
    for (const t of q) {
      const f = d.tf.get(t) ?? 0
      if (!f) continue
      const n = df.get(t) ?? 0
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avg)))
    }
    return { entry: d.entry, score }
  })
}

function buildEntries(conversation) {
  const entries = []
  for (const [key, value] of Object.entries(conversation)) {
    if (!/^session_\d+$/.test(key) || !Array.isArray(value)) continue
    for (const turn of value) {
      if (!turn || !turn.dia_id) continue
      entries.push({ id: turn.dia_id, text: (turn.speaker || '') + ': ' + (turn.text || '') })
    }
  }
  return entries
}

const samples = JSON.parse(readFileSync(DATA, 'utf8'))
const systems = COMPARE
  ? [['dsh-memory', (es, q) => scoreEntries(es, q)], ['raw-bm25', (es, q) => rawBm25(es, q)]]
  : [['dsh-memory', (es, q) => scoreEntries(es, q)]]

for (const [label, ranker] of systems) {
  const stats = new Map()
  let total = 0, hit1 = 0, hitK = 0, rr = 0
  for (const sample of samples) {
    const entries = buildEntries(sample.conversation)
    for (const qa of sample.qa || []) {
      const evidence = Array.isArray(qa.evidence) ? qa.evidence : []
      if (evidence.length === 0) continue
      const ranked = ranker(entries, qa.question).sort((a, b) => b.score - a.score)
      const topK = ranked.slice(0, K).map((r) => r.entry.id)
      const top1 = ranked[0]?.entry.id
      const firstHit = evidence.findIndex((id) => topK.includes(id))
      const rank = ranked.findIndex((r) => evidence.includes(r.entry.id))
      total += 1
      if (top1 && evidence.includes(top1)) hit1 += 1
      if (firstHit >= 0) hitK += 1
      if (rank >= 0) rr += 1 / (rank + 1)
      const c = String(qa.category || 0)
      const s = stats.get(c) || { n: 0, h1: 0, hk: 0 }
      s.n += 1
      if (top1 && evidence.includes(top1)) s.h1 += 1
      if (firstHit >= 0) s.hk += 1
      stats.set(c, s)
    }
  }
  const pct = (a, b) => (b === 0 ? '-' : ((a / b) * 100).toFixed(1) + '%')
  console.log('=== ' + label + ' ===')
  console.log('样本 ' + samples.length + ' · 可评分 QA ' + total + ' · K=' + K)
  console.log('汇总  recall@1 ' + pct(hit1, total) + '  recall@' + K + ' ' + pct(hitK, total) + '  MRR ' + (rr / total).toFixed(3))
  for (const [c, s] of [...stats.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log('  cat' + c + ' ' + (CATEGORY[c] || '?').padEnd(12) + ' n=' + String(s.n).padStart(3) + '  @1 ' + pct(s.h1, s.n).padStart(6) + '  @' + K + ' ' + pct(s.hk, s.n).padStart(6))
  }
  console.log('')
}
