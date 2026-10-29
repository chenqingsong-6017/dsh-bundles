import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  apply,
  detectScope,
  extractCandidates,
  importanceOf,
  normalizeEntry,
  recencyOf,
  renderMemory,
  scoreEntries,
  scoreMemory,
  textSimilarity,
  tokenize,
  trustMark,
  memoryEntrySchema,
  deriveStaleAfter,
  effectiveImportance,
  applicableAt,
} from '../../dsh-memory/index.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ---- v1.0 行为（全量渲染，不传 options）----
assert.equal(renderMemory([]), '')
assert.equal(renderMemory(undefined), '')
ok('空记忆不注入')

const block = renderMemory([
  { id: 'm1', text: '用户要求回答用中文' },
  { id: 'm2', text: '插件都放 D 盘' },
])
assert.ok(block.startsWith('<memory>'))
assert.ok(block.endsWith('</memory>'))
assert.ok(block.includes('- 用户要求回答用中文'))
assert.ok(block.includes('- 插件都放 D 盘'))
ok('非空记忆渲染成 <memory> 块且逐条列出')

const ordered = renderMemory([{ id: 'a', text: 'first' }, { id: 'b', text: 'second' }])
assert.ok(ordered.indexOf('first') < ordered.indexOf('second'))
ok('保持写入顺序（越靠后越新）')

// ---- v1.1 分层注入 ----
const pinnedEntry = { id: 'p1', text: 'PINNED-HARD-RULE', pinned: true }
const bulk = Array.from({ length: 12 }, (_, i) => ({
  id: `b${i}`,
  text: `记忆条目内容 ${i} ${'填充'.repeat(12)}`,
}))

const layered = renderMemory([...bulk, pinnedEntry], { maxInjectChars: 260 })
assert.ok(layered.includes('PINNED-HARD-RULE'), 'pinned 条目必须全文注入')
assert.ok(layered.includes('📌'), 'pinned 条目带置顶标记')
ok('分层注入：pinned 优先全文')

const indexLines = layered.split('\n').filter((line) => /^- \(\w+\)/.test(line))
assert.ok(indexLines.length > 0, '预算不够时应出现索引行')
assert.ok(layered.includes('memory_search'), '索引提示要引导用 memory_search 取全文')
ok('分层注入：装不下的条目降级成索引行')

assert.ok(layered.includes('记忆条目内容 11'), '最新的非 pinned 条目应优先拿到全文')
ok('分层注入：其余条目按从新到旧分配')

assert.ok(layered.length < 700, `分层后总长应受控（实际 ${layered.length}）`)
ok('分层注入：总长度远小于全量渲染')

const allLines = renderMemory([...bulk, pinnedEntry])
assert.ok(allLines.length > layered.length, '全量渲染应比分层渲染长')
assert.equal(allLines.split('\n').filter((line) => /^- \(\w+\)/.test(line)).length, 0, '全量模式不产生索引行')
ok('不传 maxInjectChars 时保持全量渲染（向后兼容）')

// ---- 检索打分 ----
const sample = { id: 'm1', text: '用户要求：所有回答用中文', tag: 'preference' }
assert.ok(scoreMemory(sample, '中文') > 0, '子串命中要有分')
assert.ok(scoreMemory(sample, '中文') > scoreMemory(sample, 'php'), '命中的分高于不命中')
assert.equal(scoreMemory(sample, '完全不存在的词xyz'), 0)
assert.equal(scoreMemory(sample, '   '), 0, '空 query 得 0 分')
assert.ok(scoreMemory(sample, 'preference') > 0, 'tag 也参与检索')
ok('scoreMemory：子串优先、tag 参与、空查询为 0')


// ---- v1.2 预算诊断 + BM25 ----
const dated = renderMemory(
  [{ id: 'd1', text: '带日期的条目内容'.repeat(4), tag: 'env', updatedAt: '2026-10-28T10:00:00.000Z' }],
  { maxInjectChars: 1200 },
)
assert.ok(/^- \(d1\) \[env\] 2026-10-28 /m.test(dated), '索引行应带 id / tag / 日期，便于按 id 续取正文')
ok('v1.2 索引行格式：id + tag + 日期 + 摘要')

const crowd = Array.from({ length: 20 }, (_, i) => ({ id: `x${i}`, text: `条目 ${i} ` + '填充'.repeat(30) }))
const tight = renderMemory(crowd, { maxInjectChars: 400 })
const diagnostic = tight.split('\n').find((line) => line.startsWith('⚠ 另有'))
assert.ok(diagnostic, '预算不足时必须输出出局诊断行，不能静默丢弃')
for (const entry of crowd) {
  assert.ok(tight.includes(`(${entry.id})`) || diagnostic.includes(entry.id), `${entry.id} 必须出现在索引行或诊断行`)
}
ok('v1.2 出局诊断：被挤出预算的条目逐条点名，零静默丢失')

const bulkOnly = Array.from({ length: 6 }, (_, i) => ({ id: `y${i}`, text: `很长的正文内容第 ${i} 条 ` + '细节'.repeat(40) }))
const noPlain = renderMemory([...bulkOnly, { id: 'keep', text: 'PINNED-RULE', pinned: true }], { maxInjectChars: 900 })
for (const entry of bulkOnly) assert.ok(!noPlain.includes(entry.text), '非 pinned 条目分层模式下不应全文注入')
ok('v1.2 分层：非 pinned 一律走索引行（同预算覆盖更多条目）')

const idfCorpus = [
  { id: 'common', text: '插件 插件 插件 常规说明' },
  { id: 'rare', text: '插件 预算 超支 说明' },
]
const idfScored = scoreEntries(idfCorpus, '插件 预算')
const commonScore = idfScored.find((item) => item.entry.id === 'common').score
const rareScore = idfScored.find((item) => item.entry.id === 'rare').score
assert.ok(rareScore > commonScore, `稀有词加权后应更高（rare=${rareScore} common=${commonScore}）`)
ok('BM25：IDF 抑制常见词（不再出现 10 条同分）')

