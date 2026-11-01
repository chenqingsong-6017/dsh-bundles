// dsh-memory schema 版本门：存储版本高于插件支持版本时必须拒绝启动，而不是静默照用。
// 依据：官方 ADR「版本更高时拒绝启动，而不是猜」（二轮深读 _research/deepseek-repos-survey-2026-11-01.md §8.5 待办）。
// 命名 memory-schema 不对应任何插件 → 由验证门阶段 3 的「孤儿测试」通道执行（check.mjs）。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, migrateState } from '../../dsh-memory/index.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log('  ✓ ' + label)
}

// 插件支持版本从迁移目标反推（SCHEMA_VERSION 未导出，不为测试额外加 API）。
const TARGET = migrateState({ version: 1, entries: [] }).to
assert.ok(Number.isInteger(TARGET) && TARGET >= 1, '迁移目标版本必须是正整数')
const FUTURE_VERSION = 99
assert.ok(FUTURE_VERSION > TARGET, '测试前提：99 必须高于当前支持版本 ' + TARGET)

// ---- 1) 纯函数：版本更高 → 抛错，信息点明版本与出路 ----
assert.throws(
  () => migrateState({ version: FUTURE_VERSION, entries: [] }),
  (error) => {
    assert.equal(error.code, 'MEMORY_SCHEMA_TOO_NEW', '错误要带可识别的 code')
    assert.match(error.message, new RegExp('存储版本 ' + FUTURE_VERSION + ' 高于插件支持的 ' + TARGET))
    assert.match(error.message, /升级 dsh-memory 插件|还原为匹配版本的备份/)
    return true
  },
  'version=99 必须抛错',
)
ok('migrateState：version=99 → 抛错（含版本号与「升级插件 / 还原备份」出路）')

// ---- 2) 纯函数：同版本 → 原样返回、不迁移、不重写 ----
const sameInput = { version: TARGET, entries: [{ id: 'm1', text: '同版本条目' }] }
const same = migrateState(sameInput)
assert.equal(same.changed, false, '同版本不应改动')
assert.equal(same.state, sameInput, '同版本必须原样返回同一个对象（不能重写）')
assert.equal(same.from, TARGET)
assert.equal(same.to, TARGET)
ok('migrateState：version=SCHEMA_VERSION（' + TARGET + '）→ 原样返回 / changed=false')

// ---- 3) 纯函数：低版本 → 正常迁移，内容不丢 ----
const old = migrateState({ version: 1, entries: [{ id: 'm2', text: '老条目', scope: 'plugin-dev' }] })
assert.equal(old.changed, true, 'version=1 应迁移')
assert.equal(old.state.version, TARGET, '迁移后版本应为 ' + TARGET)
assert.equal(old.state.entries[0].text, '老条目', '迁移不能丢内容')
assert.equal(old.state.entries[0].scope, 'plugin-dev', '迁移不能丢已有字段')
ok('migrateState：version=1 → 迁移到 ' + TARGET + '（内容与字段保留）')

// ---- 4) 加载路径 fail-loud：apply 拒绝启动，且不能把「版本新」当「文件损坏」改名隔离 ----
const fakeHost = (dir) => {
  const defs = new Map()
  const ctx = {
    tools: {
      register: (definition) => {
        defs.set(definition.name, definition)
        return () => {}
      },
    },
    effect: (fn) => fn(),
    on: () => () => {},
    get: () => undefined,
    systemPrompt: { context: () => () => {} },
  }
  apply(ctx, { storeDir: dir })
  return defs
}

