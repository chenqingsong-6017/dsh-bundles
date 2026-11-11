import assert from 'node:assert/strict'
import {
  normalizeEntity,
  entityKey,
  buildAliasMap,
  resolveEntities,
  expandEntityKeys,
  bigramSimilarity,
  findAliasCandidates,
  entityStats,
} from '../../dsh-memory/lib/entity.js'

let passed = 0
const ok = (label) => { passed += 1; console.log('  OK ' + label) }

// ---------- 1. 规范化：中文称谓前缀剥离 ----------
assert.equal(normalizeEntity('我的同事 Alice'), 'Alice')
assert.equal(normalizeEntity('我老板张三'), '张三')
assert.equal(normalizeEntity('同事李四'), '李四')
assert.equal(normalizeEntity('Alice'), 'Alice')
assert.equal(normalizeEntity(''), '')
assert.equal(normalizeEntity(null), '')
assert.equal(normalizeEntity(123), '')
ok('规范化：中文称谓前缀剥离、空/非字符串安全')

// ---------- 2. 规范化：英文称谓前缀 ----------
assert.equal(normalizeEntity('my coworker Alice'), 'Alice')
assert.equal(normalizeEntity('my colleague Bob'), 'Bob')
assert.equal(normalizeEntity('mentor Carol'), 'Carol')
ok('规范化：英文称谓前缀剥离')

// ---------- 3. entityKey：比较用归一 key ----------
assert.equal(entityKey('Alice'), 'alice')
assert.equal(entityKey('DSH-Memory'), 'dshmemory')
assert.equal(entityKey('  dsh memory '), 'dshmemory')
assert.equal(entityKey('dsh_memory'), 'dshmemory')
ok('entityKey：小写 + 去空白/连字符/下划线')

// ---------- 4. buildAliasMap：canonical + 别名双向可查 ----------
const aliases = { Alice: ['Alice Chen', 'A. Chen'], DSH: ['deepseek harness'] }
const map = buildAliasMap(aliases)
assert.equal(map.get('alice'), 'Alice')
assert.equal(map.get('alicechen'), 'Alice')
assert.equal(map.get('achen'), 'Alice')
assert.equal(map.get('deepseekharness'), 'DSH')
assert.equal(buildAliasMap(undefined).size, 0)
ok('buildAliasMap：canonical 与别名都映射到同一规范名')

// ---------- 5. resolveEntities：写入路径解析 ----------
const resolved = resolveEntities(['我的同事 Alice', 'Alice Chen', 'Bob'], aliases)
assert.deepEqual(resolved, ['Alice', 'Bob'])
assert.deepEqual(resolveEntities([], aliases), [])
assert.deepEqual(resolveEntities(null, aliases), [])
assert.deepEqual(resolveEntities(['  ', ''], aliases), [])
ok('resolveEntities：前缀剥离 + 别名归并 + 去重 + 空值安全')

// ---------- 6. expandEntityKeys：检索路径展开 ----------
const keys = expandEntityKeys('Alice Chen', aliases)
assert.ok(keys.has('alice'))
assert.ok(keys.has('alicechen'))
const keys2 = expandEntityKeys('我的同事 Alice', aliases)
assert.ok(keys2.has('alice'))
assert.equal(expandEntityKeys('', aliases).size, 0)
ok('expandEntityKeys：查询展开成 canonical + 全部别名')

// ---------- 7. bigramSimilarity：纯函数 ----------
assert.equal(bigramSimilarity('abcd', 'abcd'), 1)
assert.equal(bigramSimilarity('abcd', 'wxyz'), 0)
assert.equal(bigramSimilarity('', 'x'), 0)
assert.ok(bigramSimilarity('Alice', 'Alicia') > 0.3)
ok('bigramSimilarity：同串=1、异串=0、空串安全')

// ---------- 8. findAliasCandidates：只提示不自动合并 ----------
const entries = [
  { id: 'm1', entities: ['Alice'] },
  { id: 'm2', entities: ['Alicia'] },
  { id: 'm3', entities: ['Bob'] },
  { id: 'm4', entities: ['dsh'] },
  { id: 'm5', entities: ['dsh-memory'] },
]
const cands = findAliasCandidates(entries, { threshold: 0.3 })
assert.ok(cands.length >= 1)
assert.ok(cands.some((c) => (c.a === 'Alice' && c.b === 'Alicia') || (c.a === 'Alicia' && c.b === 'Alice')))
// 回归（2026-11-11 真机暴露）：复合词 contains 不算同物，不许提示误报
const compound = findAliasCandidates([
  { id: 'x', entities: ['DSH'] },
  { id: 'y', entities: ['dsh-memory'] },
  { id: 'z', entities: ['memory'] },
], { threshold: 0.85 })
assert.ok(!compound.some((c) => (c.a === 'DSH' && c.b === 'dsh-memory') || (c.b === 'DSH' && c.a === 'dsh-memory')), 'DSH 与 dsh-memory 是复合词，不该进候选')
// 路径前缀算同物写法：Strata 与 D:\\AI\\Strata 该提示
const pathCand = findAliasCandidates([
  { id: 'p', entities: ['Strata'] },
  { id: 'q', entities: ['D:\\AI\\Strata'] },
], { threshold: 0.85 })
assert.ok(pathCand.some((c) => c.reason === 'contains'), '名字 vs 路径 应识别为同物写法')
assert.ok(cands.every((c) => typeof c.similarity === 'number'))
ok('findAliasCandidates：相似/包含关系进候选，只提示')

// ---------- 9. entityStats：健康度 ----------
const stats = entityStats(entries, aliases)
assert.equal(stats.entities, 5)
assert.equal(stats.entriesWithEntities, 5)
assert.equal(stats.entries, 5)
assert.equal(stats.aliasCount, 3)
assert.ok(Array.isArray(stats.top))
assert.equal(stats.top.length, 5)
ok('entityStats：实体数/覆盖/别名数/Top 正确')

// ---------- 10. 边界：同名主体去重后不重复计数 ----------
const dup = entityStats([
  { id: 'a', entities: ['Alice'] },
  { id: 'b', entities: ['alice'] },
  { id: 'c', entities: ['ALICE'] },
], {})
assert.equal(dup.entities, 1)
ok('entityStats：大小写不同算同一实体（归一后去重）')

console.log('memory-entity.test.mjs: 通过 ' + passed + ' 组断言')
