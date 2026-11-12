/**
 * 负资产只读扫描核心（P0：只读——本文件不导入、不调用任何删除 / 移动 / 改名 API）。
 *
 * 判据（删除三查的机器化，缺一条就降层）：
 *   1) 过时     ：mtime 距今 >= minAgeDays
 *   2) 以后无用 ：可达性（GC mark-sweep）——git 索引里有没有它。
 *                  git 不可用 / 目录不在任何仓库内 => unknown，**不能当成无引用**，降层 doubt。
 *   3) 无价值   ：纯中间产物 / 可再生 / 重复保留份 / 空壳 / 0 字节。
 * 分层：SAFE（三条全中）/ doubt（命中信号但缺一条，理由写清缺哪条）/ ask（唯一副本、可能不可再生，只列出）。
 *
 * 可达性查询全部带 GIT_OPTIONAL_LOCKS=0：不刷新索引、不写 .git，保证扫描对目标目录零写入。
 */
import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { isProtected, isUnsafePath } from './path-safety.js'

export const DEFAULT_LIMITS = Object.freeze({ maxFiles: 20000, maxDepth: 6, minAgeDays: 30, maxRows: 60 })

const DAY_MS = 86400000
const WALK_DEADLINE_MS = 15000
const HASH_MAX_FILE_BYTES = 128 * 1024 * 1024
const HASH_BUDGET_BYTES = 256 * 1024 * 1024
const GIT_TIMEOUT_MS = 8000
const GIT_MAX_BUFFER = 64 * 1024 * 1024
const MAX_ERRORS = 80

const SKIP_DIR_NAMES = new Set(['.git', '.hg', '.svn'])
const TEMP_EXTS = new Set(['.tmp', '.bak', '.old', '.orig', '.partial', '.crdownload', '.log'])

/** 一个路径同时命中多个信号时，按这个顺序取「主信号」（越靠前越具体） */
const SIGNAL_ORDER = ['split-residue', 'replica-name', 'temp-artifact', 'zero-byte', 'empty-dir', 'duplicate']

const SIGNAL_LABEL = {
  'empty-dir': '空目录',
  'zero-byte': '0 字节文件',
  'temp-artifact': '过期中间产物',
  duplicate: '内容重复副本',
  'split-residue': '分卷残留',
  'replica-name': '复制痕迹命名',
}

const LAYER_ORDER = { SAFE: 0, doubt: 1, ask: 2 }

/** 同层内排序：越可执行的信号越靠前；内容重复副本（常见于 node_modules）排最后 */
const SIGNAL_RANK = { 'split-residue': 0, 'replica-name': 1, 'temp-artifact': 2, 'zero-byte': 3, 'empty-dir': 4, duplicate: 5 }

function signalRank(signal) {
  const rank = SIGNAL_RANK[signal]
  return rank === undefined ? 9 : rank
}

/** 复制痕迹命名：作用在「去扩展名后的 stem」上 */
const REPLICA_PATTERNS = [
  /^(.*?)\s*-\s*copy(?:\s*\d+)?$/i,
  /^(.*?)\s+copy(?:\s*\d+)?$/i,
  /^(.*?)[\s_-]*副本(?:\s*[(（]?\d+[)）]?)?$/,
  /^(.*?)[\s_-]*最终版(?:\s*\d+)?$/,
  /^(.*?)\s*[(（]\d+[)）]$/,
  /^(.*?)[\s_-]*final[\s_-]*v\d+$/i,
]

// ───────────────────────── 目录与信号 ─────────────────────────

function ageInDays(mtimeMs, nowMs) {
  const days = Math.floor((nowMs - mtimeMs) / DAY_MS)
  return days < 0 ? 0 : days
}

function stemOf(name) {
  const ext = path.extname(name)
  return ext === '' ? name : name.slice(0, name.length - ext.length)
}

/**
 * 分卷识别：返回 { key, main }。
 * key 用于同目录分组计数；main 是「合并后的主文件」候选名（同目录存在即视为已合并）。
 */
