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
  scoreEntriesStrict,
  expandQuery,
  scoreMemory,
  textSimilarity,
  tokenize,
  trustMark,
  memoryEntrySchema,
  deriveStaleAfter,
  effectiveImportance,
  applicableAt,
  suggestAliases,
  contentUnitsOf,
  relevanceCoverage,
  queryIdfSum,
  cleanAliases,
  localDateOf,
  gateDecision,
  cardMarkdown,
  slugOf,
  extractRuleCandidates,
  collectRuleFiles,
  isStaleEntry,
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

// v3.6 起预算把页脚与诊断行也算进去（之前「略超」其实是超），所以这里给足以放下索引行的预算
const layered = renderMemory([...bulk, pinnedEntry], { maxInjectChars: 420 })
assert.ok(layered.length <= 420, `v3.6 预算自洽：总长 ${layered.length} 不应超过 420`)
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
{
  // v3.12：中文从 bigram 换成**词**（词典正向最大匹配）。这里锁住三条性质：
  //   词典词整词出现、英文整词保留、词内不再拆出单字（片段三重计数的根）。
  const terms = tokenize('插件 都放 D 盘 memory')
  assert.ok(terms.has('插件'), '词典词应整词成单元')
  assert.ok(terms.has('memory'), '英文整词保留')
  assert.ok(!terms.has('插') && !terms.has('件'), '词内不应再出单字单元')
  assert.equal(tokenize('验证门').get('验证门'), 1, '词典里的 3 字词整词命中')
}
ok('tokenize：中文按词（词典切分）+ 英文词')

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

// ---- v3.5 检索桥接：aliases + 同义扩展（2026-10-29 P0） ----
{
  // 1) 规范化：aliases 去空白、丢空串，且能过 schema
  const normalized = normalizeEntry({ id: 'm1', text: '给插件更新流程', aliases: [' 生效 ', '', '装完'] })
  assert.deepEqual(normalized.aliases, ['生效', '装完'])
  assert.ok(Object.keys(memoryEntrySchema.properties).includes('aliases'), 'schema 未声明 aliases')
  assert.equal(normalizeEntry({ id: 'm1', text: 'x' }).aliases, undefined)
  ok('v3.5 normalizeEntry 保留 aliases（去空白/丢空串），未知字段不落')
}

{
  // 2) 别名是跨词面桥：问法里没有一个字出现在原文里，靠 aliases 排第一
  const entries = [
    { id: 'a1', text: '用户说给插件更新 = 去 GitHub 找实现再改', aliases: ['装完', '跑起来', '生效'] },
    { id: 'a2', text: '验证门由 dsh-proof 负责，收工前跑 check' },
    { id: 'a3', text: '竞品调研结论写在 dsh-创建 工作区' },
  ]
  const ranked = scoreEntries(entries, '插件装完怎么让它跑起来').sort((x, y) => y.score - x.score)
  assert.equal(ranked[0].entry.id, 'a1')
  ok('v3.5 aliases 命中权重最高：纯换皮问法也能排到第一')
}

{
  // 3) 同义扩展：只桥接词组，不产生单字（单字会灌噪声）
  const extra = expandQuery('记忆插件坏了怎么救')
  assert.ok(extra.size > 0)
  assert.ok([...extra.keys()].every((term) => term.length >= 2), '扩展词里出现了单字')
  assert.equal(expandQuery('今天上海天气怎么样').size, 0)
  ok('v3.5 expandQuery 只扩展词组、无关问题不扩展')
}

{
  // 4) 严格打分不吃别名：别名里的字不能把无关问题判成相关
  // 原文里不含查询词；只有别名里有 —— 严格分必须为 0，宽松分必须 > 0
  const entries = [
    { id: 'b1', text: 'SKILL.md 由 skill-forge 写入技能目录', aliases: ['怎么生成', '索引'] },
    { id: 'b2', text: 'MySQL 无关条目占位' },
  ]
  const strict = scoreEntriesStrict(entries, 'MySQL 索引优化怎么做')
  assert.equal(strict.find((item) => item.entry.id === 'b1').score, 0, '严格分被别名污染了')
  const loose = scoreEntries(entries, 'MySQL 索引优化怎么做')
  assert.ok(loose.find((item) => item.entry.id === 'b1').score > 0, '宽松分应该被别名抬起来')
  ok('v3.5 scoreEntriesStrict 不看 aliases：无关问题严格分为 0、宽松分 > 0')
}

{
  // 5) 门槛用严格分：无关问题即使有别名也不注入全文
  const entries = [
    { id: 'c1', text: 'SKILL.md 由 skill-forge 写入技能目录', aliases: ['怎么生成', '索引'] },
    { id: 'c2', text: '用户要求回答用中文' },
  ]
  const block = renderMemory(entries, { maxInjectChars: 1500, query: 'MySQL 索引优化怎么做' })
  assert.equal(Number((block.match(/相关 (\d+)/) ?? [])[1] ?? 0), 0, '无关问题被注入了全文')
  ok('v3.5 相关性门槛用严格分：别名不能把无关问题抬过门槛')
}

// ---- v3.6 注入预算自洽 + 三因子索引 + 过期硬降级 ----
{
  // 1) 预算自洽：页脚/诊断行也计入预算，总长必须装得下（给足头部的预算区间）
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, text: `条目 ${i} ${'填充'.repeat(8)}` }))
  for (const budget of [600, 900, 1500]) {
    const block = renderMemory(many, { maxInjectChars: budget })
    assert.ok(block.length <= budget, `预算 ${budget} 实际 ${block.length}，超了`)
  }
  ok('v3.6 预算自洽：页脚与诊断行计入预算，总长不超过 maxInjectChars')
}

{
  // 2) 索引层按三因子排序：重要度高、更近的优先占索引位（旧的但重要不该先被挤掉）
  const low = { id: 'l1', text: '低重要条目 填充填充', importance: 1, addedAt: '2026-10-28T00:00:00Z' }
  const high = { id: 'h1', text: '高重要条目 填充填充', importance: 10, addedAt: '2026-10-28T00:00:00Z' }
  const stats = {}
  renderMemory([low, high], { maxInjectChars: 900, stats })
  const posHigh = stats.indexed.indexOf('h1')
  const posLow = stats.indexed.indexOf('l1')
  assert.ok(posHigh >= 0, '高重要条目应进索引')
  if (posLow >= 0) assert.ok(posHigh < posLow, '高重要条目应排在低重要之前')
  ok('v3.6 索引层三因子排序：重要度高的优先占索引位')
}

