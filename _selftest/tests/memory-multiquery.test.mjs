// dsh-memory v4.11 多说法查询（max-pooling）回归。
//
// 为什么有它：v4.11 让 memory_search 接受 queries[]，每条记忆取它对所有说法的最高分。
// 机制的价值已在真机 23 题基准上量过（三道语义缺口题 第6/6/8 → 第1，Recall 0.783→0.870），
// 但「基准变好」不等于「实现正确」——本文件管的是机制边界：合并、去重、上限、回显、单查不变、max 而非 sum。
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { apply } from '../../dsh-memory/index.js'
import { makeTmp, sweepStaleDirs } from './_tmp-dirs.mjs'

let passed = 0
const ok = (label) => { passed += 1; console.log('  ✓ ' + label) }
sweepStaleDirs()

const host = (dir) => {
  const defs = new Map()
  const ctx = {
    tools: { register: (definition) => { defs.set(definition.name, definition); return () => {} } },
    effect: (fn) => fn(),
    on: () => () => {},
    get: () => undefined,
    systemPrompt: { context: () => () => {} },
  }
  apply(ctx, { storeDir: dir, maxInjectChars: 1500 })
  return defs
}

const dir = makeTmp('dsh-memory-multiquery')
try {
  const defs = host(dir)
  const add = (text) => defs.get('memory_add').execute({ text, kind: 'fact' })
  const search = (args) => defs.get('memory_search').execute(args)
  await add('alpha zeta 唯一词')
  await add('beta omega 唯一词')
  await add('gamma theta 唯一词')
  await add('alpha beta 双词')

  // 1) 单说法：行为与 v4.10 一致，且不凭空多出 queries 字段
  const single = await search({ query: 'zeta' })
  assert.equal(single.matches.length, 1)
  assert.equal(single.queries, undefined)
  ok('单说法：行为不变，不返回 queries 字段')

  // 2) 两个不相交的说法，命中都进同一结果（这是 queries 的核心用途）
  const multi = await search({ query: 'zeta', queries: ['omega'] })
  const has = (prefix) => multi.matches.some((item) => item.text.startsWith(prefix))
  assert.ok(has('alpha'), 'alpha 条目应由主说法召回')
  assert.ok(has('beta'), 'beta 条目应由额外说法召回')
  assert.ok(!has('gamma'), '无关条目不该被拉进来')
  ok('多说法：两个说法各自的命中合并进同一结果')

  // 3) 回显实际参与的说法
  assert.deepEqual(multi.queries, ['zeta', 'omega'])
  ok('多说法：返回 queries 回显实际参与的说法')

  // 4) 去重、trim、排除与 query 相同的项
  const dedup = await search({ query: 'zeta', queries: ['zeta', 'omega', 'omega', '  omega  '] })
  assert.deepEqual(dedup.queries, ['zeta', 'omega'])
  ok('多说法：去重 + trim + 排除与 query 相同的项')

  // 5) 额外说法上限 5（主 query 之外）
  const many = await search({ query: 'zeta', queries: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'] })
  assert.equal(many.queries.length, 6)
  ok('多说法：额外说法最多 5 个')

  // 6) 空串 / 非字符串安全忽略
  const messy = await search({ query: 'zeta', queries: ['', '   ', null, 42, 'omega'] })
  assert.deepEqual(messy.queries, ['zeta', 'omega'])
  ok('多说法：空串与非字符串项被忽略')

  // 7) max-pooling 而非 sum：同条记忆在两个说法下都命中时，分数等于它对任一说法的最好分数，
  //    不能把两个说法的分数加起来（加起来会让多词条目虚高，压过真正更相关的条目）。
  const alphaOnly = await search({ query: 'alpha', limit: 20 })
  const betaOnly = await search({ query: 'beta', limit: 20 })
  const pick = (result) => result.matches.find((item) => item.text.startsWith('alpha beta'))
  const scoreA = pick(alphaOnly)?.score ?? 0
  const scoreB = pick(betaOnly)?.score ?? 0
  const pooled = await search({ query: 'alpha', queries: ['beta'], limit: 20 })
  const scorePooled = pick(pooled)?.score ?? 0
  assert.equal(scorePooled, Math.max(scoreA, scoreB))
  ok('多说法：同条命中取最高分（max），不是相加（sum）')

  // 8) render 告诉调用方这次合并了几种说法
  const rendered = defs.get('memory_search').output.render({}, multi).map((part) => part.text).join('')
  assert.ok(rendered.includes('已合并 2 种说法'), 'render 应显示合并说法数，实际：' + rendered.slice(0, 80))
  ok('render：显示已合并的说法数')

  console.log(`\n全部通过（${passed} 项）`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}