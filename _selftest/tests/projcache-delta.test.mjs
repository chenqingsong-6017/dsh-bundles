#!/usr/bin/env node
// projcache-delta.test.mjs — 增量 checkpoint 的实现层回归
// 判据（错了哪个观测值会变）：
//   1) 折叠读回的值 == 写入的值（否则缓存会「错」而不只是「旧」）；
//   2) 续写只追加增量行、定期折叠成单行基线（否则省写入没发生）；
//   3) 撕裂尾行只丢最后一条增量、坏中间行整条记录按缺失处理（否则坏文件会毒数据或崩启动）；
//   4) 旧版整文档（v7）照读、首次写入升级成 journal（否则升级要迁移/丢缓存）；
//   5) storage-domain 把上一版权威值传给 backend（否则增量 diff 无基准，可能写出错值）。
// 上游依赖用最小 stub 放在临时 node_modules 里 —— 测试的是本仓 fork 的真实文件，不是副本语义。
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.resolve(HERE, '../../dsh-projcache-delta')
const LIB = path.join(BUNDLE, 'lib')
let passed = 0
const ok = (label) => { passed += 1; console.log('  OK ' + label) }

// ---------------------------------------------------------------- pure codec
const codec = await import(pathToFileURL(path.join(LIB, 'delta.js')).href)
const { mergeDelta, applyDelta, isEmptyDelta, parseDocument, serializeBaseline, serializeDelta, planJournalWrite, deepEqual } = codec

const recordOf = (turn, extra) => ({
  identity: { formatVersion: 5, createdAt: 1794229316054, cwd: 'D:/x', isSeeded: false, inheritedEventCount: 0 },
  rows: {
    title: { ver: 1, seq: 10 + turn, val: { text: 'session ' + turn } },
    tokenUsage: { ver: 2, seq: 10 + turn, val: { input: 100 * turn, output: 7 } },
    turnOutline: { ver: 1, seq: 10 + turn, val: Array.from({ length: turn }, (_, index) => ({ at: index, title: 'turn ' + index })) },
    ...extra,
  },
})

{
  let previous = recordOf(3)
  for (let turn = 4; turn < 300; turn += 1) {
    const next = recordOf(turn, turn % 7 === 0 ? { sessionStats: { ver: 1, seq: turn, val: { n: turn } } } : undefined)
    const delta = mergeDelta(previous, next, 2)
    assert.equal(JSON.stringify(applyDelta(previous, delta)), JSON.stringify(next), 'fold must reproduce the value at turn ' + turn)
    previous = next
  }
  ok('diff/apply 往返：300 回合写入后折叠值逐字段相等')
}

{
  const previous = recordOf(400)
  const next = recordOf(401)
  const delta = serializeDelta(8, mergeDelta(previous, next, 2))
  const baseline = serializeBaseline(8, next)
  const saving = 1 - Buffer.byteLength(delta) / Buffer.byteLength(baseline)
  assert.ok(saving > 0.9, 'delta must save >90% of the bytes, got ' + saving)
  ok('单回合 delta 字节 < 基线的 10%（实测 ' + (saving * 100).toFixed(1) + '% 省）')
}

{
  const base = recordOf(10)
  assert.equal(isEmptyDelta(mergeDelta(base, JSON.parse(JSON.stringify(base)), 2)), true)
  ok('值未变 → 空 delta（调用方可跳过写盘）')
  // 数组缩短不是「追加」，必须整体替换且折叠后仍相等
  const shrunk = recordOf(9)
  assert.equal(JSON.stringify(applyDelta(base, mergeDelta(base, shrunk, 2))), JSON.stringify(shrunk))
  ok('数组缩短回退为整体替换，折叠仍相等')
  assert.equal(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true)
  assert.equal(deepEqual({ a: 1 }, { a: 2 }), false)
  assert.equal(deepEqual([1, 2], [2, 1]), false)
}

