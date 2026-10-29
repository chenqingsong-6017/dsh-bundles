#!/usr/bin/env node
// 真实库微基准：30+ 正例 / 6 负例，输出 recall@k、MRR、注入了多少、负例有没有硬注入。
// 用法：node _selftest/memory-bench.mjs [--json] [--store <path>] [--cases <path>]
import { readFileSync } from 'node:fs'
import { renderMemory, scoreEntries } from '../dsh-memory/index.js'

const args = process.argv.slice(2)
const jsonOut = args.includes('--json')
const pick = (flag, fallback) => { const index = args.indexOf(flag); return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback }
const STORE = pick('--store', 'D:/AI/dsh-data/memory/memory.json')
const CASES = pick('--cases', new URL('./memory-bench-cases.json', import.meta.url).pathname.replace(/^\//, ''))
const BUDGET = 1500

const store = JSON.parse(readFileSync(STORE, 'utf8'))
const cases = JSON.parse(readFileSync(CASES, 'utf8'))
const entries = store.entries
const active = entries.filter((entry) => typeof entry.supersededBy !== 'string')
const scorable = active.filter((entry) => entry.pinned !== true)
const pinnedIds = new Set(active.filter((entry) => entry.pinned === true).map((entry) => entry.id))
const byId = new Map(entries.map((entry) => [entry.id, entry]))
const RETIRED = new Set(['deprecated', 'archived'])

/**
 * 期望 id 可能已经被合并/取代（supersededBy 链），也可能彻底废弃。
 * 沿链解析到「当前生效」的那条；链尾已废弃 → 返回 null，该用例作废。
 * 2026-10-29：在此之前基准不跟随取代链，36 条正例里有 27 条目标指向已取代/废弃 id，
 * 永远不可能命中——把 recall 报成 30.6%，是基准过期，不是检索差。
 */
function resolveExpected(id) {
  const seen = new Set()
  let current = byId.get(id)
  while (current && current.supersededBy && !seen.has(current.id)) {
    seen.add(current.id)
    current = byId.get(current.supersededBy)
  }
  if (!current) return null
  if (RETIRED.has(current.status)) return null
  return current.id
}

const rows = []
let recall1 = 0, recall3 = 0, reciprocal = 0, injectedHit = 0, chars = 0
let retired = 0
for (const item of cases.positives) {
  const expected = [...new Set(item.expected.map(resolveExpected).filter(Boolean))]
  if (expected.length === 0) {
    retired += 1
    continue
  }
  const scored = scoreEntries(scorable, item.query)
    .filter((hit) => hit.score > 0.0001)
    .sort((a, b) => b.score - a.score)
  const ids = scored.slice(0, 3).map((hit) => hit.entry.id)
  const pinnedExpected = expected.filter((id) => pinnedIds.has(id))
  const rank = ids.findIndex((id) => expected.includes(id)) + 1
  const hit = pinnedExpected.length > 0 || rank > 0
  if (pinnedExpected.length > 0) { recall1 += 1; recall3 += 1; reciprocal += 1 }
  else {
    if (rank === 1) recall1 += 1
    if (rank > 0) { recall3 += 1; reciprocal += 1 / rank }
  }
  const block = renderMemory(entries, { maxInjectChars: BUDGET, query: item.query })
  chars += block.length
  const injected = pinnedExpected.length > 0 || expected.some((id) => block.includes(`(${id})`) || block.includes(` ${id} `));
  if (injected) injectedHit += 1
  rows.push({ query: item.query, expected, top3: ids, rank, pinnedExpected: pinnedExpected.length > 0, injected, chars: block.length });
}

let negativeInjected = 0
const negativeRows = []
for (const query of cases.negatives) {
  const block = renderMemory(entries, { maxInjectChars: BUDGET, query })
  const relevant = Number((block.match(/相关 (\d+)/) ?? [])[1] ?? 0)
  // 负例只看「有没有被判定为相关并注入全文」；索引行与 pinned 硬规则是设计上常驻的，不算误注入。
  const injected = relevant > 0
  if (injected) negativeInjected += 1
  negativeRows.push({ query, relevant, chars: block.length });
}

const total = rows.length
const metrics = {
  positives: total,
  retired,
  negatives: cases.negatives.length,
  recallAt1: +(recall1 / total).toFixed(3),
  recallAt3: +(recall3 / total).toFixed(3),
  mrr: +(reciprocal / total).toFixed(3),
  injectedCoverage: +(injectedHit / total).toFixed(3),
  negativeInjectionRate: +(negativeInjected / cases.negatives.length).toFixed(3),
  avgInjectedChars: Math.round(chars / total),
  budget: BUDGET,
}

if (jsonOut) {
  console.log(JSON.stringify({ metrics, positives: rows, negatives: negativeRows }, null, 2))
  process.exit(0)
}

console.log('记忆微基准（' + store.entries.length + ' 条存储 / ' + active.length + ' 条生效 / 预算 ' + BUDGET + '）' + (retired > 0 ? ' —— 作废 ' + retired + ' 条（目标记忆已废弃）' : ''))
console.log('')
for (const row of rows) {
  const mark = row.rank > 0 || row.pinnedExpected ? '✅' : '❌'
  console.log(`${mark} ${row.query.padEnd(26)} top3=${(row.top3.join(',') || '-').padEnd(14)} rank=${row.rank || (row.pinnedExpected ? 'P' : '-')} 注入=${row.injected ? 'Y' : 'N'} ${row.chars}字`)
}
console.log('')
for (const row of negativeRows) {
  const mark = row.relevant > 0 ? '⚠️' : '✅'
  console.log(`${mark} 负例 ${row.query.padEnd(26)} 相关=${row.relevant} ${row.chars}字`)
}
console.log('')
console.log(`recall@1 ${(metrics.recallAt1 * 100).toFixed(1)}% | recall@3 ${(metrics.recallAt3 * 100).toFixed(1)}% | MRR ${metrics.mrr}`)
console.log(`注入覆盖 ${(metrics.injectedCoverage * 100).toFixed(1)}% | 负例误注入 ${(metrics.negativeInjectionRate * 100).toFixed(1)}% | 平均 ${metrics.avgInjectedChars} 字符`)
