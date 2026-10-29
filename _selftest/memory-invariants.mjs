
// dsh-memory 不变量检查（Lead 自查工具，不在验证门里）
// 用法：node _selftest/memory-invariants.mjs
// 覆盖：渲染不超预算 / 结构合法 / 统计不重复 / 确定性 / 覆盖率在 [0,1] / 脏条目不崩。
import { readFileSync } from 'node:fs'
import { renderMemory, relevanceCoverage, contentUnitsOf } from '../dsh-memory/index.js'

const store = JSON.parse(readFileSync('D:/AI/dsh-data/memory/memory.json', 'utf8'))
const entries = store.entries
const problems = []
const note = (kind, detail) => problems.push({ kind, detail })

const queries = [
  '插件', '重启', '交接', 'memory_audit 的别名覆盖怎么看', 'AGENTS.md 里对调研优先级怎么规定',
  '我的回复要带什么称呼', '大肥鱼这个称呼是什么', '换电脑之后哪些引用要重扫',
  '技能是怎么生成的', 'dsh-proof 验证门跑几个门', '', '   ', '的的的', '!!!', '😀😀😀',
  'ｆｕｌｌｗｉｄｔｈ', 'a', 'ab', 'a'.repeat(2000), '插件'.repeat(500),
  'D:\\AI\\dsh-bundles', 'https://example.com/a?b=c', 'role(support/bridge/constraint)',
]
// ≤400 的极小预算下「头部 + pinned 全文 + 页脚」本身就装不下，属于已知边界（memory_list 会用 injectedOverBudget 标出）。
const budgets = [600, 800, 1200, 1500, 3000, 8000]

for (const budget of budgets) {
  for (const q of queries) {
    const stats = {}
    let block
    try {
      block = renderMemory(entries, { maxInjectChars: budget, query: q, stats })
    } catch (error) {
      note('CRASH', `budget=${budget} q=${JSON.stringify(q.slice(0, 20))}: ${error.message}`)
      continue
    }
    if (typeof block !== 'string') { note('TYPE', `budget=${budget} 返回非字符串`); continue }
    if (block === '') continue
    if (block.length > budget) note('BUDGET_OVER', `超 ${block.length - budget} · budget=${budget} q=${JSON.stringify(q.slice(0, 18))}`)
    if (!block.startsWith('<memory>') || !block.endsWith('</memory>')) note('WRAP', `块首尾不合法 budget=${budget}`)
    const ids = [...block.matchAll(/\(([a-z0-9]+)\)/g)].map((m) => m[1])
    const dup = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]
    if (dup.length > 0) note('DUP_ID', `重复 id: ${dup.slice(0, 4)} · budget=${budget}`)
    const seen = new Set()
    for (const key of ['full', 'relevant', 'indexed', 'compact', 'dropped']) {
      for (const id of stats[key] ?? []) {
        if (seen.has(id)) note('STATS_DUP', `${id} 同时出现在多层 · budget=${budget}`)
        seen.add(id)
      }
    }
    if (renderMemory(entries, { maxInjectChars: budget, query: q }) !== block) note('NONDET', `两次渲染不一致 · budget=${budget}`)
  }
}

const corpus = entries.filter((e) => typeof e.supersededBy !== 'string' && e.pinned !== true)
for (const q of queries) {
  const r = relevanceCoverage(corpus, q)
  if (!Number.isFinite(r.coverage)) note('NONFINITE', `coverage 非数字 q=${JSON.stringify(q.slice(0, 16))}`)
  else if (r.coverage < 0 || r.coverage > 1) note('RANGE', `coverage 越界 ${r.coverage} q=${JSON.stringify(q.slice(0, 16))}`)
}
for (const [label, list, q] of [['空语料', [], '插件'], ['空query', corpus, ''], ['只有虚词', corpus, '的了吗呢'], ['单字', corpus, '插']]) {
  const r = relevanceCoverage(list, q)
  if (!Number.isFinite(r.coverage)) note('NONFINITE', `${label} => ${r.coverage}`)
}

const dirty = [{ id: 'd1' }, { id: 'd2', text: 42 }, { id: 'd3', text: '正常一条', tags: 'not-array' }, { id: 'd4', text: null }]
for (const budget of [800, 1500]) {
  try {
    const block = renderMemory([...dirty, ...entries.slice(0, 6)], { maxInjectChars: budget, query: '正常一条' })
    if (typeof block !== 'string') note('DIRTY_TYPE', '脏条目渲染返回非字符串')
  } catch (error) {
    note('DIRTY_CRASH', `脏条目崩溃 budget=${budget}: ${error.message}`)
  }
}

for (const q of queries) {
  const units = contentUnitsOf(q)
  if (!Array.isArray(units)) { note('UNITS_TYPE', 'contentUnitsOf 返回非数组'); break }
  if (units.some((unit) => typeof unit !== 'string' || unit.length === 0)) note('UNITS_DIRTY', 'contentUnitsOf 有非字符串/空串')
}

if (problems.length === 0) {
  console.log('✅ 不变量全部通过（' + budgets.length + ' 档预算 × ' + queries.length + ' 条 query）')
} else {
  console.log('发现 ' + problems.length + ' 个问题：')
  const grouped = new Map()
  for (const p of problems) { const arr = grouped.get(p.kind) ?? []; arr.push(p.detail); grouped.set(p.kind, arr) }
  for (const [kind, list] of grouped) {
    console.log(`\n[${kind}] ${list.length} 条`)
    for (const d of list.slice(0, 6)) console.log('  - ' + d)
    if (list.length > 6) console.log('  … 还有 ' + (list.length - 6) + ' 条')
  }
  process.exitCode = 1
}