const rankedCorpus = [
  { id: 'irrelevant', text: '完全无关的静态页面说明' },
  { id: 'relevant', text: '记忆超预算时拒绝写入，并提示先删过时条目' },
  { id: 'partial', text: '记忆条目的一般说明' },
]
const ranked = scoreEntries(rankedCorpus, '超预算 拒绝写入').filter((item) => item.score > 0).sort((a, b) => b.score - a.score)
assert.equal(ranked[0].entry.id, 'relevant', '最相关的条目必须排第一')
assert.ok(ranked.every((item) => item.score > 0))
ok('BM25：相关条目排序正确')
assert.ok(tokenize('插件 都放 D 盘 memory').size >= 6, 'tokenize 应切出中文 unigram/bigram 与英文词')
ok('tokenize：中文 bigram + 英文词')

// ---- v1.3 按本轮消息召回（query）----
const queryPool = [
  { id: 'q1', text: '很早写的无关条目 ' + '填充'.repeat(40) },
  { id: 'q2', text: '记忆超预算时拒绝写入，并提示先删过时条目' },
  { id: 'q3', text: '插件都放 D 盘，不落 C 盘' },
]
const withQuery = renderMemory(queryPool, { maxInjectChars: 600, query: '超预算 拒绝写入' })
assert.ok(withQuery.includes('记忆超预算时拒绝写入，并提示先删过时条目'), 'query 命中的条目应给全文')
assert.ok(withQuery.includes('- (q2)'), '相关全文行要带 id，便于续取与更新')
assert.ok(/相关 [1-9]\d*/.test(withQuery), '页脚要标明本轮相关条数')
ok('v1.3 按本轮消息召回：相关条目升级为全文并带 id')

const pinnedWithQuery = renderMemory(
  [...queryPool, { id: 'pr', text: 'PINNED-HARD-RULE', pinned: true }],
  { maxInjectChars: 800, query: '超预算 拒绝写入' },
)
assert.ok(pinnedWithQuery.includes('PINNED-HARD-RULE'), '有 query 时 pinned 仍必须全文')
ok('v1.3 有 query 时 pinned 不被挤掉')

const noQuery = renderMemory(queryPool, { maxInjectChars: 600 })
assert.ok(!noQuery.includes('填充'.repeat(40)), '无 query 时不注入非 pinned 全文（保持索引模式）')
ok('v1.3 无 query 时退回纯索引模式')

// ---- v2 字段（scope / kind / tags）与持久化 ----
const normalized = normalizeEntry({
  id: 'z1',
  text: '原子事实',
  scope: 'plugin-dev',
  kind: 'rule',
  tags: ['a', 'b'],
  migratedFrom: 'm1',
  usedCount: 3,
  pinned: true,
})
assert.equal(normalized.scope, 'plugin-dev')
assert.deepEqual(normalized.tags, ['a', 'b'])
assert.equal(normalized.usedCount, 3)
ok('normalizeEntry 保留 v2 字段')

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-test-'))
const host = (dir) => {
  const defs = new Map()
  const layers = []
  const handlers = new Map()
  const ctx = {
    tools: { register: (definition) => { defs.set(definition.name, definition); return () => {} } },
    effect: (fn) => fn(),
    on: (name, handler) => { handlers.set(name, handler); return () => {} },
    get: () => undefined,
    systemPrompt: { context: (layer) => { layers.push(layer); return () => {} } },
  }
  apply(ctx, { storeDir: dir, maxInjectChars: 1500 })
  return { defs, layers, handlers }
}
const first = host(tmpDir)
const added = await first.defs.get('memory_add').execute({
  text: '测试原子事实',
  scope: 'plugin-dev',
  kind: 'rule',
  tags: ['t1', 't2'],
  pinned: true,
})
assert.equal(added.entry.scope, 'plugin-dev')
assert.deepEqual(added.entry.tags, ['t1', 't2'])
const reloaded = host(tmpDir)
const listed = await reloaded.defs.get('memory_list').execute({})
assert.equal(listed.entries.length, 1)
assert.equal(listed.entries[0].scope, 'plugin-dev')
assert.equal(listed.entries[0].kind, 'rule')
assert.deepEqual(listed.entries[0].tags, ['t1', 't2'])
assert.equal(listed.entries[0].pinned, true)
ok('load→persist 不丢 v2 字段（重载后 scope/kind/tags 仍在）')

const searchHit = await reloaded.defs.get('memory_search').execute({ query: '原子事实' })
assert.equal(searchHit.matches[0].scope, 'plugin-dev')
assert.deepEqual(searchHit.matches[0].tags, ['t1', 't2'])
ok('memory_search 返回 scope/kind/tags')

const blockWithRule = reloaded.layers[0].text({})
assert.ok(blockWithRule.includes('测试原子事实'), 'pinned v2 条目应全文注入')
rmSync(tmpDir, { recursive: true, force: true })
ok('v2 条目参与注入渲染')

// ---- v2.1 维护闭环（supersede / usedCount / merge / audit）----
const supEntries = [
  { id: 's1', text: '旧的失效事实', supersededBy: 's2' },
  { id: 's2', text: '新的生效事实' },
]
const supBlock = renderMemory(supEntries, { maxInjectChars: 1000 })
assert.ok(supBlock.includes('新的生效事实'))
assert.ok(!supBlock.includes('旧的失效事实'), '被 supersede 的条目不应再注入')
ok('v2.1 superseded 条目不再注入')

const renderStats = {}
renderMemory(supEntries, { maxInjectChars: 1000, stats: renderStats })
assert.deepEqual(renderStats.indexed, ['s2'])
ok('v2.1 renderMemory 输出注入统计（供使用计数）')

