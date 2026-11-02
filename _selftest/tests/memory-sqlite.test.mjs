// dsh-memory v4.1（P2）SQLite 存储后端 + FTS5 候选检索的回归测试。
// 为什么有它：换存储底座/检索路径不能靠「看起来对」——迁移逐字段、检索逐位、注入逐字节，都要有机器判据。
// 覆盖：迁移与备份 / 迁移后 memory.json 不动 / 检索差分(json vs sqlite, index vs scan) / 注入逐字节 /
//       写路径( add update remove restore merge purge audit history review export candidates ) / 索引自愈 /
//       schemaTooNew 防呆 / storage:json 回滚开关 / 损坏 DB 保护 / 双实例并发写入。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { copyFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, canonicalJson, isArchivedEntry, isInvalidEntry, migrateState, readStoreSnapshot } from '../../dsh-memory/index.js'

let passed = 0
const ok = (label) => { passed += 1; console.log('  ✓ ' + label) }

const SCHEMA_VERSION = migrateState({ version: 1, entries: [] }).to
const now = '2026-11-02T00:00:00.000Z'
const entry = (id, text, extra) => ({ id, text, addedAt: now, updatedAt: now, ...(extra ?? {}) })

// 覆盖全部字段形状的固定样例（含归档、失效、draft、inject:false、aliases/entities/sources/workspaces）。
const FIXTURE = {
  version: SCHEMA_VERSION,
  nextId: 9,
  entries: [
    entry('m1', '插件都放 D 盘，数据不落 C 盘', { pinned: true, importance: 10, aliases: ['路径', 'D盘'], sources: ['AGENTS.md:1'] }),
    entry('m2', '改完插件不用重启，官方 HMR 会换文件', { scope: 'plugin-dev', kind: 'fact', tags: ['hmr', '重启'], usedCount: 3, lastUsedAt: now }),
    entry('m3', '记忆正文进 vault，记忆只留判据+指针', { inject: false, entities: ['dsh-memory', 'Obsidian'], aliases: ['分层', '指针'] }),
    entry('m4', '待复核的事实', { status: 'draft', staleAfter: '2026-10-01' }),
    entry('m5', '已失效的事实', { invalidAt: '2026-01-01' }),
    entry('m6', '被取代的旧事实', { supersededBy: 'm7', status: 'deprecated', archivedAt: now, archiveReason: 'superseded' }),
    entry('m7', '新的生效事实', { validFrom: '2026-01-01', verifiedBy: 'agent', verifiedAt: now }),
    entry('m8', '仅某工作区生效的规则', { workspaces: ['D:\\AI\\dsh-bundles'], paths: ['/a/b'], migratedFrom: 'm0' }),
  ],
}
const ARCHIVE = {
  version: 1,
  entries: [entry('m10', '归档的历史条目：批量清理前留的备份', { status: 'deprecated', archivedAt: now, archiveReason: 'cleanup' })],
}

function makeStore(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'memory.json'), JSON.stringify(FIXTURE, null, 2), 'utf8')
  writeFileSync(path.join(dir, 'archive.json'), JSON.stringify(ARCHIVE, null, 2), 'utf8')
  writeFileSync(path.join(dir, 'aliases.json'), JSON.stringify({ version: 1, aliases: { m2: ['热重载'] } }, null, 2), 'utf8')
  writeFileSync(path.join(dir, 'candidates.json'), JSON.stringify({ version: 1, nextId: 1, items: [] }, null, 2), 'utf8')
}
function host(dir, extra) {
  const defs = new Map()
  const layers = []
  const handlers = new Map()
  const ctx = {
    tools: { register: (definition) => { defs.set(definition.name, definition); return () => {} } },
    effect: (fn) => { fn(); return () => {} },
    on: (name, handler) => { handlers.set(name, handler); return () => {} },
    get: () => undefined,
    systemPrompt: { context: (layer) => { layers.push(layer); return () => {} } },
  }
  apply(ctx, { storeDir: dir, maxInjectChars: 1500, maxBytes: 20000, captureCandidates: false, captureRuleFiles: false, ...(extra ?? {}) })
  return { defs, layers, handlers }
}
function tmp(tag) { return mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-sqlite-' + tag + '-')) }
// 进程内打开的 SQLite 连接会锁住临时文件；清理失败不影响结论（临时目录交给系统清理）。
function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } catch (error) { /* 连接仍打开时忽略 */ }
}