{
  // 3) 过期硬降级：staleAfter 已过的条目即使 query 命中也不给全文（只进索引并带 ⏰）
  const expired = { id: 'x1', text: '过期的旧事实 关于部署地址', staleAfter: '2020-01-01' }
  const fresh = { id: 'x2', text: '新鲜的部署事实 关于部署地址' }
  const stats = {}
  const block = renderMemory([expired, fresh], { maxInjectChars: 1200, query: '部署地址', stats })
  assert.ok(!stats.full.includes('x1'), '过期条目不应给全文')
  assert.ok(!stats.relevant.includes('x1'), '过期条目不应进相关层')
  assert.ok(stats.indexed.includes('x1') || stats.dropped.includes('x1'), '过期条目应降级到索引或未注入')
  assert.ok(block.includes('⏰'), '过期条目应带「待重验」标记')
  ok('v3.6 过期条目硬降级：命中也不给全文，只留索引与待重验标记')
}

// ---- v3.7 写入侧闭环：别名候选提示 + 合并继承 ----
{
  const tips = suggestAliases('用户要求插件更新后必须重启 DSH 才生效，这条要记住')
  assert.ok(tips.length >= 2 && tips.length <= 4, `候选数应在 2-4，实际 ${tips.length}`)
  assert.ok(tips.every((term) => term.length >= 2), '候选不应有单字')
  assert.deepEqual(suggestAliases(''), [])
  ok('v3.7 suggestAliases：给 2-4 个内容词候选，无单字')
}

{
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-alias-hint-'))
  const h = host(tmp)
  const bare = await h.defs.get('memory_add').execute({ text: '插件更新后要重启才生效' })
  assert.ok(bare.aliasHint !== undefined, '没写别名时应返回 aliasHint')
  assert.ok(bare.aliasHint.suggestion.length > 0, 'aliasHint 应给候选词')
  const withAlias = await h.defs.get('memory_add').execute({ text: '重启才会换模块代际', aliases: ['重载', '生效'] })
  assert.equal(withAlias.aliasHint, undefined, '写了别名就不该再提示')
  rmSync(tmp, { recursive: true, force: true })
  ok('v3.7 memory_add：缺别名时给候选提示，已带别名则不提示')
}

{
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-merge-alias-'))
  const h = host(tmp)
  const a = await h.defs.get('memory_add').execute({ text: '第一条关于部署的说法', aliases: ['上线', 'deploy'] })
  const b = await h.defs.get('memory_add').execute({ text: '第二条关于部署的说法', aliases: ['发布', 'deploy'] })
  const merged = await h.defs.get('memory_merge').execute({ ids: [a.entry.id, b.entry.id] })
  assert.deepEqual([...merged.entry.aliases].sort(), ['deploy', '上线', '发布'].sort(), '合并应取并集')
  rmSync(tmp, { recursive: true, force: true })
  ok('v3.7 memory_merge：合并继承别名（取并集），桥不会随合并变稀')
}

{
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-audit-alias-'))
  const h = host(tmp)
  await h.defs.get('memory_add').execute({ text: '有别名的一条', aliases: ['同义'] })
  await h.defs.get('memory_add').execute({ text: '没别名的一条' })
  const audit = await h.defs.get('memory_audit').execute({})
  assert.equal(audit.aliases.withAliases, 1)
  assert.equal(audit.aliases.missing, 1)
  assert.equal(audit.aliases.missingIds.length, 1)
  rmSync(tmp, { recursive: true, force: true })
  ok('v3.7 memory_audit：别名覆盖率可见（有/缺/缺的 id）')
}

// ---- v3.8 相关性门槛：只数内容单元（治片段三重计数 / 虚词算分）----
{
  assert.deepEqual(contentUnitsOf('的是'), [], '两个虚词拼的 bigram 不该算内容单元')
  assert.deepEqual(contentUnitsOf('会议'), ['会议'], '含一个虚词字的真词要保留')
  const units = contentUnitsOf('推荐一部好看的电影')
  assert.ok(units.includes('推荐'), '应保留内容 bigram')
  assert.ok(!units.some((unit) => unit.length === 1), '中文不再出 unigram（片段是三重计数的根）')
  // v3.13：拉丁词按 . _ - 拆子词（URL / 路径 / 连字符标识符），所以 dsh-memory 也出 dsh / memory。
  assert.deepEqual(contentUnitsOf('dsh-memory v3.7 别名').filter((unit) => /[a-z]/.test(unit)), [
    'dsh-memory',
    'dsh',
    'memory',
    'v3.7',
    'v3',
  ])
  // v3.12 的切分口径：词；3 字词额外保留词内 bigram（验证门 → 验证门/验证/证门），便于问半截。
  assert.deepEqual(contentUnitsOf('验证门'), ['验证门', '验证', '证门'])
  assert.deepEqual(contentUnitsOf('本地部署'), ['本地', '部署'], '两个词典词各自成单元，不再拼出跨词 bigram')
  ok('contentUnitsOf：拉丁整词 + 中文按词，丢虚词单元')
}

{
  // 回归：一条含「推荐」的记忆会把「推荐一部好看的电影」送过旧门槛（实测真实库里 0.169、注入 1475 字符）。
  const fillers = Array.from({ length: 8 }, (_, i) => ({ id: `z${i}`, text: `填充条目${i} 关于磁盘清理与服务自启的杂项记录` }))
  const corpus = [...fillers, { id: 'poison', text: '已推荐未批准', tags: ['handover'] }]
  const query = '推荐一部好看的电影'
  const idfTotal = queryIdfSum(corpus, query)
  const oldTop = scoreEntriesStrict(corpus, query).sort((a, b) => b.score - a.score)[0]
  const oldCoverage = idfTotal > 0 ? oldTop.score / idfTotal : 0
  const now = relevanceCoverage(corpus, query)
  assert.ok(oldCoverage >= 0.15, `旧口径应误判过门，实际 ${oldCoverage.toFixed(3)}`)
  // v3.12：词级切分让覆盖率的分母变小（4 个内容单元而不是 8 个 bigram），这个合成用例的覆盖率
  // 从 0.147 升到 0.2321 —— 靠「单单元护栏」挡住（单命中 + df≤1 + 长查询 < 0.25），
  // 不是靠覆盖率阈值。护栏的实测依据见 README v3.12。
  assert.ok(now.coverage >= 0.20 && now.coverage < 0.25, `覆盖率应在 [0.20,0.25)，实际 ${now.coverage.toFixed(4)}`)
  assert.deepEqual(now.matchedUnits, ['推荐'])
  assert.equal(now.topId, 'poison')
  assert.equal(
    gateDecision({ coverage: now.coverage, matchedUnits: now.matchedUnits, matchedDf: now.matchedDf, unitCount: now.unitCount, agreeWithRanking: true }).pass,
    false,
    '单单元护栏应挡住它',
  )
  ok('v3.12 单单元护栏：一个「推荐」不再把「推荐一部好看的电影」送过相关层')
}