const tmp2 = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-test2-'))
const h = host(tmp2)
const aEntry = await h.defs.get('memory_add').execute({ text: '记忆模块的预算上限是 1500 字符', scope: 'plugin-dev', kind: 'fact', tags: ['budget'] })
const bEntry = await h.defs.get('memory_add').execute({ text: '记忆模块的预算上限是 1500 字符左右', scope: 'plugin-dev', kind: 'fact', tags: ['budget'] })
await h.defs.get('memory_search').execute({ query: '预算上限', limit: 5 })
const listed2 = await h.defs.get('memory_list').execute({})
const hitEntry = listed2.entries.find((entry) => entry.id === aEntry.entry.id)
assert.ok((hitEntry.usedCount ?? 0) >= 1, '命中的条目要有使用计数')
assert.ok(typeof hitEntry.lastUsedAt === 'string')
ok('v2.1 memory_search 命中自增 usedCount/lastUsedAt')

const audit = await h.defs.get('memory_audit').execute({ similarity: 0.5 })
assert.ok(Array.isArray(audit.duplicates) && audit.duplicates.length >= 1, '近似两条应被识别为重复候选')
assert.ok(audit.byScope.length >= 1)
assert.ok(audit.budget.usedChars > 0)
ok('v2.1 memory_audit 找出重复候选并报 scope/预算')

const mergedOut = await h.defs.get('memory_merge').execute({ ids: [aEntry.entry.id, bEntry.entry.id], text: '记忆预算上限 1500 字符' })
const afterMerge = await h.defs.get('memory_list').execute({})
assert.equal(afterMerge.superseded, 2)
assert.ok(afterMerge.block.includes('记忆预算上限 1500 字符'))
assert.ok(!afterMerge.block.includes('左右'))
ok('v2.1 memory_merge：合并成一条，旧条目留档不注入')

const cEntry = await h.defs.get('memory_add').execute({ text: 'DSH 版本 0.2.1-rc.3', scope: 'data-infra', kind: 'fact' })
const updOut = await h.defs.get('memory_update').execute({ id: cEntry.entry.id, text: 'DSH 版本 0.2.2', supersede: true })
assert.equal(updOut.superseded, cEntry.entry.id)
assert.notEqual(updOut.entry.id, cEntry.entry.id)
const afterUpdate = await h.defs.get('memory_list').execute({})
assert.ok(afterUpdate.block.includes('0.2.2'))
assert.ok(!afterUpdate.block.includes('0.2.1-rc.3'), '旧值不再注入')
ok('v2.1 memory_update supersede：新值生效、历史留档')

const audit2 = await h.defs.get('memory_audit').execute({})
assert.ok(audit2.superseded >= 2)
ok('v2.1 审计统计失效条数')

rmSync(tmp2, { recursive: true, force: true })

// ---- v2.2 scope 加分 + 自动沉淀候选（影子模式）----
assert.equal(detectScope('D:\\AI\\dsh-bundles\\dsh-memory'), 'plugin-dev')
assert.equal(detectScope('D:\\AI-date\\dsh-date\\dsh-创建'), 'dsh-date')
assert.equal(detectScope('C:\\Windows\\System32'), '')
assert.equal(detectScope(''), '')
ok('v2.2 detectScope：按 cwd 前缀映射 scope 域')

const candidateRules = [
  ['以后插件测试必须先跑 memory-eval', true],
  ['记住：数据都放 D 盘', true],
  ['别再手改 VirtualBox.xml 了', true],
  ['帮我看看这段代码', false],
  ['这个方案可行吗？', false],
  ['好', false],
]
for (const [text, expected] of candidateRules) {
  const got = extractCandidates(text).length > 0
  assert.equal(got, expected, `extractCandidates("${text}") 应为 ${expected}`)
}
assert.equal(extractCandidates('别再手改 VirtualBox.xml 了')[0].kind, 'rule')
ok('v2.2 extractCandidates：规则抽候选（陈述句/禁令，排除问句与闲聊）')

const scopePool = [
  { id: 'g1', text: '插件改名后要同步更新快捷方式', scope: 'global', tags: ['naming'] },
  { id: 'p1', text: '插件改名后要同步更新快捷方式', scope: 'plugin-dev', tags: ['naming'] },
]
const scoped = renderMemory(scopePool, { maxInjectChars: 800, query: '插件改名 快捷方式', scope: 'plugin-dev' })
assert.ok(scoped.indexOf('- (p1)') < scoped.indexOf('- (g1)'), '同等相关度时，命中当前 scope 的条目应排前')
ok('v2.2 scope 加分：当前工作区域条目优先')

const tmp3 = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-test3-'))
const h3 = host(tmp3)
const turnStopping = h3.handlers.get('agent/turn-stopping')
assert.equal(typeof turnStopping, 'function', '应注册 agent/turn-stopping 钩子')
await turnStopping({
  agent: {
    id: 'sess-1',
    session: {
      deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: '以后插件测试必须先跑 memory-eval' }] }],
    },
  },
})
const pendingList = await h3.defs.get('memory_candidates').execute({ action: 'list' })
assert.equal(pendingList.pending, 1)
assert.ok(pendingList.items[0].text.includes('memory-eval'))
const blockWithCandidate = h3.layers[0].text({})
assert.ok(blockWithCandidate.includes('候选记忆 1 条待确认'), '注入块要提示待确认候选')
ok('v2.2 回合结束按规则抓候选（只进候选池，不直接入库）')

const accepted = await h3.defs.get('memory_candidates').execute({ action: 'accept', id: pendingList.items[0].id })
assert.equal(accepted.pending, 0)
const memAfterAccept = await h3.defs.get('memory_list').execute({})
assert.ok(memAfterAccept.entries.some((entry) => entry.text.includes('memory-eval')), '接受后应进入记忆库')
ok('v2.2 memory_candidates accept：审核通过才入库')