function splitOf(name) {
  const lower = name.toLowerCase()
  let match = /^(.*)\.part\d+$/.exec(lower)
  if (match) return { key: match[1], main: match[1] }
  match = /^(.*)\.part$/.exec(lower)
  if (match) return { key: match[1], main: match[1] }
  match = /(?:^|[._-])part(\d+)(\.[a-z0-9]+)?$/.exec(lower)
  if (match) {
    let base = lower.slice(0, lower.length - match[0].length)
    const tail = base.slice(-1)
    if (tail === '.' || tail === '_' || tail === '-') base = base.slice(0, -1)
    const ext = match[2] || ''
    return { key: base + ext, main: base + ext }
  }
  match = /\.(r|z)(\d{2,})$/.exec(lower)
  if (match) {
    const stem = lower.slice(0, match.index)
    const merged = stem + (match[1] === 'r' ? '.rar' : '.zip')
    return { key: merged, main: merged }
  }
  match = /\.(\d{3})$/.exec(lower)
  if (match) return { key: lower.slice(0, match.index), main: lower.slice(0, match.index) }
  return null
}

/** 复制痕迹命名 → 原始 stem；不是复制痕迹返回 null */
function replicaBase(stem) {
  for (const pattern of REPLICA_PATTERNS) {
    const match = pattern.exec(stem)
    if (match && match[1] !== undefined && match[1].trim() !== '') return match[1].trim()
  }
  return null
}

/** 可达性对外表示：tracked / untracked / unknown（unknown 绝不当成「无引用」） */
function gitStateOf(value) {
  if (value === true) return 'tracked'
  if (value === false) return 'untracked'
  return 'unknown'
}

function primarySignal(record) {
  for (const signal of SIGNAL_ORDER) if (record.signals.has(signal)) return signal
  return 'unknown'
}

// ───────────────────────── 小工具 ─────────────────────────

function codeOf(error) {
  if (error && typeof error.code === 'string' && error.code !== '') return error.code
  if (error && typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}

function safeLstat(target) {
  try {
    return lstatSync(target)
  } catch {
    return null
  }
}

/** 纯字符串前缀比较（只用于排除插件自己的数据目录，不作安全判定） */
function isUnderSimple(child, parent) {
  const c = path.resolve(child).toLowerCase()
  const p = path.resolve(parent).replace(/[\\/]+$/, '').toLowerCase()
  if (c === p) return true
  return c.startsWith(p + path.sep)
}

function pushError(state, target, message) {
  if (state.errors.length < MAX_ERRORS) state.errors.push({ path: target, error: message })
  else state.droppedErrors += 1
}

function hashFile(file) {
  let fd
  try {
    fd = openSync(file, 'r')
  } catch {
    return ''
  }
  try {
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null)
      if (read <= 0) break
      hash.update(buffer.subarray(0, read))
    }
    return hash.digest('hex')
  } catch {
    return ''
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* fd 已关或不可关，不影响扫描结果 */
    }
  }
}

// ───────────────────────── git 可达性 ─────────────────────────

function gitEnvironment() {
  return Object.assign({}, process.env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' })
}

function findRepoRoot(dir) {
  let cursor = path.resolve(dir)
  for (;;) {
    if (existsSync(path.join(cursor, '.git'))) return cursor
    const parent = path.dirname(cursor)
    if (parent === cursor) return null
    cursor = parent
  }
}

function readGitIndex(repo) {
  try {
    const output = execFileSync('git', ['-C', repo, 'ls-files', '-z'], {
      encoding: 'buffer',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      env: gitEnvironment(),
    })
    const set = new Set()
    for (const entry of output.toString('utf8').split('\u0000')) if (entry !== '') set.add(entry)
    return set
  } catch {
    return null
  }
}

/**
 * 可达性探针：git 是否可用 → 所在仓库 → 该仓库一次 ls-files 建集合。
 * 任何一步失败都返回 null（unknown）——绝不把 unknown 当成「无引用」。
 */
/** git 是否可用（status 诊断用；探测失败 = unavailable，不猜） */
export function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { timeout: 4000, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'], env: gitEnvironment() })
    return true
  } catch {
    return false
  }
}

function createGitProbe() {
  let available = null
  const repoCache = new Map()
  const indexCache = new Map()
  const probeAvailable = () => {
    if (available !== null) return available
    available = gitAvailable()
    return available
  }
  return {
    isAvailable: probeAvailable,
    tracked(file) {
      if (!probeAvailable()) return null
      const dir = path.dirname(file)
      let repo = repoCache.get(dir)
      if (repo === undefined) {
        repo = findRepoRoot(dir)
        repoCache.set(dir, repo)
      }
      if (!repo) return null
      let index = indexCache.get(repo)
      if (index === undefined) {
        index = readGitIndex(repo)
        indexCache.set(repo, index)
      }
      if (!index) return null
      const relative = path.relative(repo, file).split(path.sep).join('/')
      return index.has(relative)
    },
  }
}

// ───────────────────────── 三查分层 ─────────────────────────