{
  // 反向：真的在讲同一件事的换皮问法，必须仍然过门（收紧门槛不能把召回一起砍掉）。
  const fillers = Array.from({ length: 8 }, (_, i) => ({ id: `y${i}`, text: `填充条目${i} 关于磁盘清理与服务自启的杂项记录` }))
  const corpus = [...fillers, { id: 'plug', text: '插件更新后必须重启 DSH 才会换模块代际', tags: ['plugin'] }]
  const now = relevanceCoverage(corpus, '插件更新后要重启吗')
  assert.equal(now.topId, 'plug')
  assert.ok(now.coverage >= 0.20, `真相关应过门，实际 ${now.coverage.toFixed(3)}`)
  ok('v3.8 相关性门槛：换皮但真相关的问法仍进相关层')
}

{
  // 端到端：渲染层的「相关 N」必须跟门槛一致（负例 0 条、正例 1 条）。
  const fillers = Array.from({ length: 8 }, (_, i) => ({ id: `w${i}`, text: `填充条目${i} 关于磁盘清理与服务自启的杂项记录` }))
  const store = [...fillers, { id: 'poison', text: '已推荐未批准', tags: ['handover'] }, { id: 'plug', text: '插件更新后必须重启 DSH 才会换模块代际', tags: ['plugin'] }]
  const negStats = {}
  const negBlock = renderMemory(store, { maxInjectChars: 1200, query: '推荐一部好看的电影', stats: negStats })
  assert.deepEqual(negStats.relevant, [], '负例不该进相关层')
  assert.ok(!/相关 \d/.test(negBlock), '负例不该出现「相关 N」字样')
  assert.ok(negStats.relevanceCoverage < 0.25, '诊断字段应记录本轮覆盖率（且低于单单元护栏）')
  const posStats = {}
  renderMemory(store, { maxInjectChars: 1200, query: '插件更新后要重启吗', stats: posStats })
  assert.deepEqual(posStats.relevant, ['plug'])
  ok('v3.8 renderMemory：门槛与「相关 N」口径一致，stats 带覆盖率便于排查')
}

// ---- v3.9 数据安全：一轮独立审查（两个审查员 + Lead 复验）修掉的缺陷 ----
{
  // B07：每日备份轮转不能吃掉手工回滚点
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-bak-'))
  writeFileSync(path.join(tmp, 'memory.json'), JSON.stringify({ version: 1, nextId: 1, entries: [] }), 'utf8')
  for (let i = 1; i <= 11; i += 1) writeFileSync(path.join(tmp, `memory.json.bak-202610${String(i).padStart(2, '0')}`), '{}', 'utf8')
  writeFileSync(path.join(tmp, 'memory.json.bak-before-aliases'), '{"keep":1}', 'utf8')
  writeFileSync(path.join(tmp, 'memory.json.bak-before-merge3'), '{"keep":2}', 'utf8')
  const h = host(tmp)
  await h.defs.get('memory_add').execute({ text: '触发一次落盘' })
  const names = readdirSync(tmp)
  assert.ok(names.includes('memory.json.bak-before-aliases'), '手工回滚点被轮转删了')
  assert.ok(names.includes('memory.json.bak-before-merge3'), '手工回滚点被轮转删了')
  assert.ok(names.filter((name) => /\.bak-\d{8}$/.test(name)).length <= 10, '每日备份应只留 10 份')
  rmSync(tmp, { recursive: true, force: true })
  ok('v3.9 备份轮转只动每日备份，手工回滚点保留')
}

{
  // B01：写盘失败必须报错，不能报「已记住」
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-writefail-'))
  const h = host(tmp)
  mkdirSync(path.join(tmp, 'memory.json')) // 把目标路径做成目录 → rename 必失败（等价于磁盘/权限出错）
  let threw = false
  try {
    await h.defs.get('memory_add').execute({ text: '这条永远不落盘' })
  } catch (error) {
    threw = true
  }
  assert.equal(threw, true, '写盘失败却返回成功（假成功）')
  rmSync(tmp, { recursive: true, force: true })
  ok('v3.9 写盘失败会抛错，不再假成功')
}

{
  // B03：add 的去重只认生效条目；命中的是失效条目时应重新生效
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-dedupe-dead-'))
  const h = host(tmp)
  const first = await h.defs.get('memory_add').execute({ text: '旧事实：预算 8000' })
  await h.defs.get('memory_update').execute({ id: first.entry.id, text: '新事实：预算 12000', supersede: true })
  const again = await h.defs.get('memory_add').execute({ text: '旧事实：预算 8000' })
  const list = await h.defs.get('memory_list').execute({})
  assert.ok(list.block.includes('预算 8000'), '重新写入的正文没有生效（假成功）')
  assert.ok(again.entry.id !== first.entry.id, '不该复用已失效条目的 id')
  rmSync(tmp, { recursive: true, force: true })
  ok('v3.9 add 不再跟已失效条目去重（假成功）')
}

{
  // B04：命中同一个生效条目时，新给的字段要合并进去
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-dedupe-fields-'))
  const h = host(tmp)
  await h.defs.get('memory_add').execute({ text: '同一句话' })
  const second = await h.defs.get('memory_add').execute({
    text: '同一句话',
    aliases: ['别名甲'],
    tags: ['t1'],
    scope: 'plugin-dev',
    importance: 9,
    kind: 'rule',
  })
  assert.equal(second.deduped, true)
  assert.deepEqual(second.entry.aliases, ['别名甲'])
  assert.deepEqual(second.entry.tags, ['t1'])
  assert.equal(second.entry.scope, 'plugin-dev')
  assert.equal(second.entry.importance, 9)
  rmSync(tmp, { recursive: true, force: true })
  ok('v3.9 去重时合并 aliases/tags/scope/importance（不再整包吞掉）')
}

{
  // B05：supersede 的新条目继承重要度与过期日
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-supersede-fields-'))
  const h = host(tmp)
  const old = await h.defs.get('memory_add').execute({ text: '旧说法', importance: 10, staleAfter: '2026-12-31', kind: 'fact' })
  const next = await h.defs.get('memory_update').execute({ id: old.entry.id, text: '新说法', supersede: true })
  assert.equal(next.entry.importance, 10)
  assert.equal(next.entry.staleAfter, '2026-12-31')
  rmSync(tmp, { recursive: true, force: true })
  ok('v3.9 supersede 继承 importance / staleAfter')
}