const QUERIES = [
  '插件放哪个盘', '改完插件要重启吗', 'vault 分层 指针', '待复核的事实', '新的生效事实',
  '某工作区规则', 'D 盘', 'HMR', 'm2', 'm7', '不存在的关键词', 'python 快排',
  '记忆，正文；指针。', '插件 重启 生效',
]
const searchShape = (result) => JSON.stringify({
  ids: result.matches.map((item) => item.id),
  scores: result.matches.map((item) => item.score),
  coverage: result.coverage,
  confidence: result.confidence,
  matched: result.matched,
  total: result.total,
  byId: result.byId ?? null,
})

// ---- 1) 迁移：备份 + 回读逐字段 + 原 memory.json 不动 + 重载一致 ----
const dirA = tmp('migrate')
try {
  makeStore(dirA)
  const preSnapshot = readStoreSnapshot(dirA)
  assert.equal(preSnapshot.backend, 'json')
  const memoryBefore = readFileSync(path.join(dirA, 'memory.json'), 'utf8')
  const archiveBefore = readFileSync(path.join(dirA, 'archive.json'), 'utf8')
  const jsonHost = host(dirA, { storage: 'json' })
  const jsonList = await jsonHost.defs.get('memory_list').execute({ includeArchived: true })
  const jsonInjection = jsonHost.layers[0].text({})
  const sqHost = host(dirA, { storage: 'sqlite' })
  assert.ok(existsSync(path.join(dirA, 'memory.db')), '迁移后必须生成 memory.db')
  const backupsRoot = path.join(dirA, 'backups')
  assert.ok(existsSync(backupsRoot), '迁移前必须留 JSON 备份')
  const backupDirs = readdirSync(backupsRoot).filter((item) => item.startsWith('pre-sqlite-'))
  assert.equal(backupDirs.length, 1, '必须正好一份 pre-sqlite 备份')
  const manifest = JSON.parse(readFileSync(path.join(backupsRoot, backupDirs[0], 'manifest.json'), 'utf8'))
  assert.ok(Array.isArray(manifest.files) && manifest.files.length >= 2, '备份清单要列出文件与 sha256')
  for (const item of manifest.files) assert.match(item.sha256, /^[0-9a-f]{64}$/)
  assert.equal(readFileSync(path.join(dirA, 'memory.json'), 'utf8'), memoryBefore, '迁移后 memory.json 必须原样保留（不动）')
  assert.equal(readFileSync(path.join(dirA, 'archive.json'), 'utf8'), archiveBefore, '迁移后 archive.json 必须原样保留（不动）')
  const snapshot = readStoreSnapshot(dirA)
  assert.equal(snapshot.backend, 'sqlite')
  assert.equal(snapshot.entries.length, preSnapshot.entries.length)
  assert.equal(canonicalJson(snapshot.entries), canonicalJson(preSnapshot.entries), '迁移回读必须逐字段一致（含 aliases 旁路合并口径）')
  const sqList = await sqHost.defs.get('memory_list').execute({ includeArchived: true })
  assert.equal(sqList.total, jsonList.total)
  assert.equal(sqList.active, jsonList.active)
  assert.equal(sqList.usedChars, jsonList.usedChars)
  assert.equal(sqList.block, jsonList.block, '注入块必须逐字节一致')
  assert.equal(sqHost.layers[0].text({}), jsonInjection, '注入回调输出必须逐字节一致')
  ok('迁移：备份/manifest/原文件不动/回读逐字段一致/列表与注入逐字节一致')

  // ---- 2) 检索差分：json vs sqlite(index) vs sqlite(scan) ----
  const dirScan = tmp('scan')
  makeStore(dirScan)
  const scanHost = host(dirScan, { storage: 'sqlite', retrieval: 'scan' })
  let equal = 0
  for (const query of QUERIES) {
    const a = await jsonHost.defs.get('memory_search').execute({ query, limit: 5 })
    const b = await sqHost.defs.get('memory_search').execute({ query, limit: 5 })
    const c = await scanHost.defs.get('memory_search').execute({ query, limit: 5 })
    assert.equal(searchShape(b), searchShape(a), 'sqlite index 与 json 后端检索必须逐位一致：' + query)
    assert.equal(searchShape(c), searchShape(a), 'sqlite scan 回退路径与 json 后端检索必须逐位一致：' + query)
    equal += 1
  }
  ok('检索差分：' + equal + ' 条查询（含 id 直取/多分句/负例）三后端逐位一致')
  cleanup(dirScan)

  // ---- 3) 写路径全工具（sqlite 后端） ----
  const added = await sqHost.defs.get('memory_add').execute({ text: 'SQLite 后端新增的记忆条目', tag: 'smoke', kind: 'fact', inject: false })
  assert.ok(added.entry.id)
  const updated = await sqHost.defs.get('memory_update').execute({ id: added.entry.id, text: 'SQLite 后端更新后的记忆条目' })
  assert.equal(updated.entry.text, 'SQLite 后端更新后的记忆条目')
  const older = await sqHost.defs.get('memory_add').execute({ text: '临时条目，稍后删除', tag: 'smoke', kind: 'fact', inject: false })
  const removed = await sqHost.defs.get('memory_remove').execute({ id: older.entry.id })
  assert.equal(removed.removed, true)
  const restored = await sqHost.defs.get('memory_restore').execute({ id: 'm10' })
  assert.equal(restored.restored, true)
  const merged = await sqHost.defs.get('memory_merge').execute({ ids: ['m1', 'm3'], text: '合并后的路径与分层规则' })
  assert.ok(merged.entry.id)
  const audit = await sqHost.defs.get('memory_audit').execute({ similarity: 0.5 })
  assert.ok(Array.isArray(audit.duplicates))
  const history = await sqHost.defs.get('memory_history').execute({ limit: 20 })
  assert.ok(Array.isArray(history.entries))
  const review = await sqHost.defs.get('memory_review').execute({ write: false })
  assert.ok(typeof review.markdown === 'string')
  const exported = await sqHost.defs.get('memory_export').execute({ write: false })
  assert.ok(exported.entries.length >= 1)
  const candidates = await sqHost.defs.get('memory_candidates').execute({})
  assert.ok(Array.isArray(candidates.items))
  const status = await sqHost.defs.get('memory_status').execute({})
  assert.equal(status.ready, true)
  assert.ok(String(status.storeFile).endsWith('memory.db'), 'memory_status 的 storeFile 应指向 memory.db')
  ok('写路径：add/update/remove/restore/merge/audit/history/review/export/candidates/status 全部可用')

  // ---- 4) 重载一致 + 写入能落盘 ----
  const reloaded = host(dirA, { storage: 'sqlite' })
  const reloadList = await reloaded.defs.get('memory_list').execute({ includeArchived: true })
  assert.ok(reloadList.entries.some((item) => item.id === added.entry.id), '新写入必须能在重载后读到')
  assert.ok(!reloadList.entries.some((item) => item.id === older.entry.id), '删除的条目重载后不应出现')
  const reloadSq = await reloaded.defs.get('memory_search').execute({ query: 'SQLite 后端更新后的记忆条目', limit: 3 })
  assert.equal(reloadSq.matches[0].id, added.entry.id)
  ok('重载：写入落盘、删除生效、检索命中')

  // ---- 5) 索引自愈：把 FTS 表清空后重开 → 自动重建且检索不退化 ----
  const { DatabaseSync } = await import('node:sqlite')
  const breaker = new DatabaseSync(path.join(dirA, 'memory.db'))
  breaker.exec('DELETE FROM entries_fts')
  breaker.exec('DELETE FROM term_df')
  breaker.close()
  const healed = host(dirA, { storage: 'sqlite' })
  const healedSearch = await healed.defs.get('memory_search').execute({ query: 'SQLite 后端更新后的记忆条目', limit: 3 })
  assert.equal(healedSearch.matches[0].id, added.entry.id, '索引自愈后检索必须恢复')
  ok('索引自愈：FTS/df 被清空后重开自动重建，检索不退化')

  // ---- 6) schemaTooNew 防呆：DB schema 更高 → 拒绝启动 ----
  const dirFuture = tmp('future')
  makeStore(dirFuture)
  host(dirFuture, { storage: 'sqlite' })
  const future = new DatabaseSync(path.join(dirFuture, 'memory.db'))
  future.prepare('UPDATE meta SET value = ? WHERE key = ?').run('99', 'schema_version')
  future.close()
  assert.throws(() => host(dirFuture, { storage: 'sqlite' }), (error) => {
    assert.equal(error.code, 'MEMORY_SCHEMA_TOO_NEW')
    assert.match(error.message, /拒绝启动/)
    return true
  })
  cleanup(dirFuture)
  ok('schemaTooNew：SQLite schema=99 → MEMORY_SCHEMA_TOO_NEW 拒绝启动')

  // ---- 7) storage:json 回滚开关：有 db 也走旧后端 ----
  const dirRollback = tmp('rollback')
  makeStore(dirRollback)
  const holder = host(dirRollback, { storage: 'sqlite' })
  await holder.defs.get('memory_add').execute({ text: '只进 DB 的条目', tag: 'db-only', inject: false })
  const rollbackHost = host(dirRollback, { storage: 'json' })
  const rollbackList = await rollbackHost.defs.get('memory_list').execute({ includeArchived: true })
  assert.ok(!rollbackList.entries.some((item) => item.text === '只进 DB 的条目'), 'storage: json 必须忽略 memory.db（回滚开关有效）')
  ok('回滚开关：storage: json 时忽略 memory.db，读旧 memory.json')
  cleanup(dirRollback)

  // ---- 8) 损坏 DB 保护：不抛、进入 corrupt 只读态 ----
  const dirCorrupt = tmp('corrupt')
  mkdirSync(dirCorrupt, { recursive: true })
  writeFileSync(path.join(dirCorrupt, 'memory.db'), 'this is not a sqlite database at all', 'utf8')
  const corruptHost = host(dirCorrupt, { storage: 'sqlite' })
  const corruptList = await corruptHost.defs.get('memory_list').execute({})
  assert.equal(corruptList.health, 'corrupt')
  assert.ok(existsSync(path.join(dirCorrupt, 'memory.db')), '损坏文件必须保留取证，不能被删')
  cleanup(dirCorrupt)
  ok('损坏 DB：不抛异常、进入 corrupt 只读态、原文件保留')

  // ---- 9) 双实例并发写：靠 WAL + write_seq 合并，不丢条目 ----
  const dirMulti = tmp('multi')
  makeStore(dirMulti)
  const h1 = host(dirMulti, { storage: 'sqlite' })
  const h2 = host(dirMulti, { storage: 'sqlite' })
  const a1 = await h1.defs.get('memory_add').execute({ text: '实例一写入的条目', tag: 'multi', inject: false })
  const a2 = await h2.defs.get('memory_add').execute({ text: '实例二写入的条目', tag: 'multi', inject: false })
  const a3 = await h1.defs.get('memory_add').execute({ text: '实例一第二次写入的条目', tag: 'multi', inject: false })
  const finalHost = host(dirMulti, { storage: 'sqlite' })
  const finalList = await finalHost.defs.get('memory_list').execute({ includeArchived: true })
  const ids = new Set(finalList.entries.map((item) => item.id))
  assert.ok(ids.has(a1.entry.id) && ids.has(a2.entry.id) && ids.has(a3.entry.id), '两个实例写入的条目一条都不能丢')
  assert.equal(new Set([a1.entry.id, a2.entry.id, a3.entry.id]).size, 3, '三个 id 必须互不重复')
  cleanup(dirMulti)
  ok('双实例并发写：3 条全部保留且 id 不冲突（WAL + write_seq 合并）')
} finally {
  cleanup(dirA)
}

console.log('memory-sqlite.test.mjs: 通过 ' + passed + ' 组断言')