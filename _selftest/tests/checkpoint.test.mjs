import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { diffTextLines, buildHunks, apply } from '../../dsh-checkpoint/index.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ---------- 第二部分：diff / hunk 纯函数（原有用例） ----------

const same = diffTextLines('a\nb\nc', 'a\nb\nc')
assert.equal(same.added, 0)
assert.equal(same.removed, 0)
ok('相同文本无变化')

const changed = diffTextLines('a\nb\nc', 'a\nB\nc')
assert.equal(changed.added, 1)
assert.equal(changed.removed, 1)
assert.equal(changed.ops.map((op) => `${op.op}:${op.text}`).join('|'), 'keep:a|del:b|add:B|keep:c')
ok('单行替换 = 1 增 1 删，上下文保留')

assert.equal(diffTextLines('a\nb', 'a\nb\nc').added, 1)
ok('追加一行')

assert.equal(diffTextLines('a\nb\nc', '').removed, 3)
ok('回滚到空 = 全部删除')

assert.equal(diffTextLines('x\n'.repeat(700), 'y\n').truncated, true)
ok('超长文本退化为统计')

const lines = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`)
const after = [...lines]
after[5] = 'line-6-changed'
const hunks = buildHunks(diffTextLines(lines.join('\n'), after.join('\n')).ops)
assert.equal(hunks.length, 1)
assert.equal(hunks[0].oldStart, 4)
assert.equal(hunks[0].lines.map((line) => line.op).join(','), 'context,context,del,add,context,context')
ok('单个改动折成一个 hunk（2 行上下文 + 改动对）')

const after2 = [...lines]
after2[0] = 'line-1-changed'
after2[9] = 'line-10-changed'
assert.equal(buildHunks(diffTextLines(lines.join('\n'), after2.join('\n')).ops).length, 2)
ok('相距远的改动拆成两个 hunk')

// ---------- 清理（checkpoint_prune）端到端用例 ----------

/**
 * 假 ctx 加载真实插件：拿到注册的工具定义 + pre-execute 钩子 + 卸载 flush 回调。
 * 组件服务按需注入（ctx.fs / ctx.get(name)），足以驱动 capture 与 prune。
 */
function makeHarness(config, services = {}) {
  const registered = new Map()
  const cleanups = []
  const handlers = new Map()
  const disposer = () => {}
  const ctx = {
    fs: services.fs,
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return disposer
      },
      guard() {
        return disposer
      },
      restrict() {
        return disposer
      },
      schemas() {
        return []
      },
      get() {
        return undefined
      },
    },
    effect(callback) {
      const value = callback()
      if (typeof value === 'function') cleanups.push(value)
      return disposer
    },
    on(event, handler) {
      handlers.set(event, handler)
      return disposer
    },
    provide() {
      return disposer
    },
    inject() {
      return disposer
    },
    get(name) {
      return services[name]
    },
    systemPrompt: { context: () => disposer, section: () => disposer, tools: () => disposer, variable: () => disposer },
  }
  apply(ctx, config)
  const flush = () => {
    for (const cleanup of cleanups) {
      try {
        cleanup()
      } catch {
        // cleanup 是幂等的 no-op，忽略
      }
    }
  }
  return { registered, handlers, flush }
}

const call = (harness, tool, args) => harness.registered.get(tool).execute(args ?? {})

function seedStore(storeDir, records) {
  mkdirSync(storeDir, { recursive: true })
  writeFileSync(path.join(storeDir, 'snapshots.json'), JSON.stringify({ version: 2, savedAt: new Date().toISOString(), records }), 'utf8')
}

const DAY = 24 * 60 * 60 * 1000
const isoDaysAgo = (days) => new Date(Date.now() - days * DAY).toISOString()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 临时目录全部落 D 盘（不落 C 盘）
const dataRoot = 'D:\\AI\\dsh-data'
mkdirSync(dataRoot, { recursive: true })
const root = mkdtempSync(path.join(dataRoot, '_selftest-checkpoint-'))
const work = path.join(root, 'work')
const protectedDir = path.join(root, 'protected')
const storeDir = path.join(root, 'store')
mkdirSync(work, { recursive: true })
mkdirSync(protectedDir, { recursive: true })

const paths = {
  oldA: path.join(work, 'old-a.txt'),
  recentA: path.join(work, 'recent-a.txt'),
  oldB: path.join(work, 'old-b.txt'),
  unknownSession: path.join(work, 'unknown-session.txt'),
  legacy: path.join(work, 'legacy.txt'),
  protectedKeep: path.join(protectedDir, 'keep.txt'),
}
for (const file of Object.values(paths)) writeFileSync(file, `content of ${path.basename(file)}`, 'utf8')

try {
  seedStore(storeDir, [
    { path: paths.oldA, content: 'a', capturedAt: isoDaysAgo(40), created: false, sessionId: 'sess-a' },
    { path: paths.recentA, content: 'a', capturedAt: isoDaysAgo(1), created: false, sessionId: 'sess-a' },
    { path: paths.oldB, content: 'b', capturedAt: isoDaysAgo(40), created: false, sessionId: 'sess-b' },
    // 旧存档：有 capturedAt、但没有 sessionId → 未知会话，不得被按会话清理命中
    { path: paths.unknownSession, content: 'u', capturedAt: isoDaysAgo(40), created: false },
    // 旧存档：连 capturedAt 都没有 → load 兜底为当前时间，且旧字段缺失不报错
    { path: paths.legacy, content: 'l', created: false, sessionId: 'sess-legacy' },
    // 受保护目录里的快照：cleanup 必须跳过，即使时间/会话都命中
    { path: paths.protectedKeep, content: 'p', capturedAt: isoDaysAgo(40), created: false, sessionId: 'sess-a' },
  ])

  const harness = makeHarness({ storeDir, protectDirs: [protectedDir] })
  const prune = (args) => call(harness, 'checkpoint_prune', args)
  const list = () => call(harness, 'checkpoint_list', {})

  const tools = [...harness.registered.keys()]
  assert.equal(tools.length, 7)  // v1.6：+ checkpoint_mark（任务级检查点）
  for (const name of ['checkpoint_list', 'checkpoint_diff', 'checkpoint_restore', 'checkpoint_forget', 'checkpoint_status', 'checkpoint_prune']) {
    assert.ok(tools.includes(name), `缺少工具 ${name}`)
  }
  ok('6 个工具齐全（原有 5 个 + checkpoint_prune）')

  const loaded = await list()
  assert.equal(loaded.total, 6)
  ok('旧存档（缺 sessionId / 缺 capturedAt）可加载且不报错')

  // 不带过滤条件必须拒绝（不能无条件清空）
  await assert.rejects(() => prune({}), /至少需要一个过滤条件/)
  await assert.rejects(() => prune({ olderThanDays: 0 }), /大于 0/)
  await assert.rejects(() => prune({ olderThanDays: -3 }), /大于 0/)
  ok('无过滤条件 / 非法 olderThanDays 直接拒绝')

  // dryRun 默认：只报告，不删记录、不动文件、不落盘
  const beforePreviewFile = readFileSync(path.join(storeDir, 'snapshots.json'), 'utf8')
  const preview = await prune({ olderThanDays: 30 })
  assert.equal(preview.dryRun, true)
  assert.equal(preview.matched, 3)
  assert.equal(preview.forgotten.length, 0)
  assert.equal(preview.wouldForget.length, 3)
  assert.equal(preview.protected, 1)
  assert.equal(preview.remaining, 6)
  assert.ok(preview.wouldForget.includes(paths.oldA) && preview.wouldForget.includes(paths.oldB) && preview.wouldForget.includes(paths.unknownSession))
  assert.ok(!preview.wouldForget.includes(paths.recentA) && !preview.wouldForget.includes(paths.protectedKeep))
  assert.ok(readFileSync(path.join(storeDir, 'snapshots.json'), 'utf8') === beforePreviewFile, 'dryRun 不应改写存档')
  assert.equal((await list()).total, 6)
  for (const file of Object.values(paths)) assert.ok(existsSync(file), `dryRun 不应碰文件：${file}`)
  ok('dryRun（默认）只报告：3 条待清、受保护跳过 1 条，记录与文件都没变')

  // 按会话 dryRun：只命中 sess-a 的两条（受保护那条跳过）
  const bySession = await prune({ sessionId: 'sess-a' })
  assert.equal(bySession.matched, 2)
  assert.equal(bySession.protected, 1)
  assert.equal(bySession.unknown, 1) // 缺 sessionId 的旧记录算未知，不算命中
  assert.deepEqual(new Set(bySession.wouldForget), new Set([paths.oldA, paths.recentA]))
  ok('按会话清理：只命中该会话，缺 sessionId 的旧记录按未知跳过')

  // 会话 + 时间取交集
  const combined = await prune({ sessionId: 'sess-a', olderThanDays: 30 })
  assert.equal(combined.matched, 1)
  assert.deepEqual(combined.wouldForget, [paths.oldA])
  assert.equal(combined.protected, 1)
  ok('会话 + 时间条件取交集（sess-a 且 >30 天 → 仅 old-a）')

  // confirm 红线：dryRun:false 但没 confirm 必须拒绝，且不删任何记录
  await assert.rejects(() => prune({ olderThanDays: 30, dryRun: false }), /confirm: true/)
  assert.equal((await list()).total, 6)
  ok('dryRun:false 不带 confirm 被拒绝，记录不变')

  // 真正清理：dryRun:false + confirm:true
  const pruned = await prune({ olderThanDays: 30, dryRun: false, confirm: true })
  assert.equal(pruned.dryRun, false)
  assert.equal(pruned.matched, 3)
  assert.equal(pruned.forgotten.length, 3)
  assert.equal(pruned.remaining, 3)
  assert.deepEqual(new Set(pruned.forgotten), new Set([paths.oldA, paths.oldB, paths.unknownSession]))
  assert.equal((await list()).total, 3)

  // 红线：记录被删了，但用户文件一个都不能少
  for (const file of Object.values(paths)) assert.ok(existsSync(file), `清理绝不能删用户文件：${file}`)
  ok('confirm 后才真删记录；用户工作区文件全部原样保留（红线）')

  await sleep(350)
  const persistedAfterPrune = JSON.parse(readFileSync(path.join(storeDir, 'snapshots.json'), 'utf8'))
  const persistedPaths = persistedAfterPrune.records.map((record) => record.path)
  assert.equal(persistedPaths.length, 3)
  assert.ok(!persistedPaths.includes(paths.oldA) && !persistedPaths.includes(paths.oldB))
  assert.ok(persistedPaths.includes(paths.protectedKeep) && persistedPaths.includes(paths.recentA))
  ok('清理结果原子落盘：存档只剩 3 条，受保护那条还在')

  // 受保护目录：即使会话 + 时间都命中，也永远不清理
  const protectedAgain = await prune({ sessionId: 'sess-a', olderThanDays: 1, dryRun: false, confirm: true })
  assert.equal(protectedAgain.matched, 1) // recent-a（sess-a，1 天前）
  assert.equal(protectedAgain.protected, 1) // keep.txt（sess-a，40 天前，但受保护）
  assert.equal(protectedAgain.remaining, 2)
  assert.ok(existsSync(paths.protectedKeep))
  const remainingAfter = await list()
  assert.ok(remainingAfter.files.some((file) => file.path === paths.protectedKeep))
  ok('protectDirs 保护不被绕过：受保护快照永不被清理')

  // 再清一次：唯一命中项就是受保护那条，仍必须 skipped
  const onlyProtected = await prune({ sessionId: 'sess-a', olderThanDays: 30, dryRun: false, confirm: true })
  assert.equal(onlyProtected.matched, 0)
  assert.equal(onlyProtected.protected, 1)
  assert.equal(onlyProtected.remaining, 2)
  ok('受保护快照是唯一命中项时也不会被清（matched 0）')

  // 原有工具行为不能变：restore all 仍必须 confirm；forget all 仍不需要（保持现状）
  const oldStore = path.join(root, 'store-old')
  const forgetFile = path.join(work, 'forget-me.txt')
  writeFileSync(forgetFile, 'keep me', 'utf8')
  seedStore(oldStore, [{ path: forgetFile, content: 'keep me', capturedAt: isoDaysAgo(1), created: false }])
  const legacyHarness = makeHarness({ storeDir: oldStore, protectDirs: [protectedDir] })
  await assert.rejects(() => call(legacyHarness, 'checkpoint_restore', { all: true }), /confirm: true/)
  ok('原有 checkpoint_restore：all:true 仍必须 confirm:true')

  const forgetResult = await call(legacyHarness, 'checkpoint_forget', { all: true })
  assert.equal(forgetResult.forgotten.length, 1)
  assert.equal(forgetResult.remaining, 0)
  assert.ok(existsSync(forgetFile), 'forget 只丢快照，不能删文件')
  ok('原有 checkpoint_forget：行为不变（只丢快照、不动文件）')

  // ---------- 采集侧：新记录写入 sessionId 与时间戳 ----------
  const captureRoot = path.join(root, 'capture')
  const captureStore = path.join(captureRoot, 'store')
  const captureWork = path.join(captureRoot, 'work')
  mkdirSync(captureWork, { recursive: true })
  const captureFile = path.join(captureWork, 'captured.txt')
  const virtualFiles = new Map([[captureFile, 'captured content']])
  const fakeFs = {
    resolve: async (raw, opts) => ({
      displayPath: path.isAbsolute(raw) ? raw : path.join(opts?.cwd ?? captureWork, raw),
    }),
    stat: async (target) =>
      virtualFiles.has(target.displayPath) ? { type: 'file', size: virtualFiles.get(target.displayPath).length } : null,
    readText: async (target) => virtualFiles.get(target.displayPath),
    processPath: (target) => target.displayPath,
    writeText: async () => {
      throw new Error('checkpoint 清理/采集测试不应调用 fs 写接口')
    },
  }
  const captureHarness = makeHarness(
    { storeDir: captureStore, protectDirs: [protectedDir] },
    { fs: fakeFs, workingDirectory: { ensure: async () => captureWork } },
  )
  const preExecute = captureHarness.handlers.get('tools/pre-execute')
  assert.equal(typeof preExecute, 'function')
  await preExecute({ name: 'write', arguments: { file_path: 'captured.txt' }, agent: { id: 'sess-x' }, signal: undefined }, async () => {})
  captureHarness.flush()
  const captured = JSON.parse(readFileSync(path.join(captureStore, 'snapshots.json'), 'utf8'))
  assert.equal(captured.records.length, 1)
  assert.equal(captured.records[0].sessionId, 'sess-x')
  assert.ok(Number.isFinite(Date.parse(captured.records[0].capturedAt)), 'capturedAt 必须是可解析时间戳')
  assert.equal(captured.version, 4)
  ok('新快照记录写入 sessionId（exec.agent.id）与可解析时间戳，存档 version=4')

  // ---------- 严格匹配：restore / forget / diff 歧义必须拒绝，restore 只动一个目标 ----------
  const ambRoot = path.join(root, 'ambiguous')
  const ambWork = path.join(ambRoot, 'work')
  const ambStore = path.join(ambRoot, 'store')
  mkdirSync(ambWork, { recursive: true })
  const ambA = path.join(ambWork, 'index-a.txt')
  const ambB = path.join(ambWork, 'index-b.txt')
  const ambOther = path.join(ambWork, 'other.txt')
  for (const file of [ambA, ambB, ambOther]) writeFileSync(file, `live ${path.basename(file)}`, 'utf8')
  seedStore(ambStore, [
    { path: ambA, content: 'snap a', capturedAt: isoDaysAgo(1), created: false },
    { path: ambB, content: 'snap b', capturedAt: isoDaysAgo(1), created: false },
    { path: ambOther, content: 'snap other', capturedAt: isoDaysAgo(1), created: false },
  ])
  const ambFiles = new Map([
    [ambA, 'live a'],
    [ambB, 'live b'],
    [ambOther, 'live other'],
  ])
  const ambFs = {
    resolve: async (raw) => ({ displayPath: typeof raw === 'string' ? raw : String(raw?.displayPath ?? '') }),
    stat: async (target) =>
      ambFiles.has(target.displayPath) ? { type: 'file', size: String(ambFiles.get(target.displayPath) ?? '').length } : null,
    readText: async (target) => ambFiles.get(target.displayPath),
    writeText: async (target, content) => {
      ambFiles.set(target.displayPath, content)
    },
    processPath: (target) => target.displayPath,
  }
  const amb = makeHarness({ storeDir: ambStore, protectDirs: [protectedDir] }, { fs: ambFs })
  const ambList = () => call(amb, 'checkpoint_list', {})
  assert.equal((await ambList()).total, 3, '3 个快照就位')
  ok('严格匹配用例就位：3 个快照（index-a / index-b / other）')

  // 文件名片段 "index" 命中两个 → 三个工具都必须拒绝，且列出候选路径
  const ambiguous = { code: 'AMBIGUOUS_TARGET', hasCandidates: (message) => message.includes(ambA) && message.includes(ambB) }
  await assert.rejects(
    () => call(amb, 'checkpoint_forget', { path: 'index' }),
    (error) => {
      assert.equal(error.code, ambiguous.code)
      assert.match(error.message, /命中 2 个快照/)
      assert.ok(ambiguous.hasCandidates(error.message), '候选路径必须列全，不能只说"命中多个"')
      return true
    },
  )
  assert.equal((await ambList()).total, 3, '歧义被拒后记录一条都不能少')
  ok('checkpoint_forget：模糊命中 2 个 → 拒绝并列出候选，记录不变')

  await assert.rejects(
    () => call(amb, 'checkpoint_restore', { path: 'index' }),
    (error) => {
      assert.equal(error.code, ambiguous.code)
      assert.ok(ambiguous.hasCandidates(error.message), '候选路径必须列全')
      return true
    },
  )
  assert.equal(ambFiles.get(ambA), 'live a', '歧义被拒时不能碰 index-a')
  assert.equal(ambFiles.get(ambB), 'live b', '歧义被拒时不能碰 index-b')
  assert.equal((await ambList()).total, 3)
  ok('checkpoint_restore：歧义被拒，文件一个都没动（旧行为会逐个恢复）')

  await assert.rejects(
    () => call(amb, 'checkpoint_diff', { path: 'index' }),
    (error) => {
      assert.equal(error.code, ambiguous.code)
      assert.ok(ambiguous.hasCandidates(error.message), '候选路径必须列全')
      return true
    },
  )
  ok('checkpoint_diff：歧义被拒并列出候选')

  // 唯一后缀 / 全等路径仍可用
  const singleDiff = await call(amb, 'checkpoint_diff', { path: 'index-a.txt' })
  assert.equal(singleDiff.entries.length, 1, '唯一后缀只命中一个目标')
  assert.equal(singleDiff.entries[0].path, ambA)
  ok('checkpoint_diff：唯一后缀 index-a.txt 只对比一个目标')

  const restoredOne = await call(amb, 'checkpoint_restore', { path: 'index-a.txt', confirm: true })
  assert.equal(restoredOne.restored.length, 1, 'restore 只处理一个目标')
  assert.equal(restoredOne.restored[0].path, ambA)
  assert.equal(ambFiles.get(ambA), 'snap a', '唯一命中的目标被恢复成快照内容')
  assert.equal(ambFiles.get(ambB), 'live b', '另一个同片段目标绝不能被一起恢复')
  assert.equal((await ambList()).total, 2)
  ok('checkpoint_restore：只动一个目标，index-b 原样保留')

  const restoredExact = await call(amb, 'checkpoint_restore', { path: ambB, confirm: true })
  assert.equal(restoredExact.restored.length, 1)
  assert.equal(ambFiles.get(ambB), 'snap b', '全等路径（含盘符大小写差异也可）直接可用')
  ok('checkpoint_restore：全等路径可直接恢复')

  const forgotOne = await call(amb, 'checkpoint_forget', { path: 'other' })
  assert.deepEqual(forgotOne.forgotten, [ambOther], '唯一后缀只丢一条快照')
  assert.equal(forgotOne.remaining, 0)
  assert.ok(existsSync(ambOther), 'forget 只丢快照，不删文件')
  amb.flush()
  ok('checkpoint_forget：唯一后缀只丢一条，文件不动')

  // ---------- 红线与 confirm 语义回归（2026-11-03 全局审计 C1 / C4） ----------
  // C1：红线目录（学习空间 / DSH 安装目录 / .dsh 凭据目录）里的目标，restore 一律拒绝，
  // confirm: true 也不放行；且一个字节都不许写。用假 fs 记录所有写调用。
  const redlineStore = path.join(root, 'redline-store')
  const redlineLearning = 'D:\\AI-date\\workbuddy-date\\学习\\__checkpoint_selftest_probe__.md'
  const redlineInstall = 'D:\\AI\\deepsek harness\\__checkpoint_selftest_probe__.md'
  const redlineCred = path.join(os.homedir(), '.dsh', '__checkpoint_selftest_probe__.md')
  const redlineNormal = path.join(root, 'redline-normal.txt')
  writeFileSync(redlineNormal, 'live normal', 'utf8')
  seedStore(redlineStore, [
    { path: redlineLearning, content: 'SHOULD NOT WRITE', capturedAt: isoDaysAgo(1), created: false },
    { path: redlineInstall, content: 'SHOULD NOT WRITE', capturedAt: isoDaysAgo(1), created: false },
    { path: redlineCred, content: 'SHOULD NOT WRITE', capturedAt: isoDaysAgo(1), created: true },
    { path: redlineNormal, content: 'snap normal', capturedAt: isoDaysAgo(1), created: false },
  ])
  const redWrites = []
  const redFs = {
    resolve: async (raw) => ({ displayPath: String(raw) }),
    stat: async () => ({ type: 'file', size: 1 }),
    readText: async () => '',
    processPath: (target) => target.displayPath,
    writeText: async (target) => {
      redWrites.push(target.displayPath)
    },
  }
  const red = makeHarness({ storeDir: redlineStore }, { fs: redFs })
  for (const [label, redPath] of [
    ['学习空间', redlineLearning],
    ['DSH 安装目录', redlineInstall],
    ['.dsh 凭据目录', redlineCred],
  ]) {
    for (const confirm of [true, false]) {
      const out = await call(red, 'checkpoint_restore', { path: redPath, confirm })
      assert.equal(out.restored.length, 0, `${label}（confirm=${confirm}）必须拒绝回滚：${JSON.stringify(out)}`)
      assert.equal(out.failed.length, 1, `${label} 应报一条失败`)
      assert.match(out.failed[0].reason, /红线/, `${label} 失败原因应点明红线`)
    }
  }
  assert.equal(redWrites.length, 0, '红线目标一个字节都不能写（confirm 不放行）')
  ok('红线路径 restore 一律拒绝（学习空间 / DSH 安装目录 / .dsh 凭据目录），confirm 不放行且零写入')

  // all:true + confirm：普通目标照常回滚，红线目标跳过并报失败（不能因红线把整批也拒绝）
  const allOut = await call(red, 'checkpoint_restore', { all: true, confirm: true })
  assert.equal(allOut.restored.length, 1, `all:true 应只回滚普通目标：${JSON.stringify(allOut)}`)
  assert.equal(allOut.restored[0].path, redlineNormal)
  assert.equal(allOut.failed.length, 3, '三个红线目标必须出现在 failed 里')
  assert.deepEqual(redWrites, [redlineNormal], '只允许写普通目标')
  red.flush()
  ok('restore all:true：普通目标回滚、3 个红线目标全部拒绝（不会因红线整批放行）')

  // C4：普通路径（不在工作区 / 白名单内）不带 confirm 必须拒绝；带 confirm 才回滚
  const plainRoot = path.join(root, 'plain')
  const plainStore = path.join(root, 'plain-store')
  mkdirSync(plainRoot, { recursive: true })
  const plainFile = path.join(plainRoot, 'plain.txt')
  const plainFiles = new Map([[plainFile, 'live value']])
  seedStore(plainStore, [{ path: plainFile, content: 'snap value', capturedAt: isoDaysAgo(1), created: false }])
  const plainFs = {
    resolve: async (raw) => ({ displayPath: String(raw) }),
    stat: async (target) => (plainFiles.has(target.displayPath) ? { type: 'file', size: 1 } : null),
    readText: async (target) => plainFiles.get(target.displayPath) ?? '',
    processPath: (target) => target.displayPath,
    writeText: async (target, content) => {
      plainFiles.set(target.displayPath, content)
    },
  }
  const plain = makeHarness({ storeDir: plainStore }, { fs: plainFs })
  const blocked = await call(plain, 'checkpoint_restore', { path: plainFile })
  assert.equal(blocked.restored.length, 0, '普通路径无 confirm 必须拒绝')
  assert.match(blocked.failed[0].reason, /confirm: true/)
  assert.equal(plainFiles.get(plainFile), 'live value', '被拒时不得改动文件')
  const allowed = await call(plain, 'checkpoint_restore', { path: plainFile, confirm: true })
  assert.equal(allowed.restored.length, 1)
  assert.equal(plainFiles.get(plainFile), 'snap value', '带 confirm 后正常回滚')
  plain.flush()
  ok('普通路径（不在工作区/白名单）：无 confirm 拒绝且文件不动，confirm 后才回滚')

  // 工作区内免 confirm：sessionCwd 内的目标仍可直接回滚（别把确认做成"样样都要"）
  const wsStore = path.join(root, 'ws-store')
  const wsFile = path.join(work, 'workspace-file.txt')
  const wsFiles = new Map([[wsFile, 'live ws']])
  seedStore(wsStore, [{ path: wsFile, content: 'snap ws', capturedAt: isoDaysAgo(1), created: false }])
  const wsFs = {
    resolve: async (raw) => ({ displayPath: String(raw) }),
    stat: async (target) => (wsFiles.has(target.displayPath) ? { type: 'file', size: 1 } : null),
    readText: async (target) => wsFiles.get(target.displayPath) ?? '',
    processPath: (target) => target.displayPath,
    writeText: async (target, content) => {
      wsFiles.set(target.displayPath, content)
    },
  }
  const ws = makeHarness({ storeDir: wsStore }, { fs: wsFs, workingDirectory: { ensure: async () => work } })
  const wsRestore = await ws.registered.get('checkpoint_restore').execute({ path: wsFile }, { agent: { id: 'sess-ws' } })
  assert.equal(wsRestore.restored.length, 1, '工作区内的目标无需 confirm')
  assert.equal(wsFiles.get(wsFile), 'snap ws')
  ws.flush()
  ok('工作区内目标免 confirm（sessionCwd 内），语义与「工作区外要确认」对称')

  // C1 采集侧：受保护/红线目录不进账本（统计里计 excluded，不新增记录）
  const captureFileInProtected = path.join(protectedDir, 'keep.txt')
  const beforeExcludedRecords = (await call(captureHarness, 'checkpoint_list', {})).total
  await preExecute(
    { name: 'write', arguments: { file_path: captureFileInProtected }, agent: { id: 'sess-x' }, signal: undefined },
    async () => {},
  )
  const afterExcludedRecords = (await call(captureHarness, 'checkpoint_list', {})).total
  assert.equal(afterExcludedRecords, beforeExcludedRecords, '受保护目录里的写不得新增快照')
  const capStatus = await call(captureHarness, 'checkpoint_status', {})
  assert.ok(capStatus.skipped.excluded >= 1, '应计入 skipped.excluded')
  captureHarness.flush()
  ok('采集侧：protectDirs/红线目录不进快照账本（计 excluded）')

  console.log(`checkpoint: ${passed} 项通过`)
} finally {
  rmSync(root, { recursive: true, force: true })
}

// ---------- 任务级检查点（B2 · checkpoint_mark / restore {mark}） ----------
{
  const markRoot = path.join(root, 'marks')
  const markWork = path.join(markRoot, 'work')
  const markStore = path.join(markRoot, 'store')
  mkdirSync(markWork, { recursive: true })
  const pre = path.join(markWork, 'pre.txt') // 标记前已有的快照，不该被 mark 恢复
  const f = path.join(markWork, 'task.txt')
  writeFileSync(pre, 'live pre', 'utf8')
  writeFileSync(f, 'v1', 'utf8')
  seedStore(markStore, [{ path: pre, content: 'snap pre', capturedAt: isoDaysAgo(1), created: false }])
  const diskFiles = new Map()
  const diskFs = {
    resolve: async (raw) => ({ displayPath: String(raw) }),
    stat: async (target) => (existsSync(target.displayPath) ? { type: "file", size: 1 } : null),
    readText: async (target) => readFileSync(target.displayPath, "utf8"),
    processPath: (target) => target.displayPath,
    writeText: async (target, content) => { diskFiles.set(target.displayPath, content) },
  }
  const mh = makeHarness({ storeDir: markStore, protectDirs: [protectedDir] }, { fs: diskFs, workingDirectory: { ensure: async () => markWork } })
  const mk = await call(mh, 'checkpoint_mark', { label: 'before-task' })
  assert.equal(mk.label, 'before-task')
  assert.ok(mk.id.startsWith('mk'), '返回 id')
  ok('checkpoint_mark：打标记返回 id/label')

  await sleep(5) // 确保标记之后的 capture 时间戳严格晚于 mark.at
  const preExec = mh.handlers.get('tools/pre-execute')
  await preExec({ name: 'write', arguments: { file_path: f }, agent: { id: 'sess-m' }, signal: undefined }, async () => {})
  mh.flush()
  writeFileSync(f, 'v2', 'utf8') // 模拟任务改坏
  const back = await mh.registered.get('checkpoint_restore').execute({ mark: 'before-task', confirm: true }, { agent: { id: 'sess-m' } })
  assert.equal(back.mark, 'before-task')
  assert.equal(back.restored.length, 1, '只恢复标记后的 1 个快照')
  assert.equal(diskFiles.get(f), 'v1', '任务文件回到标记时内容 v1')
  assert.equal(diskFiles.has(pre), false, '标记前的快照不得被恢复')
  ok('checkpoint_restore {mark}：只回标记后的改动，标记前不动')

  const list = await call(mh, 'checkpoint_list', {})
  assert.equal(list.marks.length, 1)
  assert.equal(list.marks[0].label, 'before-task')
  ok('checkpoint_list 报出任务标记')

  await assert.rejects(
    () => mh.registered.get('checkpoint_restore').execute({ mark: 'nope', confirm: true }, { agent: { id: 'sess-m' } }),
    (error) => error.code === 'MARK_NOT_FOUND',
  )
  ok('未知标记：MARK_NOT_FOUND 拒绝')
}

// 任务标记段用的是 root 下的 marks/ —— 上面的 finally 已删过一次 root，这一段的
// mkdirSync(recursive) 又把 root 建了回来，所以收尾必须再删一次（2026-11-11 实测：
// 漏这一步，D:\AI\dsh-data 下积了 109 个 _selftest-checkpoint-* 残留）。
rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