await turnStopping({
  agent: {
    id: 'sess-1',
    session: {
      deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: '以后插件测试必须先跑 memory-eval' }] }],
    },
  },
})
const dedupList = await h3.defs.get('memory_candidates').execute({ action: 'list' })
assert.equal(dedupList.pending, 0, '与已有记忆高度重合的句子不再进候选')
ok('v2.2 候选池去重（与已有记忆相似度 ≥0.7 跳过）')

rmSync(tmp3, { recursive: true, force: true })

// ---- v2.3 importance / recency / 绝对下限门 ----
assert.equal(importanceOf({ id: 'a', text: 'x', kind: 'rule', pinned: true }), 10)
assert.equal(importanceOf({ id: 'b', text: 'x', kind: 'fact' }), 4)
assert.equal(importanceOf({ id: 'c', text: 'x', kind: 'preference' }), 6)
assert.equal(importanceOf({ id: 'd', text: 'x', kind: 'note' }), 2)
assert.equal(importanceOf({ id: 'e', text: 'x', kind: 'fact', importance: 9 }), 9, '显式 importance 优先')
assert.ok(importanceOf({ id: 'f', text: 'x', kind: 'fact', usedCount: 20 }) > 4, '用得多的重要度更高')
ok('v2.3 importanceOf：显式优先 + kind/pinned/使用次数推导')

const fresh = recencyOf({ id: 'g', text: 'x', updatedAt: new Date().toISOString() })
const stale = recencyOf({ id: 'h', text: 'x', updatedAt: new Date(Date.now() - 138 * 3600000).toISOString() })
assert.ok(fresh > 0.98 && stale > 0.45 && stale < 0.55, `半衰 5.8 天：fresh=${fresh}, stale=${stale}`)
assert.equal(recencyOf({ id: 'i', text: 'x' }), 0.5, '无时间戳按中性值')
ok('v2.3 recencyOf：0.995/小时 指数衰减（半衰 ≈5.8 天）')

const floorPool = [
  { id: 'weak', text: '很弱的近似匹配 关键词', scope: 'global' },
  { id: 'strong', text: '记忆预算超支时拒绝写入并提示清理', scope: 'global' },
]
const unrelated = renderMemory(floorPool, { maxInjectChars: 800, query: '今天天气怎么样' })
assert.ok(!/相关 [1-9]/.test(unrelated), '无关问题不应注入相关全文')
const relevant = renderMemory(floorPool, { maxInjectChars: 800, query: '记忆预算超支' })
assert.ok(/相关 [1-9]/.test(relevant), '真正相关的仍要注入')
ok('v2.3 绝对下限门：弱匹配宁可不注入，强匹配照常')

const tmpImp = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-test4-'))
const hImp = host(tmpImp)
const addedImp = await hImp.defs.get('memory_add').execute({ text: '测试重要度字段', kind: 'fact', importance: 7 })
assert.equal(addedImp.entry.importance, 7)
const listedImp = await hImp.defs.get('memory_list').execute({})
assert.equal(listedImp.entries[0].importance, 7)
const updatedImp = await hImp.defs.get('memory_update').execute({ id: addedImp.entry.id, text: '测试重要度字段', importance: 3 })
assert.equal(updatedImp.entry.importance, 3)
rmSync(tmpImp, { recursive: true, force: true })
ok('v2.3 importance 可写入/更新/列出')

// ---- v2.4 跨域索引压缩 + 页脚引导 ----
const crossPool = [
  { id: 'in1', text: '本域事实：插件源码在 dsh-bundles 目录下', scope: 'plugin-dev', tags: ['plugin'], updatedAt: '2026-10-28T00:00:00Z' },
  { id: 'out1', text: '跨域事实：抖音客户端必须用普通权限启动', scope: 'machine', tags: ['env'], updatedAt: '2026-10-28T00:00:00Z' },
  { id: 'glob', text: '全局规则：所有回答用中文', scope: 'global', tags: ['rule'], updatedAt: '2026-10-28T00:00:00Z' },
]
const crossBlock = renderMemory(crossPool, { maxInjectChars: 1200, scope: 'plugin-dev' })
assert.ok(/- \(in1\) \[plugin\]/.test(crossBlock), '本域条目给完整索引行')
assert.ok(/- \(out1\) <machine>/.test(crossBlock), '跨域条目压成 id + 域标签')
assert.ok(!crossBlock.includes('抖音客户端必须用普通权限启动'), '跨域条目不再带摘要')
assert.ok(/跨域 1/.test(crossBlock), '页脚要标出跨域条数')
assert.ok(crossBlock.includes('memory_search'), '页脚显式引导按需检索')
ok('v2.4 跨域索引压缩：本域带摘要、跨域只点名，页脚标数与引导')

const crossStats = {}
renderMemory(crossPool, { maxInjectChars: 1200, scope: 'plugin-dev', stats: crossStats })
assert.deepEqual(crossStats.compact, ['out1'])
assert.deepEqual(crossStats.indexed, ['glob', 'in1'], '索引按数组从新到旧排列，global 与同域都算完整索引行')
ok('v2.4 注入统计区分 indexed / compact')

// ---- v2.5 数据安全：损坏保护 + 每日备份轮转 ----
const tmpCorrupt = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-corrupt-'))
writeFileSync(path.join(tmpCorrupt, 'memory.json'), '{ this is not json', 'utf8')
const hCorrupt = host(tmpCorrupt)
const corruptList = await hCorrupt.defs.get('memory_list').execute({})
assert.equal(corruptList.health, 'corrupt', '损坏时应报 corrupt 健康状态')
assert.ok(typeof corruptList.healthNote === 'string' && corruptList.healthNote.includes('.corrupt-'), '应指出损坏副本路径')
await assert.rejects(
  () => hCorrupt.defs.get('memory_add').execute({ text: '这条应该写不进去' }),
  /损坏保护/,
  '损坏保护态必须拒绝写入',
)
assert.ok(!existsSync(path.join(tmpCorrupt, 'memory.json')), '原文件应被改名留证，而不是被覆盖')
const corruptCopies = readdirSync(tmpCorrupt).filter((name) => name.includes('.corrupt-'))
assert.equal(corruptCopies.length, 1)
assert.equal(readFileSync(path.join(tmpCorrupt, corruptCopies[0]), 'utf8'), '{ this is not json', '损坏副本内容必须原样保留')
rmSync(tmpCorrupt, { recursive: true, force: true })
ok('v2.5 损坏保护：改名留证 + 只读拒绝写入，绝不静默覆盖')