{
  const a = recordOf(10)
  const b = recordOf(11)
  const journal = serializeBaseline(8, a) + serializeDelta(8, mergeDelta(a, b, 2))
  const parsed = parseDocument(journal, [8, 7])
  assert.equal(JSON.stringify(parsed.value), JSON.stringify(b))
  assert.equal(parsed.format, 'log')
  assert.equal(parsed.deltaLines, 1)
  ok('journal 解析：基线 + 增量行折叠为当前值')
  const torn = journal + '{"version":8,"delta":{"set":[["rows.ti'
  assert.equal(JSON.stringify(parseDocument(torn, [8]).value), JSON.stringify(b))
  ok('撕裂尾行：只丢最后一条增量，不丢整条记录')
  const middle = serializeBaseline(8, a) + 'garbage\n' + serializeDelta(8, mergeDelta(a, b, 2))
  assert.equal(parseDocument(middle, [8]), undefined)
  ok('坏中间行：整条记录按缺失处理（fail-soft，不当错值）')
  const legacy = JSON.stringify({ version: 7, record: a }, null, 2) + '\n'
  const legacyParsed = parseDocument(legacy, [8, 7])
  assert.equal(legacyParsed.format, 'legacy')
  assert.equal(JSON.stringify(legacyParsed.value), JSON.stringify(a))
  ok('v7 整文档照读（升级不需要迁移）')
  assert.equal(parseDocument(legacy, [8]), undefined, '未接受的版本戳必须作废')
  assert.equal(parseDocument(serializeDelta(8, mergeDelta(a, b, 2)), [8]), undefined, '没有基线的增量必须作废')
  ok('版本戳不接受 / 增量缺基线 → 记录作废')
}

{
  const descriptor = { version: 8, delta: true, deltaMaxLines: 4, deltaCompactBytes: 32768 }
  let stats
  const a = recordOf(20)
  const first = planJournalWrite(stats, descriptor, undefined, a, 8)
  assert.equal(first.kind, 'baseline')
  stats = first.stats
  const second = planJournalWrite(stats, descriptor, a, recordOf(21), 8)
  assert.equal(second.kind, 'append')
  assert.ok(second.text.includes('"delta"'))
  assert.equal(second.stats.deltaLines, 1)
  ok('首写建基线、后续追加增量')
  const unchanged = planJournalWrite(second.stats, descriptor, recordOf(21), recordOf(21), 8)
  assert.equal(unchanged.kind, 'none')
  ok('值未变 → 不写盘（none）')
  let current = second.stats
  for (let index = 0; index < 3; index += 1) current = planJournalWrite(current, descriptor, recordOf(21 + index), recordOf(22 + index), 8).stats
  assert.equal(current.deltaLines, 4)
  const compact = planJournalWrite(current, descriptor, recordOf(24), recordOf(25), 8)
  assert.equal(compact.kind, 'baseline')
  assert.equal(compact.stats.deltaLines, 0)
  ok('增量链到达上限 → 折叠回单行基线（截断链）')
  const legacyStats = { format: 'legacy', baselineBytes: 100, deltaLines: 0, deltaBytes: 0 }
  assert.equal(planJournalWrite(legacyStats, descriptor, a, recordOf(21), 8).kind, 'baseline')
  ok('旧整文档状态 → 首次写入升级成基线（不往整文档后追加）')
}