{
  // B06 / B16：merge 继承 workspaces，且不接受重复 id
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-merge-fields-'))
  const h = host(tmp)
  const a = await h.defs.get('memory_add').execute({ text: '项目A规则一：提交前跑验证门', workspaces: ['D:\\AI\\projA'] })
  const b = await h.defs.get('memory_add').execute({ text: '项目A规则二：收工前不许跳门', workspaces: ['D:\\AI\\projA'] })
  const merged = await h.defs.get('memory_merge').execute({ ids: [a.entry.id, b.entry.id] })
  assert.deepEqual(merged.entry.workspaces, ['D:\\AI\\projA'], '合并后应有 workspaces')
  assert.deepEqual(merged.entry.tags ?? [], [])
  let threw = false
  try {
    await h.defs.get('memory_merge').execute({ ids: [a.entry.id, a.entry.id] })
  } catch (error) {
    threw = true
  }
  assert.equal(threw, true, '重复 id 应被拒绝')
  rmSync(tmp, { recursive: true, force: true })
  ok('v3.9 merge 继承 workspaces；重复 id 被拒')
}

{
  // B11：删条目后 nextId 不能回退（否则复用 id）
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-nextid-'))
  const h = host(tmp)
  const a = await h.defs.get('memory_add').execute({ text: '第一条' })
  const b = await h.defs.get('memory_add').execute({ text: '第二条' })
  await h.defs.get('memory_remove').execute({ id: b.entry.id })
  const reloaded = host(tmp)
  const c = await reloaded.defs.get('memory_add').execute({ text: '第三条' })
  assert.notEqual(c.entry.id, b.entry.id, 'nextId 回退导致复用已删 id')
  assert.notEqual(c.entry.id, a.entry.id)
  rmSync(tmp, { recursive: true, force: true })
  ok('v3.9 nextId 按最大 id 兜底，删除后不复用 id')
}

{
  // B13：verified:true 要清掉 ⏰，别一条记忆同时挂「待重验 + 已验证」
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-verified-'))
  const h = host(tmp)
  const a = await h.defs.get('memory_add').execute({ text: '依赖版本的事实', kind: 'fact', staleAfter: '2020-01-01' })
  const after = await h.defs.get('memory_update').execute({ id: a.entry.id, text: a.entry.text, verified: true })
  assert.equal(trustMark(after.entry).includes('⏰'), false, 'verified 之后仍有 ⏰')
  rmSync(tmp, { recursive: true, force: true })
  ok('v3.9 verified:true 顺手刷新 staleAfter，⏰ 不再和 ✓ 同时出现')
}

{
  // B12：过期日按本地日历算，不随写入时刻漂一天
  const midnight = new Date(2026, 9, 29, 0, 30, 0)
  const morning = new Date(2026, 9, 29, 9, 0, 0)
  assert.equal(deriveStaleAfter('fact', midnight), deriveStaleAfter('fact', morning), '过期日随当天几点写而变')
  const expected = new Date(2026, 9, 29 + 90)
  assert.equal(deriveStaleAfter('fact', morning), localDateOf(expected))
  ok('v3.9 staleAfter 用本地日历（B12）')
}

{
  // B15：别名去重 / 截断
  assert.deepEqual(cleanAliases([' 甲 ', '甲', '', '乙', 'x'.repeat(80)]), ['甲', '乙', 'x'.repeat(60)])
  assert.equal(cleanAliases(Array.from({ length: 20 }, (_, i) => 'a' + i)).length, 8)
  ok('v3.9 cleanAliases：去重 / 截断 / 最多 8 条')
}

{
  // A4：覆盖率不能超过 1（短条目 + 高频词曾到 1.95）
  const short = [{ id: 'x', text: '插件插件插件', tags: [] }]
  const r = relevanceCoverage(short, '插件插件')
  assert.ok(r.coverage <= 1, '覆盖率超过 1：' + r.coverage)
  assert.ok(r.coverage >= 0)
  ok('v3.9 覆盖率封顶在 [0,1]')
}

{
  // A8：诊断行也要参与预算裁剪（预算 300 时原来 582）
  const bulk = Array.from({ length: 80 }, (_, i) => ({ id: 'z' + i, text: '第' + i + '条 ' + '插件配置与验证门说明'.repeat(3), tags: ['t' + (i % 3)] }))
  for (const budget of [600, 900, 1200]) {
    const rendered = renderMemory(bulk, { maxInjectChars: budget })
    assert.ok(rendered.length <= budget, `预算 ${budget} 实际 ${rendered.length}`)
  }
  ok('v3.9 诊断行可缩：小预算也不再超')
}

{
  // A13：text 不是字符串时渲染不崩
  const block = renderMemory([{ id: 'n1', text: null }, { id: 'n2' }, { id: 'n3', text: 42 }, { id: 'ok1', text: '正常一条' }], {
    maxInjectChars: 1200,
  })
  assert.ok(typeof block === 'string')
  assert.ok(block.includes('正常一条'))
  ok('v3.9 renderMemory 对非字符串 text 不再抛错')
}

// ---- v3.10 并发与长句检索（B02 / A3）----
{
  // B02：两个宿主 = 两个进程各自 load 后各自整库覆盖写 —— 后写者不能把前写者的条目抹掉
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-multiproc-'))
  const a = host(tmp)
  const b = host(tmp) // 先建好 = b 拿到的是空库快照
  const ra = await a.defs.get('memory_add').execute({ text: 'A 进程写的：回答用中文' })
  const rb = await b.defs.get('memory_add').execute({ text: 'B 进程写的：插件放 D 盘' })
  assert.notEqual(ra.entry.id, rb.entry.id, '两个进程分到了同一个 id')
  const listed = await host(tmp).defs.get('memory_list').execute({})
  assert.equal(listed.total, 2, '后写者把前写者的条目覆盖掉了：total=' + listed.total)
  assert.ok(!existsSync(path.join(tmp, 'memory.json.lock')), '写完没释放锁文件')
  rmSync(tmp, { recursive: true, force: true })
  ok('v3.10 两进程并发写不丢条目、不抢 id、锁会释放（B02）')
}

{
  // B02：陈旧锁（进程崩了没清）不能把后续写入永久卡死
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-stalelock-'))
  const h = host(tmp)
  const lockFile = path.join(tmp, 'memory.json.lock')
  writeFileSync(lockFile, '999999', 'utf8')
  const old = new Date(Date.now() - 60000)
  utimesSync(lockFile, old, old)
  const added = await h.defs.get('memory_add').execute({ text: '陈旧锁也要能写进去' })
  assert.ok(added.entry.id)
  assert.ok(!existsSync(lockFile), '抢到锁后应释放')
  rmSync(tmp, { recursive: true, force: true })
  ok('v3.10 陈旧锁会被抢占（B02）')
}

