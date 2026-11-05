/**
 * 存储快照读取（只读）：定位存储、读 json 后端、合并别名旁路。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'

import { DB_FILE, SCHEMA_VERSION } from './constants.js'
import { isArchivedEntry } from './entry.js'
import { fail } from './util.js'
import { normalizeEntry } from './schema.js'

export function storeLocation(overrideDir) {
  const override = typeof overrideDir === 'string' ? overrideDir.trim() : ''
  const base =
    override !== ''
      ? path.resolve(override)
      : process.env.DSH_PROFILE_DIR
        ? path.join(process.env.DSH_PROFILE_DIR, 'dsh-memory')
        : path.join(os.homedir(), '.dsh', 'dsh-memory')
  return { dir: base, file: path.join(base, 'memory.json') }
}

/* ───────── v4.1（P2）：存储快照读取（诊断/基准/测试用，只读） ─────────
 * 单一入口：有 memory.db 读 SQLite，没有就按旧 JSON 口径读 memory.json + archive.json。
 * 只读保证：不建表、不迁移、不写任何文件。基准脚本 _ops/memory-bench.mjs 用它保持与真机同源。 */
let MODULE_SQLITE_API

function moduleSqliteApi() {
  if (MODULE_SQLITE_API !== undefined) return MODULE_SQLITE_API
  try {
    MODULE_SQLITE_API = createRequire(import.meta.url)('node:sqlite')
  } catch (error) {
    MODULE_SQLITE_API = null
  }
  return MODULE_SQLITE_API
}

/** 快照也要读别名旁路（插件加载后会把旁路合并进条目；快照不合并就会与真机口径不同）。 */
function mergeAliasesFromSidecar(entries, dir) {
  let sidecar = {}
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, 'aliases.json'), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && parsed.aliases !== null && typeof parsed.aliases === 'object') sidecar = parsed.aliases
  } catch (error) {
    // 没有旁路文件从空开始
  }
  for (const entry of entries) {
    const list = sidecar[entry.id]
    if (!Array.isArray(list) || list.length === 0) continue
    if (Array.isArray(entry.aliases) && entry.aliases.length > 0) continue
    entry.aliases = list
  }
  return entries
}

export function readStoreSnapshot(storeDirOverride) {
  const location = storeLocation(storeDirOverride)
  const dbPath = path.join(location.dir, DB_FILE)
  if (existsSync(dbPath)) {
    const api = moduleSqliteApi()
    if (api === null) throw fail('MEMORY_SQLITE_UNAVAILABLE', 'node:sqlite 不可用，读不了 memory.db：' + dbPath)
    const database = new api.DatabaseSync(dbPath)
    try {
      const meta = new Map()
      try {
        for (const row of database.prepare('SELECT key, value FROM meta').all()) meta.set(row.key, row.value)
      } catch (error) {
        // 空库/未初始化：按默认值
      }
      let rows = []
      try {
        rows = database.prepare('SELECT payload FROM entries ORDER BY seq').all()
      } catch (error) {
        rows = []
      }
      const entries = []
      for (const row of rows) {
        let parsed = null
        try {
          parsed = JSON.parse(row.payload)
        } catch (error) {
          parsed = null
        }
        if (parsed === null || typeof parsed !== 'object' || typeof parsed.id !== 'string' || typeof parsed.text !== 'string') continue
        entries.push(normalizeEntry(parsed))
      }
      const nextIdRaw = Number(meta.get('next_id') ?? 1)
      const versionRaw = Number(meta.get('data_version') ?? SCHEMA_VERSION)
      mergeAliasesFromSidecar(entries, location.dir)
      return {
        backend: 'sqlite',
        dir: location.dir,
        storeFile: dbPath,
        version: versionRaw > 0 ? versionRaw : SCHEMA_VERSION,
        nextId: nextIdRaw > 0 ? nextIdRaw : 1,
        entries,
      }
    } finally {
      try {
        database.close()
      } catch (error) {}
    }
  }
  let parsed = null
  try {
    parsed = JSON.parse(readFileSync(location.file, 'utf8'))
  } catch (error) {
    parsed = null
  }
  const active = Array.isArray(parsed?.entries) ? parsed.entries : []
  const archived = []
  try {
    const archivedRaw = JSON.parse(readFileSync(path.join(location.dir, 'archive.json'), 'utf8'))
    const list = Array.isArray(archivedRaw) ? archivedRaw : Array.isArray(archivedRaw?.entries) ? archivedRaw.entries : []
    const now = new Date().toISOString()
    for (const raw of list) {
      if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.text !== 'string') continue
      const entry = normalizeEntry(raw)
      archived.push(
        isArchivedEntry(entry)
          ? entry
          : { ...entry, status: 'deprecated', archivedAt: entry.archivedAt ?? now, archiveReason: entry.archiveReason ?? 'migrated: archive.json' },
      )
    }
  } catch (error) {
    // 归档缺失/损坏按空处理（与 loadArchive 同口径）
  }
  const activeIds = new Set()
  const entries = []
  for (const raw of active) {
    if (raw === null || typeof raw !== 'object') continue
    const entry = normalizeEntry(raw)
    activeIds.add(entry.id)
    entries.push(entry)
  }
  for (const entry of archived) if (!activeIds.has(entry.id)) entries.push(entry)
  const maxIdNumber = entries.reduce((max, entry) => {
    const match = /^m?(\d+)$/.exec(String(entry.id))
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)
  const storedNextId = Number.isInteger(parsed?.nextId) && parsed.nextId > 0 ? parsed.nextId : 0
  const version = Number.isInteger(parsed?.version) && parsed.version > 0 ? parsed.version : 1
  mergeAliasesFromSidecar(entries, location.dir)
  return {
    backend: 'json',
    dir: location.dir,
    storeFile: location.file,
    version,
    nextId: Math.max(storedNextId, maxIdNumber + 1),
    entries,
  }
}