const tmpBackup = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-backup-'))
writeFileSync(
  path.join(tmpBackup, 'memory.json'),
  JSON.stringify({ version: 2, nextId: 2, entries: [{ id: 'm1', text: '既有记忆', addedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] }),
  'utf8',
)
for (let index = 0; index < 12; index += 1) {
  const name = path.join(tmpBackup, `memory.json.bak-20260${String(index + 1).padStart(3, '0')}`)
  writeFileSync(name, '{}', 'utf8')
  const old = new Date(Date.now() - (100 + index) * 86400000)
  utimesSync(name, old, old)
}
const hBackup = host(tmpBackup)
await hBackup.defs.get('memory_add').execute({ text: '触发首次写入' })
const backupsAfterFirst = readdirSync(tmpBackup).filter((name) => name.startsWith('memory.json.bak-'))
assert.ok(backupsAfterFirst.length <= 10, `备份轮转后应 ≤10 份（实际 ${backupsAfterFirst.length}）`)
const todayBackup = backupsAfterFirst.some((name) => /^memory\.json\.bak-\d{8}$/.test(name))
assert.ok(todayBackup, '首次写入前应生成当天备份')
await hBackup.defs.get('memory_add').execute({ text: '同一天再写一次' })
const backupsAfterSecond = readdirSync(tmpBackup).filter((name) => name.startsWith('memory.json.bak-'))
assert.equal(backupsAfterSecond.length, backupsAfterFirst.length, '同一天多次写入只备份一次')
rmSync(tmpBackup, { recursive: true, force: true })
ok('v2.5 每日备份：首次写前备份、同天只一份、超出保留 10 份')

// ---- v2.6 信任字段（OKF v0.2 精简版）----
// 无标记时注入内容与旧版逐字一致（不插 legend）
const plainTrust = renderMemory([{ id: 'q1', text: '旧条目' }])
assert.ok(!plainTrust.includes('标记含义'), '没有信任标记时不应插入 legend')
assert.ok(plainTrust.includes('- 旧条目'))
ok('v2.6 无标记时注入保持不变（向后兼容）')

// normalizeEntry：保留合法值、过滤非法值
const trusted = normalizeEntry({
  id: 'x1',
  text: 't',
  status: 'draft',
  staleAfter: '2026-01-01',
  verifiedBy: 'agent',
  verifiedAt: '2026-10-01T00:00:00.000Z',
  sources: ['https://example.com/a', '   '],
})
assert.equal(trusted.status, 'draft')
assert.equal(trusted.staleAfter, '2026-01-01')
assert.equal(trusted.verifiedBy, 'agent')
assert.deepEqual(trusted.sources, ['https://example.com/a'])
const bogus = normalizeEntry({ id: 'x2', text: 't', status: 'bogus', staleAfter: '10-01' })
assert.equal(bogus.status, undefined)
assert.equal(bogus.staleAfter, undefined)
ok('v2.6 normalizeEntry 保留合法信任字段、过滤非法值')

// trustMark
assert.ok(trustMark({ status: 'draft' }).includes('❓未证实'))
assert.ok(trustMark({ staleAfter: '2020-01-01' }).includes('⏰待重验'))
assert.equal(trustMark({ staleAfter: '2999-01-01' }), '')
assert.ok(trustMark({ verifiedAt: '2026-01-01T00:00:00.000Z' }).includes('✓已验证'))
assert.equal(trustMark({}), '')
ok('v2.6 trustMark：未证实 / 待重验 / 已验证 / 无标记')

// deprecated 不注入
const withDeprecated = renderMemory([
  { id: 'a1', text: '还活着的条目' },
  { id: 'a2', text: '已经废弃的条目', status: 'deprecated' },
])
assert.ok(withDeprecated.includes('还活着的条目'))
assert.ok(!withDeprecated.includes('已经废弃的条目'))
ok('v2.6 deprecated 条目只留档、不注入')

// draft 注入带标记 + legend
const draftBlock = renderMemory([{ id: 'd1', text: '这是一个猜测', status: 'draft' }])
assert.ok(draftBlock.includes('❓未证实'))
assert.ok(draftBlock.includes('标记含义'))
ok('v2.6 draft 条目注入时明确标「未证实」')

// 端到端：add / update / 持久化
const tmpTrust = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-trust-'))
const hTrust = host(tmpTrust)
await hTrust.defs.get('memory_add').execute({
  text: '待验证的猜测',
  status: 'draft',
  staleAfter: '2026-12-31',
  sources: ['D:\\x'],
})
const draftList = await hTrust.defs.get('memory_list').execute({})
const draftEntry = draftList.entries.find((entry) => entry.text === '待验证的猜测')
assert.equal(draftEntry.status, 'draft')
assert.equal(draftEntry.staleAfter, '2026-12-31')
assert.deepEqual(draftEntry.sources, ['D:\\x'])
await assert.rejects(() => hTrust.defs.get('memory_add').execute({ text: '非法状态', status: 'nope' }), /status/)
await assert.rejects(() => hTrust.defs.get('memory_add').execute({ text: '非法日期', staleAfter: '12/31' }), /staleAfter/)
ok('v2.6 memory_add：写入信任字段、非法值明确报错')

await hTrust.defs.get('memory_update').execute({ id: draftEntry.id, text: '待验证的猜测', verified: true })
const verifiedEntry = (await hTrust.defs.get('memory_list').execute({})).entries.find((entry) => entry.id === draftEntry.id)
assert.ok(typeof verifiedEntry.verifiedAt === 'string' && verifiedEntry.verifiedAt !== '', 'verified=true 应记录时间')
await hTrust.defs.get('memory_update').execute({ id: draftEntry.id, text: '待验证的猜测', verified: false })
const clearedEntry = (await hTrust.defs.get('memory_list').execute({})).entries.find((entry) => entry.id === draftEntry.id)
assert.equal(clearedEntry.verifiedAt, undefined)
ok('v2.6 memory_update：verified 可置位/清除')

// 落盘后重新加载，字段不能被白名单洗掉
const trustStore = JSON.parse(readFileSync(path.join(tmpTrust, 'memory.json'), 'utf8'))
assert.ok(trustStore.entries.some((entry) => entry.status === 'draft'), '信任字段必须持久化')
const hReload = host(tmpTrust)
const reloadedTrust = (await hReload.defs.get('memory_list').execute({})).entries.find((entry) => entry.text === '待验证的猜测')
assert.equal(reloadedTrust.status, 'draft', '重载后信任字段仍应存在')
rmSync(tmpTrust, { recursive: true, force: true })
ok('v2.6 信任字段落盘并能在重载后存活')

// ---- v2.6.1 对外 schema 单一真相源（防「一处加字段、另一处漏加 → invalid output」）----
{
  const fullEntry = normalizeEntry({
    id: 'schema-test',
    text: 't',
    tag: 'a',
    tags: ['b'],
    scope: 'global',
    kind: 'fact',
    importance: 5,
    migratedFrom: 'm0',
    validFrom: '2026-01-01',
    supersededBy: 'm9',
    usedCount: 3,
    pinned: true,
    lastUsedAt: '2026-10-01T00:00:00.000Z',
    addedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    status: 'draft',
    staleAfter: '2026-12-31',
    verifiedBy: 'agent',
    verifiedAt: '2026-10-01T00:00:00.000Z',
    sources: ['https://x'],
    paths: ['src/**'],
  })
  const declared = new Set(Object.keys(memoryEntrySchema.properties))
  const missing = Object.keys(fullEntry).filter((key) => !declared.has(key))
  assert.deepEqual(missing, [], 'normalizeEntry 产出的字段必须在 memoryEntrySchema 里声明，缺：' + missing.join(','))
  assert.equal(memoryEntrySchema.additionalProperties, false)
}
ok('v2.6.1 normalizeEntry 全字段都被 memoryEntrySchema 覆盖（lastUsedAt 漏项已修）')

// 真实工具的返回也必须过 schema：直接对 memory_list 的返回做键覆盖检查
{
  const tmpSchema = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-schema-'))
  const hSchema = host(tmpSchema)
  await hSchema.defs.get('memory_add').execute({
    text: '带全部字段的条目',
    tag: 'x',
    tags: ['y'],
    scope: 'global',
    kind: 'fact',
    importance: 7,
    pinned: true,
    status: 'stable',
    staleAfter: '2027-01-01',
    sources: ['D:/x'],
  })
  const listed = await hSchema.defs.get('memory_list').execute({})
  const declared = new Set(Object.keys(memoryEntrySchema.properties))
  for (const entry of listed.entries) {
    const extra = Object.keys(entry).filter((key) => !declared.has(key))
    assert.deepEqual(extra, [], 'memory_list 返回了 schema 未声明的字段：' + extra.join(','))
  }
  rmSync(tmpSchema, { recursive: true, force: true })
}
ok('v2.6.1 memory_list 实际返回值不含 schema 未声明字段')

// ---- v2.7 三处修复（跨域压缩 / id 检索 / 相似邻居提示）----
{
  const cross = renderMemory(
    [
      { id: 'c1', text: '本域条目：插件的官方可选 bundle 要先查 list_bundles 再决定自研', scope: 'plugin-dev' },
      { id: 'c2', text: '抖音必须普通权限启动，提权会静默退出', scope: 'machine' },
    ],
    { maxInjectChars: 500, scope: 'plugin-dev' },
  )
  const crossLine = cross.split('\n').find((line) => line.includes('<machine>'))
  assert.ok(crossLine !== undefined, '跨域条目应出现压缩行')
  assert.ok(crossLine.includes('抖音'), '压缩行必须带主题摘要，不能只有 <scope> 标签：' + crossLine)
}
ok('v2.7 跨域压缩保留主题摘要（原来只剩 <scope>，等于没注入）')

{
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-v27-'))
  const h = host(tmp)
  await h.defs.get('memory_add').execute({ text: '第一条记忆内容' })
  await h.defs.get('memory_add').execute({ text: '第二条完全无关的内容' })
  const hit = await h.defs.get('memory_search').execute({ query: 'm2' })
  assert.equal(hit.matches[0].id, 'm2', '按 id 搜索必须排在第一位')
  assert.deepEqual(hit.byId, ['m2'])
  const none = await h.defs.get('memory_search').execute({ query: 'm99' })
  assert.equal(none.byId, undefined, '不存在的 id 不应产生 byId')
  rmSync(tmp, { recursive: true, force: true })
}
ok('v2.7 memory_search 支持 m\\d+ 按 id 直取（此前命中 0）')

{
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-sim-'))
  const h = host(tmp)
  await h.defs.get('memory_add').execute({ text: '抖音必须用普通权限启动，提权会静默退出' })
  const second = await h.defs.get('memory_add').execute({ text: '抖音必须用普通权限启动，提权就会静默退出' })
  assert.ok(Array.isArray(second.similar) && second.similar.length === 1, '应给出 1 条相似邻居')
  assert.equal(second.similar[0].id, 'm1')
  assert.ok(second.similar[0].similarity >= 0.62)
  const fresh = await h.defs.get('memory_add').execute({ text: '完全无关的另一件事：NVIDIA 驱动升级要留回滚路径' })
  assert.equal(fresh.similar, undefined, '不相似的写入不应提示')
  rmSync(tmp, { recursive: true, force: true })
}
ok('v2.7 memory_add 写入时提示相似邻居（A-MEM strengthen 的零模型版）')

// ---- v2.8 自动时效 / 记忆概览 / 预算口径 ----
{
  const base = new Date('2026-10-29T00:00:00.000Z')
  assert.equal(deriveStaleAfter('fact', base), '2027-01-27')
  assert.equal(deriveStaleAfter('note', base), '2026-11-28')
  assert.equal(deriveStaleAfter('rule', base), '', '规则是长期约定，不设时效')
  assert.equal(deriveStaleAfter('preference', base), '')
  assert.equal(deriveStaleAfter('', base), '')
}
ok('v2.8 deriveStaleAfter：fact 90 天 / note 30 天 / rule 与 preference 不设')

{
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-stale-'))
  const h = host(tmp)
  const factEntry = await h.defs.get('memory_add').execute({ text: '某个会变的版本号', kind: 'fact' })
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(factEntry.entry.staleAfter ?? ''), 'fact 类应自动带 staleAfter')
  const ruleEntry = await h.defs.get('memory_add').execute({ text: '永远用中文回答', kind: 'rule' })
  assert.equal(ruleEntry.entry.staleAfter, undefined, 'rule 类不应自动带时效')
  const explicit = await h.defs.get('memory_add').execute({ text: '显式指定', kind: 'fact', staleAfter: '2030-01-01' })
  assert.equal(explicit.entry.staleAfter, '2030-01-01', '显式 staleAfter 优先')
  rmSync(tmp, { recursive: true, force: true })
}
ok('v2.8 memory_add 按 kind 自动补 staleAfter，显式值优先')

