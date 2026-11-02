// dsh-memory v4.2（集百家所长）回归：四个长板各自有机器判据。
// 覆盖：2.1 写入路径过滤（skip 可推导）/ 2.2 kind=reference / 2.3 预算见顶精简建议 / 2.4 kind=procedure 复用门槛。
// 为什么单独一个文件：v4.2 的四条都是「写入策略」，与检索打分无关；放一起回归，改造前后行为可比。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeTmp, cleanup, sweepStaleDirs } from './_tmp-dirs.mjs'
import {
  apply,
  derivableHit,
  deriveStaleAfter,
  importanceOf,
  localDateOf,
  memoryEntrySchema,
  normalizeRuleLine,
  renderMemory,
} from '../../dsh-memory/index.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log('  ✓ ' + label)
}
// 临时目录统一交给 _tmp-dirs.mjs：带 pid、退出兜底、下次运行清扫上次遗留。
// （2026-11-02 修：原来 reference / budget 两个用例压根没清理，5 小时积了 27 个垃圾目录。）
const tmp = (tag) => makeTmp('dsh-memory-v42-' + tag)
sweepStaleDirs()

// 测试宿主：结构与 memory.test.mjs 的 host() 同构；多的能力是能把 cwd 灌进去（写入过滤要读规则源）。
function host(dir, extra) {
  const defs = new Map()
  const layers = []
  const cwd = typeof extra?.cwd === 'string' ? extra.cwd : ''
  const ctx = {
    tools: { register: (definition) => { defs.set(definition.name, definition); return () => {} } },
    effect: (fn) => { fn(); return () => {} },
    on: () => () => {},
    get: (name) => (name === 'workingDirectory' ? { get: () => cwd } : undefined),
    systemPrompt: { context: (layer) => { layers.push(layer); return () => {} } },
  }
  apply(ctx, { storeDir: dir, maxInjectChars: 1500, maxBytes: 20000, captureCandidates: false, captureRuleFiles: false, ...(extra ?? {}) })
  return { defs, layers }
}
const priming = (h) => h.layers[0].text({ agent: { session: {} } })

