#!/usr/bin/env node
// 长自然句基准（v3.10）：模拟真实用户消息（寒暄 / 从句 / 铺垫词）。
// 短问法基准测不出「长句把覆盖率稀释掉」这类问题，所以单列一套。
// 用法：node _selftest/memory-bench-long.mjs
import { readFileSync } from 'node:fs'
import { renderMemory, relevanceCoverage } from '../dsh-memory/index.js'

const store = JSON.parse(readFileSync('D:/AI/dsh-data/memory/memory.json', 'utf8'))
const entries = store.entries
const corp = entries.filter((e) => typeof e.supersededBy !== 'string' && e.pinned !== true)
const byId = new Map(entries.map((e) => [e.id, e]))
// v3.13：pinned 条目永远全文在场，不该算「没召回」。短问法基准一直是这样算的（pinnedExpected → 直接算命中），
// 长句基准漏了这一条，实测把「快捷方式改名」(m19) 和「文件放哪个盘」(m1) 两条 pinned 目标误报成失败。
const pinnedIds = new Set(entries.filter((e) => e.pinned === true).map((e) => e.id))
const RETIRED = new Set(['deprecated', 'archived'])
const resolve = (id) => {
  const seen = new Set()
  let cur = byId.get(id)
  while (cur && cur.supersededBy && !seen.has(cur.id)) {
    seen.add(cur.id)
    cur = byId.get(cur.supersededBy)
  }
  if (!cur) return null
  return RETIRED.has(cur.status) ? null : cur.id
}
const cases = JSON.parse(readFileSync(new URL('./memory-bench-long.json', import.meta.url).pathname.replace(/^\//, ''), 'utf8'))

let full = 0
let total = 0
console.log('长句正例：')
for (const item of cases.positives) {
  const expected = [...new Set(item.expected.map(resolve).filter(Boolean))]
  if (expected.length === 0) continue
  total += 1
  const stats = {}
  renderMemory(entries, { maxInjectChars: 1500, query: item.query, stats })
  const r = relevanceCoverage(corp, item.query)
  const pinnedExpected = expected.filter((id) => pinnedIds.has(id))
  const hit = pinnedExpected.length > 0 || expected.some((id) => (stats.relevant ?? []).includes(id))
  if (hit) full += 1
  console.log(
    (hit ? '✅' : '❌') + ' cov=' + r.coverage.toFixed(4) + ' top=' + String(r.topId).padEnd(5) +
    ' 相关=' + JSON.stringify(stats.relevant) + ' 期望=' + expected.join(',') + ' | ' + item.query.slice(0, 26),
  )
}

let negBad = 0
console.log('\n长句负例：')
for (const q of cases.negatives) {
  const block = renderMemory(entries, { maxInjectChars: 1500, query: q })
  const relevant = Number((block.match(/相关 (\d+)/) ?? [])[1] ?? 0)
  if (relevant > 0) negBad += 1
  console.log((relevant > 0 ? '⚠️' : '✅') + ' cov=' + relevanceCoverage(corp, q).coverage.toFixed(4) + ' 相关=' + relevant + ' | ' + q.slice(0, 30))
}

console.log('\n长句全文相关 ' + full + '/' + total + ' = ' + ((100 * full) / total).toFixed(1) + '% | 长句负例误注入 ' + negBad + '/' + cases.negatives.length)