{
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-review-'))
  const h = host(tmp)
  await h.defs.get('memory_add').execute({ text: '一条硬规则', kind: 'rule', pinned: true })
  await h.defs.get('memory_add').execute({ text: '一条没被引用过的事实', kind: 'fact' })
  const r = await h.defs.get('memory_review').execute({})
  assert.equal(r.counts.total, 2)
  assert.equal(r.counts.pinned, 1)
  assert.equal(r.counts.unused, 1)
  assert.ok(r.markdown.includes('# 记忆概览'))
  assert.ok(r.markdown.includes('📌 硬规则'))
  assert.equal(r.written, true)
  assert.ok(existsSync(r.file), 'review 文件应落盘')
  const noWrite = await h.defs.get('memory_review').execute({ write: false })
  assert.equal(noWrite.written, false)
  rmSync(tmp, { recursive: true, force: true })
}
ok('v2.8 memory_review：分类计数 + markdown + 落盘 + 可关写')

{
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-budget-'))
  const h = host(tmp)
  await h.defs.get('memory_add').execute({ text: '一条记忆' })
  const listed = await h.defs.get('memory_list').execute({})
  assert.equal(typeof listed.injectedOverBudget, 'boolean', 'memory_list 要显式给出是否超预算')
  rmSync(tmp, { recursive: true, force: true })
}
ok('v2.8 memory_list 显式暴露 injectedOverBudget')