// ── 2.1 skip 可推导信息（Anthropic A4 / write-path filtering）──
{
  const root = tmp('derive')
  const ws = path.join(root, 'ws')
  mkdirSync(path.join(ws, '.dsh', 'rules'), { recursive: true })
  const ruleLine = '新增插件必须同时配 _selftest/tests/<插件名>.test.mjs，改完跑 npm run check。'
  writeFileSync(
    path.join(ws, '.dsh', 'rules', 'core.md'),
    ['---', 'id: workspace-core', 'always: true', '---', '', '# 核心', '', '- ' + ruleLine, ''].join('\n'),
    'utf8',
  )
  writeFileSync(path.join(ws, 'AGENTS.md'), '# 约定\n\n插件源码放 D 盘，数据落 D 盘 storeDir，不落 C 盘。\n', 'utf8')

  // 纯函数：规则行归一化 + 命中判定（不依赖写入路径）
  assert.equal(normalizeRuleLine('- **必须**先 `read` 再 `edit`。'), '必须先 read 再 edit。', '行归一化要去掉 bullet/加粗/反引号')
  assert.ok(derivableHit(ruleLine, ws) !== null, '与规则行逐字相同的文本必须判为可推导')
  // 真机抓到的那一条：规则行本身带反引号，候选不带（或反过来）——两边都要归一化才能命中
  const quotedRule = '- 新增插件必须同时配 `_selftest/tests/<插件名>.test.mjs`，改完跑 `npm run check`。'
  writeFileSync(
    path.join(ws, '.dsh', 'rules', 'quoted.md'),
    ['---', 'id: quoted', 'always: true', '---', '', quotedRule, ''].join('\n'),
    'utf8',
  )
  assert.ok(derivableHit('新增插件必须同时配 _selftest/tests/<插件名>.test.mjs，改完跑 npm run check。', ws) !== null, '规则带反引号、候选不带 → 也要命中（真机回归）')
  assert.ok(derivableHit(quotedRule, ws) !== null, '规则与候选都带反引号 → 命中')
  assert.ok(derivableHit('新增插件必须同时配 _selftest/tests/<插件名>.test.mjs，改完跑 npm run check', ws) !== null, '尾标点不同的近重复也要命中')
  assert.equal(derivableHit('Obsidian 库在 D 盘，卡片走 vault:// 指针检索。', ws), null, '规则源里没有的句子不能误判')
  ok('2.1 derivableHit：规则行近重复命中，无关文本不误判')

  // 写入路径：命中 → 不入库（skipped 结果，不是报错）
  const h = host(root, { cwd: ws })
  priming(h)
  const skipped = await h.defs.get('memory_add').execute({ text: ruleLine })
  assert.equal(skipped.skipped, true, '可推导的写入必须返回 skipped=true')
  assert.equal(skipped.entry, undefined, '跳过时不写 entry')
  assert.match(String(skipped.deriveSource), /core\.md$/, '要报命中的规则源文件')
  assert.ok(skipped.deriveSimilarity >= 0.86, '相似度要 ≥ 门槛，实际 ' + skipped.deriveSimilarity)
  const afterSkip = await h.defs.get('memory_list').execute({})
  assert.equal(afterSkip.active, 0, '跳过写库：库内条目数不变')
  // 逃生口：force:true 仍可写（例如规则要降级成记忆判据）
  const forced = await h.defs.get('memory_add').execute({ text: ruleLine, force: true })
  assert.ok(forced.entry && forced.entry.id, 'force:true 是逃生口')
  // 无关文本照常入库
  const normal = await h.defs.get('memory_add').execute({ text: 'Obsidian 库在 D 盘，卡片走 vault:// 指针检索。' })
  assert.ok(normal.entry && normal.entry.id, '不可推导的文本照常入库')
  assert.equal(normal.skipped, undefined, '正常写入不带 skipped')
  // 开关：deriveGate:'off' 关闭写路径过滤
  const h2 = host(root, { cwd: ws, deriveGate: 'off' })
  priming(h2)
  const off = await h2.defs.get('memory_add').execute({ text: ruleLine })
  assert.ok(off.entry && off.entry.id, 'deriveGate:off 时不拦')
  ok('2.1 memory_add：可推导 → skipped（不写库），force:true / deriveGate:off 两条逃生口可用')
  cleanup(root)
}

// ── 2.2 reference 类型（Anthropic 四类笔记之一）──
{
  const dir = tmp('reference')
  const h = host(dir)
  const added = await h.defs.get('memory_add').execute({
    text: 'Issue 跟踪在 GitHub 仓库的 Issues 页；系统仪表盘在 Grafana 的 DSH 面板。',
    kind: 'reference',
    entities: ['GitHub', 'Grafana'],
  })
  assert.equal(added.entry.kind, 'reference', 'kind=reference 要原样落库')
  assert.equal(importanceOf(added.entry), 5, 'reference 的重要性基线应为 5（高于 note/fact，低于 rule）')
  const stale = deriveStaleAfter('reference')
  assert.match(stale, /^\d{4}-\d{2}-\d{2}$/, 'reference 有复核期（外部位置会变）')
  const expected = new Date(Date.now() + 180 * 86400000)
  assert.equal(stale, localDateOf(expected), 'reference 复核期 = 180 天')
  // 检索
  const found = await h.defs.get('memory_search').execute({ query: 'Grafana 仪表盘在哪' })
  assert.ok(found.matches.some((item) => item.id === added.entry.id), 'reference 条目要能被 memory_search 检索到')
  // 注入：带 ↗ 前缀（非 pinned 条目在预算紧张时降级成索引行，所以用 pinned 全文路径验标记）
  const layerBlock = h.layers[0].text({ agent: { session: {} } })
  assert.ok(layerBlock.includes('↗ '), '索引行也要能看出是 reference，实际：' + layerBlock.slice(0, 200))
  const full = renderMemory([{ ...added.entry, pinned: true }], { maxInjectChars: 1500 })
  assert.ok(full.includes('↗ ') && full.includes(added.entry.text), '全文注入行要带 reference 标记，实际：' + full.slice(0, 200))
  ok('2.2 reference：写入 / 重要度 / 180 天复核 / 检索 / 注入标记 全部成立')
  cleanup(dir)
}

