import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  apply,
  lintTask,
  makeId,
  normalizeConfidence,
  normalizeTier,
  parseRef,
  readActiveWorkspace,
  renderReport,
} from '../../dsh-research/index.js'

let passed = 0
const ok = (label) => { passed += 1; console.log('  ✓ ' + label) }

const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-research-'))
const work = path.join(root, 'work')
mkdirSync(work, { recursive: true })
const notePath = path.join(work, 'note.md')
writeFileSync(notePath, ['# 标题', '', '第一行', '第二行', '第三行'].join('\n'), 'utf8')
const storeDir = path.join(root, 'store')

let storeSeq = 0
const host = (extra) => {
  const defs = new Map()
  const dir = extra && extra.storeDir ? extra.storeDir : path.join(root, 'store-' + (++storeSeq))
  const ctx = {
    tools: { register: (definition) => { defs.set(definition.name, definition); return () => {} } },
    effect: (fn) => fn(),
    on: () => () => {},
  }
  apply(ctx, { storeDir: dir, workspaceDir: work, outDir: path.join(root, 'out'), ...(extra ?? {}) })
  return { defs, storeDir: dir }
}

const checker = (ref) => {
  const abs = path.isAbsolute(ref.value) ? ref.value : path.resolve(work, ref.value)
  if (!existsSync(abs)) return { ok: false, reason: '文件不存在' }
  const lines = readFileSync(abs, 'utf8').split(/\r?\n/).length
  if (ref.end > lines) return { ok: false, reason: '行号越界' }
  return { ok: true }
}

// ---- 纯函数 ----
{
  assert.equal(makeId('obsidian-bridge', Date.parse('2026-11-01T10:00:00+08:00')), 'obsidian-bridge-20261101')
  assert.match(makeId('', 0), /^r-19700101-[a-z0-9]{4}$/)
  assert.equal(makeId('中文', Date.parse('2026-11-01T00:00:00+08:00')).indexOf('中文'), -1, '非 ascii 会被清洗')
  assert.deepEqual(parseRef('https://example.com/a'), { kind: 'url', value: 'https://example.com/a' })
  assert.deepEqual(parseRef('note.md:3'), { kind: 'file', value: 'note.md', start: 3, end: 3 })
  assert.deepEqual(parseRef('note.md:2-4'), { kind: 'file', value: 'note.md', start: 2, end: 4 })
  assert.equal(parseRef('D:/AI/x.md:12').kind, 'file')
  assert.equal(parseRef('就是感觉').kind, 'none')
  // 2026-11-02：#25 扩展合法证据形态（arXiv 规范化为 abs 链接）
  assert.deepEqual(parseRef('arXiv:2410.12345'), { kind: 'url', value: 'https://arxiv.org/abs/2410.12345' })
  assert.deepEqual(parseRef('arxiv:2410.12345v2'), { kind: 'url', value: 'https://arxiv.org/abs/2410.12345v2' }, '带版本后缀也要规范化')
  assert.deepEqual(parseRef('arXiv:hep-th/9901001'), { kind: 'url', value: 'https://arxiv.org/abs/hep-th/9901001' })
  assert.deepEqual(parseRef('session:abc123'), { kind: 'session', value: 'abc123' })
  assert.deepEqual(parseRef('git:9F2C1A0'), { kind: 'git', value: '9f2c1a0' })
  // 断的形态仍拒
  assert.equal(parseRef('arXiv:2410').kind, 'none', '不完整 arXiv 编号要拒')
  assert.equal(parseRef('arXiv:abc').kind, 'none', '非数字 arXiv 编号要拒')
  assert.equal(parseRef('session:').kind, 'none', '空 session id 要拒')
  assert.equal(parseRef('session:' + 'a'.repeat(65)).kind, 'none', 'session id 超过 64 字符要拒')
  assert.equal(parseRef('git:9f2c1a').kind, 'none', 'git sha 少于 7 位要拒')
  assert.equal(parseRef('git:' + 'a'.repeat(41)).kind, 'none', 'git sha 超过 40 位要拒')
  assert.equal(parseRef('git:zzzzzzz').kind, 'none', 'git sha 非 hex 要拒')
  assert.equal(parseRef('session:abc 123').kind, 'none', 'session id 含空格要拒')
  assert.equal(normalizeTier('PAPER'), 'paper')
  assert.equal(normalizeTier('blog'), '')
  assert.equal(normalizeConfidence('high', 'search'), 'medium')
  assert.equal(normalizeConfidence('', 'source'), 'high')
  ok('纯函数：id / 引用解析 / tier / 搜索摘要降级')
}