const dirFuture = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-schema-'))
try {
  const storeFile = path.join(dirFuture, 'memory.json')
  const body = JSON.stringify({
    version: FUTURE_VERSION,
    nextId: 2,
    entries: [{ id: 'm1', text: '来自更高版本的数据', addedAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }],
  })
  writeFileSync(storeFile, body, 'utf8')
  assert.throws(
    () => fakeHost(dirFuture),
    (error) => {
      assert.equal(error.code, 'MEMORY_SCHEMA_TOO_NEW')
      assert.match(error.message, /拒绝启动/, '错误要说明是拒绝启动，不能只是半死')
      assert.match(error.message, new RegExp('存储版本 ' + FUTURE_VERSION + ' 高于插件支持的 ' + TARGET))
      return true
    },
    '加载更高版本库必须抛可读错误（拒绝启动）',
  )
  assert.ok(existsSync(storeFile), '更高版本的存储文件不能被改名 / 隔离')
  assert.equal(readFileSync(storeFile, 'utf8'), body, '更高版本的原文件必须原样保留')
  assert.deepEqual(
    readdirSync(dirFuture).filter((name) => name.includes('.corrupt-')),
    [],
    '不能把「版本更新」误判成「文件损坏」而留 corrupt 副本',
  )
  ok('加载路径：版本更高 → apply 拒绝启动 + 原文件原样保留（不倒垃圾）')
} finally {
  rmSync(dirFuture, { recursive: true, force: true })
}

// ---- 5) 当前版本仍能正常加载（不能误伤同版本 / 老版本） ----
const dirCurrent = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-schema-ok-'))
try {
  const storeFile = path.join(dirCurrent, 'memory.json')
  writeFileSync(
    storeFile,
    JSON.stringify({
      version: TARGET,
      nextId: 2,
      entries: [{ id: 'm1', text: '当前版本条目', addedAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }],
    }),
    'utf8',
  )
  const defs = fakeHost(dirCurrent)
  const listed = await defs.get('memory_list').execute({})
  assert.equal(listed.entries.length, 1, '当前版本库应正常加载')
  assert.equal(listed.entries[0].text, '当前版本条目')
  ok('加载路径：当前版本（' + TARGET + '）正常加载，条目不掉')
} finally {
  rmSync(dirCurrent, { recursive: true, force: true })
}

// ---- 6) 老版本（1）库文件也能正常加载（迁移在 load 内生效） ----
const dirLegacy = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-schema-legacy-'))
try {
  writeFileSync(
    path.join(dirLegacy, 'memory.json'),
    JSON.stringify({
      version: 1,
      nextId: 2,
      entries: [{ id: 'm1', text: '老版本条目', addedAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }],
    }),
    'utf8',
  )
  const defs = fakeHost(dirLegacy)
  const listed = await defs.get('memory_list').execute({})
  assert.equal(listed.entries.length, 1, '老版本库应能迁移后加载')
  assert.equal(listed.entries[0].text, '老版本条目')
  ok('加载路径：version=1 老库正常迁移加载')
} finally {
  rmSync(dirLegacy, { recursive: true, force: true })
}

// ---- 7) 写路径：运行中磁盘被换成更高版本 → 写入必须可读失败，且绝不覆盖新数据 ----
const dirSwap = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-schema-swap-'))
try {
  const storeFile = path.join(dirSwap, 'memory.json')
  writeFileSync(storeFile, JSON.stringify({ version: TARGET, nextId: 2, entries: [] }), 'utf8')
  const defs = fakeHost(dirSwap)
  const futureBody = JSON.stringify({ version: FUTURE_VERSION, nextId: 1, entries: [] })
  writeFileSync(storeFile, futureBody, 'utf8')
  await assert.rejects(
    () => defs.get('memory_add').execute({ text: '这条不该写进更高版本的库' }),
    (error) => {
      assert.match(error.message, /记忆落盘失败|存储版本 99 高于插件支持的/)
      return true
    },
    '磁盘上是更高版本时，写入必须失败而不是静默覆盖',
  )
  assert.equal(readFileSync(storeFile, 'utf8'), futureBody, '更高版本的文件不能被旧逻辑写回覆盖')
  ok('写路径：运行中磁盘变更高版本 → 写入失败（可读错误）+ 新数据不被覆盖')
} finally {
  rmSync(dirSwap, { recursive: true, force: true })
}

console.log('memory-schema.test.mjs: 通过 ' + passed + ' 组断言')