function classifyRecord(record, limits) {
  const signal = primarySignal(record)
  const stale = record.ageDays >= limits.minAgeDays
  let valueless = true
  let valueNote = ''
  let uniqueRisk = ''

  if (signal === 'split-residue') {
    const info = record.extra.split || {}
    if (info.mainExists) {
      valueNote = '同目录已有合并主文件 ' + info.main
    } else {
      valueless = false
      valueNote = '分卷就是全部数据（没有合并主文件）'
      uniqueRisk = '分卷 ' + (info.count || 2) + ' 个但没有合并主文件 ' + info.main + '，可能是唯一副本'
    }
  } else if (signal === 'replica-name') {
    const info = record.extra.replica || {}
    if (info.originalExists) {
      valueNote = '同目录原文件还在（' + info.base + '）'
    } else {
      valueless = false
      valueNote = '原文件已不在，可能是唯一副本'
      uniqueRisk = '同目录找不到被复制的原文件 ' + info.base + '，可能是唯一副本'
    }
  } else if (signal === 'duplicate') {
    const info = record.extra.duplicate || {}
    valueNote = '内容与 ' + (info.kept || '保留份') + ' 完全相同，保留那份即可'
  } else if (signal === 'empty-dir') {
    valueNote = '空目录，没有内容可丢'
  } else if (signal === 'zero-byte') {
    valueNote = '0 字节，没有内容可丢'
  } else if (signal === 'temp-artifact') {
    valueNote = '过期中间产物，可重新生成'
  } else {
    valueless = false
    valueNote = '信号未识别'
  }

  const checks = []
  checks.push(stale ? '过时✓(' + record.ageDays + '天)' : '过时✗(' + record.ageDays + '天 < ' + limits.minAgeDays + '天)')
  if (record.gitTracked === false) checks.push('无引用✓(git 未跟踪)')
  else if (record.gitTracked === true) checks.push('无引用✗(仍在 git 索引)')
  else checks.push('无引用?(unknown：不在 git 仓库内或 git 不可用)')
  checks.push(valueless ? '无价值✓(' + valueNote + ')' : '无价值✗(' + valueNote + ')')

  const base = SIGNAL_LABEL[signal] + ' · ' + checks.join(' · ')
  if (uniqueRisk !== '') {
    return { layer: 'ask', signal, reason: base + ' · 唯一副本风险：' + uniqueRisk + ' → 只列出，不建议自动删' }
  }
  const missing = []
  if (!stale) missing.push('过时')
  if (record.gitTracked !== false) missing.push(record.gitTracked === true ? '以后无用（仍被跟踪）' : '无引用（unknown）')
  if (!valueless) missing.push('无价值')
  if (missing.length === 0) return { layer: 'SAFE', signal, reason: base }
  return { layer: 'doubt', signal, reason: base + ' · 缺：' + missing.join(' / ') }
}

// ───────────────────────── 上限与文案 ─────────────────────────

export function normalizeLimits(input) {
  const clamp = (value, fallback, min, max) => {
    if (value === undefined || value === null || value === '') return fallback
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, Math.floor(number)))
  }
  return {
    maxFiles: clamp(input && input.maxFiles, DEFAULT_LIMITS.maxFiles, 1, 200000),
    maxDepth: clamp(input && input.maxDepth, DEFAULT_LIMITS.maxDepth, 0, 32),
    minAgeDays: clamp(input && input.minAgeDays, DEFAULT_LIMITS.minAgeDays, 0, 3650),
    maxRows: clamp(input && input.maxRows, DEFAULT_LIMITS.maxRows, 1, 500),
  }
}

export function limitsText(limits) {
  return '单次最多 ' + limits.maxFiles + ' 个文件 / 深度 ' + limits.maxDepth + ' / 过时阈值 ' +
    limits.minAgeDays + ' 天 / 最多列 ' + limits.maxRows + ' 行 / 走查上限 ' + WALK_DEADLINE_MS + 'ms'
}

// ───────────────────────── 主流程 ─────────────────────────

function addRecord(state, seed, nowMs) {
  const record = {
    path: seed.path,
    size: seed.size,
    mtimeMs: seed.mtimeMs,
    ageDays: ageInDays(seed.mtimeMs, nowMs),
    signals: new Set(seed.signals || []),
    extra: seed.extra || {},
    gitTracked: null,
  }
  state.records.push(record)
  state.recordIndex.set(record.path, record)
  return record
}

function ensureRecord(state, file, nowMs) {
  const existing = state.recordIndex.get(file.path)
  if (existing) return existing
  return addRecord(state, { path: file.path, size: file.size, mtimeMs: file.mtimeMs, signals: [], extra: {} }, nowMs)
}