// ---- lintTask ----
{
  const task = {
    id: 't1',
    evidence: [
      { id: 'e1', claim: '有落点', tier: 'source', ref: 'note.md:2', confidence: 'high' },
      { id: 'e2', claim: '断引用', tier: 'source', ref: 'note.md:99', confidence: 'high' },
      { id: 'e3', claim: '推断', tier: 'search', ref: '', confidence: 'medium', inferred: true },
      { id: 'e4', claim: '只有链接', tier: 'official', ref: 'https://x.dev', confidence: 'medium' },
      { id: 'e5', claim: '会话日志里看到的', tier: 'source', ref: 'session:abc123', confidence: 'high' },
      { id: 'e6', claim: '源码里一行为证', tier: 'source', ref: 'git:9f2c1a0', confidence: 'high' },
    ],
  }
  const lint = lintTask(task, checker)
  assert.equal(lint.total, 6)
  assert.equal(lint.inferred, 1)
  assert.equal(lint.missingEvidence, 0, '推断项不计入「无落点」')
  assert.equal(lint.uncheckedUrls, 1)
  assert.equal(lint.uncheckedRefs, 2, 'session / git 是格式合法但未核对的落点')
  assert.equal(lint.brokenRefs.length, 1, 'note.md:99 应判为断引用')
  assert.equal(lint.canClose, false)
  ok('lintTask：落点 / 推断 / 链接未核 / 断引用 / 不能收尾')
}

// 2026-11-02：#25 新增形态不能当断引用；只有格式合法的落点也能收尾
{
  const task = {
    id: 't2',
    evidence: [
      { id: 'e1', claim: '论文里写的', tier: 'paper', ref: 'arXiv:2410.12345', confidence: 'high' },
      { id: 'e2', claim: '会话里看到的', tier: 'source', ref: 'session:s-2026-11-02', confidence: 'high' },
      { id: 'e3', claim: '提交里写的', tier: 'source', ref: 'git:9f2c1a0', confidence: 'high' },
    ],
  }
  const lint = lintTask(task, checker)
  assert.equal(lint.missingEvidence, 0, '三种新形态都算有落点')
  assert.equal(lint.brokenRefs.length, 0, '不能拿文件核对去查 arXiv/session/git')
  assert.equal(lint.uncheckedUrls, 1, 'arXiv 规范化为链接 → 归入链接未核对')
  assert.equal(lint.uncheckedRefs, 2)
  assert.equal(lint.canClose, true)
  ok('lintTask：arXiv / session / git 有落点、不误判断引用、不挡收尾')
}

// ---- renderReport ----
{
  const md = renderReport({ id: 't1', question: '问', decision: '决定什么', evidence: [] }, 0)
  assert.ok(md.indexOf('# 问') !== -1)
  assert.ok(md.indexOf('## 未验证 / 推断') !== -1)
  const md2 = renderReport({ id: 't2', question: 'q', decision: 'd', evidence: [{ id: 'e1', claim: '结论一', tier: 'paper', ref: 'https://a.b/c', confidence: 'high' }] }, 0)
  assert.ok(md2.indexOf('| 1 | 结论一 | https://a.b/c') !== -1, '结论表要有行')
  assert.ok(md2.indexOf('论文') !== -1, '层级要翻成中文')
  ok('renderReport：标题 / 结论表 / 未验证区 / 层级中文')
}

// ---- research_new ----
{
  const h = host({})
  const created = h.defs.get('research_new')
  const short = await created.execute({ question: '问清楚吗', decision: '了解一下' })
  assert.equal(short.ok, false, 'decision 太短必须拒')
  const tiny = await created.execute({ question: '短', decision: '决定一个具体的取舍' })
  assert.equal(tiny.ok, false, 'question 太短也拒')
  const good = await created.execute({ question: '观测石桥怎么接', decision: '决定是否引入 Obsidian 索引插件', slug: 'bridge' })
  assert.equal(good.ok, true)
  assert.equal(good.id, 'bridge-' + new Date().getFullYear() + String(new Date().getMonth() + 1).padStart(2, '0') + String(new Date().getDate()).padStart(2, '0'))
  assert.ok(existsSync(path.join(h.storeDir, 'store.json')), 'store 要落盘')
  ok('research_new：含糊问题拒绝 + 正常建任务')
}