// ── 2.3 预算见顶：报错里带「建议合并 / drop」具体条目（Anthropic A2）──
{
  const dir = tmp('budget')
  const now = new Date().toISOString()
  writeFileSync(
    path.join(dir, 'memory.json'),
    JSON.stringify({
      version: 2,
      nextId: 9,
      entries: [
        { id: 'm1', text: '部署流程甲：先跑 npm run check，再提交到 git 仓库', kind: 'note', addedAt: now, updatedAt: now },
        { id: 'm2', text: '部署流程甲：先跑 npm run check，再提交到 git 仓库。', kind: 'note', addedAt: now, updatedAt: now },
        { id: 'm3', text: '旧版接口要用 token 认证（已过复核期）', kind: 'fact', staleAfter: '2026-01-01', addedAt: now, updatedAt: now },
        // m4：从未命中、60 天未更新的**规则**——可以合并/归档吗？不行：规则不该被建议 drop（2026-11-02 复核抓到）
        { id: 'm4', text: '硬规则：插件源码放 D 盘，数据不落 C 盘', kind: 'rule', usedCount: 0, addedAt: new Date(Date.now() - 60 * 86400000).toISOString(), updatedAt: new Date(Date.now() - 60 * 86400000).toISOString() },
      ],
    }),
    'utf8',
  )
  // maxBytes 故意小于「现有 + 新条目」，且三条都还新鲜（makeRoom 的 7 天门槛挡不住）→ 走报错路径
  const h = host(dir, { maxBytes: 120 })
  let message = ''
  try {
    await h.defs.get('memory_add').execute({ text: '新记忆'.repeat(40) })
  } catch (error) {
    message = String(error.message)
    assert.equal(error.code, 'MEMORY_BUDGET_EXCEEDED', '仍是 MEMORY_BUDGET_EXCEEDED，带可识别 code')
  }
  assert.ok(message !== '', '见顶时必须报错（而不是静默丢写）')
  assert.match(message, /主动精简建议/, '报错要带精简建议段，实际：' + message)
  assert.match(message, /合并/, '要有合并建议')
  assert.match(message, /m1 \+ m2|m2 \+ m1/, '合并建议要点名相似的两条，实际：' + message)
  assert.match(message, /drop/, '要有 drop 建议')
  assert.match(message, /m3（staleAfter 2026-01-01 已过/, 'drop 建议要点名 stale 条目 m3，实际：' + message)
  assert.ok(!/m4（/.test(message), '规则条目 m4 不能被列为 drop 候选（与 makeRoom 的 kind!==rule 同口径），实际：' + message)
  ok('2.3 预算见顶：错误里带「建议合并 m1+m2 / drop m3（stale）」，且不把规则 m4 当 drop 候选')
  cleanup(dir)
}