{
  // A3：长自然句按分句取最大覆盖率 —— 同一意图不该因为"话变长"就掉出相关层
  const cases = [
    { short: '插件更新后要重启吗', long: '先别管别的，我想确认一件事，插件更新后要重启吗' },
    { short: '验证门跑几个门', long: '对了顺便问一句，另外还有个老问题一直没弄明白，验证门跑几个门' },
  ]
  const store = [
    { id: 'm74', text: '用户说「给插件更新」= 去 GitHub 找实现、学习、再对自研插件做真实改进；改完要重启 DSH 换模块代际', tags: ['plugin-update'] },
    { id: 'm70', text: '验证门：dsh-proof + 自写适配器，靠 npm run check 在收工前跑三道门（语法/结构/测试）', tags: ['verify-gate'] },
    { id: 'unrelated', text: '房产税政策与首套房的关系备忘', tags: ['misc'] },
  ]
  for (const item of cases) {
    const shortStats = {}
    const longStats = {}
    renderMemory(store, { maxInjectChars: 1200, query: item.short, stats: shortStats })
    renderMemory(store, { maxInjectChars: 1200, query: item.long, stats: longStats })
    assert.ok((shortStats.relevant ?? []).length > 0, '短问法本身该进相关层：' + item.short)
    // 长句里只要**包含**这句意图，覆盖率不应低于单独问这句（铺垫词不该稀释它）
    assert.ok(
      relevanceCoverage(store, item.long).coverage >= relevanceCoverage(store, item.short).coverage - 1e-9,
      '长句被铺垫词稀释了：' + item.long + ' => ' + relevanceCoverage(store, item.long).coverage.toFixed(3) + ' < ' + relevanceCoverage(store, item.short).coverage.toFixed(3),
    )
    assert.ok((longStats.relevant ?? []).length > 0, '长句里的意图没进相关层：' + item.long)
  }
  ok('v3.10 长自然句按分句取最大覆盖率，不再被铺垫词稀释（A3）')
}

{
  // A2：门槛由 top 条目判，相关层却按 scoreEntries 选 —— 两者不同源会注入跟 query 零内容重合的条目。
  const store = [
    { id: 'py', text: 'python 快排实现的要点', tags: ['code'] },
    { id: 'noise', text: '快点收工别磨蹭，今天先到这', tags: ['chat'] },
    { id: 'other', text: '完全无关的一条记忆', tags: ['misc'] },
  ]
  const stats = {}
  renderMemory(store, { maxInjectChars: 1200, query: 'python快排', stats })
  assert.ok((stats.relevant ?? []).includes('py'), '真正含 python 的条目没进相关层')
  assert.ok(!(stats.relevant ?? []).includes('noise'), '零内容单元重合的条目被注入了相关层')
  ok('v3.9 相关层与门槛同尺：零重合条目不进相关层（A2）')
}

// ---- v3.11 双信号门槛；v3.12 换词级口径后按 74 正例 / 35 负例重新标定 ----
{
  const pass = (coverage, matchedUnits, agreeWithRanking, matchedDf, unitCount) =>
    gateDecision({ coverage, matchedUnits, agreeWithRanking, matchedDf, unitCount }).pass
  assert.equal(pass(0.25, ['甲'], false), true, '覆盖率过主条件（v3.12 下限 0.20）就该过')
  assert.equal(pass(0.20, ['甲'], false), true, '压在 0.20 线上也算过')
  assert.equal(pass(0.15, ['甲', '乙'], true), true, '双信号一致 + 命中 2 单元 → 0.12 以上放宽')
  assert.equal(pass(0.15, ['甲'], true), false, '单命中不放宽（「电脑为什么会蓝屏」就是这种）')
  assert.equal(pass(0.15, ['甲', '乙'], false), false, '两个信号不一致时不放宽')
  assert.equal(pass(0.05, ['甲', '乙', '丙'], true), false, '低于 0.12 底线不放')
  assert.equal(
    gateDecision({ coverage: 0.15, matchedUnits: ['甲', '乙'], agreeWithRanking: true }).relaxed,
    true,
  )
  // v3.12 单单元护栏：短查询（≤2 单元）0.40、长查询（≥3 单元）0.25
  assert.equal(pass(0.3296, ['电脑'], true, [1], 2), false, '短查询单命中 + df≤1 + 0.3296 必须挡住')
  assert.equal(pass(0.4379, ['技能'], true, [1], 2), true, '短查询单命中但覆盖率 0.4379 放行')
  assert.equal(pass(0.2321, ['推荐'], true, [1], 4), false, '长查询单命中 0.2321（合成负例）挡住')
  assert.equal(pass(0.30, ['技能'], true, [1], 5), true, '长查询单命中 0.30 放行')
  assert.equal(pass(0.23, ['记忆', '插件'], true, [3, 5], 5), true, '两个单元命中不看单单元护栏')
  ok('v3.11/v3.12 gateDecision：主条件 / 双信号放宽 / 单命中护栏 / 低于底线不放')
}

// ---- v3.12 词级切分：A6 跨词边界假命中 ----
{
  // A6：bigram 时代「基本地址」里会拼出「本地」，把无关记忆顶过门槛（真实库实测 0.2375 > 0.16）。
  const corpus = [
    { id: 'a', text: '基本地址栏里没别的，都是填充' },
    { id: 'b', text: '填充用的无关记忆内容' },
    { id: 'c', text: '另一条填充用的记录' },
  ]
  const r = relevanceCoverage(corpus, '本地部署要先看文档')
  assert.deepEqual(r.matchedUnits, [], 'A6 用例不该有任何单元命中')
  assert.equal(r.coverage, 0, '覆盖率应为 0，实际 ' + r.coverage.toFixed(4))
  assert.ok(!contentUnitsOf('基本地址').includes('本地'), '「基本地址」里不应再产出跨词 bigram「本地」')
  assert.deepEqual(contentUnitsOf('本地部署'), ['本地', '部署'], '「本地部署」应切成两个词典词')
  ok('v3.12 A6：中文按词切分，跨词边界不再拼出假词（基本地址 ≠ 本地）')
}

// ---- v3.12 词级切分：词典词是一个单元，能直接命中 ----
{
  const corpus = [
    { id: 'p', text: '验证门在收工前自动跑三道门', tags: ['verify-gate'] },
    { id: 'q', text: '今天上海天气不错', tags: ['misc'] },
  ]
  assert.ok(tokenize('验证门').has('验证门'), '词典里的 3 字词应整词成单元')
  assert.ok(contentUnitsOf('验证门在收工前').includes('验证门'), '收工前/验证门都该是整词单元')
  const r = relevanceCoverage(corpus, '验证门跑几个门')
  assert.equal(r.topId, 'p', '词级切分应命中含「验证门」的条目')
  assert.ok(r.matchedUnits.includes('验证门'), '命中的单元里应出现整词「验证门」')
  ok('v3.12 词典词整词命中（验证门 / 收工前）')
}