// ---- research_evidence ----
{
  const h = host({})
  await h.defs.get('research_new').execute({ question: '这批证据记到哪', decision: '决定是否采纳这个方案' })
  const ev = h.defs.get('research_evidence')
  const empty = await ev.execute({ claim: '没有落点的结论', tier: 'source' })
  assert.equal(empty.ok, false, '没落点且没标 inferred 必须拒')
  const badTier = await ev.execute({ claim: '一条结论', tier: 'blog', ref: 'https://a.b' })
  assert.equal(badTier.ok, false, 'tier 非法要拒')
  const url = await ev.execute({ claim: '官方说 tags 必须是列表', tier: 'official', ref: 'https://obsidian.md/changelog', confidence: 'high' })
  assert.equal(url.ok, true)
  assert.equal(url.verified, false, 'url 离线只校验格式')
  const fileRef = await ev.execute({ claim: '第 2 行是第一行', tier: 'source', ref: 'note.md:2' })
  assert.equal(fileRef.ok, true)
  assert.equal(fileRef.verified, true, '文件引用要真核对')
  const broken = await ev.execute({ claim: '引用了不存在的行', tier: 'source', ref: 'note.md:99' })
  assert.equal(broken.ok, true)
  assert.equal(broken.verified, false)
  const searchHigh = await ev.execute({ claim: '搜索摘要的结论', tier: 'search', ref: 'https://a.b/c', confidence: 'high' })
  assert.equal(searchHigh.ok, true)
  const inferred = await ev.execute({ claim: '我猜是这样', tier: 'source', inferred: true })
  assert.equal(inferred.ok, true, 'inferred 允许无落点')
  // 2026-11-02：#25 三种合法形态要收，断的形态仍拒
  const arxiv = await ev.execute({ claim: '论文说上下文越长召回越差', tier: 'paper', ref: 'arXiv:2410.12345' })
  assert.equal(arxiv.ok, true, 'arXiv 编号应被接受')
  assert.equal(arxiv.refKind, 'url')
  assert.equal(arxiv.verified, false, '离线只校验格式')
  const sessionRef = await ev.execute({ claim: '会话日志里出现过', tier: 'source', ref: 'session:abc123' })
  assert.equal(sessionRef.ok, true, 'session id 应被接受')
  assert.equal(sessionRef.refKind, 'session')
  assert.equal(sessionRef.verified, false)
  const gitRef = await ev.execute({ claim: '提交里有这一行', tier: 'source', ref: 'git:9f2c1a0' })
  assert.equal(gitRef.ok, true, 'git sha 应被接受')
  assert.equal(gitRef.refKind, 'git')
  assert.equal(gitRef.verified, false)
  for (const bad of ['arXiv:abc', 'session:' + 'a'.repeat(65), 'git:9f2c1a', 'git:zzzzzzz']) {
    const rejected = await ev.execute({ claim: '形态不合法', tier: 'paper', ref: bad })
    assert.equal(rejected.ok, false, `${bad} 应被拒`)
    assert.equal(rejected.code, 'EVIDENCE_UNVERIFIABLE')
  }
  ok('research_evidence：无落点拒 / url 未核 / 文件核对 / 断引用标 false / inferred 放行 / arXiv·session·git 收、坏形态拒')
}

// ---- research_check + report ----
{
  const h = host({})
  await h.defs.get('research_new').execute({ question: '这批证据记到哪', decision: '决定是否采纳这个方案' })
  const ev = h.defs.get('research_evidence')
  const check = h.defs.get('research_check')
  const report = h.defs.get('research_report')
  await ev.execute({ claim: '再次引用坏行', tier: 'source', ref: 'note.md:99' })
  const lint = await check.execute({})
  assert.equal(lint.ok, true)
  assert.ok(lint.brokenRefs.length >= 1)
  assert.equal(lint.canClose, false)
  const outFile = path.join(root, 'out', 'out-r1.md')
  const refused = await report.execute({ outPath: outFile })
  assert.equal(refused.ok, false, '有断引用时不该出报告')
  assert.ok(refused.blockedBy.length > 0)
  const forced = await report.execute({ outPath: outFile, allowIncomplete: true, title: '测试报告' })
  assert.equal(forced.ok, true)
  assert.ok(existsSync(forced.path))
  const md = readFileSync(forced.path, 'utf8')
  assert.ok(md.indexOf('# 测试报告') !== -1)
  assert.ok(md.indexOf('## 未验证 / 推断') !== -1)
  ok('检查/报告：断引用挡住报告，allowIncomplete 才出，文件含未验证区')
}