// ---- v2.9 学习进化：遗忘曲线 / 沉淀管道 / 候选 TTL ----
{
  const now = Date.parse('2026-10-29T00:00:00.000Z')
  const day = 86400000
  const mk = (daysAgo, extra = {}) => ({
    id: 'x', text: 't', kind: 'fact', importance: 6,
    lastUsedAt: new Date(now - daysAgo * day).toISOString(), ...extra,
  })
  const close = (a, b) => Math.abs(a - b) < 1e-9
  assert.ok(close(effectiveImportance(mk(1), now), 6), '7 天内不衰减')
  assert.ok(close(effectiveImportance(mk(20), now), 5.4), '30 天内 ×0.9')
  assert.ok(close(effectiveImportance(mk(60), now), 4.2), '90 天内 ×0.7')
  assert.ok(close(effectiveImportance(mk(200), now), 3), '更久 ×0.5')
  assert.ok(close(effectiveImportance(mk(200, { pinned: true }), now), 6), 'pinned 永不衰减')
  assert.ok(close(effectiveImportance(mk(200, { kind: 'rule' }), now), 6), 'rule 永不衰减')
  assert.ok(effectiveImportance({ id: 'y', text: 't', kind: 'fact' }, now) > 0, '没有时间戳时退回基础分')
}
ok('v2.9 effectiveImportance：遗忘曲线 7/30/90 天分档，pinned 与 rule 不衰减')

{
  const got = extractCandidates('这个方案已实测失败，因为权限不够。另一个结论是必须用普通权限。')
  assert.equal(got.length, 2, '按句切分，每轮最多 2 条')
  assert.ok(got.some((item) => item.reason === '实测结论'), '识得「已实测」')
  assert.equal(extractCandidates('结论是必须走 API 建仓')[0].reason, '结论/归因')
  assert.equal(extractCandidates('记住第一件很重要的事。记住第二件很重要的事。记住第三件很重要的事。').length, 2, '超过上限要截断')
  assert.equal(extractCandidates('这个方案可行吗？').length, 0, '问句不沉淀')
}
ok('v2.9 extractCandidates：知识型规则 + 原子化切句 + 每轮上限 2')