// ---- v3.13 拉丁子词 + 护栏看「要注入的那条」 ----
{
  // 起因：记忆里写 https://github.com/...，用户问「发到 GitHub 上了吗」—— 整词 github.com 与查询 github 对不上，
  // 长句基准里那条因此排错（m78 覆盖率 0.66 却进不了相关层）。
  const urlUnits = contentUnitsOf('https://github.com/chenqingsong-6017/dsh-eval').filter((unit) => /[a-z]/.test(unit))
  assert.ok(urlUnits.includes('github'), 'URL 里的 github.com 应拆出 github')
  assert.ok(urlUnits.includes('eval'), 'dsh-eval 应拆出 eval')
  assert.ok(tokenize('dsh-eval').has('dsh') && tokenize('dsh-eval').has('eval'), '排序层也要拆')
  assert.deepEqual(contentUnitsOf('插件').filter((unit) => /[a-z]/.test(unit)), [], '纯中文不受影响')
  ok('v3.13 拉丁子词：URL / 连字符标识符按分隔段拆（github.com → github）')
}

{
  // 护栏判「实际要注入的那条」（排序 top）的证据，不是覆盖率 top 的：
  // 覆盖率 top 可能是无关条目（单命中一个词），排序 top 才是要写进提示的那条。
  const r1 = gateDecision({
    coverage: 0.21,
    matchedUnits: ['重复'],
    matchedDf: [1],
    unitCount: 5,
    agreeWithRanking: false,
    rankEvidence: { units: 2, matchedDf: [3, 2], coverage: 0.09 },
  })
  assert.equal(r1.pass, true, '排序 top 命中 2 个单元 → 不该被覆盖率 top 的单单元拖下水')
  const r2 = gateDecision({
    coverage: 0.21,
    matchedUnits: ['重复'],
    matchedDf: [1],
    unitCount: 5,
    agreeWithRanking: false,
    rankEvidence: { units: 1, matchedDf: [1], coverage: 0.09 },
  })
  assert.equal(r2.pass, false, '排序 top 也只命中 1 个罕见词 → 仍然挡')
  ok('v3.13 单单元护栏按「要注入的那条」判，不按覆盖率 top')
}


// ---- v3.15 英文停用词（LoCoMo 对照实验的产物） ----
{
  // 起因：LoCoMo 检索层 recall@1 28.3%，朴素 BM25 + 停用词 33.1% —— 差的全是 a/is/the/of。
  // 中文侧早就有虚词规则，英文侧一直漏。
  assert.ok(!tokenize('the cat and a dog').has('the'), '英文停用词不进词表')
  assert.ok(!tokenize('the cat and a dog').has('and'), '连词也不进')
  assert.ok(tokenize('the cat and a dog').has('cat'), '内容词要保留')
  assert.ok(tokenize('how are you').size > 0, '全停用词查询退化为不过滤，不能变空集')
  assert.ok(tokenize('https://github.com/x').has('github'), 'URL 子词不受停用词影响')
  ok('v3.15 英文停用词过滤 + 全停用词退化 + URL 子词不受影响')
}

// ---- v3.16 卡片导出（学 dsh-viya-memory 的「记忆要看得见」） ----
{
  const card = cardMarkdown({
    id: 'm99', kind: 'rule', tag: 'ux', tags: ['a', 'b'], scope: 'global',
    text: '记忆应该是人能看见的文件', pinned: true, importance: 9,
    addedAt: '2026-10-30T01:02:03.000Z', updatedAt: '2026-10-30T04:05:06.000Z',
    staleAfter: '2026-01-01',
  }, '2026-10-30')
  assert.ok(card.startsWith('---\n'), '卡片以 frontmatter 开头')
  assert.ok(card.includes('id: m99'), '带 id')
  assert.ok(card.includes('pinned: true'), '带 pinned')
  assert.ok(card.includes('created: 2026-10-30'), '日期只取前半段')
  assert.ok(card.includes('recheck: true'), '已过期卡打 recheck 标记')
  assert.ok(card.includes('记忆应该是人能看见的文件'), '正文在 frontmatter 之外')
  assert.ok(!card.includes('undefined'), '不输出 undefined 字段')
  const withAliases = cardMarkdown({ id: 'm98', text: 'x', aliases: ['别名一'] }, '2026-10-30')
  assert.ok(withAliases.includes('aliases: [别名一]'), '别名写进 frontmatter')
  assert.equal(slugOf('记忆 卡片/测试'), '记忆-卡片-测试', 'slug 保留中文、分隔符压缩')
  assert.equal(slugOf(''), 'card', '空文本回落 card')
  ok('v3.16 卡片导出：frontmatter 字段 / 过期标记 / slug')
}

// ---- v3.17 规则文件沉淀（补「库里根本没记」的缺口） ----
{
  const md = [
    '# 标题不算',
    '',
    '- 插件代码必须放 D 盘，不落 C 盘',
    '- 这是一句普通说明，没有硬规则词',
    '| 表格 | 内容 |',
    '```js',
    '// 必须 在代码块里不算',
    '```',
    '> 引用里的必须也不算',
    '- 看资料按这个顺序，不要一上来只搜：',
  ].join('\n')
  const got = extractRuleCandidates(md)
  assert.equal(got.length, 1, '只抽硬规则行（跳过标题/表格/代码块/引用/引导句）')
  assert.ok(got[0].text.includes('D 盘'), '内容对')
  assert.equal(got[0].kind, 'rule', 'kind 是 rule')
  const taken = new Set([got[0].text])
  assert.equal(extractRuleCandidates(md, taken).length, 0, '已存在的不重复抽')
  assert.ok(collectRuleFiles('D:\\AI-date\\dsh-date\\dsh-创建').length >= 1, '能列出本工作区规则文件')
  ok('v3.17 规则文件沉淀：只抽硬规则 / 跳过代码块表格 / 去重')
}

// ---- v3.18 自动入库的预算保护前提：deprecated 不占预算、不注入 ----
{
  const pool = [
    { id: 'k1', text: '规则一：插件必须同时配测试并跑 npm run check', kind: 'rule', status: 'draft' },
    { id: 'k2', text: '旧条目应该被归档掉不再出现', kind: 'fact', status: 'deprecated', archivedAt: '2026-10-30', archiveReason: 'auto-archive' },
  ]
  const out = renderMemory(pool, { maxInjectChars: 600 })
  assert.ok(!out.includes('旧条目'), 'deprecated 条目不注入')
  assert.ok(out.includes('规则一'), 'draft 规则仍注入')
  ok('v3.18 归档机制：deprecated 不注入、draft 参与注入')
}

