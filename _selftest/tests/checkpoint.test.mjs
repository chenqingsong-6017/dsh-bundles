import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
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
  assert.equal(tools.length, 6)
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
  assert.equal(captured.version, 3)
  ok('新快照记录写入 sessionId（exec.agent.id）与可解析时间戳，存档 version=3')

  console.log(`checkpoint: ${passed} 项通过`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