// ---- B5（2026-11-03 审计 M6）：outPath 默认只允许落在 outDir（<workspace>/_research）----
{
  const h = host({})
  await h.defs.get('research_new').execute({ question: '报告能不能写到任意路径', decision: '决定是否收紧 outPath 白名单' })
  await h.defs.get('research_evidence').execute({ claim: '有一条可核对落点', tier: 'official', ref: 'https://example.com/x', confidence: 'high' })
  const report = h.defs.get('research_report')
  const outDir = path.join(root, 'out')
  const inside = path.join(outDir, 'sub', 'ok.md')
  const written = await report.execute({ outPath: inside })
  assert.equal(written.ok, true, JSON.stringify(written))
  assert.equal(written.path, inside)
  assert.ok(existsSync(inside))

  const outside = path.join(root, 'outside-b5.md')
  const blocked = await report.execute({ outPath: outside })
  assert.equal(blocked.ok, false, '绝对路径越界必须拒')
  assert.equal(blocked.code, 'RESEARCH_OUTPATH_INVALID')
  assert.match(blocked.lastError, /allowOutsideWorkspace/)
  assert.equal(existsSync(outside), false, '被拒时不许落盘')

  const traversal = await report.execute({ outPath: '../escape-b5.md' })
  assert.equal(traversal.ok, false)
  assert.equal(traversal.code, 'RESEARCH_OUTPATH_INVALID', '.. 穿越必须拒')
  assert.equal(existsSync(path.join(root, 'escape-b5.md')), false)

  const optIn = await report.execute({ outPath: outside, allowOutsideWorkspace: true })
  assert.equal(optIn.ok, true, '显式 opt-in 才允许外部路径')
  assert.ok(existsSync(outside))
  ok('B5：outPath 默认锁在 outDir 内，绝对/.. 越界报 RESEARCH_OUTPATH_INVALID，allowOutsideWorkspace 才放行')
}

// ---- 收尾与状态 ----
{
  const h = host({})
  await h.defs.get('research_new').execute({ question: '这批证据记到哪', decision: '决定是否采纳这个方案' })
  const ev = h.defs.get('research_evidence')
  const report = h.defs.get('research_report')
  const status = h.defs.get('research_status')
  await ev.execute({ claim: '这条能核对', tier: 'source', ref: 'note.md:1' })
  const written = await report.execute({ outPath: path.join(root, 'out', 'out-r2.md'), close: true })
  assert.equal(written.ok, true)
  assert.equal(written.closed, true)
  const after = await ev.execute({ claim: '收尾后还能记吗', tier: 'source', ref: 'note.md:1' })
  assert.equal(after.ok, false, '关掉的任务不能再加证据')
  const st = await status.execute({})
  assert.equal(st.ok, true)
  assert.ok(st.tasks >= 1)
  assert.equal(st.open, 0)
  assert.ok(st.latest.length > 0)
  ok('收尾：close 后拒绝再加证据；status 报任务/证据/开放数')
}

// ---- readActiveWorkspace：默认工作区别拿插件 cwd ----
{
  const home = path.join(root, 'dsh-home')
  mkdirSync(path.join(home, 'storages'), { recursive: true })
  writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify({ tables: { workspaces: {
    a: { path: 'D:/old-workspace', updatedAt: '2026-10-01T00:00:00.000Z' },
    b: { path: 'D:/new-workspace', updatedAt: '2026-11-01T00:00:00.000Z' },
  } } }), 'utf8')
  assert.equal(readActiveWorkspace({ DSH_HOME: home }), 'D:/new-workspace', '取最近更新的工作区')
  assert.equal(readActiveWorkspace({ DSH_HOME: path.join(root, 'missing-home') }), '', '没有 storages 时返回空串')
  assert.equal(readActiveWorkspace({}), '', '没有 env 时返回空串而不是抛')
  ok('readActiveWorkspace：取最近工作区 / 缺失回落空串')
}

// ---- fail-safe ----
{
  const blocker = path.join(root, 'blocker')
  writeFileSync(blocker, 'not a dir', 'utf8')
  const h = host({ storeDir: path.join(blocker, 'nested') })
  const result = await h.defs.get('research_new').execute({ question: '还能开吗', decision: '决定写不写得进去' })
  assert.equal(result.ok, false, '写不进去要 ok:false')
  assert.ok(String(result.lastError).length > 0, '要记 lastError，而不是抛')
  ok('fail-safe：store 不可写时 ok:false + lastError，不抛')
}

rmSync(root, { recursive: true, force: true })
console.log('research: ' + passed + ' 项通过')