// ── 2.4 procedure 类型（Google ADK Procedural / Voyager 验证门槛）──
{
  const dir = tmp('procedure')
  const h = host(dir)
  const text = '先把 dsh-memory 测试跑绿再提交：node _selftest/tests/memory-v42.test.mjs → npm run check → git commit'
  // 门槛：verifiedCount < 2 一律拒（不是「用户说记住」就算）
  await assert.rejects(
    () => h.defs.get('memory_add').execute({ text, kind: 'procedure' }),
    (error) => { assert.equal(error.code, 'MEMORY_PROCEDURE_UNVERIFIED'); return true },
    '没带复用证据的 procedure 必须拒',
  )
  await assert.rejects(
    () => h.defs.get('memory_add').execute({ text, kind: 'procedure', verifiedCount: 1 }),
    (error) => { assert.equal(error.code, 'MEMORY_PROCEDURE_UNVERIFIED'); return true },
    '复用 1 次仍不够，必须 ≥2',
  )
  const added = await h.defs.get('memory_add').execute({ text, kind: 'procedure', verifiedCount: 2 })
  assert.equal(added.entry.kind, 'procedure', 'kind=procedure 落库')
  assert.equal(added.entry.verifiedCount, 2, '复用次数要留证据')
  assert.match(String(added.entry.lastVerifiedAt), /^\d{4}-\d{2}-\d{2}T/, 'lastVerifiedAt 要落 ISO 时间')
  assert.equal(importanceOf(added.entry), 7, 'procedure 的重要性基线应为 7')
  // 检索 + 注入
  const found = await h.defs.get('memory_search').execute({ query: '测试跑绿再提交 流程' })
  assert.ok(found.matches.some((item) => item.id === added.entry.id), 'procedure 能被检索')
  const procFull = renderMemory([{ ...added.entry, pinned: true }], { maxInjectChars: 1500 })
  assert.ok(procFull.includes('⚙ ') && procFull.includes(text), 'procedure 全文注入行要带 ⚙ 标记，实际：' + procFull.slice(0, 200))
  // 复用成功一次 → 累计证据（memory_update）
  const updated = await h.defs.get('memory_update').execute({ id: added.entry.id, verifiedCount: 3 })
  assert.equal(updated.entry.verifiedCount, 3, '复用成功后 verifiedCount 可累加')
  assert.ok(updated.entry.lastVerifiedAt >= added.entry.lastVerifiedAt, 'lastVerifiedAt 随之刷新')
  // 普通条目不能绕过门槛改成 procedure
  const plain = await h.defs.get('memory_add').execute({ text: '普通事实：Grafana 在 D 盘机器上' })
  await assert.rejects(
    () => h.defs.get('memory_update').execute({ id: plain.entry.id, text: plain.entry.text, kind: 'procedure' }),
    (error) => { assert.equal(error.code, 'MEMORY_PROCEDURE_UNVERIFIED'); return true },
    '已经入库的普通条目也不能无证据升级成 procedure',
  )
  // schema 必须声明新字段，否则工具层会整条拒（v3.20 踩过）
  for (const key of ['verifiedCount', 'lastVerifiedAt']) {
    assert.ok(Object.prototype.hasOwnProperty.call(memoryEntrySchema.properties, key), 'memoryEntrySchema 必须声明 ' + key)
  }
  // 卡片导出带证据
  const exported = await h.defs.get('memory_export').execute({})
  const cards = exported.entries.map((item) => readFileSync(item.file, 'utf8'))
  assert.ok(cards.some((card) => /verifiedCount: \d+/.test(card)), '导出卡片要带 verifiedCount')
  cleanup(dir)
  ok('2.4 procedure：verifiedCount≥2 才收 / 落证据 / 可检索 / 可注入 / 可累加 / 不能无证据升级')
}