// ---- v3.19 时效降权（过期不丢，但排序压后） ----
{
  const stale = { id: 's1', text: '验证门在收工前自动跑', staleAfter: '2026-01-01' }
  const fresh = { id: 's2', text: '验证门在收工前自动跑' }
  assert.equal(isStaleEntry(stale, '2026-10-30'), true, '过期判据')
  assert.equal(isStaleEntry(fresh, '2026-10-30'), false, '没有 staleAfter 不算过期')
  const ranked = scoreEntries([stale, fresh], '验证门 收工前').sort((a, b) => b.score - a.score)
  assert.equal(ranked[0].entry.id, 's2', '同样文本时未过期的排前面')
  ok('v3.19 时效降权：过期条目仍可检索，但排序压后')
}

// ---- v3.19 自动入库 + 预算保护：真跑一遍 turn-stopping（闭包逻辑的集成测试） ----
{
  const workTmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-ws-'))
  const storeTmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-auto-'))
  writeFileSync(path.join(workTmp, 'AGENTS.md'), '- 部署前必须跑 npm run check 并确认输出\n', 'utf8')
  const defs = new Map()
  const layers = []
  const handlers = new Map()
  const ctx = {
    tools: { register: (d) => { defs.set(d.name, d); return () => {} } },
    effect: (fn) => fn(),
    on: (name, h) => { handlers.set(name, h); return () => {} },
    get: (name) => (name === 'workingDirectory' ? { get: () => workTmp } : undefined),
    systemPrompt: { context: (layer) => { layers.push(layer); return () => {} } },
  }
  // 故意把 maxBytes 配小（600），塞一条 580 字符的填充记忆，
  // 让「规则（21 字符）自动入库」必然触发一次归档 —— 这才测得到预算保护。
  apply(ctx, { storeDir: storeTmp, maxInjectChars: 1500, maxBytes: 600 })
  const session = { id: 's-auto' }
  layers[0].text({ agent: { session } })
  await defs.get('memory_add').execute({ text: '填充记忆 ' + 'x'.repeat(570), kind: 'fact' })
  const before = await defs.get('memory_list').execute({})
  assert.ok(before.usedChars > 500, '预算应先被塞到 500+，实际 ' + before.usedChars)

  const ts = handlers.get('agent/turn-stopping')
  assert.equal(typeof ts, 'function', '注册了 turn-stopping')
  await ts({ agent: { id: 's-auto', session: { deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: '今天天气不错' }] }] } } })

  const after = await defs.get('memory_list').execute({})
  const auto = after.entries.filter((e) => e.text.includes('部署前必须跑'))
  assert.equal(auto.length, 1, '规则自动入库一条')
  assert.equal(auto[0].status, 'draft', '自动入库标 draft')
  assert.equal(auto[0].kind, 'rule', 'kind 是 rule')
  // v3.20：归档条目默认不在 memory_list 里（分文件冷存），要看需 includeArchived:true。
  const afterAll = await defs.get('memory_list').execute({ includeArchived: true })
  const archived = afterAll.entries.filter((e) => e.status === 'deprecated' && e.archiveReason !== undefined)
  assert.ok(archived.length >= 1, '预算不够时应有条目被归档，实际 ' + archived.length)
  assert.ok(after.usedChars <= after.maxBytes, '归档后不超预算：' + after.usedChars + '/' + after.maxBytes)
  ok('v3.19 自动入库集成：规则进库(draft) + 预算不足时归档腾地方')
  rmSync(workTmp, { recursive: true, force: true })
  rmSync(storeTmp, { recursive: true, force: true })
}

// ---- v3.20 归档分文件冷存（archive.json）：主库只留生效、列表默认不吐归档、归档可恢复 ----
{
  const sepDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-archive-'))
  writeFileSync(
    path.join(sepDir, 'memory.json'),
    JSON.stringify({
      nextId: 5,
      version: 1,
      entries: [
        { id: 'm1', text: '生效条目：插件放 D 盘', kind: 'rule' },
        { id: 'm2', text: '被 m1 取代的旧说法', supersededBy: 'm1' },
        { id: 'm3', text: '被预算保护挤掉的条目', status: 'deprecated', archivedAt: '2026-10-30T00:00:00.000Z', archiveReason: 'auto-archive' },
      ],
    }),
    'utf8',
  )
  const h = host(sepDir)
  const listed = await h.defs.get('memory_list').execute({})
  assert.equal(listed.active, 1, '生效 1 条')
  assert.equal(listed.archived, 2, '归档 2 条')
  assert.equal(listed.entries.length, 1, '默认只返回生效条目')
  assert.equal(listed.includeArchived, false, '显式回显 includeArchived=false')

  const all = await h.defs.get('memory_list').execute({ includeArchived: true })
  assert.equal(all.entries.length, 3, 'includeArchived:true 才返回全部 3 条')
  ok('v3.20 memory_list 默认不返回归档，includeArchived:true 才列全')

  // 触发一次 persist：归档条目应落到 archive.json，主库只剩生效的
  await h.defs.get('memory_add').execute({ text: '新加一条生效记忆', kind: 'fact' })
  const mainRaw = JSON.parse(readFileSync(path.join(sepDir, 'memory.json'), 'utf8'))
  const archRaw = JSON.parse(readFileSync(path.join(sepDir, 'archive.json'), 'utf8'))
  assert.ok(
    mainRaw.entries.every((e) => !e.supersededBy && e.status !== 'deprecated'),
    '主库 memory.json 不应再含归档条目',
  )
  assert.equal(archRaw.entries.length, 2, 'archive.json 收 2 条归档')
  ok('v3.20 persist 分文件：memory.json 只留生效，archive.json 存归档')

  // 重载后归档仍在（loadArchive 合并回来），且总数对得上
  const h2 = host(sepDir)
  const listed2 = await h2.defs.get('memory_list').execute({})
  assert.equal(listed2.active, 2, '重载后生效 2 条')
  assert.equal(listed2.archived, 2, '重载后归档 2 条（从 archive.json 读回）')
  ok('v3.20 重载后归档不丢：archive.json 被合并回内存态')

  // v3.19 自动归档写的 archivedAt/archiveReason 必须在 schema 里声明 —— 否则工具层校验整条失败，
  // memory_list 会直接报 invalid output（本次实测踩到：真实库里 1 条自动归档就足以让列表全挂）。
  const withMeta = await h2.defs.get('memory_list').execute({ includeArchived: true })
  const archivedSample = withMeta.entries.find((e) => e.id === 'm3')
  assert.ok(archivedSample.archivedAt !== undefined, '归档条目应带 archivedAt')
  assert.ok(archivedSample.archiveReason !== undefined, '归档条目应带 archiveReason')
  for (const key of ['archivedAt', 'archiveReason']) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(memoryEntrySchema.properties, key),
      'memoryEntrySchema 必须声明 ' + key + '（否则 additionalProperties:false 会拒掉整条工具返回）',
    )
  }
  ok('v3.20 schema 覆盖归档元字段（修 v3.19 漏声明导致 memory_list 整条拒绝）')

  // 被取代的不许恢复；纯归档的可以恢复，恢复后预算/生效数都对
  let rejected = false
  try {
    await h2.defs.get('memory_restore').execute({ id: 'm2' })
  } catch (error) {
    rejected = true
  }
  assert.equal(rejected, true, '被 supersededBy 取代的条目不许直接恢复')
  const restored = await h2.defs.get('memory_restore').execute({ id: 'm3' })
  assert.equal(restored.restored, true, '纯归档条目可恢复')
  const listed3 = await h2.defs.get('memory_list').execute({})
  assert.equal(listed3.active, 3, '恢复后生效 3 条')
  assert.equal(listed3.archived, 1, '恢复后归档剩 1 条')
  const restoredEntries = await h2.defs.get('memory_list').execute({ includeArchived: true })
  const m3 = restoredEntries.entries.find((e) => e.id === 'm3')
  assert.equal(m3.status, undefined, '恢复后 status 被清掉')
  ok('v3.20 memory_restore：拒绝被取代条目，纯归档可恢复且清掉 deprecated 标记')

  // 归档文件损坏不能连累主库启动
  writeFileSync(path.join(sepDir, 'archive.json'), '{ 这不是 JSON', 'utf8')
  const h3 = host(sepDir)
  const listedCorrupt = await h3.defs.get('memory_list').execute({})
  assert.equal(listedCorrupt.active, 3, '归档损坏时主库仍全部生效')
  assert.equal(listedCorrupt.archived, 0, '归档损坏当作没有归档')
  assert.equal(listedCorrupt.health, 'ok', '健康态不被归档损坏污染')
  ok('v3.20 归档文件损坏 fail-safe：不抛错、不污染主库')

  rmSync(sepDir, { recursive: true, force: true })
}