// ------------------------------------------------- integration (stub packages)
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'projcache-delta-'))
const modules = path.join(sandbox, 'node_modules', '@deepseek-ai')
const writePackage = (name, files) => {
  const dir = path.join(modules, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/' + name, version: '0.0.0-test', type: 'module', main: 'index.js', exports: { '.': './index.js' } }))
  for (const [file, body] of Object.entries(files)) writeFileSync(path.join(dir, file), body)
}
const copyLib = (target, source) => { copyFileSync(path.join(LIB, source), path.join(modules, target, path.basename(source))) }
const writeTopPackage = (name, files) => {
  const dir = path.join(sandbox, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0-test', type: 'module', main: 'index.js', exports: { '.': './index.js' } }))
  for (const [file, body] of Object.entries(files)) writeFileSync(path.join(dir, file), body)
}

try {
  // Chainable stand-ins for schemastery / zod: the fork only builds schemas at load time.
  const chainable = 'const chain = () => new Proxy(function () {}, { get: () => chain(), apply: () => chain() });\nexport const z = new Proxy(function () {}, { get: () => (...args) => chain() });\nexport default z;\n'
  writePackage('schemastery', { 'index.js': chainable })
  writeTopPackage('zod', { 'index.js': 'const chain = () => new Proxy(function () {}, { get: () => chain(), apply: () => chain() });\nexport const z = new Proxy(function () {}, { get: () => (...args) => chain() });\n' })
  writePackage('dsh-storage', { 'index.js': [
    'export class StorageError extends Error {',
    '  constructor(code, message, options) { super(message, options); this.code = code; }',
    '}',
    'export const UNIT_NAME_RE = /^[a-zA-Z0-9_-]+$/;',
    'export const storageBackendServiceKey = (name) => "storage.backend." + name;',
    '',
  ].join('\n') })
  writePackage('dsh-session', { 'index.js': 'export const SessionLogOffset = (value) => value;\nexport const SessionSeq = (value) => value;\n' })
  writePackage('dsh-util-values', { 'index.js': 'export const isJsonValue = () => true;\nexport const snapshotJsonValue = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));\n' })
  writePackage('cordis', { 'index.js': 'export class Service { constructor(ctx, name) { this.ctx = ctx; this.name = name; } }\n' })
  for (const name of ['dsh-storage-json', 'dsh-storage-domain', 'dsh-session-projection-cache']) {
    mkdirSync(path.join(modules, name), { recursive: true })
    writeFileSync(path.join(modules, name, 'package.json'), JSON.stringify({ name: '@deepseek-ai/' + name, version: '0.0.0-test', type: 'module', main: 'index.js', exports: { '.': './index.js' } }))
  }
  copyLib('dsh-storage-json', 'storage-json.js')
  copyFileSync(path.join(LIB, 'storage-json.js'), path.join(modules, 'dsh-storage-json', 'index.js'))
  copyFileSync(path.join(LIB, 'delta.js'), path.join(modules, 'dsh-storage-json', 'delta.js'))
  copyFileSync(path.join(LIB, 'storage-domain.js'), path.join(modules, 'dsh-storage-domain', 'index.js'))
  copyFileSync(path.join(LIB, 'session-projection-cache.js'), path.join(modules, 'dsh-session-projection-cache', 'index.js'))
  const importSandboxed = (name) => import(pathToFileURL(path.join(modules, name, 'index.js')).href)

  const storageJson = await importSandboxed('dsh-storage-json')
  const storageDomain = await importSandboxed('dsh-storage-domain')
  const projectionCache = await importSandboxed('dsh-session-projection-cache')

  // ---- storage-json: delta journal end to end (real files, real fsync) ----
  const root = path.join(sandbox, 'storages')
  const descriptor = { name: 'session_projcache', version: 8, tables: ['sessions'], hasGlobal: false, layout: 'per-record', compatibleVersions: [3, 4, 5, 6, 7], delta: true, deltaDepth: 2, deltaMaxLines: 20, deltaCompactBytes: 32768 }
  const unitFile = path.join(root, 'session_projcache', 'sessions', 'session-1.json')
  const backend = new storageJson.JsonStorageBackend(root)
  const unit = await backend.kv.open(descriptor)
  const write = async (value, previous) => {
    await unit.putRecord('sessions', 'session-1', value, previous)
  }
  const statSize = (file) => { try { return statSync(file).size } catch { return 0 } }
  await write(recordOf(0), undefined)
  assert.equal(readLines(unitFile).length, 1, '首写 = 一条基线')
  let previous = recordOf(0)
  for (let turn = 1; turn <= 5; turn += 1) { const next = recordOf(turn); await write(next, previous); previous = next }
  const lines = readLines(unitFile)
  assert.equal(lines.length, 6, '5 次增写各追加一行')
  assert.ok(lines.slice(1).every((line) => JSON.parse(line).delta !== undefined), '追加行必须是 delta 行')
  const baselineBytes = Buffer.byteLength(lines[0])
  const deltaBytes = lines.slice(1).reduce((sum, line) => sum + Buffer.byteLength(line), 0)
  assert.ok(deltaBytes / 5 < baselineBytes, '增量行必须小于整条基线')
  // 长会话才是目标场景：200 回合的基线多大，单次增量多小。
  const longBaseline = serializeBaseline(8, recordOf(200))
  const longDelta = serializeDelta(8, mergeDelta(recordOf(199), recordOf(200), 2))
  const longSaving = 1 - Buffer.byteLength(longDelta) / Buffer.byteLength(longBaseline)
  assert.ok(longSaving > 0.9, '长会话单回合增量必须省 >90%，实测 ' + (longSaving * 100).toFixed(1) + '%')
  ok('storage-json 增量日志：6 行（1 基线 + 5 增量）；200 回合基线下单次增量省 ' + (longSaving * 100).toFixed(1) + '%')

  const unchangedSize = statSize(unitFile)
  await unit.putRecord('sessions', 'session-1', recordOf(5), recordOf(5))
  assert.equal(statSize(unitFile), unchangedSize)
  ok('值未变的写入不落盘（字节零增长）')

  const beforeCompaction = readLines(unitFile).length
  for (let turn = 6; turn <= 25; turn += 1) { const next = recordOf(turn); await write(next, previous); previous = next }
  const compacted = readLines(unitFile)
  assert.ok(compacted.length < beforeCompaction + 20, '到达 deltaMaxLines 后必须折叠截断增量链')
  assert.ok(compacted.length <= 20, '折叠后行数必须回到上限以内')
  assert.ok(JSON.parse(compacted[0]).record !== undefined, '折叠后首行必须是整值基线')
  const folded = compacted.map((line) => JSON.parse(line)).reduce((value, line) => line.record !== undefined ? line.record : applyDelta(value, line.delta), undefined)
  assert.equal(JSON.stringify(folded), JSON.stringify(recordOf(25)))
  ok('到达增量链上限 → 折叠截断（' + beforeCompaction + ' 行规模不无限增长），值正确')

  await unit.close()
  await backend.close()
  {
    const reloaded = new storageJson.JsonStorageBackend(root)
    const reloadUnit = await reloaded.kv.open(descriptor)
    const all = await reloadUnit.loadAll()
    assert.equal(JSON.stringify(all.tables.sessions['session-1']), JSON.stringify(recordOf(25)))
    await reloadUnit.close()
    await reloaded.close()
    ok('重新打开单元（冷读）折叠出同一值')
  }

  // 撕裂尾行 + 旧版整文档 + 坏版本戳（直接改盘模拟）
  {
    const freshRoot = path.join(sandbox, 'storages-torn')
    const freshBackend = new storageJson.JsonStorageBackend(freshRoot)
    const freshUnit = await freshBackend.kv.open(descriptor)
    await freshUnit.putRecord('sessions', 'session-1', recordOf(0), undefined)
    await freshUnit.putRecord('sessions', 'session-1', recordOf(1), recordOf(0))
    await freshUnit.close()
    await freshBackend.close()
    const freshFile = path.join(freshRoot, 'session_projcache', 'sessions', 'session-1.json')
    writeFileSync(freshFile, readFileSync(freshFile, 'utf8') + '{"version":8,"delta":{"set":[["rows.ti')
    const tornBackend = new storageJson.JsonStorageBackend(freshRoot)
    const tornUnit = await tornBackend.kv.open(descriptor)
    const torn = await tornUnit.loadAll()
    assert.equal(JSON.stringify(torn.tables.sessions['session-1']), JSON.stringify(recordOf(1)))
    await tornUnit.close()
    await tornBackend.close()
    ok('撕裂尾行：冷读仍得到最后一条完整状态')
  }
  {
    const legacyRoot = path.join(sandbox, 'storages-legacy')
    mkdirSync(path.join(legacyRoot, 'session_projcache', 'sessions'), { recursive: true })
    const legacyFile = path.join(legacyRoot, 'session_projcache', 'sessions', 'session-1.json')
    writeFileSync(legacyFile, JSON.stringify({ version: 7, record: recordOf(3) }, null, 2) + '\n')
    const legacyBackend = new storageJson.JsonStorageBackend(legacyRoot)
    const legacyUnit = await legacyBackend.kv.open(descriptor)
    const loaded = await legacyUnit.loadAll()
    assert.equal(JSON.stringify(loaded.tables.sessions['session-1']), JSON.stringify(recordOf(3)))
    await legacyUnit.putRecord('sessions', 'session-1', recordOf(4), recordOf(3))
    const upgraded = readLines(legacyFile)
    assert.equal(upgraded.length, 1)
    assert.equal(JSON.stringify(JSON.parse(upgraded[0]).record), JSON.stringify(recordOf(4)))
    await legacyUnit.close()
    await legacyBackend.close()
    ok('v7 整文档：照读，并在首次写入时升级成 journal 基线')
  }
  {
    const oldRoot = path.join(sandbox, 'storages-whole')
    const oldBackend = new storageJson.JsonStorageBackend(oldRoot)
    const plain = { ...descriptor, delta: false }
    const plainUnit = await oldBackend.kv.open(plain)
    await plainUnit.putRecord('sessions', 'session-1', recordOf(0), undefined)
    await plainUnit.putRecord('sessions', 'session-1', recordOf(1), recordOf(0))
    const wholeFile = path.join(oldRoot, 'session_projcache', 'sessions', 'session-1.json')
    const document = JSON.parse(readFileSync(wholeFile, 'utf8'))
    assert.equal(document.version, 8)
    assert.equal(JSON.stringify(document.record), JSON.stringify(recordOf(1)))
    await plainUnit.close()
    await oldBackend.close()
    ok('delta:false 的域保持整文档写（其它域行为不变）')
  }

  // ---- storage-domain: previous value reaches the backend ----
  {
    const calls = []
    const fakeUnit = {
      loadAll: async () => ({ tables: { t: {} }, global: null }),
      putRecord: async (table, key, value, previous) => { calls.push({ table, key, value, previous }) },
      deleteRecord: async () => true,
      deleteRecords: async () => 0,
      setGlobal: async () => {},
      close: async () => {},
    }
    const fakeContext = { storage: { backend: { get: () => ({ kv: { open: async () => fakeUnit } }) } }, logger: { warn() {}, error() {} } }
    const spec = storageDomain.defineDomain({ name: 'delta_test', version: 1, layout: 'per-record', delta: true, deltaDepth: 3, tables: { t: { valueSchema: { parse: (value) => value } } } })
    const descriptorOut = storageDomain.descriptorOf(spec)
    assert.equal(descriptorOut.delta, true)
    assert.equal(descriptorOut.deltaDepth, 3)
    ok('descriptorOf 把 delta 旋钮传给 backend')
    assert.throws(() => storageDomain.defineDomain({ name: 'x', version: 1, tables: {}, delta: 'yes' }))
    assert.throws(() => storageDomain.defineDomain({ name: 'x', version: 1, tables: {}, deltaDepth: 2 }))
    ok('defineDomain 拒绝非法 delta 声明（fail loud）')
    const facility = new storageDomain.DomainFacility(fakeContext, { backend: 'json' })
    const domain = await facility.open(spec)
    const table = domain.table('t')
    await table.put('k', { a: 1 })
    await table.put('k', { a: 2 })
    assert.deepEqual(calls[0], { table: 't', key: 'k', value: { a: 1 }, previous: undefined })
    assert.deepEqual(calls[1], { table: 't', key: 'k', value: { a: 2 }, previous: { a: 1 } })
    await table.update('k', (current) => ({ a: current.a + 10 }))
    assert.deepEqual(calls[2], { table: 't', key: 'k', value: { a: 12 }, previous: { a: 2 } })
    await domain.close()
    ok('KvTable.put/update 把上一版权威值传给 backend（增量 diff 的基准）')
  }

  // ---- session-projection-cache: schema v8 + delta opt-in ----
  {
    const spec = projectionCache.spec ? projectionCache.spec : projectionCache.projectionCacheDomainSpec
    assert.equal(spec.version, 8)
    assert.deepEqual([...spec.compatibleVersions], [3, 4, 5, 6, 7])
    assert.equal(spec.delta, true)
    assert.equal(spec.layout, 'per-record')
    assert.equal(storageDomain.descriptorOf(spec).delta, true)
    assert.equal(typeof projectionCache.SessionProjectionCache, 'function')
    ok('session_projcache 域 v8：兼容 3..7、delta:true、布局不变')
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

function readLines(file) {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
}

console.log('projcache-delta: ' + passed + ' 组通过')