// ── 2.5 v4.2.1 修 M1/M2/M3：procedure 门槛的三条绕过路径各有机器判据 ──
// 审计依据：_reports/global-audit-memory-2026-11-03.md §2 M1/M2/M3（三条均真机复核为真）。
{
  const dir = tmp('procedure-gate')
  const h = host(dir)

  // M1：同一文本先当 fact 入库，再用 kind:'procedure' 走「去重捷径」——原来 :4019 在门槛 :4093 之前 return。
  const factText = 'M1 绕过用例：同一段正文先当 fact 入库的条目'
  const early = await h.defs.get('memory_add').execute({ text: factText, kind: 'fact' })
  assert.equal(early.entry.kind, 'fact')
  await assert.rejects(
    () => h.defs.get('memory_add').execute({ text: factText, kind: 'procedure' }),
    (error) => { assert.equal(error.code, 'MEMORY_PROCEDURE_UNVERIFIED'); return true },
    'M1：去重命中 + 改 kind=procedure 必须过同一道门槛（不能靠捷径改 kind）',
  )
  const upgraded = await h.defs.get('memory_add').execute({ text: factText, kind: 'procedure', verifiedCount: 2 })
  assert.equal(upgraded.deduped, true, '去重命中仍是同一条（不是新建）')
  assert.equal(upgraded.entry.kind, 'procedure', '显式给证据后允许去重分支升级 kind')
  assert.equal(upgraded.entry.verifiedCount, 2, '证据要落库，不能是 undefined')

  // M2：procedure 条目「只累加证据（无 text）+ supersede」——原来会造一条 text:'' 的新条目并作废旧条。
  const proc = await h.defs.get('memory_add').execute({ text: 'M2 用例：真跑过两遍的可复现流程', kind: 'procedure', verifiedCount: 2 })
  await assert.rejects(
    () => h.defs.get('memory_update').execute({ id: proc.entry.id, verifiedCount: 3, supersede: true }),
    (error) => { assert.equal(error.code, 'MEMORY_ARG_MISSING'); return true },
    'M2：无 text 的 supersede 必须拒绝（否则造出空正文的新条目）',
  )
  const stillThere = await h.defs.get('memory_list').execute({})
  assert.ok(stillThere.active >= 1, '被拒的 update 不能改库')
  const superseded = await h.defs.get('memory_update').execute({ id: proc.entry.id, text: 'M2 用例：真跑过两遍的可复现流程（v2）', supersede: true })
  assert.equal(superseded.superseded, proc.entry.id, '带 text 的 supersede 仍要可用')
  assert.ok(String(superseded.entry.text).trim() !== '', '新条目正文不能为空')

  // M3：fact 条目先灌 verifiedCount，再改 kind=procedure —— 原来两步都放行。
  const fact3 = await h.defs.get('memory_add').execute({ text: 'M3 绕过用例：先当事实入库的条目' })
  await assert.rejects(
    () => h.defs.get('memory_update').execute({ id: fact3.entry.id, verifiedCount: 2 }),
    (error) => { assert.equal(error.code, 'MEMORY_VERIFIEDCOUNT_INVALID'); return true },
    'M3：verifiedCount 只能写在 procedure 条目上（fact 灌计数必须拒）',
  )
  await assert.rejects(
    () => h.defs.get('memory_update').execute({ id: fact3.entry.id, text: fact3.entry.text, kind: 'procedure' }),
    (error) => { assert.equal(error.code, 'MEMORY_PROCEDURE_UNVERIFIED'); return true },
    'M3：改 kind=procedure 必须本次显式给 verifiedCount≥2（不能沿用存量值）',
  )
  const promoted = await h.defs.get('memory_update').execute({ id: fact3.entry.id, text: fact3.entry.text, kind: 'procedure', verifiedCount: 2 })
  assert.equal(promoted.entry.kind, 'procedure', '一次性带证据的升级要允许')
  assert.equal(promoted.entry.verifiedCount, 2)
  // 已是 procedure 的条目允许累加（正常路径不能被门槛误杀）
  const accumulated = await h.defs.get('memory_update').execute({ id: promoted.entry.id, verifiedCount: 3 })
  assert.equal(accumulated.entry.verifiedCount, 3, 'procedure 条目累加证据要允许')
  // kind 离开 procedure → 清掉证据，堵「降级再升级」的沿用
  const downgraded = await h.defs.get('memory_update').execute({ id: promoted.entry.id, text: promoted.entry.text, kind: 'fact' })
  assert.equal(downgraded.entry.kind, 'fact')
  assert.equal(downgraded.entry.verifiedCount, undefined, '降级离开 procedure 要清掉 verifiedCount')

  // M3 同口径：merge 不能把普通条目「合并成」procedure，除非显式给证据
  const mergeA = await h.defs.get('memory_add').execute({ text: 'M3 merge 来源甲：部署流程第一步' })
  const mergeB = await h.defs.get('memory_add').execute({ text: 'M3 merge 来源乙：部署流程第二步' })
  await assert.rejects(
    () => h.defs.get('memory_merge').execute({ ids: [mergeA.entry.id, mergeB.entry.id], kind: 'procedure' }),
    (error) => { assert.equal(error.code, 'MEMORY_PROCEDURE_UNVERIFIED'); return true },
    'merge：来源没有 procedure 证据时不能合并成 procedure',
  )
  const merged = await h.defs.get('memory_merge').execute({ ids: [mergeA.entry.id, mergeB.entry.id], kind: 'procedure', verifiedCount: 2 })
  assert.equal(merged.entry.kind, 'procedure')
  assert.equal(merged.entry.verifiedCount, 2, 'merge 显式证据要落库')
  cleanup(dir)
  ok('v4.2.1 M1/M2/M3：去重改 kind / 空 text supersede / 两步升级 三条绕过路径全被拒，正常路径不误杀')
}

console.log('memory-v42: ' + passed + ' 项通过')
