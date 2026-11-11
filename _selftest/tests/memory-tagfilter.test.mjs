// dsh-memory v4.12 分类检索（tags / scope 过滤）回归。
//
// 为什么有它：聚合问题（「做过哪几次升级」「有哪些硬规则」）靠 BM25 打分召回不全——
// 打分是找最像的几条，分类是把某类全部捞出来。本文件管机制边界：OR 语义、scope 精确匹配、
// 与 query 组合、空值忽略、facets 统计准确。
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

const dir = makeTmp('dsh-memory-tagfilter')
try {
  const defs = host(dir)
  const add = (text, extra) => defs.get('memory_add').execute({ text, kind: 'fact', ...extra })
  const search = (args) => defs.get('memory_search').execute(args)
  await add('alpha 事实 A', { tags: ['dsh-memory', 'retrieval'] })
  await add('beta 事实 B', { tags: ['dsh-memory'] })
  await add('gamma 事实 C', { tags: ['硬规则'], scope: 'global' })
  await add('delta 事实 D', { tag: 'plugin-dev', scope: 'plugin-dev' })
  await add('epsilon 事实 E')

  // 1) tags 过滤：只返回带该 tag 的
  const byTag = await search({ query: '事实', tags: ['dsh-memory'], limit: 20 })
  const texts = byTag.matches.map((item) => item.text)
  assert.ok(texts.some((t) => t.includes('alpha')) && texts.some((t) => t.includes('beta')))
  assert.ok(!texts.some((t) => t.includes('gamma')), '不该返回其他 tag 的条目')
  ok('tags 过滤：只返回带该标签的条目')

  // 2) OR 语义：多个 tag 命中任意一个即可
  const orTags = await search({ query: '事实', tags: ['dsh-memory', '硬规则'], limit: 20 })
  const orTexts = orTags.matches.map((item) => item.text)
  assert.ok(orTexts.some((t) => t.includes('alpha')))
  assert.ok(orTexts.some((t) => t.includes('gamma')), 'OR 语义：硬规则那条也要回来')
  ok('tags 过滤：多标签是 OR 不是 AND')

  // 3) 单 tag 字段（entry.tag 而不是 tags）也要能被过滤到
  const single = await search({ query: '事实', tags: ['plugin-dev'], limit: 20 })
  assert.ok(single.matches.some((item) => item.text.includes('delta')), 'entry.tag 字段应等价于单元素 tags')
  ok('tags 过滤：entry.tag 单值字段同样生效')

  // 4) scope 过滤精确匹配
  const byScope = await search({ query: '事实', scope: 'global', limit: 20 })
  assert.deepEqual(byScope.matches.map((item) => item.text), ['gamma 事实 C'])
  ok('scope 过滤：精确匹配只回一条')

  // 5) tags + scope 组合
  const both = await search({ query: '事实', tags: ['硬规则'], scope: 'global', limit: 20 })
  assert.equal(both.matches.length, 1)
  assert.equal(both.filters.tags[0], '硬规则')
  assert.equal(both.filters.scope, 'global')
  ok('tags + scope：组合过滤并回显 filters')

  // 6) 空 tags / 空 scope 忽略，等价于不过滤
  const empty = await search({ query: '事实', tags: [], scope: '', limit: 20 })
  assert.equal(empty.filters, undefined)
  assert.ok(empty.matches.length >= 4)
  ok('空值忽略：空 tags 数组与空 scope 字符串不生效，不回显 filters')

  // 7) 过滤后无命中：不报错，matched=0
  const none = await search({ query: '事实', tags: ['不存在的标签'], limit: 20 })
  assert.equal(none.matches.length, 0)
  assert.equal(none.total, 0)
  ok('过滤到空集：静默返回 0 条，不抛错')

  // 8) facets：tag/scope 分布准确
  const status = await defs.get('memory_status').execute({})
  const tagMap = new Map(status.facets.tags.map((item) => [item.tag, item.count]))
  assert.equal(tagMap.get('dsh-memory'), 2)
  assert.equal(tagMap.get('硬规则'), 1)
  assert.equal(tagMap.get('plugin-dev'), 1)
  const scopeMap = new Map(status.facets.scopes.map((item) => [item.scope, item.count]))
  assert.equal(scopeMap.get('global'), 1)
  assert.equal(scopeMap.get('plugin-dev'), 1)
  ok('facets：tag 与 scope 计数准确')

  // 9) 分类浏览不被分数门槛砍：query 与条目词面完全不重合时，仍应返回该类全部
  const offTopic = await search({ query: '完全无关的查询词 zzz', tags: ['dsh-memory'], limit: 50 })
  assert.equal(offTopic.total, 2, '过滤后语料应是 2 条')
  assert.equal(offTopic.matches.length, 2, '分数为 0 的同类条目也必须返回（分类浏览不是相似度搜索）')
  ok('分类浏览：query 词面不重合时仍返回该类全部（不被 score 门槛砍）')

  // 10) total 与 matches 对账：这是真机发现「total=10 只回 2 条」的回归判据
  const reconcile = await search({ query: 'zzz 无关', tags: ['dsh-memory'], limit: 50 })
  assert.equal(reconcile.matches.length, reconcile.total, 'matches 必须等于过滤后语料总量')
  ok('分类浏览：matches 与 total 对账一致')

  // 11) v4.13 domain 展开：传 domain 名（rule）应匹配该域下的原 tag（硬规则）
  const byDomain = await search({ query: 'zzz', tags: ['rule'], limit: 50 })
  assert.ok(byDomain.matches.some((item) => item.text.includes('gamma')), 'rule 域应包含 tag=硬规则 的条目')
  assert.ok(!byDomain.matches.some((item) => item.text.includes('alpha')), '不该把 memory 域的条目带进来')
  ok('domain 展开：传 rule 命中 tag=硬规则 的条目')

  // 12) 原 tag 精确匹配仍然有效（向后兼容）
  const byRawTag = await search({ query: 'zzz', tags: ['硬规则'], limit: 50 })
  assert.equal(byRawTag.matches.length, 1)
  ok('domain 展开：传原 tag 仍精确匹配（向后兼容）')

  // 13) facets.domains 与 unclassified
  const st2 = await defs.get('memory_status').execute({})
  const dmap = new Map((st2.facets.domains || []).map((item) => [item.domain, item.count]))
  assert.equal(dmap.get('rule'), 1, 'tag=硬规则 应归入 rule 域')
  assert.equal(dmap.get('memory'), 2, 'tag=dsh-memory 的两条应归入 memory 域')
  assert.equal(st2.facets.unclassified, 1, 'epsilon 无 tag，应计入 unclassified')
  ok('facets.domains：域统计与 unclassified 计数准确')

  console.log(`\n全部通过（${passed} 项）`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}