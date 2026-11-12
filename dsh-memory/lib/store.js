/**
 * 记忆存储：状态、持久化（JSON / SQLite 双后端）、备份、别名旁路、候选池与归档。
 *
 * 一条事实一个权威源：条目状态只在 state 里，落盘格式在 persist/load 这一对函数里；
 * 工具层只通过 createStore 返回的入口读写，不直接碰 db / 文件。
 */
import { appendFileSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { ARCHIVE_MANIFEST_MAX_BYTES, BACKUP_KEEP, BM25_ALIAS_WEIGHT, BUDGET_DEGRADED_RATIO, BM25_B, BM25_K1, BM25_TAG_WEIGHT, CANDIDATE_LIMIT, CANDIDATE_TTL_DAYS, CONSOLIDATE_MIN_USES, CONVERGE_MAX_PER_CALL, CONVERGE_MAX_USES, CONVERGE_MIN_AGE_DAYS, CURATOR_INTERVAL_MS, DB_FILE, DB_MIGRATION_LOCK, DB_SCHEMA_VERSION, FTS_TOKENIZE, MAX_QUERY_CHARS, MAX_TEXT_CHARS, RETRIEVAL_MODES, ROOM_MIN_AGE_DAYS, SCHEMA_VERSION, SIMILAR_HINT_FLOOR, STALE_PENALTY, STORE_BACKENDS } from './constants.js'
import { curationDecision, detectScope, effectiveImportance, eliminationSignal, isArchivedEntry, isInvalidEntry, isStaleEntry, localDateOf } from './entry.js'
import { canonicalJson, migrateState, normalizeEntry, schemaTooNewError } from './schema.js'
import { fail, text } from './util.js'
import { atomicWriteText } from '../../_lib/store.mjs'
import { contentUnitsOf, expandQuery, textSimilarity, tokenize } from './text.js'
import { bm25Doc } from './score.js'
import { renderMemory } from './render.js'
import { storeLocation } from './store-snapshot.js'

export function createStore({ ctx, config, maxBytes, maxColdBytes, maxInjectChars, scopeRoots, relevanceFloor }) {
  const { dir: storeDir, file: storeFile } = storeLocation(config?.storeDir)
  // v3.20：归档条目分文件冷存 —— 主库只留生效记忆，归档落 archive.json（与 aliases.json 同级的旁路文件）。
  // 起因：归档条目永远占着 memory.json，且 memory_list 每次都把 93 条一起吐出来（实测 37 KB），
  // 而它们既不计预算、也不参与注入 —— 唯一的作用是留历史。分文件后主库干净、列表默认不吐归档。
  const archiveFile = path.join(storeDir, 'archive.json')
  // v3.21：append-only 历史（学 mem0 的 history 表：ADD/UPDATE/DELETE 全记）。
  // 起因：2026-10-30 一次性物理删了 48 条归档，事后没有任何地方能查「删了什么、什么时候删的」。
  // 做法：每次 persist 成功后按基线做一次 diff，把 add/update/remove 追加成 JSONL；写失败绝不连累主操作。
  const historyFile = path.join(storeDir, 'history.jsonl')
  const HISTORY_MAX_BYTES = 2 * 1024 * 1024
  const HISTORY_TEXT_CAP = 400
  const historyCap = (value) => (typeof value === 'string' ? value.slice(0, HISTORY_TEXT_CAP) : undefined)
  /** id → { sig, text }：上一次落盘时的指纹，用来算本次 diff。 */
  let historyBaseline = new Map()
  const historySig = (entry) => `${entry.text ?? ''}|${entry.status ?? ''}|${entry.supersededBy ?? ''}`
  const resetHistoryBaseline = () => {
    historyBaseline = new Map(state.entries.map((entry) => [entry.id, { sig: historySig(entry), text: entry.text }]))
  }
  function recordHistoryDiff() {
    try {
      const next = new Map()
      const events = []
      const ts = new Date().toISOString()
      for (const entry of state.entries) {
        const sig = historySig(entry)
        next.set(entry.id, { sig, text: entry.text })
        const before = historyBaseline.get(entry.id)
        if (before === undefined) {
          events.push({ ts, event: 'add', id: entry.id, text: historyCap(entry.text), ...(entry.status ? { status: entry.status } : {}) })
        } else if (before.sig !== sig) {
          events.push({ ts, event: 'update', id: entry.id, before: historyCap(before.text), after: historyCap(entry.text), ...(entry.status ? { status: entry.status } : {}) })
        }
      }
      for (const [id, before] of historyBaseline) {
        if (!next.has(id)) events.push({ ts, event: 'remove', id, text: historyCap(before.text) })
      }
      if (events.length === 0) return
      mkdirSync(storeDir, { recursive: true })
      try {
        if (statSync(historyFile).size > HISTORY_MAX_BYTES) renameSync(historyFile, `${historyFile}.1`)
      } catch (error) {
        // 没有历史文件 / 轮转失败：继续追加即可
      }
      appendFileSync(historyFile, events.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8')
      historyBaseline = next
    } catch (error) {
      // 历史只是旁路审计，写失败不能连累主操作（fail-safe）
    }
  }
  // v3.6：别名放**旁路文件**，不跟条目混存。
  // 起因：运行中的旧版本在做 load→normalizeEntry 时不认识 aliases，一次 memory_update 落盘就把 32 条别名全洗掉了。
  // 旁路文件对旧版本完全不可见，天然免疫这种「未知字段被丢弃」的破坏。
  const aliasesFile = path.join(storeDir, 'aliases.json')
  let aliasesSidecar = {}

  function loadAliases() {
    let raw = ''
    try {
      raw = readFileSync(aliasesFile, 'utf8')
    } catch (error) {
      return // 没有旁路文件：从空开始
    }
    try {
      const parsed = JSON.parse(raw)
      const map = parsed && typeof parsed === 'object' && parsed.aliases && typeof parsed.aliases === 'object' ? parsed.aliases : null
      if (map === null) return
      const clean = {}
      for (const [id, list] of Object.entries(map)) {
        if (!Array.isArray(list)) continue
        const items = list.map((item) => (typeof item === 'string' ? item.trim() : '')).filter((item) => item !== '')
        if (items.length > 0) clean[id] = items
      }
      aliasesSidecar = clean
    } catch (error) {
      // v3.10（B08）：坏 JSON 不能静默当空 —— 否则下一次 saveAliases 就把原文覆盖没了。先另存一份留证。
      try {
        copyFileSync(aliasesFile, `${aliasesFile}.corrupt-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`)
      } catch (inner) {
        // 留证失败也不阻断启动
      }
    }
  }

  function saveAliases() {
    try {
      // 别名旁路是「防丢副本」：主源是条目自身，所以不留 .bak。
      atomicWriteText(
        aliasesFile,
        JSON.stringify(
          {
            version: 1,
            note: '别名旁路文件：改这里不会动 memory.json；插件启动时按 id 合并进条目，用于检索的跨词面桥接。',
            aliases: aliasesSidecar,
          },
          null,
          2,
        ),
        { backup: false },
      )
      return true
    } catch (error) {
      return false
    }
  }

  /** 把旁路别名合并进内存里的条目（条自带的 aliases 优先，旁路只补缺失）。 */
  function applyAliases() {
    for (const entry of state.entries) {
      const fromSidecar = aliasesSidecar[entry.id]
      if (!Array.isArray(fromSidecar) || fromSidecar.length === 0) continue
      if (Array.isArray(entry.aliases) && entry.aliases.length > 0) continue
      entry.aliases = fromSidecar
    }
  }

  /** 落盘后把内存里的 aliases 同步回旁路文件（唯一真相源 = 条目；旁路只是防丢副本）。 */
  function syncAliases() {
    const next = {}
    for (const entry of state.entries) {
      if (Array.isArray(entry.aliases) && entry.aliases.length > 0) next[entry.id] = entry.aliases
    }
    aliasesSidecar = next
    saveAliases()
  }
  // v4.10：实体别名旁路（entity resolution）——与 aliases.json 同一模式。
  // 主源是实体解析结果，旁路文件对旧版本不可见，免疫「未知字段被洗掉」。
  const entityAliasesFile = path.join(storeDir, 'entity-aliases.json')
  let entityAliasesSidecar = {}

  /** 读实体别名旁路；坏 JSON 先留证再当空（不静默覆盖原文）。 */
  function loadEntityAliases() {
    let raw = ''
    try {
      raw = readFileSync(entityAliasesFile, 'utf8')
    } catch (error) {
      return {}
    }
    try {
      const parsed = JSON.parse(raw)
      const map = parsed && typeof parsed === 'object' && parsed.aliases && typeof parsed.aliases === 'object' ? parsed.aliases : null
      if (map === null) return {}
      const clean = {}
      for (const [canonical, list] of Object.entries(map)) {
        const key = String(canonical).trim()
        if (key === '') continue
        const items = (Array.isArray(list) ? list : []).map((item) => (typeof item === 'string' ? item.trim() : '')).filter((item) => item !== '')
        clean[key] = [...new Set(items)]
      }
      entityAliasesSidecar = clean
      return clean
    } catch (error) {
      try {
        copyFileSync(entityAliasesFile, `${entityAliasesFile}.corrupt-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`)
      } catch (inner) {
        // 留证失败不阻断启动
      }
      return {}
    }
  }

  /** 写实体别名旁路；传 map 则覆盖，不传则按 memory 里的 state.entityAliases 落盘。 */
  function saveEntityAliases(map) {
    try {
      if (map && typeof map === 'object' && !Array.isArray(map)) entityAliasesSidecar = map
      atomicWriteText(
        entityAliasesFile,
        JSON.stringify(
          {
            version: 1,
            note: '实体别名旁路：canonical -> [alias...]。改这里不动 memory.json；插件启动时加载进 state.entityAliases。',
            aliases: entityAliasesSidecar,
          },
          null,
          2,
        ),
        { backup: false },
      )
      return true
    } catch (error) {
      return false
    }
  }
  const candidateFile = path.join(storeDir, 'candidates.json')

  // v4.0：新库直接以当前 schema 版本开局；老库在 load() 里由 migrateState 升级。
  const state = { version: SCHEMA_VERSION, nextId: 1, entries: [] }
  const candidates = { version: 1, nextId: 1, items: [] }

  // v4.2.3：state / candidates 以**稳定对象**形式暴露给工具层（下面 return 里的引用），
  // 加载/迁移时不能整体赋值，否则工具层拿到的是旧对象——统一走原地替换。
  function replaceState(next) {
    for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, next)
  }
  function replaceCandidates(next) {
    for (const key of Object.keys(candidates)) delete candidates[key]
    Object.assign(candidates, next)
  }
  // 数据安全：解析失败不覆盖，改名留证并进入只读保护态（P0-1）。
  let storeHealth = 'ok'
  let corruptCopy = ''
  // v3.9：加载时因字段不合法被丢弃的条目，原文件已另存到这里（只提示，不改数据）。
  let droppedCopyPath = ''

  const backupDay = () => {
    const date = new Date()
    return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
  }

  function pruneBackups() {
    try {
      if (!existsSync(storeDir)) return
      const prefix = `${path.basename(storeFile)}.bak-`
      // v3.9：只轮转「每日备份」bak-YYYYMMDD。原来按前缀一刀切，
      // 手工回滚点（bak-before-aliases / bak-before-merge3）也会被当成备份删掉（B07，实测可复现）。
      const dailyOnly = /.bak-\d{8}$/
      const names = readdirSync(storeDir).filter((name) => name.startsWith(prefix) && dailyOnly.test(name))
      if (names.length <= BACKUP_KEEP) return
      const listed = names.map((name) => {
        try {
          return { name, mtime: statSync(path.join(storeDir, name)).mtimeMs }
        } catch (error) {
          return { name, mtime: 0 }
        }
      })
      listed.sort((a, b) => b.mtime - a.mtime)
      for (const item of listed.slice(BACKUP_KEEP)) {
        try {
          unlinkSync(path.join(storeDir, item.name))
        } catch (error) {
          // 删不掉就算了，别影响主流程
        }
      }
    } catch (error) {
      // 备份清理失败不影响记忆读写
    }
  }

  function ensureDailyBackup() {
    if (!existsSync(storeFile)) return
    try {
      const target = `${storeFile}.bak-${backupDay()}`
      if (existsSync(target)) return
      copyFileSync(storeFile, target)
      pruneBackups()
    } catch (error) {
      // 备份失败不阻断写入，但 doctor 会报
    }
  }

  // ================= v4.1（P2）：SQLite 存储后端 =================
  // 设计（完整方案见 _reports/dsh-memory-p2-sqlite-plan-2026-11-02.md）：
  //   1) SQLite 只做**持久化**：entries 表存 payload（全字段 JSON）+ seq（写入顺序，排序/注入口径依赖它）
  //      + tokens/units（检索词表，由应用层 tokenize/contentUnitsOf 生成，供 FTS5 与 df 重建）；工具层代码不变。
  //   2) memory.json / archive.json 保留不动；首次以 storage: sqlite 启动时自动迁移（先备份、再回读 deepEqual，失败拒绝启动）。
  //   3) 回滚开关：config.storage = json（旧 JSON 后端代码完整保留）。
  const requireModule = createRequire(import.meta.url)
  // 代码默认仍是 json（向后兼容：旧数据目录/旧测试/回滚场景零改动）；生产由插件自带 cordis.patch.yml 显式设 storage: sqlite。
  const backend = STORE_BACKENDS.has(config?.storage) ? config.storage : 'json'
  const retrievalMode = RETRIEVAL_MODES.has(config?.retrieval) ? config.retrieval : 'index'
  const dbFile = path.join(storeDir, DB_FILE)
  let db = null
  let dbApi = null
  const dbMetaCache = new Map()
  /** v4.2.2（H2②）：本进程已发号、还没确认落盘的 id。撞号检测只认这批（别的进程写进来的条目不算）。 */
  const localNewIds = new Set()
  /** 索引镜像：id -> { tokens, units, sortLen, unitLen }（增量维护 df 与自愈重建用；10k 条约 3-5MB）。 */
  const indexMirror = new Map()
  /** id -> 写入顺序 seq（SQLite 主键顺序；加载时按「生效在前、归档在后」重排，与 JSON 后端 memory.json+archive.json 的读取顺序一致）。 */
  const seqOf = new Map()
  let indexHealthy = false
  let persistedPayloads = new Map()
  let dbWriteSeq = '0'
  let lastDbSignature = ''

  function loadSqliteApi() {
    if (dbApi !== null) return dbApi
    try {
      dbApi = requireModule('node:sqlite')
      return dbApi
    } catch (error) {
      return null
    }
  }

  const sqliteUnavailable = () =>
    fail(
      'MEMORY_SQLITE_UNAVAILABLE',
      '运行时不支持 node:sqlite（需要 Node >= 23.4；本机 DSH 内置 Node 24 满足）。为不让两套后端行为漂移，拒绝启动。' +
        '回滚方式：cordis.patch.yml 的 dsh-memory.config 里加 storage: json（旧 JSON 后端仍保留，数据不丢）。',
    )

  const dbQuote = (value) => "'" + String(value).replace(/'/g, "''") + "'"

  function createDbSchema(target) {
    target.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    target.exec("CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL, seq INTEGER NOT NULL, tokens TEXT NOT NULL, units TEXT NOT NULL, sort_len INTEGER NOT NULL, unit_len INTEGER NOT NULL)")
    target.exec('CREATE INDEX IF NOT EXISTS entries_seq ON entries(seq)')
    target.exec('CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(id UNINDEXED, tokens, tokenize = "' + FTS_TOKENIZE + '")')
    target.exec('CREATE VIRTUAL TABLE IF NOT EXISTS entries_unit_fts USING fts5(id UNINDEXED, units, tokenize = "' + FTS_TOKENIZE + '")')
    target.exec('CREATE TABLE IF NOT EXISTS term_df (term TEXT PRIMARY KEY, df INTEGER NOT NULL)')
    target.exec('CREATE TABLE IF NOT EXISTS unit_df (unit TEXT PRIMARY KEY, df INTEGER NOT NULL)')
  }

  function metaGetOn(target, key) {
    try {
      const row = target.prepare('SELECT value FROM meta WHERE key = ?').get(key)
      return row === undefined ? null : row.value
    } catch (error) {
      return null
    }
  }
  function metaSetOn(target, key, value) {
    target.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value))
  }
  const metaGet = (key) => {
    if (dbMetaCache.has(key)) return dbMetaCache.get(key)
    const value = db === null ? null : metaGetOn(db, key)
    dbMetaCache.set(key, value)
    return value
  }
  const metaSet = (key, value) => {
    dbMetaCache.set(key, String(value))
    metaSetOn(db, key, value)
  }

  /** 检索词表口径：与 bm25Doc 完全一致（text + tag/tags + aliases + entities）。 */
  function indexTermsOf(entry) {
    const tagText = Array.isArray(entry.tags) && entry.tags.length > 0 ? entry.tags.join(' ') : entry.tag ?? ''
    const aliasText = Array.isArray(entry.aliases) ? entry.aliases.join(' ') : ''
    const entityText = Array.isArray(entry.entities) ? entry.entities.join(' ') : ''
    return tokenize(String(entry.text ?? '') + ' ' + tagText + ' ' + aliasText + ' ' + entityText)
  }
  /** 覆盖率层词表口径：与 contentDoc 完全一致（text + tag/tags，不含 aliases/entities）。 */
  function indexUnitsOf(entry) {
    const tagText = Array.isArray(entry.tags) && entry.tags.length > 0 ? entry.tags.join(' ') : entry.tag ?? ''
    const counts = new Map()
    for (const unit of contentUnitsOf(String(entry.text ?? '') + ' ' + tagText)) counts.set(unit, (counts.get(unit) ?? 0) + 1)
    return counts
  }
  function countsLength(counts) {
    let total = 0
    for (const value of counts.values()) total += value
    return total
  }
  function countsToText(counts) {
    const terms = []
    for (const term of counts.keys()) terms.push(term)
    terms.sort()
    return terms.join(' ')
  }

  /** 增量维护 df / FTS / 统计计数；oldMirror 为改前镜像（新增传 undefined）。必须在事务内调用。 */
  function applyIndexEntry(entry, oldMirror) {
    const id = entry.id
    const terms = indexTermsOf(entry)
    const units = indexUnitsOf(entry)
    const tokensText = countsToText(terms)
    const unitsText = countsToText(units)
    const sortLen = countsLength(terms)
    const unitLen = countsLength(units)
    const deltas = new Map()
    if (oldMirror !== undefined) {
      for (const term of oldMirror.tokens.split(' ')) if (term !== '') deltas.set(term, (deltas.get(term) ?? 0) - 1)
      for (const unit of oldMirror.units.split(' ')) if (unit !== '') deltas.set('u:' + unit, (deltas.get('u:' + unit) ?? 0) - 1)
    } else {
      metaSet('sort_doc_count', Number(metaGet('sort_doc_count') ?? 0) + 1)
      metaSet('unit_doc_count', Number(metaGet('unit_doc_count') ?? 0) + 1)
    }
    for (const term of tokensText.split(' ')) if (term !== '') deltas.set(term, (deltas.get(term) ?? 0) + 1)
    for (const unit of unitsText.split(' ')) if (unit !== '') deltas.set('u:' + unit, (deltas.get('u:' + unit) ?? 0) + 1)
    for (const [key, delta] of deltas) {
      if (delta === 0) continue
      const isUnit = key.startsWith('u:')
      const term = isUnit ? key.slice(2) : key
      const table = isUnit ? 'unit_df' : 'term_df'
      const column = isUnit ? 'unit' : 'term'
      db.prepare('INSERT INTO ' + table + '(' + column + ', df) VALUES(?, MAX(0, ?)) ON CONFLICT(' + column + ') DO UPDATE SET df = MAX(0, df + ?)').run(term, delta, delta)
    }
    db.prepare('DELETE FROM entries_fts WHERE id = ?').run(id)
    db.prepare('INSERT INTO entries_fts(id, tokens) VALUES(?, ?)').run(id, tokensText)
    db.prepare('DELETE FROM entries_unit_fts WHERE id = ?').run(id)
    db.prepare('INSERT INTO entries_unit_fts(id, units) VALUES(?, ?)').run(id, unitsText)
    const oldSortLen = oldMirror === undefined ? 0 : oldMirror.sortLen
    const oldUnitLen = oldMirror === undefined ? 0 : oldMirror.unitLen
    metaSet('sort_len_sum', Number(metaGet('sort_len_sum') ?? 0) - oldSortLen + sortLen)
    metaSet('unit_len_sum', Number(metaGet('unit_len_sum') ?? 0) - oldUnitLen + unitLen)
    indexMirror.set(id, { tokens: tokensText, units: unitsText, sortLen, unitLen })
  }

  function removeIndexEntry(id) {
    const oldMirror = indexMirror.get(id)
    db.prepare('DELETE FROM entries_fts WHERE id = ?').run(id)
    db.prepare('DELETE FROM entries_unit_fts WHERE id = ?').run(id)
    if (oldMirror === undefined) return
    const deltas = new Map()
    for (const term of oldMirror.tokens.split(' ')) if (term !== '') deltas.set(term, (deltas.get(term) ?? 0) - 1)
    for (const unit of oldMirror.units.split(' ')) if (unit !== '') deltas.set('u:' + unit, (deltas.get('u:' + unit) ?? 0) - 1)
    for (const [key, delta] of deltas) {
      const isUnit = key.startsWith('u:')
      const term = isUnit ? key.slice(2) : key
      const table = isUnit ? 'unit_df' : 'term_df'
      const column = isUnit ? 'unit' : 'term'
      db.prepare('UPDATE ' + table + ' SET df = MAX(0, df + ?) WHERE ' + column + ' = ?').run(delta, term)
    }
    metaSet('sort_len_sum', Number(metaGet('sort_len_sum') ?? 0) - oldMirror.sortLen)
    metaSet('unit_len_sum', Number(metaGet('unit_len_sum') ?? 0) - oldMirror.unitLen)
    metaSet('sort_doc_count', Number(metaGet('sort_doc_count') ?? 0) - 1)
    metaSet('unit_doc_count', Number(metaGet('unit_doc_count') ?? 0) - 1)
    indexMirror.delete(id)
  }

  /** 全量重建 FTS + df（迁移/自愈/差分测试用）。*/
  function rebuildIndex() {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('DELETE FROM entries_fts')
      db.exec('DELETE FROM entries_unit_fts')
      db.exec('DELETE FROM term_df')
      db.exec('DELETE FROM unit_df')
      indexMirror.clear()
      const rows = db.prepare('SELECT id, payload FROM entries ORDER BY seq').all()
      const termCounts = new Map()
      const unitCounts = new Map()
      let sortLenSum = 0
      let unitLenSum = 0
      for (const row of rows) {
        let entry = null
        try { entry = JSON.parse(row.payload) } catch (error) { entry = null }
        if (entry === null || entry === undefined) continue
        const terms = indexTermsOf(entry)
        const units = indexUnitsOf(entry)
        const tokensText = countsToText(terms)
        const unitsText = countsToText(units)
        const sortLen = countsLength(terms)
        const unitLen = countsLength(units)
        for (const term of terms.keys()) termCounts.set(term, (termCounts.get(term) ?? 0) + 1)
        for (const unit of units.keys()) unitCounts.set(unit, (unitCounts.get(unit) ?? 0) + 1)
        db.prepare('INSERT INTO entries_fts(id, tokens) VALUES(?, ?)').run(row.id, tokensText)
        db.prepare('INSERT INTO entries_unit_fts(id, units) VALUES(?, ?)').run(row.id, unitsText)
        indexMirror.set(row.id, { tokens: tokensText, units: unitsText, sortLen, unitLen })
        sortLenSum += sortLen
        unitLenSum += unitLen
      }
      for (const [term, count] of termCounts) db.prepare('INSERT INTO term_df(term, df) VALUES(?, ?)').run(term, count)
      for (const [unit, count] of unitCounts) db.prepare('INSERT INTO unit_df(unit, df) VALUES(?, ?)').run(unit, count)
      metaSet('sort_doc_count', rows.length)
      metaSet('unit_doc_count', rows.length)
      metaSet('sort_len_sum', sortLenSum)
      metaSet('unit_len_sum', unitLenSum)
      db.exec('COMMIT')
      indexHealthy = true
    } catch (error) {
      try { db.exec('ROLLBACK') } catch (inner) {}
      indexHealthy = false
      throw error
    }
  }

  function pruneBackupsSqlite() {
    try {
      const prefix = DB_FILE + '.bak-'
      const dailyOnly = /[.]bak-\d{8}$/
      const names = readdirSync(storeDir).filter((name) => name.startsWith(prefix) && dailyOnly.test(name))
      if (names.length <= BACKUP_KEEP) return
      const listed = names.map((name) => {
        try { return { name, mtime: statSync(path.join(storeDir, name)).mtimeMs } } catch (error) { return { name, mtime: 0 } }
      })
      listed.sort((a, b) => b.mtime - a.mtime)
      for (const item of listed.slice(BACKUP_KEEP)) {
        try { unlinkSync(path.join(storeDir, item.name)) } catch (error) {}
      }
    } catch (error) {}
  }

  function ensureDailyBackupSqlite() {
    if (db === null) return
    try {
      const target = dbFile + '.bak-' + backupDay()
      if (existsSync(target)) return
      db.exec('VACUUM INTO ' + dbQuote(target))
      pruneBackupsSqlite()
    } catch (error) {
      // 备份失败不阻断写入（与 JSON 后端同口径）
    }
  }

  /** 迁移前备份 JSON 三件套 + sha256 清单。返回备份目录。 */
  function backupJsonBeforeMigration() {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const backupDir = path.join(storeDir, 'backups', 'pre-sqlite-' + stamp)
    mkdirSync(backupDir, { recursive: true })
    const manifest = { createdAt: new Date().toISOString(), source: storeFile, files: [] }
    for (const name of ['memory.json', 'archive.json', 'aliases.json', 'candidates.json']) {
      const from = path.join(storeDir, name)
      if (!existsSync(from)) continue
      const to = path.join(backupDir, name)
      copyFileSync(from, to)
      const bytes = readFileSync(to)
      manifest.files.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    return backupDir
  }

  /** 迁移/加载时把别名旁路文件合并进条目（旁路只补缺失；与 applyAliases 同口径）。 */
  function mergeAliasesSidecar(entries) {
    let sidecar = {}
    try {
      const parsed = JSON.parse(readFileSync(aliasesFile, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && parsed.aliases !== null && typeof parsed.aliases === 'object') sidecar = parsed.aliases
    } catch (error) {
      // 没有旁路文件从空开始
    }
    for (const entry of entries) {
      const fromSidecar = sidecar[entry.id]
      if (!Array.isArray(fromSidecar) || fromSidecar.length === 0) continue
      if (Array.isArray(entry.aliases) && entry.aliases.length > 0) continue
      entry.aliases = fromSidecar
    }
    return entries
  }

  function readJsonStoreForMigration() {
    let parsed = null
    try {
      parsed = JSON.parse(readFileSync(storeFile, 'utf8'))
    } catch (error) {
      throw fail('MEMORY_MIGRATION_FAILED', '迁移失败：memory.json 读取/解析失败（' + (error?.message ?? '') + '）。原文件未动；可用 storage: json 继续用旧后端。')
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
      throw fail('MEMORY_MIGRATION_FAILED', '迁移失败：memory.json 形状不是 {entries: []}。原文件未动；可用 storage: json 继续用旧后端。')
    }
    const active = []
    for (const raw of parsed.entries) {
      if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.text !== 'string') continue
      active.push(normalizeEntry(raw))
    }
    const archived = []
    try {
      const archivedRaw = JSON.parse(readFileSync(archiveFile, 'utf8'))
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
      // 归档文件缺失/损坏按空处理（与旧 loadArchive 的 fail-safe 同口径）
    }
    const activeIds = new Set(active.map((entry) => entry.id))
    const entries = [...active, ...archived.filter((entry) => !activeIds.has(entry.id))]
    const maxIdNumber = entries.reduce((max, entry) => {
      const match = /^m?(\d+)$/.exec(String(entry.id))
      return match ? Math.max(max, Number(match[1])) : max
    }, 0)
    const storedNextId = Number.isInteger(parsed.nextId) && parsed.nextId > 0 ? parsed.nextId : 0
    const version = Number.isInteger(parsed.version) && parsed.version > 0 ? parsed.version : 1
    if (version > SCHEMA_VERSION) throw schemaTooNewError(version, SCHEMA_VERSION)
    mergeAliasesSidecar(entries)
    return { version, nextId: Math.max(storedNextId, maxIdNumber + 1), entries }
  }

  /** JSON → SQLite 一次性迁移：备份 → 写临时 DB → 回读深比对 → 原子改名；失败删临时文件并拒绝启动。 */
  function migrateJsonToSqlite(api) {
    const lockFile = path.join(storeDir, DB_MIGRATION_LOCK)
    if (existsSync(lockFile)) {
      throw fail('MEMORY_MIGRATION_LOCKED', '检测到未完成的 SQLite 迁移锁（' + lockFile + '）。若确认上次迁移已中断，删除该锁文件后重试。')
    }
    try {
      writeFileSync(lockFile, String(process.pid), { flag: 'wx' })
    } catch (error) {
      throw fail('MEMORY_MIGRATION_LOCKED', '检测到未完成的 SQLite 迁移锁（' + lockFile + '）。若确认上次迁移已中断，删除该锁文件后重试。')
    }
    const tmpFile = dbFile + '.migrating-' + process.pid
    try {
      const source = readJsonStoreForMigration()
      const backupDir = backupJsonBeforeMigration()
      let migrationDb = null
      try {
        try { if (existsSync(tmpFile)) unlinkSync(tmpFile) } catch (error) {}
        migrationDb = new api.DatabaseSync(tmpFile)
        migrationDb.exec('PRAGMA journal_mode = WAL')
        createDbSchema(migrationDb)
        migrationDb.exec('BEGIN IMMEDIATE')
        try {
          const insert = migrationDb.prepare('INSERT INTO entries(id, payload, updated_at, seq, tokens, units, sort_len, unit_len) VALUES(?,?,?,?,?,?,?,?)')
          let seq = 0
          for (const entry of source.entries) {
            const terms = indexTermsOf(entry)
            const units = indexUnitsOf(entry)
            insert.run(entry.id, JSON.stringify(entry), String(entry.updatedAt ?? ''), seq, countsToText(terms), countsToText(units), countsLength(terms), countsLength(units))
            seq += 1
          }
          metaSetOn(migrationDb, 'schema_version', DB_SCHEMA_VERSION)
          metaSetOn(migrationDb, 'data_version', source.version)
          metaSetOn(migrationDb, 'next_id', source.nextId)
          metaSetOn(migrationDb, 'next_seq', source.entries.length)
          metaSetOn(migrationDb, 'write_seq', 1)
          metaSetOn(migrationDb, 'migrated_from', 'json')
          metaSetOn(migrationDb, 'migrated_at', new Date().toISOString())
          migrationDb.exec('COMMIT')
        } catch (error) {
          try { migrationDb.exec('ROLLBACK') } catch (inner) {}
          throw error
        }
        // 回读深比对：DB 里每条 entry 必须与源逐字段一致（内容不动）。
        const readBack = migrationDb.prepare('SELECT payload FROM entries ORDER BY seq').all()
        const parsedBack = []
        for (const row of readBack) parsedBack.push(JSON.parse(row.payload))
        const sourceCanonical = canonicalJson(source.entries)
        const backCanonical = canonicalJson(parsedBack)
        if (sourceCanonical !== backCanonical) {
          throw fail('MEMORY_MIGRATION_FAILED', '迁移回读比对不一致（源 ' + source.entries.length + ' 条 vs DB ' + parsedBack.length + ' 条）：已删除临时数据库，原 JSON 未动。')
        }
      } finally {
        try { if (migrationDb !== null) migrationDb.close() } catch (error) {}
      }
      try { unlinkSync(dbFile) } catch (error) {}
      renameSync(tmpFile, dbFile)
      return backupDir
    } catch (error) {
      try { if (existsSync(tmpFile)) unlinkSync(tmpFile) } catch (inner) {}
      if (error?.code === 'MEMORY_MIGRATION_FAILED' || error?.code === 'MEMORY_MIGRATION_LOCKED') throw error
      throw fail('MEMORY_MIGRATION_FAILED', '迁移失败：' + (error?.message ?? 'unknown') + '。原 JSON 未动；可用 storage: json 继续用旧后端。')
    } finally {
      try { unlinkSync(lockFile) } catch (error) {}
    }
  }

  function createEmptySqlite(api) {
    const emptyDb = new api.DatabaseSync(dbFile)
    try {
      emptyDb.exec('PRAGMA journal_mode = WAL')
      createDbSchema(emptyDb)
      metaSetOn(emptyDb, 'schema_version', DB_SCHEMA_VERSION)
      metaSetOn(emptyDb, 'data_version', SCHEMA_VERSION)
      metaSetOn(emptyDb, 'next_id', 1)
      metaSetOn(emptyDb, 'next_seq', 0)
      metaSetOn(emptyDb, 'write_seq', 1)
    } finally {
      try { emptyDb.close() } catch (error) {}
    }
  }

  function loadSqliteState() {
    const api = loadSqliteApi()
    if (api === null) throw sqliteUnavailable()
    mkdirSync(storeDir, { recursive: true })
    if (!existsSync(dbFile)) {
      if (existsSync(storeFile)) migrateJsonToSqlite(api)
      else createEmptySqlite(api)
    }
    // 打开 + PRAGMA + quick_check 全在一次 try 里：SQLite 是惰性打开的，坏文件往往到第一条语句才暴露。
    try {
      db = new api.DatabaseSync(dbFile)
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA busy_timeout = 2000')
      db.exec('PRAGMA synchronous = NORMAL')
      const quick = db.prepare('PRAGMA quick_check').all()
      const first = quick.length > 0 ? Object.values(quick[0])[0] : 'ok'
      if (first !== 'ok') throw new Error('quick_check: ' + String(first))
    } catch (error) {
      try { if (db !== null) db.close() } catch (inner) {}
      db = null
      storeHealth = 'corrupt'
      corruptCopy = dbFile
      return
    }
    if (db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'meta') === undefined) createDbSchema(db)
    const dbSchema = Number(metaGet('schema_version') ?? 0)
    if (dbSchema === 0) {
      metaSet('schema_version', DB_SCHEMA_VERSION)
      dbSchemaCacheReset()
    }
    if (dbSchema > DB_SCHEMA_VERSION) {
      const refusal = new Error('dsh-memory 拒绝启动：SQLite 存储 schema ' + dbSchema + ' 高于插件支持的 ' + DB_SCHEMA_VERSION + '。请升级插件或从备份恢复；为避免旧逻辑覆盖新数据，本次拒绝加载。')
      refusal.code = 'MEMORY_SCHEMA_TOO_NEW'
      throw refusal
    }
    const dataVersion = Number(metaGet('data_version') ?? 0) || 1
    if (dataVersion > SCHEMA_VERSION) throw schemaTooNewError(dataVersion, SCHEMA_VERSION)
    const rawRows = db.prepare('SELECT id, payload, tokens, units, sort_len, unit_len, seq FROM entries').all()
    seqOf.clear()
    const parsedRows = []
    for (const row of rawRows) {
      let parsed = null
      try { parsed = JSON.parse(row.payload) } catch (error) { parsed = null }
      if (parsed === null || typeof parsed !== 'object' || typeof parsed.id !== 'string' || typeof parsed.text !== 'string') continue
      const entry = normalizeEntry(parsed)
      parsedRows.push({ entry, seq: Number(row.seq ?? 0), row })
      seqOf.set(entry.id, Number(row.seq ?? 0))
    }
    // 顺序对齐 JSON 后端：memory.json 里的生效条目在前，archive.json 里的归档条目在后（各自保持写入顺序）。
    parsedRows.sort((a, b) => {
      const archivedA = isArchivedEntry(a.entry) ? 1 : 0
      const archivedB = isArchivedEntry(b.entry) ? 1 : 0
      if (archivedA !== archivedB) return archivedA - archivedB
      return a.seq - b.seq
    })
    const rows = parsedRows.map((item) => item.row)
    const entries = parsedRows.map((item) => item.entry)
    const maxIdNumber = entries.reduce((max, entry) => {
      const match = /^m?(\d+)$/.exec(String(entry.id))
      return match ? Math.max(max, Number(match[1])) : max
    }, 0)
    replaceState({
      nextId: Math.max(Number(metaGet('next_id') ?? 1) || 0, maxIdNumber + 1),
      version: dataVersion,
      entries,
    })
    persistedPayloads = new Map()
    for (const entry of entries) persistedPayloads.set(entry.id, JSON.stringify(entry))
    indexMirror.clear()
    for (const row of rows) {
      if (row.id === undefined) continue
      indexMirror.set(row.id, { tokens: String(row.tokens ?? ''), units: String(row.units ?? ''), sortLen: Number(row.sort_len ?? 0), unitLen: Number(row.unit_len ?? 0) })
    }
    dbWriteSeq = String(metaGet('write_seq') ?? '0')
    lastDbSignature = dbWriteSeq
    ensureSqliteIndex()
  }

  /** 索引自检：FTS/统计表与条目数不一致就重建（迁移中断、外部改库、旧库缺别名都能自愈）。 */
  function ensureSqliteIndex() {
    if (db === null) return
    try {
      const rowCount = Number(db.prepare('SELECT count(*) AS n FROM entries').get().n)
      const ftsRow = db.prepare('SELECT count(*) AS n FROM entries_fts').get()
      const ftsCount = ftsRow === undefined ? 0 : Number(ftsRow.n)
      const statCount = Number(metaGet('sort_doc_count') ?? 0)
      if (ftsCount !== rowCount || statCount !== rowCount || indexMirror.size !== rowCount) rebuildIndex()
      else indexHealthy = true
    } catch (error) {
      indexHealthy = false
    }
  }

  /** 别名旁路在加载后合入内存：若与 DB payload 不一致，立刻写回（索引随 persist 增量更新）。 */
  function syncSqliteAliases() {
    if (db === null) return
    let changed = false
    for (const entry of state.entries) {
      if (persistedPayloads.get(entry.id) !== JSON.stringify(entry)) {
        changed = true
        break
      }
    }
    if (!changed) return
    try {
      persistSqlite()
    } catch (error) {
      // 写失败留给下一次写入重试，不阻断启动
    }
  }

  /** 别的进程写过就刷新内存态（等价于 JSON 后端的 mergeWithDisk，靠 meta.write_seq 判断）。 */
  function refreshSqliteState() {
    if (db === null) return
    // 这里必须绕开 metaGet 缓存：write_seq/next_id 是别的进程刚写的，缓存里是旧值。
    const seq = String(metaGetOn(db, 'write_seq') ?? '0')
    if (seq === lastDbSignature) return
    const rows = db.prepare('SELECT id, payload, tokens, units, sort_len, unit_len, seq FROM entries').all()
    const byId = new Map()
    for (const row of rows) {
      let parsed = null
      try { parsed = JSON.parse(row.payload) } catch (error) { parsed = null }
      if (parsed === null || typeof parsed !== 'object' || typeof parsed.id !== 'string') continue
      seqOf.set(row.id, Number(row.seq ?? 0))
      byId.set(row.id, { entry: normalizeEntry(parsed), tokens: String(row.tokens ?? ''), units: String(row.units ?? ''), sortLen: Number(row.sort_len ?? 0), unitLen: Number(row.unit_len ?? 0) })
    }
    const next = []
    const seen = new Set()
    for (const entry of state.entries) {
      const disk = byId.get(entry.id)
      if (disk === undefined) {
        if (persistedPayloads.has(entry.id)) continue
        next.push(entry)
        seen.add(entry.id)
        continue
      }
      seen.add(entry.id)
      const mine = Date.parse(entry.updatedAt ?? '') || 0
      const theirs = Date.parse(disk.entry.updatedAt ?? '') || 0
      const winner = mine >= theirs ? entry : disk.entry
      next.push(winner)
      if (winner === disk.entry) persistedPayloads.set(entry.id, JSON.stringify(disk.entry))
      if (winner === disk.entry) indexMirror.set(entry.id, { tokens: disk.tokens, units: disk.units, sortLen: disk.sortLen, unitLen: disk.unitLen })
    }
    for (const [id, disk] of byId) {
      if (seen.has(id)) continue
      next.push(disk.entry)
      persistedPayloads.set(id, JSON.stringify(disk.entry))
      indexMirror.set(id, { tokens: disk.tokens, units: disk.units, sortLen: disk.sortLen, unitLen: disk.unitLen })
    }
    // 与加载顺序同口径：生效在前、归档在后；组内按 seq。
    next.sort((a, b) => {
      const archivedA = isArchivedEntry(a) ? 1 : 0
      const archivedB = isArchivedEntry(b) ? 1 : 0
      if (archivedA !== archivedB) return archivedA - archivedB
      return (seqOf.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (seqOf.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    })
    state.entries = next
    const maxIdNumber = state.entries.reduce((max, entry) => {
      const match = /^m?(\d+)$/.exec(String(entry.id))
      return match ? Math.max(max, Number(match[1])) : max
    }, 0)
    state.nextId = Math.max(Number(metaGetOn(db, 'next_id') ?? state.nextId), maxIdNumber + 1)
    state.version = Math.max(state.version, Number(metaGetOn(db, 'data_version') ?? state.version))
    // v4.2.2（H2③）：统计键缓存必须随刷新一起失效。别的进程已经改了 sort_doc_count / unit_doc_count /
    // sort_len_sum（以及 df 表的维护基准），继续用本进程缓存里的旧值写回，会把计数改歪——
    // 审计 H2 实测：entries 16 行而 sort_doc_count=1 → memory_search 的 idf 变负 → 静默返回 0 条。
    // 整表清空最稳（DB 是权威源）：下面再放回本次已确认的三个键，其余键下次按需直读。
    dbMetaCache.clear()
    dbMetaCache.set('next_id', String(state.nextId))
    dbMetaCache.set('write_seq', seq)
    dbMetaCache.set('data_version', String(state.version))
    lastDbSignature = seq
  }

  /**
   * v4.2.2（H2①）：在 BEGIN IMMEDIATE 内原子发号。
   * 旧实现是「execute() 先 refresh，再读 state.nextId 发号，最后 persist 里才开写事务」——
   * 读号与写号之间存在 TOCTOU：两个进程同窗口各自拿到 m1，主键冲突被
   * `ON CONFLICT(id) DO UPDATE` 静默吃掉（审计 H2：16 次写入报成功、库里只剩 10 条）。
   * 现在发号本身就是一个短写事务：读 meta.next_id → +1 写回 → COMMIT，拿到的号不会被别人重复发。
   * JSON 后端没有跨进程并发（锁文件串行），保持原语义：内存自增。
   */
  function newEntryId() {
    if (backend !== 'sqlite' || db === null) {
      const id = `m${state.nextId}`
      state.nextId += 1
      return id
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      const stored = Number(metaGetOn(db, 'next_id') ?? 1)
      // state.nextId 是刷新后的下限（含库内最大 id + 1），两者取大——只增不减。
      const floor = Math.max(Number.isFinite(stored) && stored > 0 ? stored : 1, state.nextId)
      metaSetOn(db, 'next_id', floor + 1)
      db.exec('COMMIT')
      state.nextId = floor + 1
      localNewIds.add('m' + floor)
      dbMetaCache.set('next_id', String(state.nextId))
      return `m${floor}`
    } catch (error) {
      try { db.exec('ROLLBACK') } catch (inner) {}
      if (String(error?.message ?? '').includes('SQLITE_BUSY')) {
        throw fail('MEMORY_STORE_WRITE_FAILED', '记忆库正被另一个进程写入（SQLITE_BUSY），本次没有分配 id、没有写入任何数据；稍等重试一次即可。')
      }
      throw error
    }
  }

  function persistSqlite() {
    if (storeHealth === 'corrupt') return false
    if (db === null) return false
    try {
      ensureDailyBackupSqlite()
      refreshSqliteState()
      const payloads = new Map()
      for (const entry of state.entries) payloads.set(entry.id, JSON.stringify(entry))
      // v4.2.2（H2②）：只把「本进程发号、还没落盘」的 id 当新条目。
      // 不能用「快照前没见过的 id」判断——refresh 会把别的进程刚写的条目并进来，那样会把别人的条目误判成撞号。
      const freshLocalIds = []
      for (const id of localNewIds) if (payloads.has(id)) freshLocalIds.push(id)
      const upserts = []
      for (const [id, payload] of payloads) if (persistedPayloads.get(id) !== payload) upserts.push([id, payload])
      const deletes = []
      for (const id of persistedPayloads.keys()) if (!payloads.has(id)) deletes.push(id)
      db.exec('BEGIN IMMEDIATE')
      try {
        // v4.2.2（H2②）：新条目撞主键不再 DO UPDATE 静默覆盖。
        // 本进程刚发号（freshLocalIds）而库里已有同一 id = 被别的进程占了：把内存态回退到磁盘版本，
        // 然后抛 MEMORY_ID_CONFLICT 让本次事务整体回滚（调用方重试会拿到新号）。
        const existingRow = db.prepare('SELECT payload, tokens, units, sort_len, unit_len, seq FROM entries WHERE id = ?')
        const conflicts = []
        for (const id of freshLocalIds) {
          if (!payloads.has(id)) continue
          const row = existingRow.get(id)
          if (row !== undefined) conflicts.push({ id, row })
        }
        if (conflicts.length > 0) {
          for (const item of conflicts) {
            localNewIds.delete(item.id)
            let diskEntry = null
            try { diskEntry = normalizeEntry(JSON.parse(item.row.payload)) } catch (error) { diskEntry = null }
            const at = state.entries.findIndex((entry) => entry.id === item.id)
            if (diskEntry === null) {
              if (at >= 0) state.entries.splice(at, 1)
              persistedPayloads.delete(item.id)
              indexMirror.delete(item.id)
              seqOf.delete(item.id)
              continue
            }
            if (at >= 0) state.entries[at] = diskEntry
            else state.entries.push(diskEntry)
            persistedPayloads.set(item.id, String(item.row.payload))
            indexMirror.set(item.id, { tokens: String(item.row.tokens ?? ''), units: String(item.row.units ?? ''), sortLen: Number(item.row.sort_len ?? 0), unitLen: Number(item.row.unit_len ?? 0) })
            seqOf.set(item.id, Number(item.row.seq ?? 0))
          }
          throw fail(
            'MEMORY_ID_CONFLICT',
            '新增条目 id 冲突（' + conflicts.slice(0, 3).map((item) => item.id).join('、') + (conflicts.length > 3 ? ' 等 ' + conflicts.length + ' 条' : '') + '）：库里已被另一进程占用。' +
              '本次写入已整体回滚、没有覆盖任何数据；直接重试一次即可（会自动分配新的 id）。',
          )
        }
        const insert = db.prepare('INSERT INTO entries(id, payload, updated_at, seq, tokens, units, sort_len, unit_len) VALUES(?,?,?,?,?,?,?,?)')
        const update = db.prepare('UPDATE entries SET payload = ?, updated_at = ?, tokens = ?, units = ?, sort_len = ?, unit_len = ? WHERE id = ?')
        // v4.2.2（H2⑤）：next_seq 必须在写事务内直读磁盘——旧实现读内存缓存，两进程并发写时
        // 各自拿到相同的起始 seq，seq 重复发号、next_seq 落后于行数（审计 H2 实测：16 行、next_seq=15）。
        let nextSeq = Number(metaGetOn(db, 'next_seq') ?? state.entries.length)
        for (const [id, payload] of upserts) {
          const entry = state.entries.find((item) => item.id === id)
          if (entry === undefined) continue
          const oldMirror = indexMirror.get(id)
          const terms = indexTermsOf(entry)
          const units = indexUnitsOf(entry)
          const tokensText = countsToText(terms)
          const unitsText = countsToText(units)
          const sortLen = countsLength(terms)
          const unitLen = countsLength(units)
          const seqRow = db.prepare('SELECT seq FROM entries WHERE id = ?').get(id)
          const seq = seqRow === undefined ? nextSeq++ : Number(seqRow.seq)
          // v4.2.2（H2②）：新增走 INSERT、已存在走 UPDATE —— 没有任何覆盖别人新条目的路径。
          if (seqRow === undefined) insert.run(id, payload, String(entry.updatedAt ?? ''), seq, tokensText, unitsText, sortLen, unitLen)
          else update.run(payload, String(entry.updatedAt ?? ''), tokensText, unitsText, sortLen, unitLen, id)
          seqOf.set(id, seq)
          applyIndexEntry(entry, oldMirror)
          persistedPayloads.set(id, payload)
        }
        for (const id of deletes) {
          db.prepare('DELETE FROM entries WHERE id = ?').run(id)
          removeIndexEntry(id)
          seqOf.delete(id)
          persistedPayloads.delete(id)
        }
        // v4.2.2（H2③）：写后对账 —— 统计键以 entries 实际行数为准。
        // 并发写会把计数写歪；旧实现里 sort_doc_count 一旦偏小，memory_search 的 idf 会变负、
        // 分数被 score > 0.0001 全部滤掉 → 检索静默返回 0 条（审计 H2 连带后果）。
        const rowCount = Number(db.prepare('SELECT count(*) AS n FROM entries').get().n)
        metaSet('sort_doc_count', rowCount)
        metaSet('unit_doc_count', rowCount)
        const maxSeqRow = db.prepare('SELECT MAX(seq) AS n FROM entries').get()
        const maxSeq = maxSeqRow === undefined || maxSeqRow.n === null ? -1 : Number(maxSeqRow.n)
        metaSet('next_seq', Math.max(nextSeq, maxSeq + 1))
        // v4.2.2（H2①）：next_id 只增不减 —— 别的进程可能已经发到更大的号，不能拿本进程的旧值写回去。
        const storedNextId = Number(metaGetOn(db, 'next_id') ?? 0) || 0
        state.nextId = Math.max(state.nextId, storedNextId)
        metaSet('next_id', state.nextId)
        metaSet('data_version', state.version)
        // v4.2.2（H2⑤）：write_seq 同样在事务内直读磁盘再 +1。旧实现读缓存 +1 是 TOCTOU：
        // 两进程可写相同值，单调性丢失后别的进程 refresh 判重失效（与 next_seq 同一根因）。
        const writeSeq = Number(metaGetOn(db, 'write_seq') ?? 0) + 1
        metaSet('write_seq', writeSeq)
        db.exec('COMMIT')
        for (const id of freshLocalIds) localNewIds.delete(id)
        // 发号后没进内存的 id（校验阶段就抛错）也清掉，避免集合无限增长。
        for (const id of [...localNewIds]) if (!payloads.has(id)) localNewIds.delete(id)
        lastDbSignature = String(writeSeq)
      } catch (error) {
        try { db.exec('ROLLBACK') } catch (inner) {}
        throw error
      }
      syncAliases()
      recordHistoryDiff()
      flushManifest()
      return true
    } catch (error) {
      // v4.2.2（H2②）：id 冲突是可重试的并发错误，不是存储损坏 —— 原样上抛，别降级成只读。
      if (error instanceof Error && (error.code === 'MEMORY_ID_CONFLICT' || error.message.startsWith('SQLite 存储写入失败') || error.message.includes('SQLITE_BUSY'))) throw error
      storeHealth = 'readonly'
      throw fail('MEMORY_STORE_WRITE_FAILED', 'SQLite 存储写入失败（' + (error?.message ?? 'unknown') + '）。本次写入没有生效，别当成已保存；可用 storage: json 回滚后重试。')
    }
  }

  function dbSchemaCacheReset() {
    dbMetaCache.clear()
  }

  // ---------- v4.1（P2.2）：FTS5 候选集 + 统计 ----------
  // 为什么不是「FTS5 的 bm25」：排序公式（BM25 K1/B + tag×2 + alias×2.5 + 扩展×0.2 + STALE_PENALTY）在应用层，
  // 换成 FTS5 内置 bm25 = 换公式（红线 1）。所以 FTS5 只做两件事：候选集召回 + df 查表；分数仍按原公式算。
  function ftsCandidateIds(terms) {
    if (db === null) return null
    const phrases = []
    for (const term of terms) {
      const clean = String(term ?? '')
      if (clean === '') continue
      phrases.push('"' + clean.replace(/"/g, '""') + '"')
    }
    if (phrases.length === 0) return null
    try {
      const rows = db.prepare('SELECT id FROM entries_fts WHERE tokens MATCH ?').all(phrases.join(' OR '))
      const ids = new Set()
      for (const row of rows) ids.add(row.id)
      return ids
    } catch (error) {
      indexHealthy = false
      return null
    }
  }

  function indexDf(term) {
    try {
      const row = db.prepare('SELECT df FROM term_df WHERE term = ?').get(term)
      return row === undefined ? 0 : Number(row.df)
    } catch (error) {
      indexHealthy = false
      return 0
    }
  }

  /** memory_search 语料的统计量 = 全量 df/计数 − invalidAt 已失效条目的贡献（与 scoreEntries 收到的 docs 集合逐位对齐）。 */
  function searchCorpusStats() {
    const invalidDocs = []
    for (const entry of state.entries) if (isInvalidEntry(entry)) invalidDocs.push(bm25Doc(entry))
    const totalCount = Number(metaGet('sort_doc_count') ?? 0)
    const totalLen = Number(metaGet('sort_len_sum') ?? 0)
    let invalidLen = 0
    for (const doc of invalidDocs) invalidLen += doc.length
    const docCount = Math.max(0, totalCount - invalidDocs.length)
    const avgLen = docCount > 0 ? (totalLen - invalidLen) / docCount : 1
    const dfCache = new Map()
    return {
      docCount,
      avgLen,
      df(term) {
        const cached = dfCache.get(term)
        if (cached !== undefined) return cached
        let value = indexDf(term)
        for (const doc of invalidDocs) if (doc.terms.has(term)) value -= 1
        const result = Math.max(0, value)
        dfCache.set(term, result)
        return result
      },
    }
  }

  /** 与 scoreEntries 公式逐位相同的候选打分（只对 FTS5 候选集算；差分测试要求与全量扫描 top-k/score 逐位一致）。 */
  function scoreEntriesIndexed(searchable, query) {
    if (db === null || !indexHealthy) return null
    const queryTerms = tokenize(query)
    const expansion = expandQuery(query)
    if (queryTerms.size === 0 && expansion.size === 0) {
      const zeros = []
      for (const entry of searchable) zeros.push({ entry, score: 0 })
      return zeros
    }
    const weights = new Map()
    for (const term of queryTerms.keys()) weights.set(term, 1)
    for (const [term, weight] of expansion) if (!weights.has(term)) weights.set(term, weight)
    const candidateIds = ftsCandidateIds([...weights.keys()])
    if (candidateIds === null) return null
    const searchableById = new Map()
    for (const entry of searchable) searchableById.set(entry.id, entry)
    const stats = searchCorpusStats()
    const today = localDateOf()
    const scored = []
    for (const id of candidateIds) {
      const entry = searchableById.get(id)
      if (entry === undefined) continue
      const doc = bm25Doc(entry)
      let score = 0
      for (const [term, weight] of weights) {
        const frequency = doc.terms.get(term) ?? 0
        if (frequency === 0) continue
        const hit = stats.df(term)
        const idf = Math.log(1 + (stats.docCount - hit + 0.5) / (hit + 0.5))
        const tagBoost = doc.tagText.includes(term) ? BM25_TAG_WEIGHT : 1
        const aliasBoost = doc.aliasTerms.has(term) ? BM25_ALIAS_WEIGHT : 1
        score += weight * tagBoost * aliasBoost * idf * ((frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / stats.avgLen)))
      }
      if (isStaleEntry(entry, today)) score *= STALE_PENALTY
      if (score > 0.0001) scored.push({ entry, score })
    }
    return scored
  }
  const requireWritable = () => {
    if (storeHealth !== 'corrupt') return
    throw fail('MEMORY_STORE_CORRUPT', 
      `记忆库损坏保护中：原文件已另存为 ${corruptCopy || storeFile}。人工确认修复（把合法 JSON 改名回 ${storeFile}）并重载插件前，拒绝写入。`,
    )
  }

  /**
   * v3.18 自动入库（高置信度通道）：规则文件来的硬规则直接以 draft 身份进库。
   * 依据 arXiv 2610.27377《What to Store, When to Recall, What to Forget in Experience Memory for Coding Agents》——
   * 写入策略要在「该记」和「该忘」之间做预算权衡，而不是一律推给人审。
   * 三条同时成立才收：来源=规则文件 / kind=rule / 与现有记忆相似度 < 0.7。
   * 预算不够时先归档「最低价值」条目（status=deprecated + archivedAt，可逆，不物理删）。
   */
  // v3.25：加 minAgeDays —— 普通写入腾地方时只归档「至少 N 天没动过」的条目，
  // 避免刚写进来的记忆立刻被后续写入挤掉。规则入库通道保持 minAgeDays=0（原行为）。
  function lowestValueCandidate(minAgeDays = 0, tier = 'hot') {
    const cutoff = minAgeDays > 0 ? Date.now() - minAgeDays * 86400000 : 0
    const today = localDateOf()
    // Hermes 判断机制：淘汰按「信号」排序，不再拿「从未命中」当唯一/优先判据。
    // stale（到期未复核）是确定性信号，排最前；never-used 是「没证据」，只能垫底，且必须足够旧才准参与。
    // v4.15：只归档**同一层**的条目——归档冷层条目腾不出热层空间，反之亦然（原来不分层，等于白归档）。
    // v4.15②：豁免并入 isEliminationProtected——2026-11-12 集成测试抓到 makeRoom 会归档 vault:// 指针条目（真误归档）。
    const pool = activeEntries().filter((entry) => !isEliminationProtected(entry) && tierOf(entry) === tier)
    if (pool.length === 0) return null
    const scored = pool.map((entry) => {
      const sig = eliminationSignal(entry, today)
      if (sig.rank === 1) {
        // never-used 旁证：minAge 门槛只对它生效；stale（rank 0）不需要年龄门槛。
        const updated = Date.parse(String(entry.updatedAt ?? entry.addedAt ?? ''))
        if (cutoff > 0 && !(Number.isFinite(updated) && updated < cutoff)) {
          return { entry, rank: 2, imp: effectiveImportance(entry) }
        }
      }
      return { entry, rank: sig.rank, imp: effectiveImportance(entry) }
    })
    const eligible = scored.filter((s) => s.rank <= 1)
    if (eligible.length === 0) return null
    eligible.sort((a, b) => (a.rank - b.rank) || (a.imp - b.imp))
    return eligible[0].entry
  }

  function makeRoom(size, opts) {
    const fallbackReason = typeof opts?.reason === 'string' ? opts.reason : 'auto-archive: 为规则自动入库腾预算'
    const minAgeDays = Number.isFinite(opts?.minAgeDays) ? opts.minAgeDays : 0
    const tier = opts?.tier === 'cold' ? 'cold' : 'hot'
    const archived = []
    let guard = 0
    while (tierUsed(tier) + size > tierMax(tier) && guard < 20) {
      guard += 1
      const victim = lowestValueCandidate(minAgeDays, tier)
      if (victim === null) return { ok: false, archived }
      const sig = eliminationSignal(victim, localDateOf())
      victim.status = 'deprecated'
      victim.archivedAt = new Date().toISOString()
      // 分类归档理由（对齐 Hermes「每条淘汰都必须带 why」）：有判断信号就写信号，没有才回退到调用方给的通用理由。
      victim.archiveReason = sig.rank <= 1 ? '淘汰·' + sig.reason : fallbackReason
      archived.push(victim.id)
      queueManifest([{ ts: victim.archivedAt, by: 'makeRoom', id: victim.id, reason: victim.archiveReason, signal: sig.rank <= 1 ? sig.signal : 'none', chars: victim.text.length }])
    }
    return { ok: tierUsed(tier) + size <= tierMax(tier), archived }
  }

  /**
   * v4.15② 满库自动收敛（取经 hindsight 的 merge/evict + Hermes「每条淘汰都要带 why」）。
   *
   * 触发条件：**只有那一层已经写满**时才调（degraded 不调）——这是最后一道闸，不是常态淘汰。
   * 两步，都只归档不删除（memory_restore 可逐条回滚）：
   *   ① 包含式去重：A 的正文是 B 的子串 → A 冗余，归档 A（reason 写明包含于谁）。
   *   ② 低价值归档：同层、非 pinned/rule/draft、usedCount ≤ CONVERGE_MAX_USES、
   *      至少 CONVERGE_MIN_AGE_DAYS 天没动过、正文不含 vault:// 指针（指针是知识入口，不自动归）。
   * 单次最多 CONVERGE_MAX_PER_CALL 条；够写就停，不顺手清空。
   *
   * 为什么不用 LLM 合并：hindsight 的 merge 要 LLM 裁决（consolidator.py:301-374），
   * 我们没有能保证不丢细节的确定性合并器，硬做就是造假。只做可证明安全的包含式去重。
   */
  function convergeTier(size, tier = 'hot') {
    const archived = []
    const merged = []
    const stamp = () => new Date().toISOString()
    const fits = () => tierUsed(tier) + size <= tierMax(tier)
    const archive = (entry, reason, by) => {
      entry.status = 'deprecated'
      entry.archivedAt = stamp()
      entry.archiveReason = reason
      archived.push(entry.id)
      queueManifest([{ ts: entry.archivedAt, by, id: entry.id, reason, signal: 'none', chars: entry.text.length }])
    }

    // ① 包含式去重（只碰非豁免条目：pinned / rule / draft / 身份 / vault:// 指针一律不动）
    const pool = activeEntries().filter((entry) => !isEliminationProtected(entry) && tierOf(entry) === tier)
    for (const small of pool) {
      if (fits() || archived.length >= CONVERGE_MAX_PER_CALL) break
      const body = String(small.text ?? '')
      if (body.length < 24) continue
      const host = pool.find((other) => other.id !== small.id && String(other.text ?? '').includes(body))
      if (host === undefined) continue
      if (archived.includes(small.id)) continue
      archive(small, '收敛·包含于 ' + host.id, 'converge:containment')
      merged.push({ into: host.id, from: small.id })
    }

    // ② 低价值归档（价值 = 重要度低 → 使用次数少 → 最旧 优先）
    const cutoff = Date.now() - CONVERGE_MIN_AGE_DAYS * 86400000
    const today = localDateOf()
    const lowValue = () =>
      activeEntries()
        .filter((entry) => {
          if (isEliminationProtected(entry)) return false
          if (tierOf(entry) !== tier) return false
          if (Number(entry.usedCount ?? 0) > CONVERGE_MAX_USES) return false
          const ts = Date.parse(String(entry.lastUsedAt ?? entry.updatedAt ?? entry.addedAt ?? ''))
          return Number.isFinite(ts) && ts < cutoff
        })
        .map((entry) => ({ entry, imp: effectiveImportance(entry) }))
        .sort((a, b) => a.imp - b.imp || Number(a.entry.usedCount ?? 0) - Number(b.entry.usedCount ?? 0))

    while (!fits() && archived.length < CONVERGE_MAX_PER_CALL) {
      const next = lowValue()[0]
      if (next === undefined) break
      const stale = isStaleEntry(next.entry, today)
      archive(next.entry, stale ? '收敛·staleAfter 已过' : '收敛·低价值（重要度/使用次数最低、≥' + CONVERGE_MIN_AGE_DAYS + ' 天未动）', 'converge:lowValue')
    }

    return { ok: fits(), tier, archived, merged }
  }

  /**
   * v4.2（Anthropic A2「索引硬预算超了要报错强制精简」）：见顶时给**可执行**建议——
   * 哪几条能合并（合计多少字符）、哪几条 stale / 从未命中可以 drop。
   * 只读、只算候选，不改库；真正的合并/删除仍由 memory_merge / memory_remove 显式执行。
   */
  function pruneSuggestions() {
    const pool = activeEntries().filter((entry) => entry.pinned !== true)
    // 两两相似度是 O(n²)：上限取最近 120 条，避免在写入主路径上算几万次。
    const capped = pool.slice(-120)
    const pairs = []
    for (let i = 0; i < capped.length; i += 1) {
      for (let j = i + 1; j < capped.length; j += 1) {
        const similarity = textSimilarity(capped[i].text, capped[j].text)
        if (similarity >= SIMILAR_HINT_FLOOR) pairs.push({ a: capped[i], b: capped[j], similarity })
      }
    }
    pairs.sort((x, y) => y.similarity - x.similarity)
    const merges = pairs.slice(0, 3).map((pair) => ({
      a: pair.a.id,
      b: pair.b.id,
      similarity: Math.round(pair.similarity * 1000) / 1000,
      total: pair.a.text.length + pair.b.text.length,
    }))
    const today = localDateOf()
    const cutoff = Date.now() - ROOM_MIN_AGE_DAYS * 86400000
    const dropCandidates = []
    for (const entry of pool) {
      // 规则条目永不作为 drop 候选：它们由规则文件自动入库 / pinned 硬约定，删了会被重新沉淀；
      // 与 makeRoom 的 lowestValueCandidate（kind !== 'rule'）保持同一口径（2026-11-02 独立复核抓到不一致）。
      if (entry.kind === 'rule') continue
      if (isStaleEntry(entry, today)) {
        dropCandidates.push({ entry, reason: 'staleAfter ' + entry.staleAfter + ' 已过（待重验）' })
        continue
      }
      const updated = Date.parse(String(entry.updatedAt ?? entry.addedAt ?? ''))
      if ((entry.usedCount ?? 0) === 0 && Number.isFinite(updated) && updated < cutoff) {
        dropCandidates.push({ entry, reason: '从未被检索命中、>' + ROOM_MIN_AGE_DAYS + ' 天未更新' })
      }
    }
    dropCandidates.sort((x, y) => effectiveImportance(x.entry) - effectiveImportance(y.entry))
    const drops = dropCandidates.slice(0, 5).map((item) => ({
      id: item.entry.id,
      chars: item.entry.text.length,
      reason: item.reason,
    }))
    return { merges, drops, scanned: capped.length, truncated: pool.length > capped.length }
  }

  /** v4.2：见顶报错 = 现状 + 可执行精简建议（合并 / drop），不再只说「超预算」。 */
  // v4.15：按**层**报数——热层（进 prompt）和冷层（只检索）是两本账，混着报会让人以为「删冷条目能腾热空间」。
  function budgetExceededMessage(need, archivedIds, tier = 'hot') {
    const plan = pruneSuggestions()
    const lines = []
    const self = tierBudget(tier)
    const other = tierBudget(tier === 'cold' ? 'hot' : 'cold')
    lines.push(
      '记忆' +
        (tier === 'cold' ? '冷层' : '热层') +
        '已占用 ' +
        self.used +
        ' / ' +
        self.max +
        ' 字符（另一层 ' +
        (tier === 'cold' ? '热层' : '冷层') +
        ' ' +
        other.used +
        ' / ' +
        other.max +
        (tier === 'cold' ? '，不进 prompt' : '') +
        '），本次需 ' +
        need +
        ' 字符；自动归档腾地方后仍不够。',
    )
    if (Array.isArray(archivedIds) && archivedIds.length > 0) {
      lines.push('本轮已自动归档：' + archivedIds.join(' ') + '（可 memory_restore 恢复）。')
    }
    lines.push('主动精简建议（v4.2）：')
    if (plan.merges.length > 0) {
      lines.push('  ① 合并（memory_merge {ids:["a","b"]}，相似条目并成一条）：')
      for (const item of plan.merges) {
        lines.push('     - ' + item.a + ' + ' + item.b + ' 相似 ' + item.similarity + '，合计 ' + item.total + ' 字符 → 合并成一条')
      }
    }
    if (plan.drops.length > 0) {
      lines.push('  ② drop（memory_remove {id, confirm:true}；先 memory_list 按删除三查核对，不带 confirm 只返回将删清单）：')
      for (const item of plan.drops) {
        lines.push('     - ' + item.id + '（' + item.reason + '，' + item.chars + ' 字符）')
      }
    }
    if (plan.merges.length === 0 && plan.drops.length === 0) {
      lines.push('  没有可合并 / 可 drop 的候选：其余条目都是 pinned / 规则 / 刚写入或高价值，只能 memory_update 精简长条目。')
    }
    lines.push(
      tier === 'cold'
        ? '若还不够：冷层不占每轮 prompt，可调大 maxColdBytes（配置 dsh-memory.maxColdBytes），或 memory_update 精简长条目。'
        : '若还不够：memory_update 精简长条目，或调大 maxBytes（热层上限，决定每轮 prompt 成本；冷层不占这里）。',
    )
    return lines.join('\n')
  }

  function autoPromoteRule(candidate, scope) {
    const raw = String(candidate?.text ?? '').trim()
    if (raw === '') return null
    if (state.entries.some((entry) => entry.text === raw)) return null
    if (activeEntries().some((entry) => textSimilarity(entry.text, raw) >= SIMILAR_HINT_FLOOR)) return null
    const room = makeRoom(raw.length)
    if (!room.ok) return null
    const now = new Date().toISOString()
    const entry = normalizeEntry({
      id: newEntryId(),
      text: raw,
      kind: 'rule',
      status: 'draft',
      ...(typeof scope === 'string' && scope !== '' ? { scope } : {}),
      addedAt: now,
      updatedAt: now,
      sources: [candidate.reason ?? 'rule-file'],
    })
    state.entries.push(entry)
    persist()
    return { entry, archived: room.archived }
  }

  function loadCandidates() {
    try {
      const parsed = JSON.parse(readFileSync(candidateFile, 'utf8'))
      const items = Array.isArray(parsed?.items) ? parsed.items : []
      replaceCandidates({
        version: 1,
        nextId: Number.isInteger(parsed?.nextId) && parsed.nextId > 0 ? parsed.nextId : items.length + 1,
        items: items.filter((item) => item && typeof item.text === 'string' && typeof item.id === 'string'),
      })
    } catch (error) {
      // 没有候选池：从空开始
    }
  }

  function persistCandidates() {
    try {
      // 候选池是派生数据（可从条目重建），用内核但不留 .bak：避免数据目录里多一份镜像。
      atomicWriteText(candidateFile, JSON.stringify(candidates, null, 2), { backup: false })
      return true
    } catch (error) {
      return false
    }
  }

  let lastSignature = ''
  let tmpCounter = 0

  /** 磁盘上 memory.json + archive.json 的指纹（mtime + size）：用来判断「别的进程写过了没有」。 */
  function storeSignature() {
    const part = (file) => {
      try {
        const info = statSync(file)
        return `${info.mtimeMs}:${info.size}`
      } catch (error) {
        return '-'
      }
    }
    return `${part(storeFile)}|${part(archiveFile)}`
  }

  /**
   * v3.20：读归档文件。不存在返回 []；**坏了也返回 [] 不抛** —— 归档坏掉绝不能连累主库启动。
   * 读出来的每一条都强制按归档处理（补 status=deprecated），防止文件被手工改过导致「档案复活」。
   */
  function readArchiveEntries() {
    let raw = ''
    try {
      raw = readFileSync(archiveFile, 'utf8')
    } catch (error) {
      return []
    }
    try {
      const parsed = JSON.parse(raw)
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : []
      const now = new Date().toISOString()
      return list
        .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.text === 'string')
        .map(normalizeEntry)
        .map((entry) =>
          isArchivedEntry(entry)
            ? entry
            : { ...entry, status: 'deprecated', archivedAt: entry.archivedAt ?? now, archiveReason: entry.archiveReason ?? 'migrated: archive.json' },
        )
    } catch (error) {
      return []
    }
  }

  /** v3.20：把归档文件里的条目并回内存态（主库同 id 的条目优先，归档只补缺）。 */
  function loadArchive() {
    // v4.1：SQLite 后端主表里已含归档条目（archived 语义由 status/supersededBy/invalidAt 判定），无需再并一次。
    if (backend === 'sqlite') return
    const archived = readArchiveEntries()
    if (archived.length === 0) return
    const seen = new Set(state.entries.map((entry) => entry.id))
    let added = 0
    for (const entry of archived) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      state.entries.push(entry)
      added += 1
    }
    if (added === 0) return
    const maxIdNumber = state.entries.reduce((max, entry) => {
      const match = /^m?(\d+)$/.exec(String(entry.id))
      return match ? Math.max(max, Number(match[1])) : max
    }, 0)
    state.nextId = Math.max(state.nextId, maxIdNumber + 1)
    lastSignature = storeSignature()
  }

  /** v3.20：原子写一个小文件（temp 唯一名 + fsync + rename 重试）。persist 用它写 archive.json。 */
  function writeAtomic(targetFile, body) {
    tmpCounter += 1
    const temp = `${targetFile}.tmp-${process.pid}-${tmpCounter}`
    writeFileSync(temp, body, 'utf8')
    try {
      const fd = openSync(temp, 'r')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } catch (error) {
      // 个别文件系统不支持 fsync：退化成不 fsync，但不因此失败
    }
    let renamed = false
    let lastError = null
    for (let attempt = 0; attempt < 3 && !renamed; attempt += 1) {
      try {
        renameSync(temp, targetFile)
        renamed = true
      } catch (error) {
        lastError = error
      }
    }
    if (!renamed) {
      try {
        unlinkSync(temp)
      } catch (error) {
        // 临时文件清不掉就留着，下次覆盖
      }
      throw fail('MEMORY_ARCHIVE_WRITE_FAILED', `归档写入失败（${lastError?.message ?? 'rename failed'}）：${path.basename(targetFile)}`)
    }
  }

  /** 读磁盘上的库；文件不存在返回 null；JSON/形状不对则抛错（由调用方决定是隔离还是忽略）。 */
  function readDiskState() {
    let raw = ''
    try {
      raw = readFileSync(storeFile, 'utf8')
    } catch (error) {
      return null
    }
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
      throw fail('MEMORY_STORE_SHAPE_INVALID', 'store shape is not {entries: []}')
    }
    const rawEntries = parsed.entries
    const kept = rawEntries
      .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.text === 'string')
      .map(normalizeEntry)
    // v3.9：形状不合法的条目被丢弃时先留证，别让下一次 persist 把它彻底抹掉（B09）。
    if (kept.length !== rawEntries.length) {
      try {
        const droppedCopy = `${storeFile}.dropped-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
        copyFileSync(storeFile, droppedCopy)
        droppedCopyPath = droppedCopy
      } catch (error) {
        // 留证失败不阻断
      }
    }
    // v3.9：nextId 不能只靠 entries.length —— 删过条目后它会落后、造成重复 id（B11）。
    const maxIdNumber = kept.reduce((max, entry) => {
      const match = /^m?(\d+)$/.exec(String(entry.id))
      return match ? Math.max(max, Number(match[1])) : max
    }, 0)
    const storedNextId = Number.isInteger(parsed?.nextId) && parsed.nextId > 0 ? parsed.nextId : 0
    // v4.1：磁盘上是更高版本 = 旧逻辑不认识的新数据，读进来再写回就会静默洗字段。
    // 这里带 code 抛出，由调用方决定 fail-loud；mergeWithDisk 会原样上抛而不是吞掉。
    const diskVersion = Number.isInteger(parsed?.version) && parsed.version > 0 ? parsed.version : 1
    if (diskVersion > SCHEMA_VERSION) throw schemaTooNewError(diskVersion, SCHEMA_VERSION)
    return {
      entries: kept,
      version: diskVersion,
      nextId: Math.max(storedNextId, maxIdNumber + 1),
    }
  }

  /**
   * v3.10（B02）：写前比对磁盘指纹，变了就把对方的条目合进来，再整库落盘。
   * 原来每个进程各自 load、各自整库覆盖写 —— 后写者会把别人刚写的条目静默抹掉（实测两条只剩一条、还抢同一个 id）。
   * 合并规则：按 id 取并集，updatedAt 新者胜；平手用本地（本次写入的意图）。
   * 已知边界：并发「删除」没有墓碑，可能被另一进程的写复活（比丢新增轻，先这样）。
   */
  function mergeWithDisk() {
    let disk
    try {
      disk = readDiskState()
    } catch (error) {
      // 版本比插件新：不是「坏文件」，旧逻辑绝不能覆盖它 → 原样上抛，让本次写入变成可读失败。
      if (error?.code === 'MEMORY_SCHEMA_TOO_NEW') throw error
      return // 磁盘上那份坏了：不合并，保住内存里的（损坏保护由 load 负责）
    }
    if (disk === null) return
    const signature = storeSignature()
    if (signature === lastSignature) return
    const byId = new Map()
    for (const entry of disk.entries) byId.set(entry.id, entry)
    for (const entry of state.entries) {
      const existing = byId.get(entry.id)
      if (existing === undefined) {
        byId.set(entry.id, entry)
        continue
      }
      const mine = Date.parse(entry.updatedAt ?? '') || 0
      const theirs = Date.parse(existing.updatedAt ?? '') || 0
      byId.set(entry.id, mine >= theirs ? entry : existing)
    }
    // v3.20：别的进程可能往 archive.json 追加了归档条目（指纹包含它），这里一并并进来。
    for (const entry of readArchiveEntries()) {
      if (!byId.has(entry.id)) byId.set(entry.id, entry)
    }
    state.entries = [...byId.values()]
    const maxIdNumber = state.entries.reduce((max, entry) => {
      const match = /^m?(\d+)$/.exec(String(entry.id))
      return match ? Math.max(max, Number(match[1])) : max
    }, 0)
    state.nextId = Math.max(state.nextId, maxIdNumber + 1)
    state.version = Math.max(state.version, disk.version)
    lastSignature = signature
  }

  /**
   * v3.10（B02）：写工具在**分配 id / 查找条目之前**先跟磁盘对齐一次。
   * 否则两个进程各自按自己的 nextId 发号，会分到同一个 id（实测 A、B 都是 m1）。
   */
  function refreshBeforeWrite() {
    // v4.1：SQLite 后端靠 WAL + write_seq 合并，不用 JSON 的锁文件/mergeWithDisk。
    if (backend === 'sqlite') {
      if (db !== null) refreshSqliteState()
      return
    }
    // v4.2.1（H1）：锁目录必须先存在（见 ensureStoreDir / acquireLock 的注释）。
    ensureStoreDir()
    const release = acquireLock()
    try {
      mergeWithDisk()
    } finally {
      release()
    }
  }

  const LOCK_WAIT_MS = 400
  const LOCK_STALE_MS = 5000
  function sleepSync(ms) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
    } catch (error) {
      const until = Date.now() + ms
      while (Date.now() < until) {
        // 忙等兜底（环境不支持 Atomics.wait 时）
      }
    }
  }

  /**
   * v4.2.1（H1）：storeDir 必须**先**存在 —— 原 persist() 先 acquireLock 后 mkdirSync，
   * 目录不存在/不可写时 wx 写锁抛错 → 内层 catch `continue` → deadline 检查永远走不到 →
   * 同步死循环把整个 DSH 进程堵死（审计 global-audit-memory-2026-11-03 §1 H1）。
   * 这里把「目录可用」收敛成一个入口：失败就抛可读错误，绝不重试。
   */
  function ensureStoreDir() {
    try {
      mkdirSync(storeDir, { recursive: true })
    } catch (error) {
      throw fail(
        'MEMORY_STORE_WRITE_FAILED',
        `记忆目录不可用（${storeDir}）：${error?.code ?? ''} ${error?.message ?? String(error)}。` +
          '本次写入没有生效，别当成已保存；先确认该路径存在且可写（或改 config.storeDir），再重试。',
      )
    }
  }

  /**
   * 跨进程互斥：memory.json.lock 用 wx 原子创建；陈旧锁（进程崩了）超过 5 秒直接抢。
   * v4.2.1（H1）：三条硬约束，缺一条就可能退化成同步死循环——
   *   ① 锁所在目录不存在 → 立刻抛可读错误，不重试；
   *   ② 内层 catch（stat 锁失败）不 `continue`，统一落到 deadline 判定 / sleep；
   *   ③ wx 写锁失败的 errno 不是「别人占着锁」（如 ENOENT/ENOTDIR/EACCES/EPERM/EROFS）→ 立刻抛，不重试。
   */
  function acquireLock() {
    const lockFile = `${storeFile}.lock`
    const lockDir = path.dirname(lockFile)
    try {
      const info = statSync(lockDir)
      if (!info.isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' })
    } catch (error) {
      throw fail(
        'MEMORY_STORE_LOCKED',
        `记忆目录不存在或不可用（${lockDir}）：${error?.code ?? ''} ${error?.message ?? String(error)}。` +
          '本次写入没有生效；先让该目录可写（或改 config.storeDir）再重试。',
      )
    }
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
      try {
        writeFileSync(lockFile, String(process.pid), { flag: 'wx' })
        return () => {
          try {
            unlinkSync(lockFile)
          } catch (error) {
            // 锁已经被别人清了也不影响
          }
        }
      } catch (error) {
        // 只有 EEXIST 才算「别人正占着锁」；其余（目录只读/路径不是目录/磁盘满）重试也不会好。
        if (error?.code !== 'EEXIST') {
          throw fail(
            'MEMORY_STORE_LOCKED',
            `无法创建记忆锁文件（${lockFile}）：${error?.code ?? ''} ${error?.message ?? String(error)}。` +
              '本次写入没有生效；确认该目录可写后重试。',
          )
        }
        let stale = false
        try {
          const info = statSync(lockFile)
          stale = Date.now() - info.mtimeMs > LOCK_STALE_MS
        } catch (inner) {
          // 锁在这一瞬间被别的进程清掉了：既不算「被占着」，也不能 continue（原 bug），
          // 落到下面的 deadline / sleep 后重试。
          stale = false
        }
        if (stale) {
          let removed = false
          try {
            unlinkSync(lockFile)
            removed = true
          } catch (inner) {
            // 删不掉（撞车 / 权限）就走 deadline 判定，绝不原地空转
          }
          // 只有真的删掉了才抢下一轮；否则继续走到 deadline，保证循环必然终止。
          if (removed) continue
        }
        if (Date.now() > deadline) {
          throw fail('MEMORY_STORE_LOCKED', '另一个 DSH 进程正在写记忆（memory.json.lock 被占），等它写完重试一次即可。')
        }
        sleepSync(25)
      }
    }
  }

  // ── v4.14：淘汰可观测 + 可审计（取经 Hermes 的 run report / no-op 原因日志，2026-11-12）──
  // 为什么独立成文件：维护统计不进 state 就不碰主库 schema / SQLite 迁移（数据能活过插件重写），
  // 也避免「只是为了报个数」每 6h 重写整个记忆库。
  const maintenanceFile = path.join(storeDir, 'maintenance.json')
  const manifestFile = path.join(storeDir, 'archive-manifest.jsonl')
  const emptyMaintenance = () => ({
    lastRunAt: '',
    checked: 0,
    archived: 0,
    promoted: 0,
    skipped: { pinned: 0, rule: 0, draft: 0, notDue: 0, grace: 0 },
    note: '',
  })
  let maintenanceStats = emptyMaintenance()
  let lastMaintenanceAt = 0
  const loadMaintenance = () => {
    try {
      const parsed = JSON.parse(readFileSync(maintenanceFile, 'utf8'))
      if (parsed === null || typeof parsed !== 'object') return
      maintenanceStats = {
        ...emptyMaintenance(),
        ...parsed,
        skipped: { ...emptyMaintenance().skipped, ...(parsed.skipped && typeof parsed.skipped === 'object' ? parsed.skipped : {}) },
      }
    } catch (error) {
      // 没有记录 / 损坏：从空开始（下次运行覆盖，不影响主库）
    }
  }
  // 归档审计行先攒着，等主库真的落盘成功再追加 —— 否则「manifest 说归档了、主库其实没写成功」就是假账。
  let pendingManifest = []
  const queueManifest = (rows) => {
    for (const row of rows) pendingManifest.push(row)
  }
  const flushManifest = () => {
    if (pendingManifest.length === 0) return
    const rows = pendingManifest
    pendingManifest = []
    try {
      ensureStoreDir()
      try {
        if (statSync(manifestFile).size > ARCHIVE_MANIFEST_MAX_BYTES) renameSync(manifestFile, manifestFile + '.1')
      } catch (error) {
        // 文件还不存在：第一次写
      }
      appendFileSync(manifestFile, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
    } catch (error) {
      // 审计写失败不连累主流程；丢的只是这一批审计行
    }
  }

  function persist() {
    if (backend === 'sqlite') return persistSqlite()
    if (storeHealth === 'corrupt') return false
    ensureDailyBackup()
    // v3.10（B02）：跨进程互斥 + 写前合并。见 acquireLock / mergeWithDisk 的注释。
    // v4.2.1（H1）：mkdir 必须在 acquireLock **之前** —— 否则目录缺失时拿锁先失败，退化成死循环。
    ensureStoreDir()
    const releaseLock = acquireLock()
    try {
      mergeWithDisk()
      // v3.20：归档分文件冷存。主库只写生效条目；归档条目落 archive.json。
      // 顺序：**先写归档、再写主库** —— 归档写失败就整体失败（主库原样不动），
      // 不会出现「主库已经把条目摘掉、归档却没写成功」的丢数据窗口。
      const activeForWrite = state.entries.filter((entry) => !isArchivedEntry(entry))
      const archivedForWrite = state.entries.filter((entry) => isArchivedEntry(entry))
      writeAtomic(archiveFile, JSON.stringify({ version: 1, entries: archivedForWrite }, null, 2))
      const body = JSON.stringify({ ...state, entries: activeForWrite }, null, 2)
      // 学 write-file-atomic：临时文件名必须**每进程唯一**（pid + 序号）。
      // 原来固定用 `memory.json.tmp`，两个进程同时写会共用同一个临时文件互相踩 —— 比整库覆盖更隐蔽。
      tmpCounter += 1
      const temp = `${storeFile}.tmp-${process.pid}-${tmpCounter}`
      writeFileSync(temp, body, 'utf8')
      // 学 write-file-atomic 的 fsync 默认行为：先把内容压到盘再 rename，断电不至于留下半截。
      try {
        const fd = openSync(temp, 'r')
        try {
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
      } catch (error) {
        // 个别文件系统不支持 fsync：退化成不 fsync，但不因此失败
      }
      // v3.9：两处修正
      // 1) 删掉「rename 失败就直接覆盖目标文件」的兜底 —— 那是非原子写，崩在中间会留下半截 JSON（B17）。
      // 2) rename 失败重试几次，仍失败就**抛错**：原来只 return false，六个写工具全当成功，
      //    模型以为记住了、重载却是空的（B01，实测 add 返回 m1 而磁盘无文件）。
      let renamed = false
      let lastError = null
      for (let attempt = 0; attempt < 3 && !renamed; attempt += 1) {
        try {
          renameSync(temp, storeFile)
          renamed = true
        } catch (error) {
          lastError = error
        }
      }
      if (!renamed) {
        try {
          unlinkSync(temp)
        } catch (error) {
          // 临时文件清不掉就留着，下次覆盖
        }
        storeHealth = 'readonly'
        throw fail('MEMORY_STORE_WRITE_FAILED', 
          `记忆落盘失败（${lastError?.message ?? 'rename failed'}）。本次写入没有生效，别当成已保存；先用 memory_list 确认，修好磁盘/权限后重载插件。`,
        )
      }
      lastSignature = storeSignature()
      syncAliases()
      // v3.21：落盘成功后记一次 diff（add/update/remove），形成 append-only 审计链。
      recordHistoryDiff()
      // v4.14：主库落盘成功后才写归档审计行（假账比没账更糟）。
      flushManifest()
      return true
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith('记忆落盘失败') || error.message.includes('memory.json.lock') || error.code === 'MEMORY_STORE_LOCKED' || error.code === 'MEMORY_STORE_WRITE_FAILED')
      ) {
        // 锁竞争 / 目录不可用是可恢复的环境问题，保持原 code、不要把 storeHealth 打成 readonly
        // （否则一次并发写就让本进程后续全部写入被拒）。
        throw error
      }
      storeHealth = 'readonly'
      throw fail('MEMORY_STORE_WRITE_FAILED', `记忆落盘失败（${error?.message ?? 'unknown'}）。本次写入没有生效，别当成已保存。`)
    } finally {
      releaseLock()
    }
  }

  function load() {
    if (backend === 'sqlite') return loadSqliteState()
    let raw = ''
    try {
      raw = readFileSync(storeFile, 'utf8')
    } catch (error) {
      return // 没有存档：从空开始
    }
    try {
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
        throw fail('MEMORY_STORE_SHAPE_INVALID', 'store shape is not {entries: []}')
      }
      const entries = parsed.entries
      const kept = entries
        .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.text === 'string')
        .map(normalizeEntry)
      // v3.9：形状不合法的条目被丢弃时先留证，别让下一次 persist 把它彻底抹掉（B09）。
      if (kept.length !== entries.length) {
        try {
          const droppedCopy = `${storeFile}.dropped-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
          copyFileSync(storeFile, droppedCopy)
          droppedCopyPath = droppedCopy
        } catch (error) {
          // 留证失败不阻断加载
        }
      }
      // v3.9：nextId 不能只靠 entries.length —— 删过条目后它会落后、造成重复 id（B11）。
      const maxIdNumber = kept.reduce((max, entry) => {
        const match = /^m?(\d+)$/.exec(String(entry.id))
        return match ? Math.max(max, Number(match[1])) : max
      }, 0)
      const storedNextId = Number.isInteger(parsed?.nextId) && parsed.nextId > 0 ? parsed.nextId : 0
      replaceState({
        nextId: Math.max(storedNextId, maxIdNumber + 1),
        version: Number.isInteger(parsed?.version) && parsed.version > 0 ? parsed.version : 1,
        entries: kept,
      })
      // v4.0：加载即迁移（只升不降）。迁移本身不落盘，跟着下一次 persist 一起写，
      // 避免「读的时候顺手改文件」这种危险副作用。
      const migrated = migrateState(state)
      if (migrated.changed) {
        replaceState(migrated.state)
      }
      // v3.10（B02）：记下这次的磁盘指纹，persist 据此判断「别的进程写过了没有」。
      lastSignature = storeSignature()
    } catch (error) {
      // 版本比插件新：既不能当「损坏」改名隔离（那会把更高版本的数据当垃圾挪走），
      // 也不能半死继续跑（旧逻辑下一次 persist 就会用它覆盖新数据）。
      // 抛出去 → apply 失败 → 插件拒绝启动，错误信息里带版本与出路。
      if (error?.code === 'MEMORY_SCHEMA_TOO_NEW') {
        const refusal = new Error('dsh-memory 拒绝启动：' + error.message + '（存储文件：' + storeFile + '）')
        refusal.code = 'MEMORY_SCHEMA_TOO_NEW'
        refusal.fromVersion = error.fromVersion
        refusal.targetVersion = error.targetVersion
        throw refusal
      }
      // 损坏：把原文件改名留证，进入只读保护态；绝不静默覆盖。
      storeHealth = 'corrupt'
      try {
        corruptCopy = `${storeFile}.corrupt-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
        renameSync(storeFile, corruptCopy)
      } catch (renameError) {
        corruptCopy = storeFile
      }
    }
  }

  load()
  loadArchive()
  // v4.14：上次维护结果（含「什么都没做」）从旁路文件恢复，重启后仍可观测。
  loadMaintenance()
  // v3.21：历史 diff 的基线要取「刚加载完」的状态，否则第一次写会把所有存量都记成 add。
  resetHistoryBaseline()
  loadAliases()
  applyAliases()
  state.entityAliases = loadEntityAliases()
  if (backend === 'sqlite' && db !== null) {
    ensureSqliteIndex()
    syncSqliteAliases()
  }
  loadCandidates()

  // v2.9：候选池 TTL——过期未确认的自动标记 expired（保留记录，不删）。
  // 否则候选池只增不减，pending 数永远虚高，「有 N 条待确认」的提醒会变成噪声。
  const expireCandidates = () => {
    const nowMs = Date.now()
    let changed = false
    for (const item of candidates.items) {
      if (item.status === 'pending' && typeof item.expiresAt === 'string' && Date.parse(item.expiresAt) < nowMs) {
        item.status = 'expired'
        changed = true
      }
    }
    if (changed) persistCandidates()
  }
  expireCandidates()

  // v3.3（口径修复）：生效 = 未被 superseded **且** 不是 deprecated。
  // 原来只判 supersededBy，导致 deprecated 条目仍算进 activeEntries → usedChars 预算虚高、
  // memory_review 的 total 比实际注入多 3 条、memory_audit 的 active 也偏大。
  // renderMemory 一直是两者都过滤的，这里对齐它。
  const isActive = (entry) => !isArchivedEntry(entry)
  const activeEntries = () => state.entries.filter(isActive)
  const usedChars = () => activeEntries().reduce((sum, entry) => sum + entry.text.length, 0)
  // v4.15：两层预算（取经 Letta：上下文里的块和外部存储不是同一个上限）。
  // 热层 = 会进 prompt 的条目（inject !== false），每轮 prompt 成本由它决定，仍卡 maxBytes；
  // 冷层 = inject:false（只参与 memory_search），不占 prompt，单独卡 maxColdBytes。
  // 口径：渲染层 render.js 对 inject:false 一律不注入（连 pinned 也不），所以分层就按 inject 一个字段判，别另造第二套。
  const tierOf = (entry) => (entry?.inject === false ? 'cold' : 'hot')
  // v4.15② §7④ 淘汰豁免（单一判据，makeRoom 与 convergeTier 共用）：
  // pinned（硬规则在场）/ kind=rule（长期约定）/ draft（等人工确认）/ slot=identity（身份画像）/
  // 正文含 vault://（指针是知识入口，自动归档会断链）——这五类任何自动腾挪都不许动。
  const isEliminationProtected = (entry) =>
    entry?.pinned === true ||
    entry?.kind === 'rule' ||
    entry?.status === 'draft' ||
    entry?.slot === 'identity' ||
    String(entry?.text ?? '').includes('vault://')
  const tierMax = (tier) => (tier === 'cold' ? maxColdBytes : maxBytes)
  const tierUsed = (tier) =>
    activeEntries().reduce((sum, entry) => sum + (tierOf(entry) === tier ? entry.text.length : 0), 0)
  const hotChars = () => tierUsed('hot')
  const coldChars = () => tierUsed('cold')
  // v4.14：预算状态（体检/工具同一口径，避免「health 报 ok、写入却被拒」的假安全）。
  // degraded = 已用 ≥95%（新写入随时可能失败）；full = 已经写不进去（除删除/更新变短外无解）。
  const tierBudget = (tier = 'hot') => {
    const max = tierMax(tier)
    const used = tierUsed(tier)
    const ratio = max > 0 ? used / max : 1
    const state = used >= max ? 'full' : ratio >= BUDGET_DEGRADED_RATIO ? 'degraded' : 'ok'
    return { tier, used, max, remaining: Math.max(0, max - used), state }
  }
  const budgetState = () => tierBudget('hot')
  const coldBudgetState = () => tierBudget('cold')
  const publicEntry = (entry) => ({ ...entry })
  const renderOnce = (query, stats, scope, cwd) =>
    renderMemory(state.entries, {
      maxInjectChars,
      query,
      ...(typeof scope === 'string' && scope !== '' ? { scope } : {}),
      ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
      ...(relevanceFloor !== undefined ? { relevanceFloor } : {}),
      ...(stats ? { stats } : {}),
    })

  // ---- 使用计数（给冷热/淘汰提供依据）----
  let usageDirty = false
  let lastUsageFlush = 0
  // v3.10（B14）：缓存最近一次装配系统提示时的 cwd。memory_list / audit / review 拿不到会话上下文，
  // 原来用空 cwd 渲染 → 带 workspaces 的条目永远被算成「没注入」，报的字数也偏小。
  let lastKnownCwd = ''
  let lastCountedQuery = ''
  const countUsage = (ids) => {
    if (!Array.isArray(ids) || ids.length === 0) return
    const stamp = new Date().toISOString()
    for (const id of ids) {
      const entry = state.entries.find((item) => item.id === id)
      if (entry === undefined) continue
      entry.usedCount = (entry.usedCount ?? 0) + 1
      entry.lastUsedAt = stamp
      usageDirty = true
    }
  }
  const flushUsage = () => {
    if (!usageDirty) return
    try {
      persist()
      usageDirty = false
      lastUsageFlush = Date.now()
    } catch (error) {
      // v3.9：persist 现在会抛错（写失败要报错）。用量计数只是记账，不能因此打断系统提示装配。
      usageDirty = false
      lastUsageFlush = Date.now()
    }
  }

  // ── v4.4 维护循环（对齐 Hermes curator + 「越用越好用」）──
  // 读路径顺带跑，CURATOR_INTERVAL_MS 节流。两件事：
  //   1) consolidate（上）：draft 未证实条目被命中 ≥ CONSOLIDATE_MIN_USES 次 → 升 stable（越用越证实）。
  //   2) curate（下）：staleAfter 到期 + 宽限期未复核未使用 → 归档（不过时；status=deprecated + archivedAt，可 memory_restore）。
  // 不变量：只归档不删；pinned / kind=rule 豁免一切自动迁移；draft 只走 consolidate、不自动归档；
  //   维护写失败 try/catch 吞掉，绝不打断读路径（系统提示装配 / memory_list 都要继续）。
  const runMaintenance = (force = false) => {
    const now = Date.now()
    if (!force && now - lastMaintenanceAt < CURATOR_INTERVAL_MS) {
      return { ran: false, archived: 0, promoted: 0 }
    }
    lastMaintenanceAt = now
    const today = localDateOf()
    // v4.14：统计口径 = 本轮「看过 / 归档 / 巩固 / 为什么跳过」，每次运行都落盘。
    // 没有这组计数，lastRunAt 只会停在「上次真的动过」的时刻，分不清「没跑」和「跑了没事可做」
    // （Hermes 用 no-op 原因日志解决同一个问题；2026-11-12 取经）。
    const skipped = { pinned: 0, rule: 0, draft: 0, notDue: 0, grace: 0 }
    const archivedRows = []
    let checked = 0
    let promoted = 0
    for (const entry of state.entries) {
      if (isArchivedEntry(entry)) continue
      checked += 1
      // draft（未证实）只走 consolidate：被命中够多次 → 升 stable；不参与 curate（该由人确认，不是时间淘汰）。
      if (entry.status === 'draft') {
        if ((entry.usedCount ?? 0) >= CONSOLIDATE_MIN_USES) {
          entry.status = 'stable'
          entry.updatedAt = new Date(now).toISOString()
          promoted += 1
        } else {
          skipped.draft += 1
        }
        continue
      }
      // 硬规则 / 规则永不自动迁移（Hermes：pinned 豁免一切；rule 是「怎么做事」的长期约定）。
      if (entry.pinned === true) {
        skipped.pinned += 1
        continue
      }
      if (entry.kind === 'rule') {
        skipped.rule += 1
        continue
      }
      const decision = curationDecision(entry, today, now)
      if (!decision.archive) {
        // curationDecision 只在「stale 但宽限期内仍活跃」时给理由；空串 = 还没到期。
        if (decision.reason !== '') skipped.grace += 1
        else skipped.notDue += 1
        continue
      }
      // 信号必须在改状态之前算（判据读的是条目自己的时间戳，不依赖 status，但先算更稳）。
      const signal = eliminationSignal(entry, today).signal
      entry.status = 'deprecated'
      entry.archivedAt = new Date(now).toISOString()
      entry.archiveReason = 'curator·' + decision.reason
      archivedRows.push({ ts: entry.archivedAt, by: 'curator', id: entry.id, reason: entry.archiveReason, signal, chars: entry.text.length })
    }
    const archived = archivedRows.length
    maintenanceStats = {
      lastRunAt: new Date(now).toISOString(),
      checked,
      archived,
      promoted,
      skipped,
      note: archived === 0 && promoted === 0 ? '本次没有可归档条目（staleAfter 未到期或仍在宽限期内）——不是没跑' : '',
    }
    try {
      ensureStoreDir()
      atomicWriteText(maintenanceFile, JSON.stringify(maintenanceStats, null, 2), { backup: false })
    } catch (error) {
      // 观测落盘失败不打断读路径；内存里的 stats 仍然是对的
    }
    if (archived > 0 || promoted > 0) {
      queueManifest(archivedRows)
      try {
        persist()
      } catch (error) {
        // 维护写失败绝不能打断读路径；本次迁移留到下次节流再试。
      }
    }
    return { ran: true, archived, promoted }
  }

  // 从运行期上下文取「本条用户消息」当检索查询：官方 AGENTS.md 也走 context.agent.session。
  // text() 必须同步且廉价，所以这里只做内存计算；拿不到会话就退化成「无 query」的纯索引模式。
  const currentQuery = (context) => {
    try {
      const session = context?.agent?.session
      if (session === undefined || typeof session.deriveMessages !== 'function') return ''
      const messages = session.deriveMessages()
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (message?.role !== 'user' || !Array.isArray(message.content)) continue
        const joined = message.content
          .filter((part) => part?.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('\n')
          .trim()
        if (joined !== '') return joined.slice(0, MAX_QUERY_CHARS)
      }
      return ''
    } catch (error) {
      return ''
    }
  }

  const currentScopeOf = (context) => {
    try {
      const session = context?.agent?.session
      if (session === undefined) return ''
      const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : ctx.workingDirectory
      const workingDirectory = service !== undefined && service !== null ? service : ctx.workingDirectory
      const cwd = typeof workingDirectory?.get === 'function' ? workingDirectory.get(session) : ''
      return detectScope(cwd, scopeRoots)
    } catch (error) {
      return ''
    }
  }

  // v3.0：workspaces 条件注入要当前工作目录（scope 粒度不够——同一 scope 下仍有不同工作区）。
  const currentCwdOf = (context) => {
    try {
      const session = context?.agent?.session
      if (session === undefined) return ''
      const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : ctx.workingDirectory
      const workingDirectory = service !== undefined && service !== null ? service : ctx.workingDirectory
      return typeof workingDirectory?.get === 'function' ? workingDirectory.get(session) : ''
    } catch (error) {
      return ''
    }
  }

  const pendingCandidates = () => candidates.items.filter((item) => item.status === 'pending')
  const addCandidate = (text, scope, kind, reason, sessionId) => {
    const value = String(text ?? '').trim()
    if (value === '') return false
    // 已经记过的、或与现有生效记忆高度重合的，不再候选
    for (const entry of activeEntries()) {
      if (entry.text === value || textSimilarity(entry.text, value) >= 0.7) return false
    }
    for (const item of pendingCandidates()) {
      if (item.text === value || textSimilarity(item.text, value) >= 0.7) return false
    }
    if (pendingCandidates().length >= CANDIDATE_LIMIT) return false
    candidates.items.push({
      id: `c${candidates.nextId}`,
      text: value.slice(0, MAX_TEXT_CHARS),
      ...(scope !== '' ? { scope } : {}),
      kind,
      reason,
      status: 'pending',
      ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + CANDIDATE_TTL_DAYS * 86400000).toISOString(),
    })
    candidates.nextId += 1
    persistCandidates()
    return true
  }

  const injectedBlock = (context) => {
    // v4.4：读路径顺带跑维护（6h 节流，内部判）。写失败已被 runMaintenance 吞掉，不影响装配。
    runMaintenance()
    const query = currentQuery(context)
    const scope = currentScopeOf(context)
    const stats = {}
    const cwd = currentCwdOf(context)
    if (typeof cwd === 'string' && cwd !== '') lastKnownCwd = cwd
    let block = ''
    try {
      block = renderOnce(query, stats, scope, cwd)
    } catch (error) {
      // v3.9：渲染异常绝不能连累系统提示装配 —— 一条脏数据不该让每个会话都起不来。
      return ''
    }
    // 同一个 query 只计一次（text() 每个 step 都会被调用）；按分钟节流落盘。
    if (query !== '' && query !== lastCountedQuery) {
      lastCountedQuery = query
      countUsage(stats.relevant)
      if (usageDirty && Date.now() - lastUsageFlush > 60000) flushUsage()
    }
    const pending = pendingCandidates().length
    if (pending === 0) return block
    const reminder = `💡 候选记忆 ${pending} 条待确认（memory_candidates 查看）`
    if (block === '') return ['<memory>', '（记忆库为空）', reminder, '</memory>'].join('\n')
    return block.replace('</memory>', `${reminder}\n</memory>`)
  }

  // 工具层只需要这些入口；可变标量走 getter，保证读到的是最新值（不是创建时的快照）。
  return {
    storeDir,
    storeFile,
    state,
    candidates,
    backend,
    retrievalMode,
    dbFile,
    historyFile,
    load,
    persist,
    saveEntityAliases,
    persistCandidates,
    loadCandidates,
    refreshBeforeWrite,
    refreshSqliteState,
    requireWritable,
    newEntryId,
    scoreEntriesIndexed,
    makeRoom,
    convergeTier,
    budgetExceededMessage,
    autoPromoteRule,
    isActive,
    activeEntries,
    usedChars,
    tierOf,
    hotChars,
    coldChars,
    tierUsage: tierBudget,
    coldBudgetState,
    publicEntry,
    renderOnce,
    countUsage,
    flushUsage,
    currentScopeOf,
    pendingCandidates,
    addCandidate,
    runMaintenance,
    budgetState,
    maintenanceFile,
    manifestFile,
    injectedBlock,
    get storeHealth() {
      return storeHealth
    },
    get maintenance() {
      return maintenanceStats
    },
    get corruptCopy() {
      return corruptCopy
    },
    get db() {
      return db
    },
    get usageDirty() {
      return usageDirty
    },
    get lastUsageFlush() {
      return lastUsageFlush
    },
    get lastKnownCwd() {
      return lastKnownCwd
    },
  }
}