// ---- v3.21 预算放宽 + append-only 历史 + 批量清归档 ----
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-v321-'))
  const h = host(dir)
  const listed = await h.defs.get('memory_list').execute({})
  assert.equal(listed.maxBytes, 12000, '默认存储预算应为 12000（v3.21 放宽）')
  ok('v3.21 默认存储预算 8000 → 12000（注入预算不变，仍 1200/1500）')

  const added = await h.defs.get('memory_add').execute({ text: '历史用例：先加一条', kind: 'fact' })
  await h.defs.get('memory_update').execute({ id: added.entry.id, text: '历史用例：改一下' })
  await h.defs.get('memory_remove').execute({ id: added.entry.id })
  const hist = await h.defs.get('memory_history').execute({ limit: 50 })
  const events = hist.entries.map((e) => e.event)
  assert.ok(events.includes('add'), '历史里应有 add，实际 ' + events.join(','))
  assert.ok(events.includes('update'), '历史里应有 update')
  assert.ok(events.includes('remove'), '历史里应有 remove')
  const removedEvent = hist.entries.find((e) => e.event === 'remove' && e.id === added.entry.id)
  assert.ok(String(removedEvent.text).includes('历史用例'), 'remove 事件要留下被删正文（截断前 400 字）')
  const onlyMine = await h.defs.get('memory_history').execute({ id: added.entry.id })
  assert.ok(onlyMine.matched >= 2, '按 id 过滤应命中多条，实际 ' + onlyMine.matched)
  ok('v3.21 append-only 历史：add/update/remove 落 history.jsonl，可按 id 过滤')

  const dir2 = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-purge-'))
  writeFileSync(
    path.join(dir2, 'memory.json'),
    JSON.stringify({
      nextId: 9,
      version: 1,
      entries: [
        { id: 'm1', text: '生效记忆', kind: 'rule' },
        { id: 'm2', text: '旧说法', supersededBy: 'm1' },
        { id: 'm3', text: '被挤掉的', status: 'deprecated', archivedAt: '2026-10-01T00:00:00.000Z', archiveReason: 'auto-archive' },
      ],
    }),
    'utf8',
  )
  const hp = host(dir2)
  let refused = false
  try {
    await hp.defs.get('memory_purge').execute({ confirm: false })
  } catch (error) {
    refused = true
  }
  assert.equal(refused, true, '没有 confirm:true 必须拒绝')
  const purged = await hp.defs.get('memory_purge').execute({ confirm: true })
  assert.equal(purged.purged, 2, '应删 2 条归档（superseded + deprecated）')
  const afterPurge = await hp.defs.get('memory_list').execute({})
  assert.equal(afterPurge.active, 1, '生效记忆不受影响')
  assert.equal(afterPurge.archived, 0, '归档已清零')
  const historyAfter = await hp.defs.get('memory_history').execute({ limit: 50 })
  assert.ok(historyAfter.entries.filter((e) => e.event === 'remove').length >= 2, 'purge 也要进历史（remove 事件）')
  ok('v3.21 memory_purge：无 confirm 拒绝；只删归档、生效记忆不动，且进历史')
  rmSync(dir, { recursive: true, force: true })
  rmSync(dir2, { recursive: true, force: true })
}

// v3.23：inject:false 只参与检索、不占每轮注入预算（事实/历史类条目）
{
  const fact = { id: 'f1', text: 'FACT-ONLY-SEARCHABLE', kind: 'fact', inject: false }
  const ruleItem = { id: 'r1', text: 'RULE-ALWAYS-IN', kind: 'rule' }
  const both = renderMemory([fact, ruleItem], { maxInjectChars: 800 })
  assert.equal(both.includes('FACT-ONLY-SEARCHABLE'), false, 'inject:false 不能进注入块')
  assert.equal(both.includes('RULE-ALWAYS-IN'), true, '普通条目照常注入')
  const onlyFact = renderMemory([fact], { maxInjectChars: 800 })
  assert.equal(onlyFact.includes('FACT-ONLY-SEARCHABLE'), false, '只剩 inject:false 时也不出现')
  assert.equal(normalizeEntry({ id: 'x', text: 'y', inject: false }).inject, false, 'normalizeEntry 保留 inject:false')
  assert.equal(normalizeEntry({ id: 'x', text: 'y' }).inject, undefined, '缺省不写 inject 字段')
  assert.equal(normalizeEntry({ id: 'x', text: 'y', inject: true }).inject, undefined, 'inject:true 不落盘（缺省即注入）')
  ok('v3.23 inject:false：只检索不注入，且缺省行为不变')
}

console.log(`memory: ${passed} 项通过`)