{
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-ttl-'))
  host(tmp)
  writeFileSync(
    path.join(tmp, 'candidates.json'),
    JSON.stringify({ version: 1, nextId: 2, items: [
      { id: 'c1', text: '过期的候选', kind: 'fact', status: 'pending', reason: 'x', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-08T00:00:00.000Z' },
    ] }),
    'utf8',
  )
  const h2 = host(tmp)
  const listed = await h2.defs.get('memory_candidates').execute({ action: 'list' })
  assert.equal(listed.pending, 0, '过期候选不计入 pending')
  assert.equal(listed.items.length, 0)
  rmSync(tmp, { recursive: true, force: true })
}
ok('v2.9 候选池 TTL：过期未确认自动标记 expired，不再计入 pending')

// ---- v3.0 工作区条件注入 ----
{
  assert.equal(applicableAt({ id: 'a', text: 't' }, 'D:\\x'), true, '没设 workspaces 时到处适用')
  const e = { id: 'b', text: 't', workspaces: ['D:\\AI-date\\dsh-date\\dsh-亲爱的管家'] }
  assert.equal(applicableAt(e, 'D:\\AI-date\\dsh-date\\dsh-亲爱的管家'), true)
  assert.equal(applicableAt(e, 'D:\\AI-date\\dsh-date\\dsh-亲爱的管家\\sub'), true, '子目录也算匹配')
  assert.equal(applicableAt(e, 'D:\\AI-date\\dsh-date\\dsh-创建'), false)
  assert.equal(applicableAt(e, ''), false, '拿不到 cwd 时保守不注入')
  assert.equal(applicableAt(e, 'D:\\AI-date\\dsh-date\\dsh-创建\\'), false, '尾斜杠不影响判定')
  assert.equal(applicableAt({ id: 'c', text: 't', workspaces: [] }, 'D:\\x'), true, '空数组等于没设')
}
ok('v3.0 applicableAt：workspaces 前缀匹配，空 cwd 保守不注入')

{
  const e1 = { id: 'w1', text: '只在 A 工作区生效的规则', workspaces: ['D:\\A'] }
  const e2 = { id: 'w2', text: '到处都生效的规则' }
  const inA = renderMemory([e1, e2], { maxInjectChars: 1500, cwd: 'D:\\A' })
  assert.ok(inA.includes('只在 A 工作区'), '匹配工作区时注入')
  const inB = renderMemory([e1, e2], { maxInjectChars: 1500, cwd: 'D:\\B' })
  assert.ok(!inB.includes('只在 A 工作区'), '不匹配时整条不注入')
  assert.ok(inB.includes('到处都生效'), '无 workspaces 的条目不受影响')
  const noCwd = renderMemory([e1, e2], { maxInjectChars: 1500 })
  assert.ok(!noCwd.includes('只在 A 工作区'), '没传 cwd 时条件条目也不注入')
}
ok('v3.0 renderMemory：workspaces 不匹配的条目连索引都不占')

// ---- v3.1 记忆自我污染防护 ----
{
  assert.equal(extractCandidates('把它们当背景，不要逐条复述').length, 0, '注入块头部提示语不许入候选')
  assert.equal(extractCandidates('其他工作区一律不套用 📌 用户陈青松是皇上').length, 0, '带 📌 的注入块内容不许入候选')
  assert.equal(extractCandidates('<memory> 记住这条很重要的事实 </memory>').length, 0, '带 <memory> 标签的整段不许入候选')
  assert.equal(extractCandidates('这个方案已实测失败，因为权限不够').length, 1, '正常知识仍要捕获')
}
ok('v3.1 污染门：注入块自身的标记与提示语一律不入候选')

// ---- v3.3 生效口径统一 ----
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-archived-'))
  const h = host(tmp)
  await h.defs.get('memory_add').execute({ text: '会被留档的条目一', kind: 'fact' })
  await h.defs.get('memory_add').execute({ text: '会被留档的条目二', kind: 'fact' })
  await h.defs.get('memory_add').execute({ text: '保留的条目', kind: 'fact' })
  await h.defs.get('memory_update').execute({ id: 'm1', text: '改过的条目一', status: 'deprecated' })
  const listed = await h.defs.get('memory_list').execute({})
  const review = await h.defs.get('memory_review').execute({ write: false })
  const audit = await h.defs.get('memory_audit').execute({})
  assert.equal(review.counts.total, 2, 'review 的 total 只算生效（应排除 deprecated）')
  assert.equal(audit.active, 2, 'audit 的 active 也只算生效')
  assert.equal(listed.archived, 1, 'archived 必须包含 deprecated')
  assert.equal(audit.archived, 1)
  assert.equal(audit.active + audit.archived, audit.total, 'active + archived === total')
  assert.equal(listed.superseded, 0, '没有 supersede 时 superseded 为 0')
  rmSync(tmp, { recursive: true, force: true })
}
ok('v3.3 口径统一：review / audit / list 对 deprecated 的处理一致')

// ---- v3.4 输出契约自检：required 必须真的返回，且不能越界 ----
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-contract-'))
  const h = host(tmp)
  await h.defs.get('memory_add').execute({ text: '契约测试条目一，用于校验返回字段', kind: 'fact', tags: ['contract'] })
  await h.defs.get('memory_add').execute({ text: '契约测试条目二，用于校验返回字段', kind: 'rule' })
  const calls = [
    ['memory_list', {}],
    ['memory_search', { query: '契约' }],
    ['memory_add', { text: '契约测试条目三，新增用', kind: 'note' }],
    ['memory_update', { id: 'm1', text: '契约测试条目一（已改）' }],
    ['memory_audit', {}],
    ['memory_review', { write: false }],
    ['memory_candidates', { action: 'list' }],
  ]
  for (const [name, args] of calls) {
    const def = h.defs.get(name)
    assert.ok(def !== undefined, `工具未注册：${name}`)
    const value = await def.execute(args)
    const schema = def.output?.schema
    if (schema === undefined) continue
    const required = Array.isArray(schema.required) ? schema.required : []
    const missing = required.filter((key) => !(key in value))
    assert.deepEqual(missing, [], `${name} 返回缺少 required 字段：${missing.join(',')}`)
    if (schema.additionalProperties === false && schema.properties !== undefined) {
      const declared = new Set(Object.keys(schema.properties))
      const extra = Object.keys(value).filter((key) => !declared.has(key))
      assert.deepEqual(extra, [], `${name} 返回了 schema 未声明的字段：${extra.join(',')}`)
    }
  }
  rmSync(tmp, { recursive: true, force: true })
}
ok('v3.4 输出契约：每个工具的 required 字段都真的返回，且不越界')

console.log(`memory: ${passed} 项通过`)