function detectDuplicates(state, nowMs) {
  const bySize = new Map()
  for (const file of state.allFiles) {
    if (!(file.size > 0) || file.size > HASH_MAX_FILE_BYTES) continue
    const group = bySize.get(file.size)
    if (group) group.push(file)
    else bySize.set(file.size, [file])
  }
  let budget = HASH_BUDGET_BYTES
  let budgetHit = false
  for (const group of bySize.values()) {
    if (group.length < 2) continue
    if (budget <= 0) {
      budgetHit = true
      break
    }
    const byHash = new Map()
    for (const file of group) {
      if (budget <= 0) break
      if (file.size > budget) continue
      const digest = hashFile(file.path)
      if (digest === '') continue
      budget -= file.size
      const same = byHash.get(digest)
      if (same) same.push(file)
      else byHash.set(digest, [file])
    }
    for (const same of byHash.values()) {
      if (same.length < 2) continue
      same.sort((a, b) => (a.path.length - b.path.length) || (a.mtimeMs - b.mtimeMs) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      const kept = same[0]
      for (const file of same.slice(1)) {
        const record = ensureRecord(state, file, nowMs)
        record.signals.add('duplicate')
        record.extra.duplicate = { kept: kept.path, copies: same.length }
      }
    }
  }
  return budgetHit
}

/**
 * 只读扫描。
 * options: { roots: string[], limits?: object, guard?: string[], storeDir?: string, nowMs?: number }
 */
export function scanAssets(options) {
  const opts = options || {}
  const limits = normalizeLimits(opts.limits)
  const guard = Array.isArray(opts.guard) ? opts.guard : []
  const storeDir = typeof opts.storeDir === 'string' && opts.storeDir.trim() !== '' ? path.resolve(opts.storeDir) : ''
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now()
  const startedAt = Date.now()

  const state = {
    scannedFiles: 0,
    scannedDirs: 0,
    truncated: false,
    protectedCount: 0,
    errors: [],
    droppedErrors: 0,
    records: [],
    recordIndex: new Map(),
    allFiles: [],
  }

  const roots = []
  const requested = Array.isArray(opts.roots) ? opts.roots : []
  for (const item of requested) {
    if (typeof item !== 'string' || item.trim() === '') {
      pushError(state, '', 'roots 里有非字符串或空值，已跳过')
      continue
    }
    roots.push(path.resolve(item.trim()))
  }

  const stack = []
  for (const root of roots) {
    if (isUnsafePath(root)) {
      state.protectedCount += 1
      pushError(state, root, '路径写法不安全（UNC / 设备路径），按 fail-closed 判 protected 并跳过')
      continue
    }
    const info = safeLstat(root)
    if (!info) {
      pushError(state, root, '路径不存在或读不到，已跳过')
      continue
    }
    if (info.isSymbolicLink()) {
      state.protectedCount += 1
      pushError(state, root, '根目录是 reparse point（junction / 符号链接），按 fail-closed 跳过')
      continue
    }
    if (!info.isDirectory()) {
      pushError(state, root, '根目录不是目录（P0 只扫目录），已跳过')
      continue
    }
    stack.push({ dir: root, depth: 0 })
  }

  while (stack.length > 0) {
    if (state.scannedFiles >= limits.maxFiles) {
      state.truncated = true
      pushError(state, '', '文件数达到上限 ' + limits.maxFiles + '，扫描提前结束')
      break
    }
    if (Date.now() - startedAt > WALK_DEADLINE_MS) {
      state.truncated = true
      pushError(state, '', '扫描超过 ' + WALK_DEADLINE_MS + 'ms 未完成，已截断')
      break
    }
    const frame = stack.pop()
    const dir = frame.dir
    if (isProtected(dir, guard)) {
      state.protectedCount += 1
      pushError(state, dir, '红线目录：按 fail-closed 整棵子树跳过（不计入候选）')
      continue
    }
    if (storeDir !== '' && isUnderSimple(dir, storeDir)) continue

    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      state.scannedDirs += 1
      pushError(state, dir, '目录读不出来：' + codeOf(error))
      continue
    }
    state.scannedDirs += 1

    if (entries.length === 0) {
      const info = safeLstat(dir)
      if (info) addRecord(state, { path: dir, size: 0, mtimeMs: info.mtimeMs, signals: ['empty-dir'], extra: {} }, nowMs)
      continue
    }

    const subdirs = []
    const names = []
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        state.protectedCount += 1
        pushError(state, full, 'reparse point（junction / 符号链接）：按 fail-closed 跳过，不跟随')
        continue
      }
      if (entry.isDirectory()) {
        if (!SKIP_DIR_NAMES.has(entry.name.toLowerCase())) subdirs.push(full)
        continue
      }
      if (entry.isFile()) names.push(entry.name)
    }
    for (const sub of subdirs) {
      if (frame.depth + 1 > limits.maxDepth) {
        state.truncated = true
        continue
      }
      stack.push({ dir: sub, depth: frame.depth + 1 })
    }

    const lowerNames = new Set()
    const stems = new Set()
    for (const name of names) {
      lowerNames.add(name.toLowerCase())
      const stem = stemOf(name)
      if (stem !== '') stems.add(stem.toLowerCase())
    }
    const splitInfo = new Map()
    const groupCounts = new Map()
    for (const name of names) {
      const info = splitOf(name)
      if (!info) continue
      splitInfo.set(name, info)
      groupCounts.set(info.key, (groupCounts.get(info.key) || 0) + 1)
    }

    for (const name of names) {
      if (state.scannedFiles >= limits.maxFiles) {
        state.truncated = true
        break
      }
      const full = path.join(dir, name)
      const info = safeLstat(full)
      if (!info) {
        pushError(state, full, '读不到文件信息，已跳过')
        continue
      }
      state.scannedFiles += 1
      const lower = name.toLowerCase()
      const ext = path.extname(lower)
      const signals = []
      const extra = {}

      if (info.size === 0) signals.push('zero-byte')
      if (TEMP_EXTS.has(ext)) signals.push('temp-artifact')

      const split = splitInfo.get(name)
      if (split) {
        const mainLower = split.main.toLowerCase()
        const mainExists = mainLower !== lower && lowerNames.has(mainLower)
        const count = groupCounts.get(split.key) || 0
        if (mainExists || count >= 2) {
          signals.push('split-residue')
          extra.split = { main: split.main, mainExists, count: Math.max(count, 1) }
        }
      }

      const stem = stemOf(name)
      const base = stem === '' ? null : replicaBase(stem)
      if (base !== null) {
        const baseLower = base.toLowerCase()
        const originalExists = baseLower !== stem.toLowerCase() && stems.has(baseLower)
        signals.push('replica-name')
        extra.replica = { base, originalExists }
      }

      state.allFiles.push({ path: full, size: info.size, mtimeMs: info.mtimeMs })
      if (signals.length === 0) continue
      addRecord(state, { path: full, size: info.size, mtimeMs: info.mtimeMs, signals, extra }, nowMs)
    }
  }

  if (detectDuplicates(state, nowMs)) {
    pushError(state, '', '哈希预算用尽（' + HASH_BUDGET_BYTES + ' 字节），部分重复检测已跳过')
    state.truncated = true
  }

  const probe = createGitProbe()
  for (const record of state.records) record.gitTracked = probe.tracked(record.path)

  const counts = { safe: 0, doubt: 0, ask: 0, protected: state.protectedCount }
  const bytes = { safeBytes: 0, doubtBytes: 0, askBytes: 0, estimatedReclaim: 0 }
  const items = []
  for (const record of state.records) {
    const verdict = classifyRecord(record, limits)
    if (verdict.layer === 'SAFE') {
      counts.safe += 1
      bytes.safeBytes += record.size
    } else if (verdict.layer === 'doubt') {
      counts.doubt += 1
      bytes.doubtBytes += record.size
    } else {
      counts.ask += 1
      bytes.askBytes += record.size
    }
    items.push({
      path: record.path,
      layer: verdict.layer,
      signal: verdict.signal,
      reason: verdict.reason,
      size: record.size,
      ageDays: record.ageDays,
      gitTracked: gitStateOf(record.gitTracked),
    })
  }

  items.sort((a, b) =>
    (LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer]) ||
    (signalRank(a.signal) - signalRank(b.signal)) ||
    (b.size - a.size) ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  )
  bytes.estimatedReclaim = bytes.safeBytes

  const totalCandidates = items.length
  const truncated = state.truncated || totalCandidates > limits.maxRows
  if (state.droppedErrors > 0) {
    pushError(state, '', '另有 ' + state.droppedErrors + ' 条路径异常未逐条列出（避免刷屏）')
  }

  return {
    scannedFiles: state.scannedFiles,
    scannedDirs: state.scannedDirs,
    roots,
    limits: limitsText(limits),
    truncated,
    counts,
    bytes,
    items: items.slice(0, limits.maxRows),
    errors: state.errors,
  }
}
