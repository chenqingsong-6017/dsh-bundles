/**
 * dsh-butler-tidy —— 内务司整理工具：盘点 → 出方案 → 确认执行 → 可撤销 → 诊断。
 *
 * 参考实现（设计取意，非代码照搬）：
 *   - organize-tool（tfeldmann/organize）：规则 = 位置 + 过滤 + 动作；核心是 `sim` 先模拟。
 *   - FolderSorter：预览优先、可撤销上一次整理、规则可导出 JSON。
 *   - Hazel / File Juggler：按类型、日期、名称匹配后归位。
 *
 * 本插件的取舍：
 *   1) 不做「定时自动整理」——那违反本机 UX 规范 R4（危险动作默认拒绝），改为按需调用。
 *   2) 只搬不删：整理 = 移动到分类文件夹；清理 = 只删白名单里的临时目录，其余仅报告。
 *   3) 一切可撤销：整理前写 manifest，undo 按 manifest 反向搬回。
 *   4) 红线：系统目录、插件源码、学习空间等永不入列（采集阶段就排除，R5 噪音隔离）。
 *   5) 输出说人话：枚举值内部化，计数与错误明细收进 tidy_status（R2/R7）。
 *
 * 数据落 `config.storeDir`（默认 D:\AI\dsh-data\tidy，本机约定不落 C 盘）：
 *   manifests/organize-<时间戳>.json   每次整理的移动清单（用于撤销）
 *   tidy.log.jsonl                     最近操作流水（诊断用）
 */

import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

export const name = 'dsh-butler-tidy'
export const inject = ['tools']

const text = (value) => ({ type: 'text', text: value })

const MB = 1024 * 1024
const GB = 1024 * MB
const SCAN_MAX_ENTRIES = 80000
const SCAN_DEADLINE_MS = 7000
const PLAN_MAX_FILES = 5000
const DEFAULT_MAX_APPLY = 300

// ───────────────────────────── 格式化 ─────────────────────────────

function fmtSize(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value >= GB) return `${(value / GB).toFixed(1)} GB`
  if (value >= MB) return `${(value / MB).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`
  return `${value} B`
}

function fmtCount(n) {
  return Number(n).toLocaleString('zh-CN')
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

function stampOf(date = new Date()) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(
    date.getMinutes(),
  )}${pad2(date.getSeconds())}-${String(date.getMilliseconds()).padStart(3, '0')}`
}

function hhmmss(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

/** 把内部策略翻成人话（R2：不暴露枚举值） */
const POLICY_LABEL = {
  safe: '可清',
  cautious: '谨慎',
  admin: '需管理员',
  observe: '仅报告',
}

// ───────────────────────────── 分类规则 ─────────────────────────────

const TYPE_GROUPS = [
  {
    label: 'Documents',
    exts: ['.doc', '.docx', '.pdf', '.txt', '.md', '.rtf', '.odt', '.epub', '.mobi', '.wps', '.pages'],
  },
  {
    label: 'Spreadsheets',
    exts: ['.xls', '.xlsx', '.csv', '.et', '.numbers', '.ods'],
  },
  {
    label: 'Presentations',
    exts: ['.ppt', '.pptx', '.dps', '.key', '.odp'],
  },
  {
    label: 'Images',
    exts: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.heic', '.tif', '.tiff', '.psd', '.raw'],
  },
  {
    label: 'Videos',
    exts: ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.ts', '.m4v', '.rmvb'],
  },
  {
    label: 'Audio',
    exts: ['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.wma', '.ape'],
  },
  {
    label: 'Archives',
    exts: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso', '.cab'],
  },
  {
    label: 'Installers',
    exts: ['.exe', '.msi', '.msix', '.appx', '.dmg', '.pkg', '.apk'],
  },
  {
    label: 'Fonts',
    exts: ['.ttf', '.otf', '.woff', '.woff2', '.fon', '.fnt'],
  },
  {
    label: 'Subtitles',
    exts: ['.srt', '.ass', '.ssa', '.vtt', '.sub'],
  },
  {
    label: 'Logs',
    exts: ['.log', '.dmp', '.etl'],
  },
  {
    label: 'Code',
    exts: [
      '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.cs',
      '.go', '.rs', '.rb', '.php', '.json', '.xml', '.yml', '.yaml', '.toml', '.ini', '.html', '.css',
      '.sh', '.ps1', '.bat', '.cmd', '.sql', '.ipynb',
    ],
  },
]

const TYPE_OF_EXT = new Map()
for (const group of TYPE_GROUPS) {
  for (const ext of group.exts) TYPE_OF_EXT.set(ext, group.label)
}

/** 永不整理的扩展名/文件名：快捷方式、系统索引文件 */
const SKIP_EXT = new Set(['.lnk', '.url', '.desktop.ini', '.tmp', '.part', '.crdownload'])
const SKIP_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store'])

function buildTypeMap(config) {
  const map = new Map(TYPE_OF_EXT)
  const custom = config?.typeMap
  if (custom && typeof custom === 'object') {
    for (const [rawExt, folder] of Object.entries(custom)) {
      if (typeof folder !== 'string' || folder.trim() === '') continue
      const ext = rawExt.startsWith('.') ? rawExt.toLowerCase() : `.${rawExt.toLowerCase()}`
      map.set(ext, folder.trim().replace(/[\\/:*?"<>|]/g, ''))
    }
  }
  return map
}

// ───────────────────────────── 路径与保护 ─────────────────────────────

/**
 * Windows 设备前缀（`\\?\`、`\\.\`）与 UNC（`\\server\share`，含 `\\localhost\D$`
 * 这类本地管理共享）一律视为「不能安全判定」的写法。
 * 2026-11-03 审计 T2：`\\?\D:\AI\dsh-bundles\...` / `\\localhost\D$\...` 都能让纯
 * 字符串前缀比较判不出「在红线内」——这里直接 fail-closed。
 */
const UNSAFE_PATH_PREFIX = /^[\\/]{2}/

/** 路径写法本身就不能安全判定（UNC / 设备路径 / 空值 / 含空字节） */
function isUnsafePath(value) {
  if (typeof value !== 'string') return true
  const raw = value.trim()
  if (raw === '') return true
  if (UNSAFE_PATH_PREFIX.test(raw)) return true
  if (raw.includes('\u0000')) return true
  return false
}

/** 路径（含任一级祖先）是不是 reparse point：junction / 符号链接 / 其他重解析点 */
function hasReparsePoint(resolvedPath) {
  let cursor = resolvedPath
  for (;;) {
    try {
      if (lstatSync(cursor).isSymbolicLink()) return true
    } catch {
      // 这一级不存在，继续往上看
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) return false
    cursor = parent
  }
}

/**
 * 真实路径：先拒绝 UNC / 设备前缀，再 realpath 解析 junction 与符号链接。
 * - 解析链条上任何一级是 reparse point → 返回 ''（调用方按红线/fail-closed 处理）；
 * - 路径不存在 → 逐级向上找最近可解析祖先再拼回剩余段（这样父目录的 junction 也能解析）；
 * - 全都不存在 → 退回 path.resolve（审计要求：不存在的路径用 resolve）。
 */
function realPathOf(value) {
  if (isUnsafePath(value)) return ''
  const resolved = path.resolve(value.trim())
  if (hasReparsePoint(resolved)) return ''
  try {
    return realpathSync.native(resolved)
  } catch {
    let cursor = resolved
    const tail = []
    for (;;) {
      const parent = path.dirname(cursor)
      if (parent === cursor) return resolved
      tail.unshift(path.basename(cursor))
      cursor = parent
      try {
        return path.join(realpathSync.native(cursor), ...tail)
      } catch {
        // 继续向上
      }
    }
  }
}

/** 归一化：真实路径 + 小写 + 去尾部分隔符；不能安全判定时返回 '' */
function norm(p) {
  const real = realPathOf(p)
  return real === '' ? '' : real.replace(/[\\/]+$/, '').toLowerCase()
}

function isUnder(child, parent) {
  const c = norm(child)
  const p = norm(parent)
  if (c === '' || p === '') return false
  return c === p || c.startsWith(`${p}${path.sep}`)
}

/** 文件可能被锁：返回错误码人话 */
function lockHint(err) {
  const code = err && err.code ? err.code : 'UNKNOWN'
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return '文件占用或权限不足'
  if (code === 'ENOENT') return '文件已不在了'
  if (code === 'ENOSPC') return '磁盘空间不足'
  if (code === 'EDUPLEFT') return '已复制到目标，但原目录没删净（有文件被占用），会留下重复，需人工确认'
  return code
}

function storeLocation(configured) {
  const fallback = (() => {
    // 本机约定：插件数据落 D 盘；没有 D 盘的机器再退回 profile / 用户目录
    if (existsSync('D:\\')) return path.join('D:\\AI\\dsh-data', 'tidy')
    if (process.env.DSH_PROFILE_DIR) return path.join(process.env.DSH_PROFILE_DIR, 'dsh-butler-tidy')
    return path.join(os.homedir(), '.dsh', 'dsh-butler-tidy')
  })()
  const root = typeof configured === 'string' && configured.trim() !== '' ? path.resolve(configured.trim()) : fallback
  return { dir: root, manifests: path.join(root, 'manifests'), logFile: path.join(root, 'tidy.log.jsonl') }
}

/** 红线目录：整理/清理永不进入 */
function protectedDirs(config) {
  const home = os.homedir()
  const base = [
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\ProgramData',
    path.join(home, 'AppData'),
    'D:\\AI\\dsh-bundles',
    'D:\\AI\\deepsek harness',
    'D:\\AI\\hermes-agent',
    'D:\\AI-date\\workbuddy-date\\学习',
  ]
  if (Array.isArray(config?.protectDirs)) {
    for (const item of config.protectDirs) {
      if (typeof item === 'string' && item.trim() !== '') base.push(item.trim())
    }
  }
  return [...new Set(base.map((item) => path.resolve(item)))]
}

/**
 * 目标是否落在红线（或根本无法安全判定）：
 * 写法不安全 / 含 reparse point / 解析不出真实路径 → 一律 true（fail-closed）。
 * 2026-11-03 审计 T2/T3：junction、`\\?\`、UNC 三种写法都曾绕过这里的字符串比较。
 */
function isProtected(target, guard) {
  const c = norm(target)
  if (c === '') return true
  return guard.some((dir) => {
    const p = norm(dir)
    return p !== '' && (c === p || c.startsWith(`${p}${path.sep}`))
  })
}

// ───────────────────────────── 目录度量 ─────────────────────────────

/**
 * 度量目录大小（有界：条目数与时间双上限，避免扫全盘卡死）。
 * 符号链接一律不跟随，避免循环。
 */
function measureDir(root, { maxEntries = SCAN_MAX_ENTRIES, deadlineMs = SCAN_DEADLINE_MS } = {}) {
  const result = { bytes: 0, files: 0, truncated: false }
  if (!root || !existsSync(root)) return result
  const deadline = Date.now() + deadlineMs
  const stack = [root]
  while (stack.length > 0) {
    if (result.files >= maxEntries || Date.now() > deadline) {
      result.truncated = true
      break
    }
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      continue
    }
    for (const entry of entries) {
      if (result.files >= maxEntries) {
        result.truncated = true
        break
      }
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      try {
        result.bytes += statSync(full).size
        result.files += 1
      } catch (error) {
        /* 读不到就跳过，不阻断整体盘点 */
      }
    }
  }
  return result
}

function driveInfo(letter) {
  try {
    const stats = statfsSync(`${letter}:\\`)
    const bsize = Number(stats.bsize) || 0
    const total = Number(stats.blocks) * bsize
    const free = Number(stats.bavail) * bsize
    if (!total) return undefined
    return { letter, totalBytes: Math.round(total), freeBytes: Math.round(free) }
  } catch (error) {
    return undefined
  }
}

// ───────────────────────────── 可清目录白名单 ─────────────────────────────

function junkCatalog() {
  const home = os.homedir()
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  const win = process.env.SystemRoot || 'C:\\Windows'

  const deletable = [
    { id: 'user-temp', label: '用户临时文件', path: path.join(local, 'Temp'), policy: 'safe' },
    { id: 'win-temp', label: '系统临时文件', path: path.join(win, 'Temp'), policy: 'safe' },
    {
      id: 'wu-cache',
      label: 'Windows 更新缓存',
      path: path.join(win, 'SoftwareDistribution', 'Download'),
      policy: 'safe',
    },
    { id: 'crash-dumps', label: '程序崩溃转储', path: path.join(local, 'CrashDumps'), policy: 'safe' },
    { id: 'minidump', label: '系统蓝屏转储', path: path.join(win, 'Minidump'), policy: 'safe' },
    { id: 'win-old', label: '旧系统备份 Windows.old', path: path.join(path.dirname(win), 'Windows.old'), policy: 'admin' },
    { id: 'recycle-c', label: 'C 盘回收站', path: 'C:\\$Recycle.Bin', policy: 'cautious' },
    { id: 'recycle-d', label: 'D 盘回收站', path: 'D:\\$Recycle.Bin', policy: 'cautious' },
  ]

  const observe = [
    { id: 'edge-cache', label: 'Edge 浏览器缓存', path: path.join(local, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache') },
    { id: 'chrome-cache', label: 'Chrome 浏览器缓存', path: path.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Cache') },
    { id: 'thumbcache', label: '资源管理器缩略图缓存', path: path.join(local, 'Microsoft', 'Windows', 'Explorer') },
  ]

  return { deletable, observe }
}

// ───────────────────────────── 散乱盘点 ─────────────────────────────

function shellFolderCandidates(name) {
  const home = os.homedir()
  const candidates = [path.join(home, name)]
  if (process.env.OneDrive) candidates.push(path.join(process.env.OneDrive, name))
  return [...new Set(candidates)]
}

function topLevelStats(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    return undefined
  }
  let files = 0
  let bytes = 0
  const extCount = new Map()
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const ext = path.extname(entry.name).toLowerCase()
    try {
      bytes += statSync(path.join(dir, entry.name)).size
      files += 1
    } catch (error) {
      continue
    }
    if (ext) extCount.set(ext, (extCount.get(ext) || 0) + 1)
  }
  if (files === 0) return { files: 0, bytes: 0, topExts: [] }
  const topExts = [...extCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([ext]) => ext)
  return { files, bytes, topExts }
}

function scatteredSpots() {
  const spots = [
    { label: '桌面', candidates: shellFolderCandidates('Desktop') },
    { label: '下载', candidates: shellFolderCandidates('Downloads') },
    { label: '文档', candidates: shellFolderCandidates('Documents') },
    { label: 'D 盘根目录', candidates: ['D:\\'] },
  ]
  const found = []
  for (const spot of spots) {
    for (const candidate of spot.candidates) {
      if (!existsSync(candidate)) continue
      const stats = topLevelStats(candidate)
      if (!stats || stats.files === 0) continue
      found.push({ label: spot.label, path: candidate, ...stats })
      break
    }
  }
  return found
}

// ───────────────────────────── 采集与分类 ─────────────────────────────

/**
 * 收集待整理文件。
 * 只收普通文件；跳过快捷方式/系统文件；subfolders 时最多下钻 3 层且跳过红线目录。
 */
function collectFiles(target, { subfolders = false, typeMap, guard, maxFiles = PLAN_MAX_FILES } = {}) {
  const files = []
  let truncated = false
  const queue = [{ dir: target, depth: 0 }]

  while (queue.length > 0) {
    const current = queue.shift()
    let entries
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch (error) {
      continue
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true
        break
      }
      const full = path.join(current.dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!subfolders || current.depth >= 3) continue
        if (isProtected(full, guard)) continue
        queue.push({ dir: full, depth: current.depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      const lower = entry.name.toLowerCase()
      if (lower === 'desktop.ini' || SKIP_NAMES.has(lower)) continue
      const ext = path.extname(lower)
      if (SKIP_EXT.has(ext)) continue
      let stat
      try {
        stat = statSync(full)
      } catch (error) {
        continue
      }
      files.push({
        from: full,
        name: entry.name,
        ext,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        relative: path.relative(target, full),
      })
    }
    if (truncated) break
  }

  files.sort((a, b) => b.size - a.size)
  return { files, truncated }
}

/** 按规则决定归属文件夹 */
function classify(file, rule, typeMap) {
  if (rule === 'by-date') {
    const date = new Date(file.mtimeMs)
    if (Number.isNaN(date.getTime())) return 'Unknown'
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`
  }
  return typeMap.get(file.ext) || 'Misc'
}

/** 目标名冲突时加序号；conflict=skip 则放弃 */
function resolveDestination(target, folder, name, planned, conflict) {
  const dir = path.join(target, folder)
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = path.join(dir, name)
  let index = 2
  while (planned.has(candidate.toLowerCase()) || existsSync(candidate)) {
    if (conflict === 'skip') return undefined
    candidate = path.join(dir, `${stem} (${index})${ext}`)
    index += 1
    if (index > 500) return undefined
  }
  planned.add(candidate.toLowerCase())
  return candidate
}

/** 生成整理方案（纯计算，不动文件） */
function buildOrganizePlan(target, { rule, subfolders, typeMap, guard, conflict = 'rename', maxFiles = PLAN_MAX_FILES }) {
  const collected = collectFiles(target, { subfolders, typeMap, guard, maxFiles })
  const planned = new Set()
  const moves = []
  const skipped = []
  for (const file of collected.files) {
    const folder = classify(file, rule, typeMap)
    const to = resolveDestination(target, folder, file.name, planned, conflict)
    if (!to) {
      skipped.push({ name: file.name, reason: '同名文件已存在' })
      continue
    }
    moves.push({ from: file.from, to, name: file.name, folder, size: file.size, relative: file.relative })
  }
  const groups = new Map()
  for (const move of moves) {
    const group = groups.get(move.folder) || { label: move.folder, folder: move.folder, files: 0, bytes: 0 }
    group.files += 1
    group.bytes += move.size
    groups.set(move.folder, group)
  }
  const ordered = [...groups.values()].sort((a, b) => b.bytes - a.bytes)
  return {
    moves,
    groups: ordered,
    skipped,
    truncated: collected.truncated,
    totalFiles: moves.length,
    totalBytes: moves.reduce((sum, move) => sum + move.size, 0),
  }
}

// ───────────────────────────── 执行 ─────────────────────────────

/** 移动文件或目录；跨卷时退回复制 + 删除 */
function movePath(from, to) {
  // 注意：不能无条件 mkdir 父目录——目标是盘根（如 D:\）时 mkdirSync('D:\\') 会抛 EPERM
  const parent = path.dirname(to)
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
  try {
    renameSync(from, to)
  } catch (error) {
    if (error && error.code === 'EXDEV') {
      copyEntry(from, to)
      try {
        rmSync(from, { recursive: true, force: true })
      } catch (removeError) {
        // 复制成功但源目录删不干净：明确报出来，别让用户以为只是「占用」
        const conflict = new Error('copied but source removal failed')
        conflict.code = 'EDUPLEFT'
        throw conflict
      }
      return
    }
    throw error
  }
}

function copyEntry(from, to) {
  const stat = statSync(from)
  if (stat.isDirectory()) {
    cpSync(from, to, { recursive: true })
    return
  }
  copyFileSync(from, to)
}

function appendLog(logFile, record) {
  try {
    mkdirSync(path.dirname(logFile), { recursive: true })
    writeFileSync(logFile, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' })
  } catch (error) {
    /* 日志失败不影响主流程 */
  }
}

function writeManifest(store, kind, payload) {
  mkdirSync(store.manifests, { recursive: true })
  const file = path.join(store.manifests, `${kind}-${stampOf()}.json`)
  writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
  return file
}

function listManifests(store) {
  if (!existsSync(store.manifests)) return []
  try {
    // 按清单里的时间戳排序，不能按文件名排：否则 folders-* 会排到 organize-* 后面
    return readdirSync(store.manifests)
      .map((entry) => {
        const match = /^(organize|folders|rename|dupes|residue)-(\d{8}-\d{6}(?:-\d{3})?)\.json$/.exec(entry)
        return match ? { name: entry, stamp: match[2] } : undefined
      })
      .filter(Boolean)
      .sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0))
      .map((item) => item.name)
  } catch (error) {
    return []
  }
}

/** 校验整理目标：存在、是目录、不在红线内、不是系统盘根 */
function validateTarget(target, guard, store) {
  if (typeof target !== 'string' || target.trim() === '') {
    return { error: '没给整理目录。请用 target 指定一个文件夹，例如 D:\\下载。' }
  }
  const raw = target.trim()
  // 2026-11-03 审计 T2：UNC（含 \\localhost\D$ 管理共享）与 \\?\ 设备路径不能安全判定 → 直接拒
  if (isUnsafePath(raw)) {
    return { error: `这个路径写法不能安全判定（UNC / 设备路径）：${raw}，不动。请用普通盘符路径，例如 D:\\下载。` }
  }
  const resolved = path.resolve(raw)
  if (!existsSync(resolved)) return { error: `这个目录不存在：${resolved}。先确认路径再试。` }
  // 2026-11-03 审计 T2：junction / 符号链接会骗过字符串比较（曾指向红线目录仍给方案）→ 直接拒
  if (hasReparsePoint(resolved)) {
    return { error: `${resolved} 是 junction / 符号链接（重解析点），真实位置无法安全判定，不动。` }
  }
  let stat
  try {
    stat = statSync(resolved)
  } catch (error) {
    return { error: `这个目录读不到：${resolved}（${lockHint(error)}）。` }
  }
  if (!stat.isDirectory()) return { error: `这不是文件夹：${resolved}。` }
  const real = realPathOf(resolved)
  if (real === '') return { error: `${resolved} 解析不出真实路径，按不可动处理。` }
  if (isUnder(real, store.dir)) return { error: '这是本插件自己的数据目录，不能整理它。' }
  if (isProtected(real, guard)) {
    return { error: `${real} 在红线目录内（系统目录/插件源码/学习空间），不动。` }
  }
  if (real.toLowerCase() === 'c:\\') {
    return { error: 'C 盘根目录是系统盘要害，不能整体整理。请指定具体文件夹，例如 C:\\Users\\<你>\\Downloads。' }
  }
  return { resolved: real }
}

// ───────────────────────────── 主逻辑：扫描 ─────────────────────────────

function doScan(config, args, guard, store) {
  const driveArg = args && args.drive ? args.drive : 'both'
  const drives = []
  if (driveArg === 'both' || driveArg === 'c') {
    const info = driveInfo('C')
    if (info) drives.push(info)
  }
  if (driveArg === 'both' || driveArg === 'd') {
    const info = driveInfo('D')
    if (info) drives.push(info)
  }

  const catalog = junkCatalog()
  const cleanableItems = []
  let safeBytes = 0
  let cautiousBytes = 0
  let adminBytes = 0

  for (const item of catalog.deletable) {
    if (!existsSync(item.path)) continue
    const measured = measureDir(item.path)
    if (measured.bytes === 0 && measured.files === 0) continue
    cleanableItems.push({
      id: item.id,
      label: item.label,
      path: item.path,
      bytes: Math.round(measured.bytes),
      files: measured.files,
      policy: item.policy,
      truncated: measured.truncated,
    })
    if (item.policy === 'safe') safeBytes += measured.bytes
    if (item.policy === 'cautious') cautiousBytes += measured.bytes
    if (item.policy === 'admin') adminBytes += measured.bytes
  }
  cleanableItems.sort((a, b) => b.bytes - a.bytes)

  const notes = []
  for (const item of catalog.observe) {
    if (!existsSync(item.path)) continue
    const measured = measureDir(item.path, { maxEntries: 20000, deadlineMs: 3000 })
    if (measured.bytes === 0) continue
    notes.push(`${item.label} ${fmtSize(measured.bytes)}（需关掉程序才可清，本次不动）`)
  }
  const adminItem = cleanableItems.find((item) => item.policy === 'admin')
  if (adminItem) notes.push('Windows.old 需管理员权限，建议用「设置 → 系统 → 存储 → 清理建议」处理')

  const scattered = scatteredSpots().map((spot) => ({
    label: spot.label,
    path: spot.path,
    files: spot.files,
    bytes: Math.round(spot.bytes),
    topExts: spot.topExts,
  }))

  // 整体扫描：盘符顶层目录体量（有界，只有 topLevel:true 才跑）
  const topDirs = []
  if (args && args.topLevel) {
    const driveLetters = []
    if (driveArg === 'both' || driveArg === 'c') driveLetters.push('C')
    if (driveArg === 'both' || driveArg === 'd') driveLetters.push('D')
    for (const letter of driveLetters) {
      const root = `${letter}:\\`
      let entries
      try {
        entries = readdirSync(root, { withFileTypes: true })
      } catch (error) {
        continue
      }
      const startedAt = Date.now()
      let measuredCount = 0
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const full = path.join(root, entry.name)
        let size = { bytes: 0, files: 0, truncated: true }
        let measured = false
        if (measuredCount < 18 && Date.now() - startedAt < 16000) {
          size = measureDir(full, { maxEntries: 30000, deadlineMs: 800 })
          measuredCount += 1
          measured = true
        }
        topDirs.push({
          drive: letter,
          name: entry.name,
          path: full,
          bytes: Math.round(size.bytes),
          files: size.files,
          measured,
          truncated: size.truncated,
        })
      }
    }
    topDirs.sort((a, b) => b.bytes - a.bytes)
  }

  const safe = Math.round(safeBytes)
  const cautious = Math.round(cautiousBytes)
  const hint =
    safe + cautious === 0
      ? '没有可清理的临时文件。若要整理文件，用 tidy_plan 指定目录出方案。'
      : `可清项确认后执行：tidy_apply（kind=clean，confirm:true）；谨慎项（回收站）需在 targets 里点名。`

  // 深度探查：给了 path 就把这个目录查到底
  let inspect = {
    path: '',
    bytes: 0,
    files: 0,
    dirs: 0,
    topTypes: [],
    references: [],
    processes: [],
    locks: [],
    locksChecked: false,
    markers: [],
    verdict: '',
    reason: '',
  }
  if (args && typeof args.path === 'string' && args.path.trim() !== '') {
    const target = path.resolve(args.path.trim())
    if (existsSync(target)) {
      inspect = inspectTarget(target, guard || [], store || { dir: os.tmpdir() }, { locks: Boolean(args.locks) })
    } else {
      inspect.path = target
      inspect.verdict = 'missing'
      inspect.reason = `路径不存在：${target}`
    }
  }

  const health = args && args.health ? probeHealth() : { errors7d: 0, bootMs: 0, autoNotRunning: 0, installedApps: 0, uptimeHours: 0 }
  const residue =
    args && args.residue ? probeResidue() : { deadPath: [], ghostServices: [], deadStartup: [], deadTasks: [] }
  const events = args && args.events ? probeEvents(Number(args.days) || 7) : { systemTotal: 0, appTotal: 0, systemTop: [], appTop: [] }

  return {
    drives,
    cleanableBytes: safe + cautious,
    safeBytes: safe,
    cautiousBytes: cautious,
    adminBytes: Math.round(adminBytes),
    cleanableItems,
    scattered,
    notes,
    topDirs,
    inspect,
    health,
    residue,
    events,
    hint,
  }
}

// ───────────────────────────── 主逻辑：方案 ─────────────────────────────

function doPlan(config, args, guard, store) {
  const kind = args && args.kind === 'clean' ? 'clean' : 'organize'
  if (kind === 'clean') {
    const scan = doScan(config, { drive: 'both' }, guard, store)
    const wanted = Array.isArray(args.targets) && args.targets.length > 0 ? args.targets : undefined
    const items = wanted ? scan.cleanableItems.filter((item) => wanted.includes(item.id)) : scan.cleanableItems.filter((item) => item.policy === 'safe')
    const totalBytes = items.reduce((sum, item) => sum + item.bytes, 0)
    return {
      kind,
      target: '',
      rule: '',
      totalFiles: items.reduce((sum, item) => sum + item.files, 0),
      totalBytes: Math.round(totalBytes),
      groups: items.map((item) => ({
        label: item.label,
        folder: POLICY_LABEL[item.policy] || '可清',
        files: item.files,
        bytes: item.bytes,
      })),
      preview: items.map((item) => ({ name: item.label, size: fmtSize(item.bytes), to: POLICY_LABEL[item.policy] || '可清' })),
      candidates: [],
      renames: [],
      omitted: 0,
      truncated: false,
      hint: '确认后执行 tidy_apply（kind=clean，confirm:true）。清理的是临时文件，删了系统会重建。',
    }
  }

  const rule = args && args.rule === 'by-date' ? 'by-date' : 'by-type'
  const subfolders = Boolean(args && args.subfolders)
  const limit = Number.isInteger(args && args.limit) ? Math.min(Math.max(args.limit, 1), 50) : 15
  const checked = validateTarget(args && args.target, guard, store)
  if (checked.error) {
    return {
      kind,
      target: typeof args?.target === 'string' ? args.target : '',
      rule,
      totalFiles: 0,
      totalBytes: 0,
      groups: [],
      preview: [],
      candidates: [],
      renames: [],
      omitted: 0,
      truncated: false,
      code: 'TARGET_REJECTED',
      hint: checked.error,
    }
  }
  const typeMap = buildTypeMap(config)
  const plan = buildOrganizePlan(checked.resolved, { rule, subfolders, typeMap, guard })
  return {
    kind,
    target: checked.resolved,
    rule,
    totalFiles: plan.totalFiles,
    totalBytes: Math.round(plan.totalBytes),
    groups: plan.groups.map((group) => ({
      label: group.label,
      folder: group.folder,
      files: group.files,
      bytes: Math.round(group.bytes),
    })),
    preview: plan.moves.slice(0, limit).map((move) => ({
      name: move.relative,
      size: fmtSize(move.size),
      to: path.join(move.folder, path.basename(move.to)),
    })),
    omitted: Math.max(0, plan.moves.length - limit),
    candidates: [],
    renames: [],
    truncated: plan.truncated,
    hint:
      plan.totalFiles === 0
        ? '这个目录没有需要整理的文件（快捷方式和系统文件不整理）。'
        : '确认无误后执行 tidy_apply（同 target/rule/subfolders，confirm:true）；想反悔可用 tidy_undo。',
  }
}

// ───────────────────────────── 依赖探测（搬目录前查引用） ─────────────────────────────

/**
 * 查目录被谁引用、有没有进程在里面跑：
 * 服务、计划任务、开机自启、开始菜单快捷方式 + 正在运行的进程。
 * 这是"YULE 事件"的教训：搬/改一个程序安装目录前，必须先把引用查出来。
 * 探测失败返回空结果（不阻断流程）。
 */
function detectDependencies(target) {
  const empty = { references: [], processes: [] }
  const needle = target.replace(/'/g, "''")
  const script = `
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$p = '${needle}'
$pl = $p.ToLower()
$refs = @()
$procs = @()
try {
  Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object { $_.PathName -and $_.PathName.ToLower().Contains($pl) } | ForEach-Object { $script:refs += [pscustomobject]@{ kind = '服务'; name = $_.Name; detail = $_.PathName } }
  Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object { $t = $_; $_.Actions | Where-Object { $_.Execute -and $_.Execute.ToLower().Contains($pl) } | ForEach-Object { $script:refs += [pscustomobject]@{ kind = '计划任务'; name = $t.TaskName; detail = $_.Execute } } }
  Get-CimInstance Win32_StartupCommand -ErrorAction SilentlyContinue | Where-Object { $_.Command -and $_.Command.ToLower().Contains($pl) } | ForEach-Object { $script:refs += [pscustomobject]@{ kind = '开机自启'; name = $_.Name; detail = $_.Command } }
  $sh = New-Object -ComObject WScript.Shell
  @("$env:APPDATA\\Microsoft\\Windows\\Start Menu", "$env:ProgramData\\Microsoft\\Windows\\Start Menu") | ForEach-Object {
    Get-ChildItem $_ -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
      $t = $sh.CreateShortcut($_.FullName).TargetPath
      if ($t -and $t.ToLower().Contains($pl)) { $script:refs += [pscustomobject]@{ kind = '开始菜单'; name = $_.BaseName; detail = $t } }
    }
  }
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.ToLower().StartsWith($pl) } | ForEach-Object { $script:procs += [pscustomobject]@{ pid = $_.Id; name = $_.ProcessName; path = $_.Path } }
} catch { }
@{ references = @($refs); processes = @($procs) } | ConvertTo-Json -Compress -Depth 4
`
  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 25000, windowsHide: true },
    )
    const trimmed = String(output || '').trim()
    if (trimmed === '' || trimmed === 'null') return empty
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object') return empty
    const refs = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : []
    const procs = Array.isArray(parsed.processes) ? parsed.processes : parsed.processes ? [parsed.processes] : []
    return {
      references: refs
        .filter((item) => item && item.kind)
        .map((item) => ({ kind: String(item.kind), name: String(item.name || ''), detail: String(item.detail || '') })),
      processes: procs
        .filter((item) => item && item.pid)
        .map((item) => ({ pid: Number(item.pid) || 0, name: String(item.name || ''), path: String(item.path || '') })),
    }
  } catch (error) {
    return empty
  }
}

/** 标记探测：Electron 应用、代码仓库、游戏、安装器等特征文件 */
const MARKERS = [
  { file: 'app.asar', label: 'Electron 应用（内含 app.asar）' },
  { file: '.git', label: 'Git 仓库' },
  { file: 'package.json', label: 'Node 项目' },
  { file: 'steam_appid.txt', label: 'Steam 游戏' },
  { file: 'unins000.exe', label: 'Inno Setup 安装的程序' },
  { file: 'uninstall.exe', label: '带卸载器的程序' },
  { file: 'launcher', label: '带启动器目录' },
]

function detectMarkers(target) {
  const found = []
  for (const marker of MARKERS) {
    try {
      if (existsSync(path.join(target, marker.file))) found.push(marker.label)
    } catch (error) {
      /* 读不到就跳过 */
    }
  }
  return found
}

/** 用 Sysinternals handle64 抓占用（找不到工具就跳过，不算失败） */
function detectLocks(target, store) {
  const tool = path.join(store.dir, 'tools', 'handle64.exe')
  if (!existsSync(tool)) return { checked: false, holders: [] }
  try {
    const output = execFileSync(tool, ['-nobanner', target], { encoding: 'utf8', timeout: 20000, windowsHide: true })
    const seen = new Set()
    const holders = []
    for (const line of String(output || '').split('\n')) {
      const match = /^(.+?)\s+pid:\s*(\d+)\s+type:\s*\S+\s+\S+:\s*(.+)$/.exec(line.trim())
      if (!match) continue
      const key = `${match[1].trim()}|${match[2]}`
      if (seen.has(key)) continue
      seen.add(key)
      holders.push({ process: match[1].trim(), pid: Number(match[2]) || 0 })
    }
    return { checked: true, holders }
  } catch (error) {
    return { checked: true, holders: [] }
  }
}

/** 综合探查：体积构成 + 引用 + 运行中进程 + 占用 + 特征 + 结论 */
function inspectTarget(target, guard, store, options = {}) {
  const result = {
    path: target,
    bytes: 0,
    files: 0,
    dirs: 0,
    topTypes: [],
    references: [],
    processes: [],
    locks: [],
    locksChecked: false,
    markers: [],
    verdict: 'safe',
    reason: '',
  }
  // 2026-11-03 审计 T3：原先只做字符串比较，junction / \\?\ / UNC 写法会给出「可动」的相反结论。
  if (isUnsafePath(target)) {
    result.verdict = 'forbidden'
    result.reason = '路径写法不能安全判定（UNC / 设备路径），按不可动处理。'
    return result
  }
  const inspectResolved = path.resolve(target)
  if (hasReparsePoint(inspectResolved)) {
    result.verdict = 'forbidden'
    result.reason = '是 junction / 符号链接（重解析点），真实位置无法安全判定，按不可动处理。'
    return result
  }
  const inspectReal = realPathOf(inspectResolved)
  result.path = inspectReal === '' ? target : inspectReal
  if (inspectReal === '' || isProtected(inspectReal, guard)) {
    result.verdict = 'forbidden'
    result.reason = '在红线目录内（系统目录 / 插件源码 / 学习空间），不许动。'
    return result
  }

  const measured = measureDir(target, { maxEntries: 60000, deadlineMs: 5000 })
  result.bytes = Math.round(measured.bytes)
  result.files = measured.files

  // 顶层构成（只看两层，避免慢）
  const typeMap = new Map()
  try {
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        result.dirs += 1
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase() || '（无扩展名）'
      const bucket = typeMap.get(ext) || { label: ext, files: 0, bytes: 0 }
      try {
        bucket.bytes += statSync(path.join(target, entry.name)).size
      } catch (error) {
        /* skip */
      }
      bucket.files += 1
      typeMap.set(ext, bucket)
    }
  } catch (error) {
    /* skip */
  }
  result.topTypes = [...typeMap.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 8)

  const deps = detectDependencies(target)
  result.references = deps.references
  result.processes = deps.processes
  result.markers = detectMarkers(target)

  if (options.locks) {
    const locks = detectLocks(target, store)
    result.locksChecked = locks.checked
    result.locks = locks.holders
  }

  if (result.references.length > 0) {
    result.verdict = 'caution'
    result.reason = `被 ${result.references.length} 处系统引用（服务/自启/计划任务/开始菜单），改名或搬走会让它们失效。`
  } else if (result.processes.length > 0) {
    result.verdict = 'caution'
    result.reason = `有 ${result.processes.length} 个进程正在这个目录里运行，先关掉。`
  } else if (result.locks.length > 0) {
    result.verdict = 'caution'
    result.reason = `有 ${result.locks.length} 个进程咬着里面的文件，改名会失败。`
  } else {
    result.verdict = 'safe'
    result.reason = '没查出引用、运行中进程或占用，可以动。'
  }
  return result
}

/** 系统体检（只读）：7 天错误数、开机耗时、自启未运行、已装软件数、开机时长 */
function probeHealth() {
  const empty = { errors7d: 0, bootMs: 0, autoNotRunning: 0, installedApps: 0, uptimeHours: 0 }
  const script = `
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$os = Get-CimInstance Win32_OperatingSystem
$bootMs = 0
try { $ev = Get-WinEvent -LogName 'Microsoft-Windows-Diagnostics-Performance/Operational' -MaxEvents 30 -ErrorAction Stop | Where-Object { $_.Id -eq 100 } | Select-Object -First 1; if ($ev) { $bootMs = [int]$ev.Properties[3].Value } } catch { }
$errors = 0
try { $errors = (Get-WinEvent -FilterHashtable @{LogName = 'System'; Level = 1, 2; StartTime = (Get-Date).AddDays(-7)} -ErrorAction Stop | Measure-Object).Count } catch { }
$auto = @(Get-CimInstance Win32_Service | Where-Object { $_.StartMode -eq 'Auto' -and $_.State -ne 'Running' })
$apps = 0
foreach ($r in @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall')) { $apps += (Get-ChildItem $r -ErrorAction SilentlyContinue | Measure-Object).Count }
@{ errors7d = $errors; bootMs = $bootMs; autoNotRunning = $auto.Count; installedApps = $apps; uptimeHours = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1) } | ConvertTo-Json -Compress
`
  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 30000, windowsHide: true },
    )
    const raw = String(output || '').trim()
    if (raw === '') return empty
    const parsed = JSON.parse(raw)
    return {
      errors7d: Number(parsed.errors7d) || 0,
      bootMs: Number(parsed.bootMs) || 0,
      autoNotRunning: Number(parsed.autoNotRunning) || 0,
      installedApps: Number(parsed.installedApps) || 0,
      uptimeHours: Number(parsed.uptimeHours) || 0,
    }
  } catch (error) {
    return empty
  }
}

/** 事件日志归类（只读）：近 N 天系统/应用错误，按「来源 + 事件ID」聚合，附噪音判定 */
function probeEvents(days = 7) {
  const empty = { systemTotal: 0, appTotal: 0, systemTop: [], appTop: [] }
  const span = Number(days) > 0 ? Number(days) : 7
  const script = `
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$start = (Get-Date).AddDays(-${span})
$sys = @(Get-WinEvent -FilterHashtable @{LogName = 'System'; Level = 1, 2; StartTime = $start} -ErrorAction SilentlyContinue)
$app = @(Get-WinEvent -FilterHashtable @{LogName = 'Application'; Level = 1, 2; StartTime = $start} -ErrorAction SilentlyContinue)
function Get-TopGroups($events) {
  $events | Group-Object { "$($_.ProviderName)#$($_.Id)" } | Sort-Object Count -Descending | Select-Object -First 6 | ForEach-Object {
    $first = $_.Group[0]
    $msg = ''
    try { $msg = ($first.Message.Split([char]10)[0]).Trim() } catch { }
    [pscustomobject]@{ source = [string]$first.ProviderName; id = [int]$first.Id; count = [int]$_.Count; sample = $msg }
  }
}
@{ systemTotal = $sys.Count; appTotal = $app.Count; systemTop = @(Get-TopGroups $sys); appTop = @(Get-TopGroups $app) } | ConvertTo-Json -Compress -Depth 5
`
  const noise = (source, id) => {
    if (source === 'Microsoft-Windows-DistributedCOM' && id === 10010) return '噪音：DCOM 注册超时，通常不影响使用'
    if (source === 'Schannel' && id === 36876) return '噪音：证书验证失败，常见于代理/加速器'
    if (source === 'Microsoft-Windows-Security-SPP' && id === 8198) return '噪音：许可证激活检查失败'
    return ''
  }
  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 45000, windowsHide: true },
    )
    const raw = String(output || '').trim()
    if (raw === '') return empty
    const parsed = JSON.parse(raw)
    const listify = (value) => (Array.isArray(value) ? value : value ? [value] : [])
    const map = (value) =>
      listify(value).map((item) => ({
        source: String(item.source || ''),
        id: Number(item.id) || 0,
        count: Number(item.count) || 0,
        sample: String(item.sample || ''),
        note: noise(String(item.source || ''), Number(item.id) || 0),
      }))
    return {
      systemTotal: Number(parsed.systemTotal) || 0,
      appTotal: Number(parsed.appTotal) || 0,
      systemTop: map(parsed.systemTop),
      appTop: map(parsed.appTop),
    }
  } catch (error) {
    return empty
  }
}

/** 应用残留探查（只读）：失效 PATH、幽灵服务、失效自启、失效计划任务 */
function probeResidue() {
  const empty = { deadPath: [], ghostServices: [], deadStartup: [], deadTasks: [] }
  const script = `
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function Resolve-Exe([string]$cmd) {
  if (-not $cmd) { return '' }
  $v = $cmd.Trim()
  if ($v.StartsWith('"')) {
    $end = $v.IndexOf('"', 1)
    $v = if ($end -gt 1) { $v.Substring(1, $end - 1) } else { $v.Substring(1) }
  } else {
    # 未加引号但路径含空格：先截到 .exe/.com/.bat/.cmd/.lnk 为止，别按空格切
    $m = [regex]::Match($v, '^(.*?\\.(exe|com|bat|cmd|lnk))(\\s|$)', 'IgnoreCase')
    if ($m.Success) { $v = $m.Groups[1].Value }
    elseif ($v -match '\\s') { $v = ($v -split '\\s+')[0] }
  }
  $v = [Environment]::ExpandEnvironmentVariables($v)
  if ($v -notmatch '^[A-Za-z]:\\\\') { return '' }
  return $v
}
function Test-Dead([string]$cmd) {
  $e = Resolve-Exe $cmd
  if (-not $e) { return $false }
  if (Test-Path $e) { return $false }
  if (Test-Path ($e + '.exe')) { return $false }
  return $true
}
$deadPath = @()
$allPath = ([Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User'))
foreach ($seg in ($allPath -split ';')) { $s = $seg.Trim(); if ($s -and $s -notmatch '^%' -and -not (Test-Path $s)) { $deadPath += $s } }
$deadPath = @($deadPath | Select-Object -Unique | Select-Object -First 15)
$ghostServices = @(Get-CimInstance Win32_Service | Where-Object { $_.PathName -and (Test-Dead $_.PathName) } | ForEach-Object { [pscustomobject]@{ name = $_.Name; path = $_.PathName } } | Select-Object -First 15)
$deadStartup = @(Get-CimInstance Win32_StartupCommand | Where-Object { $_.Command -and (Test-Dead $_.Command) } | ForEach-Object { [pscustomobject]@{ name = $_.Name; command = $_.Command } } | Select-Object -First 15)
$deadTasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object { $t = $_; $t.Actions | Where-Object { $_.Execute -and (Test-Dead $_.Execute) } | ForEach-Object { [pscustomobject]@{ task = $t.TaskName; execute = $_.Execute } } } | Select-Object -First 15)
@{ deadPath = @($deadPath); ghostServices = @($ghostServices); deadStartup = @($deadStartup); deadTasks = @($deadTasks) } | ConvertTo-Json -Compress -Depth 4
`
  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 45000, windowsHide: true },
    )
    const raw = String(output || '').trim()
    if (raw === '') return empty
    const parsed = JSON.parse(raw)
    const listify = (value) => (Array.isArray(value) ? value : value ? [value] : [])
    return {
      deadPath: listify(parsed.deadPath).map((item) => String(item)),
      ghostServices: listify(parsed.ghostServices).map((item) => ({ name: String(item.name || ''), path: String(item.path || '') })),
      deadStartup: listify(parsed.deadStartup).map((item) => ({ name: String(item.name || ''), command: String(item.command || '') })),
      deadTasks: listify(parsed.deadTasks).map((item) => ({ task: String(item.task || ''), execute: String(item.execute || '') })),
    }
  } catch (error) {
    return empty
  }
}

// ───────────────────────────── 主逻辑：目录归并与改名 ─────────────────────────────

/** 目录归并方案：列出目标目录下的平级目录与体积 */
function doPlanFolders(args, guard, store) {
  const empty = {
    kind: 'folders',
    target: '',
    rule: '',
    totalFiles: 0,
    totalBytes: 0,
    groups: [],
    preview: [],
    candidates: [],
    renames: [],
    omitted: 0,
    truncated: false,
    hint: '',
  }
  const checked = validateTarget(args && args.target, guard, store)
  if (checked.error) return { ...empty, code: 'TARGET_REJECTED', target: typeof args?.target === 'string' ? args.target : '', hint: checked.error }

  const target = checked.resolved
  let entries
  try {
    entries = readdirSync(target, { withFileTypes: true })
  } catch (error) {
    return { ...empty, code: 'TARGET_UNREADABLE', target, hint: `这个目录读不到：${lockHint(error)}。` }
  }

  const limit = Number.isInteger(args && args.limit) ? Math.min(Math.max(args.limit, 1), 60) : 30
  const candidates = []
  const startedAt = Date.now()
  let measured = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const full = path.join(target, entry.name)
    if (isProtected(full, guard)) continue
    if (isUnder(full, store.dir)) continue
    let size = { bytes: 0, files: 0, truncated: true }
    let didMeasure = false
    // 逐个量体积有成本：最多量 20 个、总预算 18 秒，其余标「未量」，别拿 0 B 骗人
    if (measured < 20 && Date.now() - startedAt < 18000) {
      size = measureDir(full, { maxEntries: 20000, deadlineMs: 1500 })
      measured += 1
      didMeasure = true
    }
    candidates.push({
      name: entry.name,
      path: full,
      size: Math.round(size.bytes),
      files: size.files,
      measured: didMeasure,
      truncated: size.truncated,
    })
  }
  candidates.sort((a, b) => {
    if (a.measured !== b.measured) return a.measured ? -1 : 1
    if (a.measured && b.measured && a.size !== b.size) return b.size - a.size
    return a.name.localeCompare(b.name)
  })
  const shown = candidates.slice(0, limit)
  const totalBytes = candidates.reduce((sum, item) => sum + item.size, 0)
  return {
    kind: 'folders',
    target,
    rule: '',
    totalFiles: candidates.length,
    totalBytes: Math.round(totalBytes),
    groups: [],
    preview: [],
    candidates: shown,
    renames: [],
    omitted: Math.max(0, candidates.length - shown.length),
    truncated: candidates.some((item) => item.truncated),
    hint:
      candidates.length === 0
        ? '这个目录下没有可归并的子目录。'
        : '挑出要归并的目录，把 items:[{from, into}] 传给 tidy_apply（kind=folders，confirm:true）。',
  }
}

/** 校验一条改名请求，返回 { from, to, toName, size } 或 { error } */
function validateRename(item, guard) {
  if (!item || typeof item.path !== 'string' || item.path.trim() === '') return { error: '缺 path（要改名的文件）' }
  if (typeof item.name !== 'string' || item.name.trim() === '') return { error: '缺 name（新名字）' }
  const from = path.resolve(item.path.trim())
  if (!existsSync(from)) return { error: '文件不存在' }
  let stat
  try {
    stat = statSync(from)
  } catch (error) {
    return { error: `读不到（${lockHint(error)}）` }
  }
  if (!stat.isFile() && !stat.isDirectory()) return { error: '这个对象既不是文件也不是目录，改不了名' }
  if (isProtected(from, guard)) return { error: '在红线目录内' }

  const rawName = item.name.trim()
  if (rawName !== path.basename(rawName)) return { error: '新名字不要带路径' }
  if (/[\\/:*?"<>|]/.test(rawName)) return { error: '新名字有非法字符' }
  if (rawName === '.' || rawName === '..') return { error: '名字不合法' }

  // 文件没写扩展名时沿用原扩展名，避免把 .pdf 改成无后缀；目录不做这件事
  const isDir = stat.isDirectory()
  let toName = rawName
  if (!isDir) {
    const oldExt = path.extname(from)
    if (path.extname(toName) === '' && oldExt !== '') toName = `${toName}${oldExt}`
  }
  const to = path.join(path.dirname(from), toName)
  if (norm(to) === norm(from)) return { error: '新名字和原名相同' }
  if (existsSync(to)) return { error: '同名对象已存在' }
  return { from, to, toName, size: stat.size, isDir }
}

/** 改名方案：只校验，不动文件 */
function doPlanRename(args, guard) {
  const list = Array.isArray(args?.renames) ? args.renames : []
  const rows = []
  let bytes = 0
  for (const item of list) {
    const checked = validateRename(item, guard)
    if (checked.error) {
      rows.push({
        from: item && typeof item.name === 'string' ? item.name : '?',
        to: '',
        path: item && typeof item.path === 'string' ? item.path : '',
        size: '—',
        ok: false,
        note: checked.error,
      })
      continue
    }
    bytes += checked.size
    rows.push({
      from: path.basename(checked.from),
      to: checked.toName,
      path: checked.from,
      size: fmtSize(checked.size),
      ok: true,
      note: '',
    })
  }
  const okCount = rows.filter((row) => row.ok).length
  return {
    kind: 'rename',
    target: '',
    rule: '',
    totalFiles: okCount,
    totalBytes: Math.round(bytes),
    groups: [],
    preview: [],
    candidates: [],
    renames: rows,
    omitted: 0,
    truncated: false,
    hint:
      rows.length === 0
        ? '没给改名清单。请传 renames:[{path, name}]。'
        : rows.some((row) => !row.ok)
          ? '有行不合法（见备注），修好再执行。'
          : '确认无误后 tidy_apply（kind=rename，renames 同参数，confirm:true）。',
  }
}

/** 执行目录归并 */
function doApplyFolders(args, guard, store) {
  const base = {
    applied: false,
    kind: 'folders',
    moved: 0,
    deletedFiles: 0,
    freedBytes: 0,
    skipped: 0,
    errors: [],
    blockers: [],
    manifest: '',
    remaining: 0,
    hint: '',
  }
  const items = Array.isArray(args?.items) ? args.items : []
  if (items.length === 0) {
    return { ...base, code: 'MISSING_INPUT', hint: '没给要归并的目录（items:[{from, into, name?}]）。先用 tidy_plan（kind=folders）看候选。' }
  }
  if (args?.confirm !== true) {
    return { ...base, code: 'CONFIRM_REQUIRED', hint: '目录归并会移动整个文件夹。先给用户看方案，得到同意后传 confirm:true。' }
  }
  const force = Boolean(args && args.force)
  const records = []
  const errors = []
  const blockers = []
  let moved = 0
  let bytes = 0
  let skipped = 0
  for (const item of items) {
    if (!item || typeof item.from !== 'string' || typeof item.into !== 'string') {
      skipped += 1
      continue
    }
    const from = path.resolve(item.from)
    const into = path.resolve(item.into)
    let stat
    try {
      stat = statSync(from)
    } catch (error) {
      skipped += 1
      errors.push(`${path.basename(from)}：不存在或读不到`)
      continue
    }
    if (!stat.isDirectory()) {
      skipped += 1
      errors.push(`${path.basename(from)}：不是目录`)
      continue
    }
    if (isProtected(from, guard) || isProtected(into, guard)) {
      skipped += 1
      errors.push(`${path.basename(from)}：在红线目录内`)
      continue
    }
    if (isUnder(into, from) || norm(into) === norm(from)) {
      skipped += 1
      errors.push(`${path.basename(from)}：不能移到自己里面`)
      continue
    }

    // 依赖检查：被服务 / 开机自启 / 计划任务 / 开始菜单引用时，默认不搬（除非 force:true）
    if (!force) {
      const deps = detectDependencies(from).references
      if (deps.length > 0) {
        skipped += 1
        for (const dep of deps.slice(0, 6)) {
          if (blockers.length < 20) {
            blockers.push({ name: path.basename(from), kind: dep.kind, detail: dep.name || dep.detail })
          }
        }
        continue
      }
    }

    const wantedName =
      typeof item.name === 'string' && item.name.trim() !== ''
        ? item.name.trim().replace(/[\\/:*?"<>|]/g, '').trim()
        : ''
    const to = path.join(into, wantedName !== '' ? wantedName : path.basename(from))
    if (existsSync(to)) {
      skipped += 1
      errors.push(`${path.basename(from)}：目标处已有同名目录`)
      continue
    }
    const before = measureDir(from, { maxEntries: 20000, deadlineMs: 2000 })
    try {
      movePath(from, to)
      moved += 1
      bytes += before.bytes
      records.push({ from, to })
    } catch (error) {
      skipped += 1
      if (errors.length < 8) errors.push(`${path.basename(from)}：${lockHint(error)}`)
    }
  }
  let manifest = ''
  if (records.length > 0) {
    manifest = writeManifest(store, 'folders', { at: new Date().toISOString(), moves: records })
  }
  appendLog(store.logFile, {
    at: new Date().toISOString(),
    kind: 'folders',
    moved,
    bytes: Math.round(bytes),
    errors: errors.length,
    blocked: blockers.length,
  })
  return {
    ...base,
    applied: true,
    moved,
    freedBytes: Math.round(bytes),
    skipped,
    errors,
    blockers,
    manifest,
    hint:
      blockers.length > 0
        ? '有目录被系统引用（服务/自启/计划任务/开始菜单），臣没有动。确认要强行搬时传 force:true，并准备好改这些引用。'
        : manifest
          ? '目录已归并，可 tidy_undo 撤回。'
          : '一个都没动成，看上面原因。',
  }
}

/** 执行改名 */
function doApplyRename(args, guard, store) {
  const base = {
    applied: false,
    kind: 'rename',
    moved: 0,
    deletedFiles: 0,
    freedBytes: 0,
    skipped: 0,
    errors: [],
    manifest: '',
    remaining: 0,
    hint: '',
  }
  const list = Array.isArray(args?.renames) ? args.renames : []
  if (list.length === 0) return { ...base, code: 'MISSING_INPUT', hint: '没给改名清单（renames:[{path, name}]）。' }
  if (args?.confirm !== true) {
    return { ...base, code: 'CONFIRM_REQUIRED', hint: '改名会动文件名。先给用户看预览，得到同意后传 confirm:true。' }
  }
  const records = []
  const errors = []
  let moved = 0
  let bytes = 0
  let skipped = 0
  for (const item of list) {
    const checked = validateRename(item, guard)
    if (checked.error) {
      skipped += 1
      if (errors.length < 8) errors.push(`${item && item.name ? item.name : '?'}：${checked.error}`)
      continue
    }
    try {
      movePath(checked.from, checked.to)
      moved += 1
      bytes += checked.size
      records.push({ from: checked.from, to: checked.to })
    } catch (error) {
      skipped += 1
      if (errors.length < 8) errors.push(`${path.basename(checked.from)}：${lockHint(error)}`)
    }
  }
  let manifest = ''
  if (records.length > 0) {
    manifest = writeManifest(store, 'rename', { at: new Date().toISOString(), moves: records })
  }
  appendLog(store.logFile, { at: new Date().toISOString(), kind: 'rename', moved, errors: errors.length })
  return {
    ...base,
    applied: true,
    moved,
    freedBytes: Math.round(bytes),
    skipped,
    errors,
    manifest,
    hint: manifest ? '名字已改好，可 tidy_undo 撤回。' : '一个都没改成，看上面原因。',
  }
}

// ───────────────────────────── 主逻辑：执行 ─────────────────────────────

function doApply(config, args, guard, store) {
  const kind = args && args.kind === 'clean' ? 'clean' : 'organize'
  const confirm = args?.confirm === true
  const maxFiles = Number.isInteger(args && args.maxFiles) ? Math.min(Math.max(args.maxFiles, 1), 2000) : DEFAULT_MAX_APPLY

  // ── 清理
  if (kind === 'clean') {
    if (!confirm) {
      return {
        applied: false,
        kind,
        moved: 0,
        deletedFiles: 0,
        freedBytes: 0,
        skipped: 0,
        errors: [],
        manifest: '',
        remaining: 0,
        code: 'CONFIRM_REQUIRED',
        hint: '清理不可撤销。请先把结果给用户看，得到明确同意后传 confirm:true 再执行。',
      }
    }
    const wanted = Array.isArray(args && args.targets) && args.targets.length > 0 ? args.targets : undefined
    const catalog = junkCatalog()
    const targets = catalog.deletable.filter((item) => {
      if (wanted) return wanted.includes(item.id) && item.policy !== 'admin'
      return item.policy === 'safe'
    })
    let deletedFiles = 0
    let freedBytes = 0
    let skipped = 0
    const errors = []
    for (const item of targets) {
      if (!existsSync(item.path)) continue
      let entries
      try {
        entries = readdirSync(item.path, { withFileTypes: true })
      } catch (error) {
        skipped += 1
        errors.push(`${item.label}：${lockHint(error)}`)
        continue
      }
      for (const entry of entries) {
        const full = path.join(item.path, entry.name)
        const before = entry.isDirectory() ? measureDir(full) : { bytes: safeSize(full), files: 1 }
        try {
          rmSync(full, { recursive: true, force: true })
          deletedFiles += before.files
          freedBytes += before.bytes
        } catch (error) {
          skipped += 1
          if (errors.length < 8) errors.push(`${entry.name}：${lockHint(error)}`)
        }
      }
    }
    appendLog(store.logFile, { at: new Date().toISOString(), kind, deletedFiles, freedBytes, skipped })
    return {
      applied: true,
      kind,
      moved: 0,
      deletedFiles,
      freedBytes: Math.round(freedBytes),
      skipped,
      errors,
      manifest: '',
      remaining: 0,
      hint: skipped > 0 ? '部分文件正被占用（多为正在运行的程序），关掉程序后可再清一次。' : '清理完成。',
    }
  }

  // ── 整理
  const rule = args && args.rule === 'by-date' ? 'by-date' : 'by-type'
  const subfolders = Boolean(args && args.subfolders)
  const conflict = args && args.conflict === 'skip' ? 'skip' : 'rename'
  const checked = validateTarget(args && args.target, guard, store)
  if (checked.error) {
    return {
      applied: false,
      kind,
      moved: 0,
      deletedFiles: 0,
      freedBytes: 0,
      skipped: 0,
      errors: [],
      manifest: '',
      remaining: 0,
      code: 'TARGET_REJECTED',
      hint: checked.error,
    }
  }
  if (!confirm) {
    return {
      applied: false,
      kind,
      moved: 0,
      deletedFiles: 0,
      freedBytes: 0,
      skipped: 0,
      errors: [],
      manifest: '',
      remaining: 0,
      code: 'CONFIRM_REQUIRED',
      hint: '整理会移动文件。请先给用户看 tidy_plan 的方案，得到明确同意后传 confirm:true 再执行。',
    }
  }

  const typeMap = buildTypeMap(config)
  const plan = buildOrganizePlan(checked.resolved, { rule, subfolders, typeMap, guard, conflict, maxFiles })
  const moves = plan.moves.slice(0, maxFiles)
  const records = []
  const errors = []
  let moved = 0
  let bytes = 0
  for (const move of moves) {
    try {
      movePath(move.from, move.to)
      moved += 1
      bytes += move.size
      records.push({ from: move.from, to: move.to, bytes: move.size })
    } catch (error) {
      if (errors.length < 8) errors.push(`${move.name}：${lockHint(error)}`)
    }
  }
  let manifest = ''
  if (records.length > 0) {
    manifest = writeManifest(store, 'organize', {
      at: new Date().toISOString(),
      target: checked.resolved,
      rule,
      moves: records,
    })
  }
  appendLog(store.logFile, { at: new Date().toISOString(), kind, target: checked.resolved, moved, bytes: Math.round(bytes), errors: errors.length })
  const remaining = Math.max(0, plan.totalFiles - moved)
  return {
    applied: true,
    kind,
    moved,
    deletedFiles: 0,
    freedBytes: Math.round(bytes),
    skipped: plan.skipped.length + Math.max(0, moves.length - moved),
    errors,
    manifest,
    remaining,
    hint:
      remaining > 0
        ? `还有 ${remaining} 个文件没动（单次上限 ${maxFiles}）。可再执行一次补齐。`
        : '整理完成。想还原可用 tidy_undo。',
  }
}

function safeSize(file) {
  try {
    return statSync(file).size
  } catch (error) {
    return 0
  }
}

// ───────────────────────────── 主逻辑：空目录与重复文件 ─────────────────────────────

/** 扫描空目录（有界；不跟随符号链接，不进红线） */
function findEmptyDirs(root, guard, { maxEntries = 30000, deadlineMs = 12000 } = {}) {
  const empty = []
  let truncated = false
  const deadline = Date.now() + deadlineMs
  const stack = [root]
  let visited = 0
  while (stack.length > 0) {
    if (visited >= maxEntries || Date.now() > deadline) {
      truncated = true
      break
    }
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      continue
    }
    visited += 1
    if (dir !== root && entries.length === 0) {
      empty.push(dir)
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (isProtected(full, guard)) continue
      stack.push(full)
    }
  }
  return { empty, truncated }
}

/** 文件哈希：full=false 只读前 64 KB（快速初筛），full=true 全量 */
function hashFile(file, full) {
  const fd = openSync(file, 'r')
  try {
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(1024 * 1024)
    let position = 0
    let total = 0
    while (true) {
      const bytes = readSync(fd, buffer, 0, buffer.length, position)
      if (bytes <= 0) break
      hash.update(buffer.subarray(0, bytes))
      position += bytes
      total += bytes
      if (!full && total >= 65536) break
    }
    return { hash: hash.digest('hex'), bytes: total }
  } finally {
    closeSync(fd)
  }
}

/**
 * 查重复文件：先按大小分组，再只对候选做「部分哈希 → 全量哈希」——fclones / czkawka 的两段式。
 * 只统计 4 KB ~ 100 MB 的普通文件；超大文件不参与（避免长时间读盘）。
 */
function findDuplicates(root, guard, { maxFiles = 20000, maxBytes = 100 * 1024 * 1024 } = {}) {
  const files = []
  const deadline = Date.now() + 20000
  const stack = [root]
  while (stack.length > 0 && files.length < maxFiles && Date.now() < deadline) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      continue
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (isProtected(full, guard)) continue
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      let stat
      try {
        stat = statSync(full)
      } catch (error) {
        continue
      }
      if (stat.size < 4096 || stat.size > maxBytes) continue
      files.push({ path: full, size: stat.size })
    }
  }

  const bySize = new Map()
  for (const file of files) {
    const list = bySize.get(file.size) || []
    list.push(file)
    bySize.set(file.size, list)
  }

  const groups = []
  for (const [size, list] of bySize) {
    if (list.length < 2) continue
    const byPartial = new Map()
    for (const file of list) {
      let key
      try {
        key = hashFile(file.path, false).hash
      } catch (error) {
        continue
      }
      const bucket = byPartial.get(key) || []
      bucket.push(file)
      byPartial.set(key, bucket)
    }
    for (const bucket of byPartial.values()) {
      if (bucket.length < 2) continue
      const byFull = new Map()
      for (const file of bucket) {
        let key
        try {
          key = hashFile(file.path, true).hash
        } catch (error) {
          continue
        }
        const exact = byFull.get(key) || []
        exact.push(file)
        byFull.set(key, exact)
      }
      for (const [hash, exact] of byFull) {
        if (exact.length >= 2) groups.push({ hash, size, files: exact.map((file) => file.path) })
      }
    }
  }
  groups.sort((a, b) => b.size * (b.files.length - 1) - a.size * (a.files.length - 1))
  return { groups, scanned: files.length }
}

/** 空目录方案（只读） */
function doPlanEmpty(args, guard, store) {
  const base = {
    kind: 'empty',
    target: '',
    rule: '',
    totalFiles: 0,
    totalBytes: 0,
    groups: [],
    preview: [],
    candidates: [],
    renames: [],
    dupeGroups: [],
    omitted: 0,
    truncated: false,
    hint: '',
  }
  const checked = validateTarget(args && args.target, guard, store)
  if (checked.error) return { ...base, code: 'TARGET_REJECTED', target: typeof args?.target === 'string' ? args.target : '', hint: checked.error }
  const limit = Number.isInteger(args && args.limit) ? Math.min(Math.max(args.limit, 1), 60) : 30
  const result = findEmptyDirs(checked.resolved, guard)
  const shown = result.empty.slice(0, limit).map((item) => ({
    name: path.basename(item),
    path: item,
    size: 0,
    files: 0,
    measured: true,
    truncated: false,
  }))
  return {
    ...base,
    target: checked.resolved,
    totalFiles: result.empty.length,
    candidates: shown,
    omitted: Math.max(0, result.empty.length - shown.length),
    truncated: result.truncated,
    hint:
      result.empty.length === 0
        ? '这个目录树下没有空目录。'
        : '确认后 tidy_apply（kind=empty，同 target，confirm:true）删掉这些空目录；空目录删了随时可重建。',
  }
}

/** 重复文件方案（只读） */
function doPlanDupes(args, guard, store) {
  const base = {
    kind: 'dupes',
    target: '',
    rule: '',
    totalFiles: 0,
    totalBytes: 0,
    groups: [],
    preview: [],
    candidates: [],
    renames: [],
    dupeGroups: [],
    omitted: 0,
    truncated: false,
    hint: '',
  }
  const checked = validateTarget(args && args.target, guard, store)
  if (checked.error) return { ...base, code: 'TARGET_REJECTED', target: typeof args?.target === 'string' ? args.target : '', hint: checked.error }
  const result = findDuplicates(checked.resolved, guard)
  const limit = Number.isInteger(args && args.limit) ? Math.min(Math.max(args.limit, 1), 30) : 12
  const shown = result.groups.slice(0, limit).map((group) => ({
    hash: group.hash.slice(0, 12),
    size: group.size,
    files: group.files,
  }))
  const wasted = result.groups.reduce((sum, group) => sum + group.size * (group.files.length - 1), 0)
  const copies = result.groups.reduce((sum, group) => sum + (group.files.length - 1), 0)
  return {
    ...base,
    target: checked.resolved,
    totalFiles: copies,
    totalBytes: Math.round(wasted),
    dupeGroups: shown,
    omitted: Math.max(0, result.groups.length - shown.length),
    hint:
      result.groups.length === 0
        ? `扫了 ${fmtCount(result.scanned)} 个候选文件，没有发现重复（4 KB ~ 100 MB 范围内）。`
        : `确认后可用 tidy_apply（kind=dupes，confirm:true）：多余副本移入隔离区，随时 tidy_undo 取回。`,
  }
}

/** 执行：删除空目录 */
function doApplyEmpty(args, guard, store) {
  const base = {
    applied: false,
    kind: 'empty',
    moved: 0,
    deletedFiles: 0,
    freedBytes: 0,
    skipped: 0,
    errors: [],
    blockers: [],
    manifest: '',
    remaining: 0,
    hint: '',
  }
  const checked = validateTarget(args && args.target, guard, store)
  if (checked.error) return { ...base, code: 'TARGET_REJECTED', hint: checked.error }
  if (args?.confirm !== true) {
    return { ...base, code: 'CONFIRM_REQUIRED', hint: '空目录本身没有内容，删除是安全的，但仍需先给用户看清单；确认后传 confirm:true。' }
  }
  // 自底向上多扫几轮：删掉空子目录后，父目录可能也空了
  let removed = 0
  let skipped = 0
  let truncated = false
  const errors = []
  for (let pass = 0; pass < 3; pass += 1) {
    const result = findEmptyDirs(checked.resolved, guard)
    truncated = truncated || result.truncated
    if (result.empty.length === 0) break
    for (const dir of result.empty) {
      try {
        rmdirSync(dir)
        removed += 1
      } catch (error) {
        skipped += 1
        if (errors.length < 8) errors.push(`${path.basename(dir)}：${lockHint(error)}`)
      }
    }
  }
  appendLog(store.logFile, { at: new Date().toISOString(), kind: 'empty', removed, skipped })
  return {
    ...base,
    applied: true,
    moved: removed,
    skipped,
    errors,
    hint: removed > 0 ? `删了 ${removed} 个空目录${truncated ? '（树太大，只扫了一部分）' : ''}。` : '没有可删的空目录。',
  }
}

/** 执行：把多余副本移入隔离区（可 tidy_undo 取回），确认无用后再删隔离区 */
function doApplyDupes(args, guard, store) {
  const base = {
    applied: false,
    kind: 'dupes',
    moved: 0,
    deletedFiles: 0,
    freedBytes: 0,
    skipped: 0,
    errors: [],
    blockers: [],
    manifest: '',
    remaining: 0,
    hint: '',
  }
  const checked = validateTarget(args && args.target, guard, store)
  if (checked.error) return { ...base, code: 'TARGET_REJECTED', hint: checked.error }
  if (args?.confirm !== true) {
    return { ...base, code: 'CONFIRM_REQUIRED', hint: '查重要动文件。先给用户看 tidy_plan（kind=dupes）的结果，确认后传 confirm:true。' }
  }
  const result = findDuplicates(checked.resolved, guard)
  const quarantine = path.join(store.dir, '_dupes', stampOf())
  const records = []
  const errors = []
  let moved = 0
  let bytes = 0
  let skipped = 0
  for (const group of result.groups) {
    const extras = group.files.slice(1) // 每组保留第一份，其余进隔离区
    for (const file of extras) {
      try {
        mkdirSync(quarantine, { recursive: true })
        const target = path.join(quarantine, `${moved + 1}-${path.basename(file)}`)
        movePath(file, target)
        moved += 1
        bytes += group.size
        records.push({ from: file, to: target })
      } catch (error) {
        skipped += 1
        if (errors.length < 8) errors.push(`${path.basename(file)}：${lockHint(error)}`)
      }
    }
  }
  let manifest = ''
  if (records.length > 0) {
    manifest = writeManifest(store, 'dupes', { at: new Date().toISOString(), moves: records })
  }
  appendLog(store.logFile, { at: new Date().toISOString(), kind: 'dupes', moved, bytes: Math.round(bytes), errors: errors.length })
  return {
    ...base,
    applied: true,
    moved,
    freedBytes: Math.round(bytes),
    skipped,
    errors,
    manifest,
    hint:
      records.length > 0
        ? `已把 ${moved} 份多余副本移入隔离区：${quarantine}。确认没用再删该目录；想反悔可 tidy_undo。`
        : '没有可隔离的重复文件。',
  }
}

// ───────────────────── 残留处置（只动用户级、可撤销） ─────────────────────

/** 统一跑一段 PowerShell 并解析 JSON 输出 */
function runPowerShellJson(script, timeout = 45000) {
  const wrapped = `$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
${script}
`
  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrapped],
      { encoding: 'utf8', timeout, windowsHide: true },
    )
    const raw = String(output || '').trim()
    if (raw === '') return undefined
    return JSON.parse(raw)
  } catch (error) {
    return undefined
  }
}

const RESIDUE_HELPERS = `
function Resolve-Exe([string]$cmd) {
  if (-not $cmd) { return '' }
  $v = $cmd.Trim()
  if ($v.StartsWith('"')) {
    $end = $v.IndexOf('"', 1)
    $v = if ($end -gt 1) { $v.Substring(1, $end - 1) } else { $v.Substring(1) }
  } else {
    # 未加引号但路径含空格：先截到 .exe/.com/.bat/.cmd/.lnk 为止，别按空格切
    $m = [regex]::Match($v, '^(.*?\\.(exe|com|bat|cmd|lnk))(\\s|$)', 'IgnoreCase')
    if ($m.Success) { $v = $m.Groups[1].Value }
    elseif ($v -match '\\s') { $v = ($v -split '\\s+')[0] }
  }
  $v = [Environment]::ExpandEnvironmentVariables($v)
  if ($v -notmatch '^[A-Za-z]:\\\\') { return '' }
  return $v
}
function Test-Dead([string]$cmd) {
  $e = Resolve-Exe $cmd
  if (-not $e) { return $false }
  if (Test-Path $e) { return $false }
  if (Test-Path ($e + '.exe')) { return $false }
  return $true
}
`

/** 分作用域探查残留：用户级（可移除）/ 系统级（需管理员） */
function probeResidueScoped() {
  const script = `${RESIDUE_HELPERS}
$userPathDead = @()
$u = [Environment]::GetEnvironmentVariable('Path', 'User')
foreach ($seg in ($u -split ';')) { $s = $seg.Trim(); if ($s -and -not (Test-Path $s)) { $userPathDead += $s } }
$userPathDuplicates = @()
$seenUser = @{}
foreach ($seg in ($u -split ';')) { $s = $seg.Trim(); if (-not $s) { continue }; $k = $s.ToLower(); if ($seenUser.ContainsKey($k)) { $userPathDuplicates += $s } else { $seenUser[$k] = $true } }
$machinePathDead = @()
$m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
foreach ($seg in ($m -split ';')) { $s = $seg.Trim(); if ($s -and -not (Test-Path $s)) { $machinePathDead += $s } }
$machinePathDuplicates = @()
$seenMachine = @{}
foreach ($seg in ($m -split ';')) { $s = $seg.Trim(); if (-not $s) { continue }; $k = $s.ToLower(); if ($seenMachine.ContainsKey($k)) { $machinePathDuplicates += $s } else { $seenMachine[$k] = $true } }
$userRunDead = @()
$hkcu = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue
if ($hkcu) { foreach ($p in $hkcu.PSObject.Properties) { if ($p.Name -like 'PS*') { continue }; if ($p.Value -and (Test-Dead $p.Value)) { $userRunDead += [pscustomobject]@{ name = $p.Name; command = $p.Value } } } }
$machineRunDead = @()
$hklm = Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue
if ($hklm) { foreach ($p in $hklm.PSObject.Properties) { if ($p.Name -like 'PS*') { continue }; if ($p.Value -and (Test-Dead $p.Value)) { $machineRunDead += [pscustomobject]@{ name = $p.Name; command = $p.Value } } } }
$deadTasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object { $t = $_; $t.Actions | Where-Object { $_.Execute -and (Test-Dead $_.Execute) } | ForEach-Object { [pscustomobject]@{ task = $t.TaskName; path = $t.TaskPath; execute = $_.Execute } } } | Select-Object -First 15)
@{ userPathDead = @($userPathDead); userPathDuplicates = @($userPathDuplicates); machinePathDead = @($machinePathDead); machinePathDuplicates = @($machinePathDuplicates); userRunDead = @($userRunDead); machineRunDead = @($machineRunDead); deadTasks = @($deadTasks) } | ConvertTo-Json -Compress -Depth 4
`
  const parsed = runPowerShellJson(script) || {}
  const listify = (value) => (Array.isArray(value) ? value : value ? [value] : [])
  return {
    userPathDead: listify(parsed.userPathDead).map((item) => String(item)),
    userPathDuplicates: listify(parsed.userPathDuplicates).map((item) => String(item)),
    machinePathDead: listify(parsed.machinePathDead).map((item) => String(item)),
    machinePathDuplicates: listify(parsed.machinePathDuplicates).map((item) => String(item)),
    userRunDead: listify(parsed.userRunDead).map((item) => ({ name: String(item.name || ''), command: String(item.command || '') })),
    machineRunDead: listify(parsed.machineRunDead).map((item) => ({ name: String(item.name || ''), command: String(item.command || '') })),
    deadTasks: listify(parsed.deadTasks).map((item) => ({ task: String(item.task || ''), path: String(item.path || ''), execute: String(item.execute || '') })),
  }
}

/** 残留方案：用户级可移除项 + 系统级需管理员项 */
function doPlanResidue(args, guard, store) {
  const base = {
    kind: 'residue',
    target: '',
    rule: '',
    totalFiles: 0,
    totalBytes: 0,
    groups: [],
    preview: [],
    candidates: [],
    renames: [],
    dupeGroups: [],
    residueItems: [],
    omitted: 0,
    truncated: false,
    hint: '',
  }
  const scoped = probeResidueScoped()
  const items = []
  for (const item of scoped.userPathDead) items.push({ kind: '用户 PATH', name: item, scope: 'user' })
  for (const item of scoped.userPathDuplicates) items.push({ kind: '用户 PATH（重复）', name: item, scope: 'user' })
  for (const item of scoped.userRunDead) items.push({ kind: '用户自启', name: item.name, scope: 'user' })
  for (const item of scoped.machinePathDead) items.push({ kind: '系统 PATH', name: item, scope: 'admin' })
  for (const item of scoped.machinePathDuplicates) items.push({ kind: '系统 PATH（重复）', name: item, scope: 'admin' })
  for (const item of scoped.machineRunDead) items.push({ kind: '系统自启', name: item.name, scope: 'admin' })
  for (const item of scoped.deadTasks) items.push({ kind: '计划任务', name: item.task, scope: 'admin' })
  const userCount = items.filter((item) => item.scope === 'user').length
  return {
    ...base,
    residueItems: items,
    totalFiles: userCount,
    hint:
      items.length === 0
        ? '没有发现残留，干净。'
        : `可直接移除的用户级残留 ${userCount} 条；其余 ${items.length - userCount} 条属系统级（服务/系统任务/系统 PATH），需要管理员权限，插件只报告不动手。`,
  }
}

/** 执行残留移除：只处理用户 PATH 与用户自启，全部写清单可撤销 */
function doApplyResidue(args, guard, store) {
  const base = {
    applied: false,
    kind: 'residue',
    moved: 0,
    deletedFiles: 0,
    freedBytes: 0,
    skipped: 0,
    errors: [],
    blockers: [],
    manifest: '',
    remaining: 0,
    hint: '',
  }
  if (args?.confirm !== true) {
    return { ...base, code: 'CONFIRM_REQUIRED', hint: '改注册表/环境变量前必须先看清单；确认后传 confirm:true。' }
  }
  // 改前备份：把 HKCU 的 Run 与 Environment 两个键导出成 .reg，出事能还原
  const backupDir = path.join(store.dir, 'tools', 'backups')
  let backupFile = ''
  try {
    mkdirSync(backupDir, { recursive: true })
    const stamp = stampOf()
    const runBackup = path.join(backupDir, `run-${stamp}.reg`)
    const envBackup = path.join(backupDir, `env-${stamp}.reg`)
    execFileSync('reg.exe', ['export', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', runBackup, '/y'], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    })
    execFileSync('reg.exe', ['export', 'HKCU\\Environment', envBackup, '/y'], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    })
    backupFile = path.dirname(runBackup)
  } catch (error) {
    backupFile = ''
  }
  const scoped = probeResidueScoped()
  const wantedRun = Array.isArray(args.runNames) && args.runNames.length > 0 ? args.runNames : scoped.userRunDead.map((item) => item.name)
  const dropPath = args.dropUserPathDead !== false
  const script = `${RESIDUE_HELPERS}
$dropPath = ${dropPath ? '$true' : '$false'}
$wantedRun = @(${wantedRun.map((name) => `'${String(name).replace(/'/g, "''")}'`).join(',')})
$oldUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$removedPath = @()
if ($dropPath) {
  $kept = @()
  $seen = @{}
  foreach ($seg in ($oldUserPath -split ';')) {
    $s = $seg.Trim(); if (-not $s) { continue }
    $k = $s.ToLower()
    if ($seen.ContainsKey($k)) { $removedPath += $s; continue }
    $seen[$k] = $true
    if (Test-Path $s) { $kept += $s } else { $removedPath += $s }
  }
  if ($removedPath.Count -gt 0) { [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User') }
}
$removedRun = @()
foreach ($name in $wantedRun) {
  $val = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name $name -ErrorAction SilentlyContinue).$name
  if ($val) { Remove-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name $name -ErrorAction SilentlyContinue; $removedRun += [pscustomobject]@{ name = $name; value = $val } }
}
@{ oldUserPath = $oldUserPath; removedPath = @($removedPath); removedRun = @($removedRun) } | ConvertTo-Json -Compress -Depth 4
`
  const parsed = runPowerShellJson(script) || {}
  const removedPath = Array.isArray(parsed.removedPath) ? parsed.removedPath : parsed.removedPath ? [parsed.removedPath] : []
  const removedRun = Array.isArray(parsed.removedRun) ? parsed.removedRun : parsed.removedRun ? [parsed.removedRun] : []
  const records = []
  if (removedPath.length > 0) records.push({ type: 'path', oldValue: String(parsed.oldUserPath || '') })
  for (const item of removedRun) records.push({ type: 'run', name: String(item.name || ''), oldValue: String(item.value || '') })

  let manifest = ''
  if (records.length > 0) manifest = writeManifest(store, 'residue', { at: new Date().toISOString(), records })
  appendLog(store.logFile, { at: new Date().toISOString(), kind: 'residue', removedPath: removedPath.length, removedRun: removedRun.length })
  const total = removedPath.length + removedRun.length
  return {
    ...base,
    applied: true,
    moved: total,
    manifest,
    hint:
      total > 0
        ? `已移除用户级残留 ${total} 条（PATH ${removedPath.length} · 自启 ${removedRun.length}），清单可 tidy_undo 恢复${backupFile ? `；改前已备份注册表到 ${backupFile}` : ''}。`
        : '没有可移除的用户级残留。',
  }
}

// ───────────────────────────── 主逻辑：撤销 ─────────────────────────────

function doUndo(store, args) {
  const confirm = args?.confirm === true
  const manifests = listManifests(store)
  if (manifests.length === 0) {
    return {
      applied: false,
      restored: 0,
      skipped: 0,
      errors: [],
      manifest: '',
      code: 'NO_MANIFEST',
      hint: '还没有可撤销的整理记录。',
    }
  }
  const wanted =
    typeof args?.manifest === 'string' && /^(organize|folders|rename|dupes|residue)-[\d-]+\.json$/.test(args.manifest)
      ? args.manifest
      : manifests[0]
  const file = path.join(store.manifests, wanted)
  if (!existsSync(file)) {
    return { applied: false, code: 'MANIFEST_NOT_FOUND', restored: 0, skipped: 0, errors: [], manifest: wanted, hint: '找不到这份整理记录，可能已被清理。' }
  }
  if (!confirm) {
    return {
      applied: false,
      restored: 0,
      skipped: 0,
      errors: [],
      manifest: wanted,
      code: 'CONFIRM_REQUIRED',
      hint: '撤销会把文件搬回原位。先给用户看要还原的记录，得到同意后传 confirm:true。',
    }
  }
  let payload
  try {
    payload = JSON.parse(readText(file))
  } catch (error) {
    return { applied: false, code: 'MANIFEST_UNREADABLE', restored: 0, skipped: 0, errors: [], manifest: wanted, hint: '这份记录读不出来，无法撤销。' }
  }
  if (wanted.startsWith('residue-')) {
    // 残留处置的撤销：把环境变量 / 自启项原值写回去
    const records = Array.isArray(payload.records) ? payload.records : []
    mkdirSync(store.dir, { recursive: true })
    const payloadFile = path.join(store.dir, `_undo-${Date.now()}.json`)
    writeFileSync(payloadFile, JSON.stringify(records), 'utf8')
    const script = `
$records = Get-Content '${payloadFile.replace(/'/g, "''")}' -Raw | ConvertFrom-Json
$restored = 0
foreach ($r in @($records)) {
  if ($r.type -eq 'path' -and $r.oldValue) { [Environment]::SetEnvironmentVariable('Path', [string]$r.oldValue, 'User'); $restored++ }
  elseif ($r.type -eq 'run' -and $r.name) { Set-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name ([string]$r.name) -Value ([string]$r.oldValue); $restored++ }
}
@{ restored = $restored } | ConvertTo-Json -Compress
`
    const outcome = runPowerShellJson(script) || {}
    try {
      rmSync(payloadFile, { force: true })
    } catch (error) {
      /* 临时文件删不掉不影响结果 */
    }
    const restoredCount = Number(outcome.restored) || 0
    appendLog(store.logFile, { at: new Date().toISOString(), kind: 'undo-residue', restored: restoredCount })
    return {
      applied: true,
      restored: restoredCount,
      skipped: 0,
      errors: [],
      manifest: wanted,
      hint: restoredCount > 0 ? '环境变量/自启项已按原值恢复。' : '这份记录里没有可恢复的项。',
    }
  }

  const moves = Array.isArray(payload.moves) ? [...payload.moves].reverse() : []
  let restored = 0
  let skipped = 0
  const errors = []
  for (const move of moves) {
    try {
      if (!existsSync(move.to)) {
        skipped += 1
        continue
      }
      if (existsSync(move.from)) {
        skipped += 1
        continue
      }
      mkdirSync(path.dirname(move.from), { recursive: true })
      movePath(move.to, move.from)
      restored += 1
    } catch (error) {
      if (errors.length < 8) errors.push(`${path.basename(move.to)}：${lockHint(error)}`)
    }
  }
  appendLog(store.logFile, { at: new Date().toISOString(), kind: 'undo', restored, skipped })
  return {
    applied: true,
    restored,
    skipped,
    errors,
    manifest: wanted,
    hint: skipped > 0 ? '跳过的文件多半是原位已有同名文件（可能是用户后来放的），未覆盖。' : '已还原到整理前的位置。',
  }
}

/** 读文本文件（单独包一层，便于统一报错） */
function readText(file) {
  return readFileSync(file, 'utf8')
}

// ───────────────────────────── 主逻辑：诊断 ─────────────────────────────

/** status 用：数据目录真的读得到吗（还没建也算未就绪：没有任何可读记录） */
function probeStoreReadable(dir) {
  try {
    if (!existsSync(dir)) return { ready: false, reason: `数据目录还没建：${dir}（第一次整理后自动创建）` }
    readdirSync(dir)
    return { ready: true, reason: '' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ready: false, reason: `数据目录读不到：${dir}（${message}）` }
  }
}

function doStatus(config, store, guard) {
  const manifests = listManifests(store)
  let lastApply = ''
  let lastUndo = ''
  if (manifests.length > 0) {
    try {
      const name = manifests[0]
      const payload = JSON.parse(readText(path.join(store.manifests, name)))
      const prefix = name.split('-')[0]
      const kindLabel = prefix === 'rename' ? '改名' : prefix === 'folders' ? '归并' : '整理'
      const count = Array.isArray(payload.moves) ? payload.moves.length : 0
      lastApply = `${hhmmss(payload.at)} · ${kindLabel}${payload.target ? ` ${payload.target}` : ''} · ${count} 项`
    } catch (error) {
      lastApply = ''
    }
  }
  let logEntries = 0
  if (existsSync(store.logFile)) {
    try {
      logEntries = readText(store.logFile).split('\n').filter((line) => line.trim() !== '').length
    } catch (error) {
      logEntries = 0
    }
  }
  // 台账统计：读不出来也不影响整理诊断，只多一条提示
  const inventory = inventoryStats(store)
  const notices = []
  // #37：红线目录改名/迁移后保护会静默失效——这里点名「配了但当前不存在」的项。
  const missingGuards = guard.filter((dir) => !existsSync(dir))
  if (missingGuards.length > 0) {
    notices.push(
      '红线目录有 ' + missingGuards.length + ' 个当前不存在（改名/迁移后保护可能失效，请复核）：' +
        missingGuards.slice(0, 5).join(' / ') + (missingGuards.length > 5 ? ' …' : ''),
    )
  }
  if (manifests.length === 0) notices.push('还没有整理记录，第一次整理后会在这里出现。')
  if (manifests.length > 20) notices.push(`整理记录已有 ${manifests.length} 份，可按需清理旧记录。`)
  if (inventory.error) notices.push('台账读不出来：' + inventory.error + '检查 ' + path.join(store.dir, 'inventory.json') + ' 后再处理。')
  const readable = probeStoreReadable(store.dir)
  return {
    ready: readable.ready,
    unavailableReason: readable.reason,
    storeDir: store.dir,
    manifests: manifests.length,
    lastApply,
    lastUndo,
    logEntries,
    protectCount: guard.length,
    limits: `单次最多整理 ${DEFAULT_MAX_APPLY} 个文件；盘点上限 ${fmtCount(SCAN_MAX_ENTRIES)} 项 / ${SCAN_DEADLINE_MS / 1000} 秒`,
    notices,
    inventoryEntries: inventory.entries,
    inventoryActive: inventory.active,
    inventoryRemoved: inventory.removed,
    inventoryStale: inventory.stale,
  }
}

// ───────────────────────────── 安装 / 卸载台账 ─────────────────────────────
//
// 台账 = storeDir/inventory.json（程序用）+ inventory.md（人看）。
// 四个工具只写这两个文件：不删用户文件、不改注册表、不停服务。
//   装完 → inventory_add；卸前 → plan_uninstall（只读预演）；卸后 → inventory_check（只读复核）。
// 台账解析失败时一律拒绝写入，并报出文件路径 —— 防止把用户手工改坏的文件静默清空。

const INVENTORY_VERSION = 1
const INVENTORY_KINDS = ['installer', 'portable', 'dsh-plugin', 'dev-tool']
const INVENTORY_KIND_LABEL = {
  installer: '安装包',
  portable: '便携版',
  'dsh-plugin': 'DSH 插件',
  'dev-tool': '开发工具',
}
const REF_FIELDS = ['services', 'startup', 'tasks', 'shortcuts', 'pathEntries', 'registryKeys']
const REF_FIELD_LABEL = {
  services: '服务',
  startup: '开机自启',
  tasks: '计划任务',
  shortcuts: '开始菜单',
  pathEntries: 'PATH',
  registryKeys: '注册表键',
}

function inventoryPaths(store) {
  return { jsonFile: path.join(store.dir, 'inventory.json'), mdFile: path.join(store.dir, 'inventory.md') }
}

function emptyRefs() {
  const refs = {}
  for (const field of REF_FIELDS) refs[field] = []
  return refs
}

function emptyInventoryEntry() {
  return {
    id: '',
    name: '',
    kind: 'installer',
    path: '',
    version: '',
    source: '',
    uninstallCmd: '',
    installedAt: '',
    updatedAt: '',
    dataDirs: [],
    refs: emptyRefs(),
    notes: '',
    status: 'active',
    removedAt: '',
    stale: false,
  }
}

/** 引用统一成 {name, detail}，避免 schema 出现可选字段 */
function toRefItems(value) {
  const list = Array.isArray(value) ? value : value ? [value] : []
  return list
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({ name: String(item.name || ''), detail: String(item.detail || '') }))
}

/** 把磁盘上的台账条目补齐成完整结构（旧版本/手改过的也不炸） */
function normalizeEntry(raw) {
  const entry = emptyInventoryEntry()
  if (!raw || typeof raw !== 'object') return entry
  const str = (value) => (typeof value === 'string' ? value : '')
  entry.id = str(raw.id)
  entry.name = str(raw.name)
  entry.kind = INVENTORY_KINDS.includes(raw.kind) ? raw.kind : 'installer'
  entry.path = str(raw.path)
  entry.version = str(raw.version)
  entry.source = str(raw.source)
  entry.uninstallCmd = str(raw.uninstallCmd)
  entry.installedAt = str(raw.installedAt)
  entry.updatedAt = str(raw.updatedAt)
  entry.dataDirs = Array.isArray(raw.dataDirs)
    ? raw.dataDirs.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
    : []
  const refs = raw.refs && typeof raw.refs === 'object' ? raw.refs : {}
  entry.refs = emptyRefs()
  for (const field of REF_FIELDS) entry.refs[field] = toRefItems(refs[field])
  entry.notes = str(raw.notes)
  entry.status = raw.status === 'removed' ? 'removed' : 'active'
  entry.removedAt = str(raw.removedAt)
  entry.stale = Boolean(raw.stale)
  return entry
}

function refCountOf(refs) {
  if (!refs) return 0
  return REF_FIELDS.reduce((sum, field) => sum + (Array.isArray(refs[field]) ? refs[field].length : 0), 0)
}

/** 六类引用摊平成一行行的 {kind, field, name, detail} */
function flattenRefs(refs) {
  const rows = []
  for (const field of REF_FIELDS) {
    for (const item of Array.isArray(refs?.[field]) ? refs[field] : []) {
      rows.push({ field, kind: REF_FIELD_LABEL[field], name: String(item.name || ''), detail: String(item.detail || '') })
    }
  }
  return rows
}

function refCountLine(refs) {
  const parts = REF_FIELDS.map((field) => REF_FIELD_LABEL[field] + ' ' + (Array.isArray(refs?.[field]) ? refs[field].length : 0))
  return parts.join(' · ') + '（共 ' + refCountOf(refs) + ' 处）'
}

function fmtDateText(value, withTime = true) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const day = date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
  if (!withTime) return day
  return day + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

function shortenText(value, max = 120) {
  const text = String(value || '')
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

/**
 * 六类引用采集（只读）：服务 / 开机自启 / 计划任务 / 开始菜单 / PATH / 注册表卸载键。
 * 沿用本插件既有的 PowerShell 采集写法；失败返回 ok:false，不阻断调用方。
 */
function probeInstallRefs(target) {
  const empty = { ok: false, refs: emptyRefs(), processes: [] }
  if (typeof target !== 'string' || target.trim() === '') return empty
  let needle
  try {
    needle = path.resolve(target.trim())
  } catch (error) {
    return empty
  }
  const escaped = needle.replace(/'/g, "''")
  const script = `$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$p = '${escaped}'
$pl = $p.ToLower()
$script:services = @()
$script:startup = @()
$script:tasks = @()
$script:shortcuts = @()
$script:pathEntries = @()
$script:registryKeys = @()
$script:procs = @()
try {
  Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object { $_.PathName -and $_.PathName.ToLower().Contains($pl) } | ForEach-Object { $script:services += [pscustomobject]@{ name = [string]$_.Name; detail = [string]$_.PathName } }
  Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object {
    $t = $_
    $t.Actions | Where-Object { $_.Execute -and $_.Execute.ToLower().Contains($pl) } | ForEach-Object {
      $script:tasks += [pscustomobject]@{ name = [string]$t.TaskName; detail = [string]$_.Execute }
    }
  }
  Get-CimInstance Win32_StartupCommand -ErrorAction SilentlyContinue | Where-Object { $_.Command -and $_.Command.ToLower().Contains($pl) } | ForEach-Object { $script:startup += [pscustomobject]@{ name = [string]$_.Name; detail = [string]$_.Command } }
  $sh = New-Object -ComObject WScript.Shell
  @("$env:APPDATA\\Microsoft\\Windows\\Start Menu", "$env:ProgramData\\Microsoft\\Windows\\Start Menu") | ForEach-Object {
    $startDir = $_
    Get-ChildItem $startDir -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
      $shortcutPath = $_.FullName
      $shortcut = $sh.CreateShortcut($shortcutPath)
      if ($shortcut.TargetPath -and $shortcut.TargetPath.ToLower().Contains($pl)) {
        $script:shortcuts += [pscustomobject]@{ name = [string]$_.BaseName; detail = [string]$shortcut.TargetPath }
      }
    }
  }
  foreach ($scope in @('User', 'Machine')) {
    $value = [Environment]::GetEnvironmentVariable('Path', $scope)
    if (-not $value) { continue }
    $label = if ($scope -eq 'User') { '用户 PATH' } else { '系统 PATH' }
    foreach ($seg in ($value -split ';')) {
      $s = $seg.Trim()
      if ($s -and $s.ToLower().Contains($pl)) { $script:pathEntries += [pscustomobject]@{ name = $label; detail = $s } }
    }
  }
  foreach ($root in @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall')) {
    Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
      $key = $_
      $props = $null
      try { $props = Get-ItemProperty $key.PSPath -ErrorAction Stop } catch { return }
      $hit = $false
      foreach ($field in @($props.InstallLocation, $props.UninstallString, $props.DisplayIcon, $props.InstallPath)) {
        if ($field -and ([string]$field).ToLower().Contains($pl)) { $hit = $true }
      }
      if (-not $hit) { return }
      $display = if ($props.DisplayName) { [string]$props.DisplayName } else { [string]$key.PSChildName }
      $where = ([string]$key.PSPath).Replace('Microsoft.PowerShell.Core\\Registry::', '')
      $script:registryKeys += [pscustomobject]@{ name = $display; detail = $where }
    }
  }
  foreach ($root in @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths', 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths')) {
    Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
      $key = $_
      $value = $null
      try { $value = (Get-ItemProperty $key.PSPath -ErrorAction Stop).'(default)' } catch { return }
      if ($value -and ([string]$value).ToLower().Contains($pl)) {
        $script:registryKeys += [pscustomobject]@{ name = [string]$key.PSChildName; detail = [string]$value }
      }
    }
  }
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.ToLower().StartsWith($pl) } | ForEach-Object { $script:procs += [pscustomobject]@{ pid = [int]$_.Id; name = [string]$_.ProcessName; path = [string]$_.Path } }
} catch { }
@{ services = @($script:services); startup = @($script:startup); tasks = @($script:tasks); shortcuts = @($script:shortcuts); pathEntries = @($script:pathEntries); registryKeys = @($script:registryKeys); processes = @($script:procs) } | ConvertTo-Json -Compress -Depth 4
`
  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 30000, windowsHide: true },
    )
    const raw = String(output || '').trim()
    if (raw === '' || raw === 'null') return empty
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return empty
    const refs = emptyRefs()
    for (const field of REF_FIELDS) refs[field] = toRefItems(parsed[field])
    const rawProcs = Array.isArray(parsed.processes) ? parsed.processes : parsed.processes ? [parsed.processes] : []
    const processes = rawProcs
      .filter((item) => item && item.pid)
      .map((item) => ({ pid: Number(item.pid) || 0, name: String(item.name || ''), path: String(item.path || '') }))
    return { ok: true, refs, processes }
  } catch (error) {
    return empty
  }
}

/** 读台账；解析失败只报错、绝不返回可写对象（防止覆盖原文件） */
function readInventory(store) {
  const { jsonFile } = inventoryPaths(store)
  const empty = { version: INVENTORY_VERSION, nextId: 1, entries: [] }
  if (!existsSync(jsonFile)) return { file: jsonFile, existed: false, data: empty }
  let raw
  try {
    raw = readText(jsonFile)
  } catch (error) {
    return { file: jsonFile, existed: true, error: '台账文件读不出来（' + lockHint(error) + '）。' }
  }
  if (String(raw).trim() === '') {
    return { file: jsonFile, existed: true, error: '台账文件是空的（可能被写坏）。' }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { file: jsonFile, existed: true, error: '台账 JSON 解析失败：' + error.message }
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
    return { file: jsonFile, existed: true, error: '台账结构不对：缺少 entries 数组。' }
  }
  const entries = parsed.entries.map(normalizeEntry)
  const nextId = Number.isInteger(parsed.nextId) && parsed.nextId > 0 ? parsed.nextId : entries.length + 1
  return { file: jsonFile, existed: true, data: { version: INVENTORY_VERSION, nextId, entries } }
}

/** 原子写：同目录临时文件 + rename，写一半断电也不会留下半截 JSON */
function atomicWriteText(file, content) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = file + '.tmp-' + process.pid + '-' + Date.now()
  try {
    writeFileSync(temp, content, 'utf8')
    renameSync(temp, file)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch (ignored) {
      /* 临时文件删不掉不影响结果 */
    }
    throw error
  }
}

function writeInventory(store, data) {
  const { jsonFile, mdFile } = inventoryPaths(store)
  const payload = { version: INVENTORY_VERSION, nextId: data.nextId, entries: data.entries }
  atomicWriteText(jsonFile, JSON.stringify(payload, null, 2))
  atomicWriteText(mdFile, renderInventoryMarkdown(payload))
  return { jsonFile, mdFile }
}

/** inventory.md：给人看的视图，每次写台账后重新生成 */
function renderInventoryMarkdown(payload) {
  const entries = Array.isArray(payload?.entries) ? payload.entries : []
  const active = entries.filter((entry) => entry.status !== 'removed')
  const removed = entries.filter((entry) => entry.status === 'removed')
  const stale = entries.filter((entry) => entry.stale)
  const lines = []
  lines.push('# 安装 / 卸载台账')
  lines.push('')
  lines.push('> 由 dsh-butler-tidy 的台账工具维护：inventory_add 登记、plan_uninstall 卸前预演、inventory_check 卸后复核。')
  lines.push('> 生成时间：' + fmtDateText(new Date()))
  lines.push('')
  lines.push('共 ' + entries.length + ' 条：在用 ' + active.length + ' · 已卸载 ' + removed.length + ' · 待核对 ' + stale.length)
  lines.push('')

  const writeSection = (title, list, options) => {
    lines.push('## ' + title + '（' + list.length + '）')
    lines.push('')
    if (list.length === 0) {
      lines.push('（没有）')
      lines.push('')
      return
    }
    for (const entry of list) {
      const version = entry.version ? ' v' + entry.version : ''
      lines.push('### ' + entry.name + version)
      lines.push('')
      lines.push('- 编号：' + entry.id)
      lines.push('- 类型：' + (INVENTORY_KIND_LABEL[entry.kind] || entry.kind))
      lines.push('- 路径：' + (entry.path || '（未填）'))
      if (entry.source) lines.push('- 来源：' + entry.source)
      if (entry.uninstallCmd) lines.push('- 卸载命令：' + entry.uninstallCmd)
      if (entry.installedAt) lines.push('- 登记时间：' + fmtDateText(entry.installedAt))
      if (options && options.removed && entry.removedAt) lines.push('- 卸载时间：' + fmtDateText(entry.removedAt))
      if (entry.stale) lines.push('- 状态：待核对（记录与磁盘对不上，跑 inventory_check 复核）')
      if (entry.dataDirs.length > 0) {
        lines.push('- 数据目录：')
        for (const dir of entry.dataDirs) lines.push('  - ' + dir)
      }
      lines.push('- 关联引用：' + refCountLine(entry.refs))
      const refRows = flattenRefs(entry.refs)
      for (const row of refRows.slice(0, 6)) {
        lines.push('  - ' + row.kind + '：' + row.name + (row.detail ? '（' + shortenText(row.detail) + '）' : ''))
      }
      if (refRows.length > 6) lines.push('  - … 另有 ' + (refRows.length - 6) + ' 处引用')
      if (entry.notes) lines.push('- 备注：' + entry.notes)
      lines.push('')
    }
  }

  writeSection('在用', active, { removed: false })
  writeSection('已卸载（历史记录）', removed, { removed: true })
  return lines.join('\n')
}

/** 台账里按编号 / 名字 / 路径找条目（精确优先，其次包含） */
function findInventoryEntries(entries, query) {
  const needle = String(query || '').trim()
  if (needle === '') return []
  const lower = needle.toLowerCase()
  const exact = []
  const nameHit = []
  const pathHit = []
  for (const entry of entries) {
    const name = String(entry.name || '').toLowerCase()
    const id = String(entry.id || '').toLowerCase()
    const target = String(entry.path || '').toLowerCase()
    if (name === lower || id === lower) exact.push(entry)
    else if (name.includes(lower)) nameHit.push(entry)
    else if (target.includes(lower)) pathHit.push(entry)
  }
  return [...exact, ...nameHit, ...pathHit]
}

/** 生成下一个编号（inv-0001 起） */
function nextInventoryId(data) {
  const used = new Set(data.entries.map((entry) => entry.id))
  let seq = Number.isInteger(data.nextId) && data.nextId > 0 ? data.nextId : 1
  while (used.has('inv-' + String(seq).padStart(4, '0'))) seq += 1
  data.nextId = seq + 1
  return 'inv-' + String(seq).padStart(4, '0')
}

/** 登记一条：同名视为更新（只覆盖本次给的可选字段），同路径换个名字视为冲突 */
function doInventoryAdd(args, store) {
  const { jsonFile, mdFile } = inventoryPaths(store)
  const base = {
    ok: false,
    created: false,
    id: '',
    entry: emptyInventoryEntry(),
    refsScanned: false,
    refCount: 0,
    total: 0,
    inventoryFile: jsonFile,
    markdownFile: mdFile,
    error: '',
    hint: '',
  }
  const fail = (message, hint, code) => ({ ...base, code: code || 'INVENTORY_ERROR', error: message, hint })
  const name = typeof args?.name === 'string' ? args.name.trim() : ''
  if (name === '') {
    return fail('没给名称（name）。', '登记一条需要 name + kind + path，例如 name="某软件"、kind="installer"、path="D:\\某软件"。', 'EMPTY_NAME')
  }
  const kind = typeof args?.kind === 'string' ? args.kind.trim() : 'installer'
  if (!INVENTORY_KINDS.includes(kind)) {
    return fail('类型取值不对：' + (kind || '（空）'), 'kind 只能是 installer / portable / dsh-plugin / dev-tool 之一。', 'INVALID_KIND')
  }
  const rawPath = typeof args?.path === 'string' ? args.path.trim() : ''
  if (rawPath === '') {
    return fail('没给安装路径（path）。', '把程序主体所在目录或可执行文件写进 path，例如 D:\\某软件；登记前先确认它已经装好。', 'EMPTY_PATH')
  }
  let absPath
  try {
    absPath = path.resolve(rawPath)
  } catch (error) {
    return fail('路径看不懂：' + rawPath, '请给绝对路径，例如 D:\\某软件。', 'BAD_PATH')
  }
  if (!existsSync(absPath)) {
    return fail('这个路径不存在：' + absPath, '登记前先确认程序已经装好；路径写错就改 path，便携包请指到解压后的目录。', 'PATH_MISSING')
  }
  const spec = readInventory(store)
  if (spec.error) {
    return fail(spec.error, '台账解析失败时不会覆盖原文件。请先备份或修好 ' + spec.file + '，再重试登记。', 'INVENTORY_UNREADABLE')
  }
  const data = spec.data
  const lowerName = name.toLowerCase()
  const sameName = data.entries.find((entry) => String(entry.name || '').toLowerCase() === lowerName)
  const samePath = data.entries.find(
    (entry) => entry.path && norm(entry.path) === norm(absPath) && String(entry.name || '').toLowerCase() !== lowerName,
  )
  if (samePath) {
    return fail(
      '这个路径已经登记在「' + samePath.name + '」（' + samePath.id + '）名下。',
      '一个路径只记一条：要么改用已有条目，要么先确认旧条目已卸载（inventory_check 的 markRemoved）后再登记新的。',
      'PATH_CONFLICT',
    )
  }
  const dataDirs = Array.isArray(args?.dataDirs)
    ? args.dataDirs.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => path.resolve(item.trim()))
    : undefined
  const scanRefs = args?.scanRefs !== false
  let probe = { ok: false, refs: emptyRefs(), processes: [] }
  if (scanRefs) probe = probeInstallRefs(absPath)
  const now = new Date().toISOString()
  const textField = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
  let entry
  let created
  if (sameName) {
    entry = sameName
    created = false
    entry.kind = kind
    entry.path = absPath
    const version = textField(args?.version)
    if (version !== undefined) entry.version = version
    const source = textField(args?.source)
    if (source !== undefined) entry.source = source
    const uninstallCmd = textField(args?.uninstallCmd)
    if (uninstallCmd !== undefined) entry.uninstallCmd = uninstallCmd
    const notes = textField(args?.notes)
    if (notes !== undefined) entry.notes = notes
    if (dataDirs !== undefined) entry.dataDirs = dataDirs
    if (scanRefs && probe.ok) entry.refs = probe.refs
    entry.updatedAt = now
    entry.stale = false
    if (entry.status === 'removed') {
      entry.status = 'active'
      entry.removedAt = ''
    }
  } else {
    created = true
    entry = emptyInventoryEntry()
    entry.id = nextInventoryId(data)
    entry.name = name
    entry.kind = kind
    entry.path = absPath
    entry.version = textField(args?.version) || ''
    entry.source = textField(args?.source) || ''
    entry.uninstallCmd = textField(args?.uninstallCmd) || ''
    entry.installedAt = now
    entry.updatedAt = now
    entry.dataDirs = dataDirs || []
    entry.refs = probe.ok ? probe.refs : emptyRefs()
    entry.notes = textField(args?.notes) || ''
    data.entries.push(entry)
  }
  try {
    writeInventory(store, data)
  } catch (error) {
    return fail('台账写不进去：' + lockHint(error) + '（' + jsonFile + '）', '检查数据目录是否可写；台账原文件没被动过，修好后重试。', 'INVENTORY_WRITE_FAILED')
  }
  const refsScanned = Boolean(scanRefs && probe.ok)
  let hint = created
    ? '装完就记，卸前用 plan_uninstall 预演一遍；确认卸载完再用 inventory_check 复核。'
    : '已按本次参数更新已有登记（没给的字段保持原值）。'
  if (scanRefs && !probe.ok) hint = hint + ' 引用扫描没跑成，登记里暂缺引用信息，稍后可重跑 inventory_add 补上。'
  return {
    ...base,
    ok: true,
    created,
    id: entry.id,
    entry,
    refsScanned,
    refCount: refCountOf(entry.refs),
    total: data.entries.length,
    error: '',
    hint,
  }
}

/** 列出条目（默认只在用；可按类型 / 状态过滤） */
function doInventoryList(args, store) {
  const { jsonFile } = inventoryPaths(store)
  const emptyResult = (error, hint, code) => ({
    storeDir: store.dir,
    total: 0,
    shown: 0,
    omitted: 0,
    activeCount: 0,
    removedCount: 0,
    staleCount: 0,
    storeBytes: 0,
    entries: [],
    inventoryFile: jsonFile,
    error,
    hint,
    ...(code ? { code } : {}),
  })
  const spec = readInventory(store)
  if (spec.error) return emptyResult(spec.error, '台账解析失败，臣没有覆盖它。请先检查 ' + spec.file + '。', 'INVENTORY_UNREADABLE')
  const kind = typeof args?.kind === 'string' ? args.kind.trim() : ''
  if (kind !== '' && !INVENTORY_KINDS.includes(kind)) {
    return emptyResult('类型筛选值不对：' + kind, 'kind 只能是 installer / portable / dsh-plugin / dev-tool。', 'INVALID_KIND')
  }
  const status = args?.status === 'removed' ? 'removed' : args?.status === 'all' ? 'all' : 'active'
  const limit = Number.isInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), 200) : 20
  const all = spec.data.entries
  const matched = all.filter((entry) => {
    if (status !== 'all' && entry.status !== status) return false
    if (kind !== '' && entry.kind !== kind) return false
    return true
  })
  const measured = existsSync(store.dir) ? measureDir(store.dir, { maxEntries: 6000, deadlineMs: 1500 }) : { bytes: 0 }
  const shown = matched.slice(0, limit)
  const activeCount = all.filter((entry) => entry.status !== 'removed').length
  const removedCount = all.length - activeCount
  const staleCount = all.filter((entry) => entry.stale).length
  let hint = ''
  if (all.length === 0) hint = '台账还是空的。装完新东西用 inventory_add 登记（name / kind / path 必填）。'
  else if (matched.length > shown.length) {
    hint = '还有 ' + (matched.length - shown.length) + ' 条未列出：调大 limit，或用 status="all" 看历史记录。'
  } else if (status === 'active' && removedCount > 0) {
    hint = '另有 ' + removedCount + ' 条已卸载的历史记录，要看用 status="all"。'
  }
  return {
    ...emptyResult('', hint),
    total: matched.length,
    shown: shown.length,
    omitted: matched.length - shown.length,
    activeCount,
    removedCount,
    staleCount,
    storeBytes: Math.round(measured.bytes),
    entries: shown,
  }
}

/** 卸前建议步骤：按条目实际查到的引用 / 进程 / 数据目录生成，不执行任何动作 */
function buildUninstallSteps(entry, info) {
  const steps = []
  if (info.processes.length > 0) {
    steps.push(
      '先关掉正在运行的程序：' +
        info.processes
          .slice(0, 6)
          .map((item) => item.name + '(pid ' + item.pid + ')')
          .join('、') +
        (info.processes.length > 6 ? ' 等 ' + info.processes.length + ' 个' : ''),
    )
  }
  if (entry.uninstallCmd) {
    steps.push('运行卸载命令：' + entry.uninstallCmd)
  } else if (entry.kind === 'portable') {
    steps.push('便携版一般没有卸载器：确认不保留配置后直接删安装目录（建议先备份数据目录）。')
  } else {
    steps.push('没有登记卸载命令：去「设置 → 应用」或程序目录里找卸载器；找不到就按便携版处理，手动删目录。')
  }
  for (const field of REF_FIELDS) {
    const items = Array.isArray(info.refs[field]) ? info.refs[field] : []
    if (items.length === 0) continue
    const names = items
      .slice(0, 5)
      .map((item) => item.name || item.detail)
      .join('、')
    const suffix = items.length > 5 ? ' 等 ' + items.length + ' 处' : ''
    if (field === 'services') steps.push('停掉并删除服务（需管理员）：' + names + suffix)
    else if (field === 'tasks') steps.push('删除计划任务：' + names + suffix)
    else if (field === 'startup') steps.push('删除开机自启项：' + names + suffix)
    else if (field === 'shortcuts') steps.push('删掉开始菜单快捷方式：' + names + suffix)
    else if (field === 'pathEntries') steps.push('清掉 PATH 里的相关段（用户级可自己改，系统级需管理员）：' + names + suffix)
    else steps.push('删除注册表卸载键（需管理员；删前先导出 .reg 备份）：' + names + suffix)
  }
  if (info.refsSource === 'recorded') {
    steps.push('注意：本次引用清单来自登记时的记录，不是现扫的；动手前建议再跑一次 plan_uninstall。')
  }
  if (info.dataDirs.length > 0) {
    const remaining = info.dataDirs.filter((item) => item.exists)
    if (remaining.length > 0) {
      steps.push(
        '决定数据目录去留：' +
          remaining.map((item) => item.path + '（' + fmtSize(item.bytes) + '）').join('、') +
          '。里面有配置 / 存档 / 许可证就先备份。',
      )
    } else {
      steps.push('数据目录已经都不在了，无需处理。')
    }
  }
  if (info.redlineNotes.length > 0) steps.push('红线提醒：' + info.redlineNotes[0])
  steps.push('删完跑 inventory_check 复核残留；确认干净的条目用 inventory_check 的 markRemoved 收进历史。')
  return steps
}

/** 卸前预演：只读，不删任何东西 */
function doPlanUninstall(args, store, guard) {
  const { jsonFile } = inventoryPaths(store)
  const base = {
    found: false,
    query: '',
    matches: 0,
    entry: emptyInventoryEntry(),
    targetExists: false,
    targetBytes: 0,
    targetFiles: 0,
    targetTruncated: false,
    refs: emptyRefs(),
    refCount: 0,
    refsScanned: false,
    refsSource: 'none',
    dataDirs: [],
    dataBytes: 0,
    processes: [],
    locks: [],
    locksChecked: false,
    redlineNotes: [],
    steps: [],
    removesNothing: true,
    notice: '这是只读预演：不删文件、不改注册表、不停服务。',
    inventoryFile: jsonFile,
    error: '',
    hint: '',
  }
  const nameQuery = typeof args?.name === 'string' ? args.name.trim() : ''
  const pathQuery = typeof args?.path === 'string' ? args.path.trim() : ''
  const query = nameQuery || pathQuery
  if (query === '') {
    return { ...base, code: 'EMPTY_QUERY', error: '没给要预演的对象。', hint: '用 name（台账里的名字或编号）或 path（安装路径）指定一条，例如 name="某软件"。' }
  }
  const spec = readInventory(store)
  if (spec.error) {
    return { ...base, code: 'INVENTORY_UNREADABLE', query, error: spec.error, hint: '台账解析失败，臣没有覆盖它。请先检查 ' + spec.file + '。' }
  }
  const matched = findInventoryEntries(spec.data.entries, query)
  if (matched.length === 0) {
    return {
      ...base,
      query,
      code: 'NOT_FOUND',
      error: '台账里没有匹配「' + query + '」的条目。',
      hint: '先用 inventory_list 看已登记的名字；确实是新装的，用 inventory_add 补录后再预演。',
    }
  }
  const entry = matched[0]
  const target = entry.path
  const targetExists = target !== '' && existsSync(target)
  const measured = targetExists ? measureDir(target, { maxEntries: 40000, deadlineMs: 4000 }) : { bytes: 0, files: 0, truncated: false }
  const scanRefs = args?.scanRefs !== false
  const probe = scanRefs ? probeInstallRefs(target) : { ok: false, refs: emptyRefs(), processes: [] }
  let refs = emptyRefs()
  let refsScanned = false
  let refsSource = 'none'
  if (probe.ok) {
    refs = probe.refs
    refsScanned = true
    refsSource = 'fresh'
  } else if (refCountOf(entry.refs) > 0) {
    refs = entry.refs
    refsSource = 'recorded'
  }
  const dataDirs = []
  let dataBytes = 0
  const startedAt = Date.now()
  let measuredDirs = 0
  for (const dir of entry.dataDirs) {
    const dirExists = existsSync(dir)
    let size = { bytes: 0, files: 0, truncated: false }
    if (dirExists && measuredDirs < 8 && Date.now() - startedAt < 8000) {
      size = measureDir(dir, { maxEntries: 20000, deadlineMs: 1500 })
      measuredDirs += 1
    } else if (dirExists) {
      size = { bytes: 0, files: 0, truncated: true }
    }
    dataBytes += size.bytes
    dataDirs.push({ path: dir, exists: dirExists, bytes: Math.round(size.bytes), files: size.files, truncated: size.truncated })
  }
  const processes = probe.ok ? probe.processes : []
  const locksResult = args?.locks ? detectLocks(target, store) : { checked: false, holders: [] }
  const redlineNotes = []
  if (target !== '' && isProtected(target, guard)) {
    redlineNotes.push('安装路径在红线目录内（系统目录 / 插件源码 / 学习空间）：真要删请逐项人工确认，插件不会代删。')
  }
  for (const dir of entry.dataDirs) {
    if (isProtected(dir, guard)) redlineNotes.push('数据目录在红线目录内：' + dir)
  }
  if (store && target !== '' && isUnder(target, store.dir)) {
    redlineNotes.push('安装路径就是本插件自己的数据目录：删掉会连整理记录和台账一起丢。')
  }
  const steps = buildUninstallSteps(entry, {
    dataDirs,
    refs,
    refsSource,
    processes,
    redlineNotes,
  })
  const hint =
    matched.length > 1
      ? '匹配到 ' + matched.length + ' 条，本次只预演「' + entry.name + '」；要预演别的条目，用 name 写全名或编号。'
      : '按上面步骤执行；卸完用 inventory_check 复核残留，确认干净后再标记为已卸载。'
  return {
    ...base,
    found: true,
    query,
    matches: matched.length,
    entry,
    targetExists,
    targetBytes: Math.round(measured.bytes),
    targetFiles: measured.files,
    targetTruncated: Boolean(measured.truncated),
    refs,
    refCount: refCountOf(refs),
    refsScanned,
    refsSource,
    dataDirs,
    dataBytes: Math.round(dataBytes),
    processes,
    locks: locksResult.holders,
    locksChecked: locksResult.checked,
    redlineNotes,
    steps,
    error: '',
    hint,
  }
}

/** 卸后复核：只读；只改 inventory.json 里的 stale / removed 标记，不删记录、不动用户文件 */
function doInventoryCheck(args, store) {
  const { jsonFile, mdFile } = inventoryPaths(store)
  const base = {
    checked: 0,
    missingCount: 0,
    residueCount: 0,
    okCount: 0,
    missing: [],
    residue: [],
    ok: [],
    staleMarked: 0,
    removedMarked: 0,
    probes: 0,
    inventoryFile: jsonFile,
    markdownFile: mdFile,
    error: '',
    hint: '',
  }
  const spec = readInventory(store)
  if (spec.error) return { ...base, code: 'INVENTORY_UNREADABLE', error: spec.error, hint: '台账解析失败，臣没有覆盖它。请先检查 ' + spec.file + '。' }
  const query = typeof args?.name === 'string' ? args.name.trim() : ''
  let scoped = spec.data.entries
  if (query !== '') {
    const matched = findInventoryEntries(scoped, query)
    if (matched.length === 0) {
      return { ...base, code: 'NOT_FOUND', error: '台账里没有匹配「' + query + '」的条目。', hint: '先用 inventory_list 看已登记的名字。' }
    }
    scoped = matched
  }
  const active = scoped.filter((entry) => entry.status !== 'removed')
  if (active.length === 0) {
    return {
      ...base,
      hint: query !== '' ? '这条已经标记为已卸载（历史记录），不需要再复核。' : '台账里没有在用的条目，先 inventory_add 登记。',
    }
  }
  const markStale = args?.markStale !== false
  const markRemoved = args?.markRemoved === true
  const scanRefs = args?.scanRefs !== false
  const budget = { probes: 0, maxProbes: 8, deadline: Date.now() + 25000 }
  const missing = []
  const residue = []
  const ok = []
  let staleMarked = 0
  let removedMarked = 0
  let changed = false
  const now = new Date().toISOString()
  for (const entry of active) {
    const pathExists = entry.path !== '' && existsSync(entry.path)
    const dirsGone = entry.dataDirs.filter((dir) => !existsSync(dir))
    const allDirsGone = dirsGone.length === entry.dataDirs.length
    if (pathExists) {
      let detail = '路径与数据目录都在。'
      if (dirsGone.length > 0) {
        detail = '路径在；数据目录缺 ' + dirsGone.length + '/' + entry.dataDirs.length + ' 个：' + dirsGone.slice(0, 3).join(' / ')
      }
      ok.push({ id: entry.id, name: entry.name, detail })
      if (entry.stale) {
        entry.stale = false
        changed = true
      }
      continue
    }
    let fresh = null
    if (scanRefs && budget.probes < budget.maxProbes && Date.now() < budget.deadline) {
      budget.probes += 1
      const probed = probeInstallRefs(entry.path)
      if (probed.ok) fresh = probed.refs
    }
    const refsInUse = fresh || entry.refs
    const refItems = flattenRefs(refsInUse)
    if (refItems.length > 0) {
      for (const item of refItems.slice(0, 20)) {
        residue.push({
          id: entry.id,
          name: entry.name,
          refKind: item.kind,
          detail: shortenText(item.name + (item.detail ? ' · ' + item.detail : ''), 300),
        })
      }
      missing.push({
        id: entry.id,
        name: entry.name,
        kind: entry.kind,
        path: entry.path,
        detail: '安装路径已不在；引用残留 ' + refItems.length + ' 处' + (fresh ? '' : '（引用取自登记时的记录，本次未重扫）'),
      })
      if (markStale && !entry.stale) {
        entry.stale = true
        changed = true
        staleMarked += 1
      }
      continue
    }
    let detail = '安装路径已不在，也没有查到关联引用。'
    if (entry.dataDirs.length > 0) {
      detail = allDirsGone
        ? '安装路径与数据目录都已不在，也没有关联引用。'
        : '安装路径已不在；数据目录还留着 ' + (entry.dataDirs.length - dirsGone.length) + ' 个，删前确认。'
    }
    missing.push({ id: entry.id, name: entry.name, kind: entry.kind, path: entry.path, detail })
    if (markRemoved && allDirsGone) {
      entry.status = 'removed'
      entry.removedAt = now
      entry.stale = false
      changed = true
      removedMarked += 1
    } else if (markStale && !entry.stale) {
      entry.stale = true
      changed = true
      staleMarked += 1
    }
  }
  let error = ''
  if (changed) {
    try {
      writeInventory(store, spec.data)
    } catch (writeError) {
      error = '复核算完了，但台账写不进去：' + lockHint(writeError) + '（' + jsonFile + '）'
    }
  }
  const missingCount = missing.length
  const residueCount = residue.length
  let hint = ''
  if (missingCount === 0 && residueCount === 0) hint = '对账通过：在用条目都还在，没有引用残留。'
  else if (missingCount > 0) {
    hint = '确认已卸载且数据也清干净的条目，用 inventory_check 的 markRemoved 收进历史；引用残留按 plan_uninstall 的步骤逐条清。'
  } else hint = '引用有残留，建议用 plan_uninstall 看建议步骤逐条清理。'
  return {
    ...base,
    checked: active.length,
    missing,
    residue,
    ok,
    missingCount,
    residueCount,
    okCount: ok.length,
    staleMarked,
    removedMarked,
    probes: budget.probes,
    error,
    hint,
  }
}

/** 给 tidy_status 用的台账统计（读不出来也不抛） */
function inventoryStats(store) {
  const spec = readInventory(store)
  if (spec.error) return { entries: 0, active: 0, removed: 0, stale: 0, error: spec.error }
  const entries = spec.data.entries
  const active = entries.filter((entry) => entry.status !== 'removed').length
  return {
    entries: entries.length,
    active,
    removed: entries.length - active,
    stale: entries.filter((entry) => entry.stale).length,
    error: '',
  }
}

// ───────────────────────────── 台账：人话输出 ─────────────────────────────

function renderInventoryAdd(_args, value) {
  const entry = value?.entry || emptyInventoryEntry()
  if (!value?.ok) {
    const failed = ['登记没成：' + (value?.error || '未知原因')]
    if (value?.hint) failed.push(value.hint)
    return [text(failed.join('\n'))]
  }
  const lines = []
  if (value?.created) {
    lines.push(
      '陛下，已登记「' + entry.name + '」（' + entry.id + ' · ' + (INVENTORY_KIND_LABEL[entry.kind] || entry.kind) + '）。',
    )
  } else {
    lines.push('陛下，已更新「' + entry.name + '」的登记（' + entry.id + '）。')
  }
  lines.push('  路径：' + (entry.path || '（未填）'))
  if (entry.version) lines.push('  版本：' + entry.version)
  if (entry.dataDirs.length > 0) {
    const shown = entry.dataDirs.slice(0, 3).join(' · ')
    lines.push('  数据目录：' + entry.dataDirs.length + ' 个（' + shown + (entry.dataDirs.length > 3 ? ' …' : '') + '）')
  }
  lines.push('  关联引用：' + refCountLine(entry.refs))
  lines.push('  台账：' + (value?.inventoryFile || '') + '（共 ' + fmtCount(value?.total ?? 0) + ' 条）')
  if (!value?.refsScanned) lines.push('  （本次没拿到关联引用：可能跳过了扫描或扫描失败；需要的话再跑一次 inventory_add）')
  if (value?.hint) lines.push('下一步：' + value.hint)
  return [text(lines.join('\n'))]
}

function renderInventoryList(_args, value) {
  if (value?.error) {
    return [text(['台账读不出来：' + value.error, value?.hint].filter(Boolean).join('\n'))]
  }
  const lines = []
  const allCount = (Number(value?.activeCount) || 0) + (Number(value?.removedCount) || 0)
  if (allCount === 0) {
    lines.push('陛下，台账还是空的。')
    if (value?.hint) lines.push(value.hint)
    lines.push('数据目录：' + (value?.storeDir || '') + '（约 ' + fmtSize(value?.storeBytes ?? 0) + '）')
    return [text(lines.join('\n'))]
  }
  lines.push(
    '陛下，台账共 ' +
      fmtCount(allCount) +
      ' 条（在用 ' +
      fmtCount(value?.activeCount ?? 0) +
      ' · 已卸载 ' +
      fmtCount(value?.removedCount ?? 0) +
      ' · 待核对 ' +
      fmtCount(value?.staleCount ?? 0) +
      '），本次列 ' +
      fmtCount(value?.total ?? 0) +
      ' 条：',
  )
  for (const entry of Array.isArray(value?.entries) ? value.entries : []) {
    const version = entry.version ? ' · v' + entry.version : ''
    const statusText = entry.status === 'removed' ? '已卸载' : entry.stale ? '待核对' : '在用'
    lines.push('  • ' + entry.name + '（' + (INVENTORY_KIND_LABEL[entry.kind] || entry.kind) + version + '） · ' + statusText)
    lines.push('      ' + (entry.path || '（未填路径）'))
    if (entry.dataDirs.length > 0 || refCountOf(entry.refs) > 0) {
      lines.push('      数据目录 ' + entry.dataDirs.length + ' 个 · ' + refCountOf(entry.refs) + ' 处引用')
    }
  }
  if ((value?.omitted ?? 0) > 0) lines.push('  … 还有 ' + fmtCount(value.omitted) + ' 条未列出')
  lines.push('数据目录：' + (value?.storeDir || '') + '（约 ' + fmtSize(value?.storeBytes ?? 0) + '）')
  if (value?.hint) lines.push(value.hint)
  return [text(lines.join('\n'))]
}

function renderPlanUninstall(_args, value) {
  if (!value?.found) {
    const lines = ['陛下，这次预演没成：' + (value?.error || '未知原因')]
    if (value?.hint) lines.push(value.hint)
    return [text(lines.join('\n'))]
  }
  const entry = value.entry || emptyInventoryEntry()
  const lines = []
  lines.push('陛下，卸载预演（只读，不删任何东西）：「' + entry.name + '」（' + entry.id + ' · ' + (INVENTORY_KIND_LABEL[entry.kind] || entry.kind) + '）')
  lines.push('  状态：' + (entry.status === 'removed' ? '已卸载（历史）' : entry.stale ? '待核对' : '在用') + (entry.version ? ' · 版本 ' + entry.version : ''))
  lines.push(
    '  安装路径：' +
      (entry.path || '（未填）') +
      (value.targetExists
        ? '（还在，' + fmtSize(value.targetBytes ?? 0) + ' / ' + fmtCount(value.targetFiles ?? 0) + ' 个文件' + (value.targetTruncated ? '，只量了一部分' : '') + '）'
        : '（已不在）'),
  )
  if (entry.uninstallCmd) lines.push('  卸载命令：' + entry.uninstallCmd)
  if (value.dataDirs.length > 0) {
    lines.push('  数据目录：' + value.dataDirs.length + ' 个，共 ' + fmtSize(value.dataBytes ?? 0))
    for (const dir of value.dataDirs.slice(0, 8)) {
      lines.push('    • ' + dir.path + '（' + (dir.exists ? '在，' + fmtSize(dir.bytes) : '已不在') + '）')
    }
    if (value.dataDirs.length > 8) lines.push('    … 另有 ' + (value.dataDirs.length - 8) + ' 个')
  }
  const refs = value.refs || emptyRefs()
  const refGroups = REF_FIELDS.filter((field) => (refs[field] || []).length > 0)
  if (refGroups.length === 0) {
    lines.push(value.refsSource === 'recorded' ? '  受影响引用：本次没重扫，登记时记录的引用也没有' : '  受影响引用：没查到')
  } else {
    const note = value.refsSource === 'recorded' ? '（取自登记记录，本次未重扫）' : ''
    lines.push('  受影响引用：共 ' + fmtCount(value.refCount ?? 0) + ' 处' + note)
    for (const field of refGroups) {
      lines.push('    ' + REF_FIELD_LABEL[field] + ' ' + refs[field].length + ' 处')
      for (const item of refs[field].slice(0, 5)) {
        lines.push('      · ' + (item.name || '（未命名）') + (item.detail ? '（' + shortenText(item.detail, 90) + '）' : ''))
      }
      if (refs[field].length > 5) lines.push('      … 另有 ' + (refs[field].length - 5) + ' 处')
    }
  }
  const processes = Array.isArray(value.processes) ? value.processes : []
  if (processes.length > 0) {
    lines.push('  正在运行的进程：' + processes.slice(0, 6).map((item) => item.name + '(pid ' + item.pid + ')').join('、') + (processes.length > 6 ? ' 等' : ''))
  }
  const locks = Array.isArray(value.locks) ? value.locks : []
  if (value.locksChecked) {
    lines.push('  文件占用：' + (locks.length === 0 ? '无' : locks.slice(0, 5).map((item) => item.process + '(pid ' + item.pid + ')').join('、')))
  }
  for (const note of Array.isArray(value.redlineNotes) ? value.redlineNotes : []) lines.push('【红线】' + note)
  const steps = Array.isArray(value.steps) ? value.steps : []
  if (steps.length > 0) {
    lines.push('【建议步骤】')
    steps.forEach((step, index) => lines.push('  ' + (index + 1) + '. ' + step))
  }
  if (value.hint) lines.push('下一步：' + value.hint)
  return [text(lines.join('\n'))]
}

function renderInventoryCheck(_args, value) {
  if (value?.error) {
    const lines = ['复核没成：' + value.error]
    if (value?.hint) lines.push(value.hint)
    return [text(lines.join('\n'))]
  }
  const lines = []
  if ((value?.checked ?? 0) === 0) {
    lines.push('陛下，' + (value?.hint || '台账里没有要复核的条目。'))
    return [text(lines.join('\n'))]
  }
  lines.push(
    '陛下，台账复核完毕（在用 ' +
      fmtCount(value.checked ?? 0) +
      ' 条）：正常 ' +
      fmtCount(value.okCount ?? 0) +
      ' 条 · 记录有但已不在 ' +
      fmtCount(value.missingCount ?? 0) +
      ' 条 · 引用残留 ' +
      fmtCount(value.residueCount ?? 0) +
      ' 处。',
  )
  const missing = Array.isArray(value.missing) ? value.missing : []
  if (missing.length > 0) {
    lines.push('【记录有但已不在】')
    for (const item of missing.slice(0, 10)) {
      lines.push('  • ' + item.name + '（' + (item.path || '未填路径') + '）')
      lines.push('      ' + item.detail)
    }
    if (missing.length > 10) lines.push('  … 另有 ' + (missing.length - 10) + ' 条')
  }
  const residue = Array.isArray(value.residue) ? value.residue : []
  if (residue.length > 0) {
    lines.push('【引用残留】')
    for (const item of residue.slice(0, 12)) lines.push('  • ' + item.name + ' ← ' + item.refKind + '：' + item.detail)
    if (residue.length > 12) lines.push('  … 另有 ' + (residue.length - 12) + ' 处')
  }
  const okRows = Array.isArray(value.ok) ? value.ok : []
  if (okRows.length > 0) {
    lines.push('【正常】')
    for (const item of okRows.slice(0, 6)) lines.push('  • ' + item.name + '：' + item.detail)
    if (okRows.length > 6) lines.push('  … 另有 ' + (okRows.length - 6) + ' 条')
  }
  if ((value?.staleMarked ?? 0) > 0) lines.push('已把 ' + fmtCount(value.staleMarked) + ' 条标记为待核对（只改台账，没删记录）。')
  if ((value?.removedMarked ?? 0) > 0) lines.push('已把 ' + fmtCount(value.removedMarked) + ' 条标记为已卸载（历史保留）。')
  if ((value?.staleMarked ?? 0) === 0 && (value?.removedMarked ?? 0) === 0) lines.push('台账没有需要改动的标记。')
  if (value?.hint) lines.push('下一步：' + value.hint)
  return [text(lines.join('\n'))]
}

// ───────────────────────────── 台账：schema 与参数 ─────────────────────────────

const inventoryRefItemSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    detail: { type: 'string' },
  },
  required: ['name', 'detail'],
  additionalProperties: false,
}

const inventoryRefsSchema = {
  type: 'object',
  properties: {
    services: { type: 'array', items: inventoryRefItemSchema },
    startup: { type: 'array', items: inventoryRefItemSchema },
    tasks: { type: 'array', items: inventoryRefItemSchema },
    shortcuts: { type: 'array', items: inventoryRefItemSchema },
    pathEntries: { type: 'array', items: inventoryRefItemSchema },
    registryKeys: { type: 'array', items: inventoryRefItemSchema },
  },
  required: ['services', 'startup', 'tasks', 'shortcuts', 'pathEntries', 'registryKeys'],
  additionalProperties: false,
}

const inventoryEntrySchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    kind: { type: 'string' },
    path: { type: 'string' },
    version: { type: 'string' },
    source: { type: 'string' },
    uninstallCmd: { type: 'string' },
    installedAt: { type: 'string' },
    updatedAt: { type: 'string' },
    dataDirs: { type: 'array', items: { type: 'string' } },
    refs: inventoryRefsSchema,
    notes: { type: 'string' },
    status: { type: 'string' },
    removedAt: { type: 'string' },
    stale: { type: 'boolean' },
  },
  required: [
    'id',
    'name',
    'kind',
    'path',
    'version',
    'source',
    'uninstallCmd',
    'installedAt',
    'updatedAt',
    'dataDirs',
    'refs',
    'notes',
    'status',
    'removedAt',
    'stale',
  ],
  additionalProperties: false,
}

const inventoryAddSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    created: { type: 'boolean' },
    id: { type: 'string' },
    entry: inventoryEntrySchema,
    refsScanned: { type: 'boolean' },
    refCount: { type: 'integer' },
    total: { type: 'integer' },
    inventoryFile: { type: 'string' },
    markdownFile: { type: 'string' },
    error: { type: 'string' },
    hint: { type: 'string' },
    code: { type: 'string' },
  },
  required: [
    'ok',
    'created',
    'id',
    'entry',
    'refsScanned',
    'refCount',
    'total',
    'inventoryFile',
    'markdownFile',
    'error',
    'hint',
  ],
  additionalProperties: false,
}

const inventoryAddParameters = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Display name; acts as the natural key. Passing an existing name updates that entry.' },
    kind: {
      type: 'string',
      enum: ['installer', 'portable', 'dsh-plugin', 'dev-tool'],
      description: 'installer (with uninstaller) | portable (no uninstaller) | dsh-plugin (DSH bundle) | dev-tool.',
    },
    path: { type: 'string', description: 'Install directory or main executable (absolute path, must exist).' },
    version: { type: 'string', description: 'Version string, if known.' },
    source: { type: 'string', description: 'Where it came from (URL / store / download page).' },
    uninstallCmd: { type: 'string', description: 'Uninstall command or path to the uninstaller, if known.' },
    dataDirs: {
      type: 'array',
      items: { type: 'string' },
      description: 'Extra data/config directories to remember for later cleanup (AppData, saves, plugin data dirs).',
    },
    notes: { type: 'string', description: 'Free-form note.' },
    scanRefs: {
      type: 'boolean',
      description:
        'Also scan services / startup / scheduled tasks / shortcuts / PATH / registry keys that reference the path and store them in the entry. Default true (takes a few seconds).',
    },
  },
  required: ['name', 'kind', 'path'],
  additionalProperties: false,
}

const inventoryListSchema = {
  type: 'object',
  properties: {
    storeDir: { type: 'string' },
    total: { type: 'integer' },
    shown: { type: 'integer' },
    omitted: { type: 'integer' },
    activeCount: { type: 'integer' },
    removedCount: { type: 'integer' },
    staleCount: { type: 'integer' },
    storeBytes: { type: 'integer' },
    entries: { type: 'array', items: inventoryEntrySchema },
    inventoryFile: { type: 'string' },
    error: { type: 'string' },
    hint: { type: 'string' },
    code: { type: 'string' },
  },
  required: [
    'storeDir',
    'total',
    'shown',
    'omitted',
    'activeCount',
    'removedCount',
    'staleCount',
    'storeBytes',
    'entries',
    'inventoryFile',
    'error',
    'hint',
  ],
  additionalProperties: false,
}

const inventoryListParameters = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['installer', 'portable', 'dsh-plugin', 'dev-tool'],
      description: 'Only list entries of this kind.',
    },
    status: {
      type: 'string',
      enum: ['active', 'removed', 'all'],
      description: 'active (default: still installed) | removed (history) | all.',
    },
    limit: { type: 'integer', description: 'Max entries to return, 1-200. Default 20.' },
  },
  additionalProperties: false,
}

const planUninstallDataDirSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    exists: { type: 'boolean' },
    bytes: { type: 'integer' },
    files: { type: 'integer' },
    truncated: { type: 'boolean' },
  },
  required: ['path', 'exists', 'bytes', 'files', 'truncated'],
  additionalProperties: false,
}

const planUninstallProcessSchema = {
  type: 'object',
  properties: {
    pid: { type: 'integer' },
    name: { type: 'string' },
    path: { type: 'string' },
  },
  required: ['pid', 'name', 'path'],
  additionalProperties: false,
}

const planUninstallLockSchema = {
  type: 'object',
  properties: {
    process: { type: 'string' },
    pid: { type: 'integer' },
  },
  required: ['process', 'pid'],
  additionalProperties: false,
}

const planUninstallSchema = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    query: { type: 'string' },
    matches: { type: 'integer' },
    entry: inventoryEntrySchema,
    targetExists: { type: 'boolean' },
    targetBytes: { type: 'integer' },
    targetFiles: { type: 'integer' },
    targetTruncated: { type: 'boolean' },
    refs: inventoryRefsSchema,
    refCount: { type: 'integer' },
    refsScanned: { type: 'boolean' },
    refsSource: { type: 'string' },
    dataDirs: { type: 'array', items: planUninstallDataDirSchema },
    dataBytes: { type: 'integer' },
    processes: { type: 'array', items: planUninstallProcessSchema },
    locks: { type: 'array', items: planUninstallLockSchema },
    locksChecked: { type: 'boolean' },
    redlineNotes: { type: 'array', items: { type: 'string' } },
    steps: { type: 'array', items: { type: 'string' } },
    removesNothing: { type: 'boolean' },
    notice: { type: 'string' },
    inventoryFile: { type: 'string' },
    error: { type: 'string' },
    hint: { type: 'string' },
    code: { type: 'string' },
  },
  required: [
    'found',
    'query',
    'matches',
    'entry',
    'targetExists',
    'targetBytes',
    'targetFiles',
    'targetTruncated',
    'refs',
    'refCount',
    'refsScanned',
    'refsSource',
    'dataDirs',
    'dataBytes',
    'processes',
    'locks',
    'locksChecked',
    'redlineNotes',
    'steps',
    'removesNothing',
    'notice',
    'inventoryFile',
    'error',
    'hint',
  ],
  additionalProperties: false,
}

const planUninstallParameters = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Ledger entry name or id to preview.' },
    path: { type: 'string', description: 'Install path (or a fragment of it) to preview.' },
    scanRefs: {
      type: 'boolean',
      description:
        'Re-scan services / startup / scheduled tasks / shortcuts / PATH / registry now. Default true; false falls back to the refs stored in the ledger.',
    },
    locks: {
      type: 'boolean',
      description: 'Also use Sysinternals handle64 (if present) to find processes holding files open. Slower.',
    },
  },
  additionalProperties: false,
}

const inventoryCheckMissingSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    kind: { type: 'string' },
    path: { type: 'string' },
    detail: { type: 'string' },
  },
  required: ['id', 'name', 'kind', 'path', 'detail'],
  additionalProperties: false,
}

const inventoryCheckResidueSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    refKind: { type: 'string' },
    detail: { type: 'string' },
  },
  required: ['id', 'name', 'refKind', 'detail'],
  additionalProperties: false,
}

const inventoryCheckOkSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    detail: { type: 'string' },
  },
  required: ['id', 'name', 'detail'],
  additionalProperties: false,
}

const inventoryCheckSchema = {
  type: 'object',
  properties: {
    checked: { type: 'integer' },
    missingCount: { type: 'integer' },
    residueCount: { type: 'integer' },
    okCount: { type: 'integer' },
    missing: { type: 'array', items: inventoryCheckMissingSchema },
    residue: { type: 'array', items: inventoryCheckResidueSchema },
    ok: { type: 'array', items: inventoryCheckOkSchema },
    staleMarked: { type: 'integer' },
    removedMarked: { type: 'integer' },
    probes: { type: 'integer' },
    inventoryFile: { type: 'string' },
    markdownFile: { type: 'string' },
    error: { type: 'string' },
    hint: { type: 'string' },
    code: { type: 'string' },
  },
  required: [
    'checked',
    'missingCount',
    'residueCount',
    'okCount',
    'missing',
    'residue',
    'ok',
    'staleMarked',
    'removedMarked',
    'probes',
    'inventoryFile',
    'markdownFile',
    'error',
    'hint',
  ],
  additionalProperties: false,
}

const inventoryCheckParameters = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Only check one entry (name / id / path fragment). Default: every active entry.' },
    markStale: {
      type: 'boolean',
      description: 'Mark entries whose path (and data dirs) vanished as stale=true in the ledger. Default true; only inventory.json changes.',
    },
    markRemoved: {
      type: 'boolean',
      description:
        'Also move entries whose path and data dirs are gone, with no leftover references, to status=removed (kept as history). Default false — confirm first.',
    },
    scanRefs: {
      type: 'boolean',
      description: 'Re-scan the six reference kinds for vanished paths. Default true; false is faster but may miss leftover references.',
    },
  },
  additionalProperties: false,
}

// ───────────────────────────── 工具注册 ─────────────────────────────

export function apply(ctx, config) {
  const store = storeLocation(config?.storeDir)
  const guard = protectedDirs(config)
  const tools = ctx.tools

  const scanSchema = {
    type: 'object',
    properties: {
      drives: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            letter: { type: 'string' },
            freeBytes: { type: 'integer' },
            totalBytes: { type: 'integer' },
          },
          required: ['letter', 'freeBytes', 'totalBytes'],
          additionalProperties: false,
        },
      },
      cleanableBytes: { type: 'integer' },
      safeBytes: { type: 'integer' },
      cautiousBytes: { type: 'integer' },
      adminBytes: { type: 'integer' },
      cleanableItems: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            path: { type: 'string' },
            bytes: { type: 'integer' },
            files: { type: 'integer' },
            policy: { type: 'string' },
            truncated: { type: 'boolean' },
          },
          required: ['id', 'label', 'path', 'bytes', 'files', 'policy', 'truncated'],
          additionalProperties: false,
        },
      },
      scattered: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            path: { type: 'string' },
            files: { type: 'integer' },
            bytes: { type: 'integer' },
            topExts: { type: 'array', items: { type: 'string' } },
          },
          required: ['label', 'path', 'files', 'bytes', 'topExts'],
          additionalProperties: false,
        },
      },
      notes: { type: 'array', items: { type: 'string' } },
      topDirs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            drive: { type: 'string' },
            name: { type: 'string' },
            path: { type: 'string' },
            bytes: { type: 'integer' },
            files: { type: 'integer' },
            measured: { type: 'boolean' },
            truncated: { type: 'boolean' },
          },
          required: ['drive', 'name', 'path', 'bytes', 'files', 'measured', 'truncated'],
          additionalProperties: false,
        },
      },
      inspect: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          bytes: { type: 'integer' },
          files: { type: 'integer' },
          dirs: { type: 'integer' },
          topTypes: {
            type: 'array',
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, files: { type: 'integer' }, bytes: { type: 'integer' } },
              required: ['label', 'files', 'bytes'],
              additionalProperties: false,
            },
          },
          references: {
            type: 'array',
            items: {
              type: 'object',
              properties: { kind: { type: 'string' }, name: { type: 'string' }, detail: { type: 'string' } },
              required: ['kind', 'name', 'detail'],
              additionalProperties: false,
            },
          },
          processes: {
            type: 'array',
            items: {
              type: 'object',
              properties: { pid: { type: 'integer' }, name: { type: 'string' }, path: { type: 'string' } },
              required: ['pid', 'name', 'path'],
              additionalProperties: false,
            },
          },
          locks: {
            type: 'array',
            items: {
              type: 'object',
              properties: { process: { type: 'string' }, pid: { type: 'integer' } },
              required: ['process', 'pid'],
              additionalProperties: false,
            },
          },
          locksChecked: { type: 'boolean' },
          markers: { type: 'array', items: { type: 'string' } },
          verdict: { type: 'string' },
          reason: { type: 'string' },
        },
        required: [
          'path',
          'bytes',
          'files',
          'dirs',
          'topTypes',
          'references',
          'processes',
          'locks',
          'locksChecked',
          'markers',
          'verdict',
          'reason',
        ],
        additionalProperties: false,
      },
      health: {
        type: 'object',
        properties: {
          errors7d: { type: 'integer' },
          bootMs: { type: 'integer' },
          autoNotRunning: { type: 'integer' },
          installedApps: { type: 'integer' },
          uptimeHours: { type: 'number' },
        },
        required: ['errors7d', 'bootMs', 'autoNotRunning', 'installedApps', 'uptimeHours'],
        additionalProperties: false,
      },
      residue: {
        type: 'object',
        properties: {
          deadPath: { type: 'array', items: { type: 'string' } },
          ghostServices: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, path: { type: 'string' } },
              required: ['name', 'path'],
              additionalProperties: false,
            },
          },
          deadStartup: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, command: { type: 'string' } },
              required: ['name', 'command'],
              additionalProperties: false,
            },
          },
          deadTasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: { task: { type: 'string' }, execute: { type: 'string' } },
              required: ['task', 'execute'],
              additionalProperties: false,
            },
          },
        },
        required: ['deadPath', 'ghostServices', 'deadStartup', 'deadTasks'],
        additionalProperties: false,
      },
      events: {
        type: 'object',
        properties: {
          systemTotal: { type: 'integer' },
          appTotal: { type: 'integer' },
          systemTop: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                source: { type: 'string' },
                id: { type: 'integer' },
                count: { type: 'integer' },
                sample: { type: 'string' },
                note: { type: 'string' },
              },
              required: ['source', 'id', 'count', 'sample', 'note'],
              additionalProperties: false,
            },
          },
          appTop: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                source: { type: 'string' },
                id: { type: 'integer' },
                count: { type: 'integer' },
                sample: { type: 'string' },
                note: { type: 'string' },
              },
              required: ['source', 'id', 'count', 'sample', 'note'],
              additionalProperties: false,
            },
          },
        },
        required: ['systemTotal', 'appTotal', 'systemTop', 'appTop'],
        additionalProperties: false,
      },
      hint: { type: 'string' },
    },
    required: [
      'drives',
      'cleanableBytes',
      'safeBytes',
      'cautiousBytes',
      'adminBytes',
      'cleanableItems',
      'scattered',
      'notes',
      'topDirs',
      'inspect',
      'health',
      'residue',
      'events',
      'hint',
    ],
    additionalProperties: false,
  }

  ctx.effect(() =>
    tools.register({
      name: 'tidy_scan',
      description:
        'Take inventory of C:/D: drives: how much space known-safe junk occupies (temp files, update cache, crash dumps, recycle bins), plus how many loose files sit on Desktop/Downloads/Documents. Read-only; changes nothing.',
      parameters: {
        type: 'object',
        properties: {
          drive: { type: 'string', enum: ['both', 'c', 'd'], description: 'Which drives to report. Default both.' },
          topLevel: {
            type: 'boolean',
            description:
              'Also measure every top-level directory of the selected drives (bounded walk) and rank them by size. Default false.',
          },
          path: {
            type: 'string',
            description:
              'Deep-inspect one directory: size composition, system references (services/startup/tasks/start-menu), running processes, markers and a move-safety verdict. Nothing is changed.',
          },
          locks: {
            type: 'boolean',
            description: 'For path inspection: also use Sysinternals handle64 (if present) to find who holds files open. Slower.',
          },
          health: {
            type: 'boolean',
            description:
              'Also run a read-only system health check: 7-day error count, boot duration, auto-start services not running, installed program count, uptime.',
          },
          residue: {
            type: 'boolean',
            description:
              'Also scan for application leftovers (read-only): dead PATH entries, ghost services, dead startup entries, dead scheduled tasks.',
          },
          events: {
            type: 'boolean',
            description:
              'Also summarize recent event-log errors (read-only): top groups by source + event id for System and Application logs, with a noise verdict.',
          },
          days: { type: 'integer', description: 'For events: how many days back to scan. Default 7.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: scanSchema,
        render(_args, value) {
          const lines = []
          const items = Array.isArray(value?.cleanableItems) ? value.cleanableItems : []
          const scattered = Array.isArray(value?.scattered) ? value.scattered : []
          lines.push(
            `陛下，盘点完毕：可清 ${fmtSize(value?.cleanableBytes ?? 0)}（安全项 ${fmtSize(value?.safeBytes ?? 0)}${
              (value?.cautiousBytes ?? 0) > 0 ? ` / 谨慎项 ${fmtSize(value.cautiousBytes)}` : ''
            }）。`,
          )
          if (items.length > 0) {
            lines.push('【可清】')
            for (const item of items.slice(0, 8)) {
              const suffix = item.truncated ? '（超大，只量了一部分）' : ''
              lines.push(`  • ${item.label} ${fmtSize(item.bytes)}（${fmtCount(item.files)} 个文件）${suffix}`)
            }
            if (items.length > 8) lines.push(`  … 另有 ${items.length - 8} 项，用 tidy_status 或 tidy_plan 看全`)
          } else {
            lines.push('【可清】（没有）')
          }
          if (scattered.length > 0) {
            lines.push('【散乱】')
            for (const spot of scattered.slice(0, 6)) {
              const exts = Array.isArray(spot.topExts) && spot.topExts.length > 0 ? `（${spot.topExts.join(' ')}）` : ''
              lines.push(`  • ${spot.label} ${fmtCount(spot.files)} 个文件 ${fmtSize(spot.bytes)}${exts}`)
            }
          }
          const drives = Array.isArray(value?.drives) ? value.drives : []
          if (drives.length > 0) {
            lines.push(`【余量】${drives.map((d) => `${d.letter} 剩 ${fmtSize(d.freeBytes)} / ${fmtSize(d.totalBytes)}`).join(' · ')}`)
          }
          const topDirs = Array.isArray(value?.topDirs) ? value.topDirs : []
          if (topDirs.length > 0) {
            lines.push('【整体】（按体量排）')
            for (const item of topDirs.slice(0, 12)) {
              if (!item.measured) {
                lines.push(`  ${item.drive}: ${item.name}  未量`)
                continue
              }
              const tag = item.truncated ? '（未量全）' : ''
              lines.push(`  ${item.drive}: ${item.name}  ${fmtSize(item.bytes)}  ${fmtCount(item.files)} 个文件${tag}`)
            }
            if (topDirs.length > 12) lines.push(`  … 另有 ${topDirs.length - 12} 个目录`)
          }
          const notes = Array.isArray(value?.notes) ? value.notes : []
          for (const note of notes.slice(0, 3)) lines.push(`【提示】${note}`)
          const inspect = value?.inspect
          if (inspect && inspect.path) {
            const verdictLabel =
              inspect.verdict === 'safe'
                ? '可动'
                : inspect.verdict === 'forbidden'
                  ? '勿动'
                  : inspect.verdict === 'missing'
                    ? '路径不存在'
                    : '需谨慎'
            lines.push(`【探查】${inspect.path}`)
            lines.push(`  结论：${verdictLabel} — ${inspect.reason}`)
            if (inspect.files > 0) {
              lines.push(`  体量：${fmtSize(inspect.bytes)} / ${fmtCount(inspect.files)} 个文件 / ${fmtCount(inspect.dirs)} 个子目录`)
            }
            const types = Array.isArray(inspect.topTypes) ? inspect.topTypes : []
            if (types.length > 0) {
              lines.push(`  构成：${types.slice(0, 5).map((item) => `${item.label} ${fmtSize(item.bytes)}`).join(' · ')}`)
            }
            const refs = Array.isArray(inspect.references) ? inspect.references : []
            for (const ref of refs.slice(0, 5)) lines.push(`  引用：${ref.kind} · ${ref.name}`)
            if (refs.length > 5) lines.push(`  … 另有 ${refs.length - 5} 条引用`)
            const procs = Array.isArray(inspect.processes) ? inspect.processes : []
            for (const proc of procs.slice(0, 5)) lines.push(`  运行中：${proc.name} (pid ${proc.pid})`)
            const locks = Array.isArray(inspect.locks) ? inspect.locks : []
            if (inspect.locksChecked) {
              if (locks.length === 0) lines.push('  占用：无')
              else for (const lock of locks.slice(0, 5)) lines.push(`  占用：${lock.process} (pid ${lock.pid})`)
            }
            const markers = Array.isArray(inspect.markers) ? inspect.markers : []
            if (markers.length > 0) lines.push(`  特征：${markers.join('、')}`)
          }
          if (_args && _args.health && value?.health) {
            const h = value.health
            lines.push(
              `【体检】7 天系统错误 ${fmtCount(h.errors7d)} 条 · 已装软件 ${fmtCount(h.installedApps)} 个 · 自启未运行 ${fmtCount(h.autoNotRunning)} 个 · 本次开机 ${h.uptimeHours} 小时`,
            )
            if (h.bootMs > 0) lines.push(`  上次开机耗时：${(h.bootMs / 1000).toFixed(1)} 秒`)
          }
          if (_args && _args.residue && value?.residue) {
            const r = value.residue
            const total = r.deadPath.length + r.ghostServices.length + r.deadStartup.length + r.deadTasks.length
            lines.push(
              `【残留】共 ${fmtCount(total)} 处：幽灵服务 ${r.ghostServices.length} · 失效自启 ${r.deadStartup.length} · 失效计划任务 ${r.deadTasks.length} · 失效 PATH ${r.deadPath.length}`,
            )
            for (const svc of r.ghostServices.slice(0, 5)) lines.push(`  幽灵服务：${svc.name}`)
            for (const task of r.deadTasks.slice(0, 5)) lines.push(`  失效任务：${task.task}`)
            for (const item of r.deadPath.slice(0, 3)) lines.push(`  失效 PATH：${item}`)
            if (total === 0) lines.push('  没有发现残留，干净。')
          }
          if (_args && _args.events && value?.events) {
            const ev = value.events
            lines.push(`【事件】系统错误 ${fmtCount(ev.systemTotal)} 条 · 应用错误 ${fmtCount(ev.appTotal)} 条（近 ${_args.days || 7} 天）`)
            for (const item of ev.systemTop.slice(0, 4)) {
              const tag = item.note ? ` · ${item.note}` : ''
              lines.push(`  系统 ${fmtCount(item.count)}× ${item.source} [${item.id}]${tag}`)
            }
            for (const item of ev.appTop.slice(0, 3)) {
              const tag = item.note ? ` · ${item.note}` : ''
              lines.push(`  应用 ${fmtCount(item.count)}× ${item.source} [${item.id}]${tag}`)
            }
            if (ev.systemTotal === 0 && ev.appTotal === 0) lines.push('  没有错误事件，清爽。')
          }
          if (value?.hint) lines.push(`下一步：${value.hint}`)
          return [text(lines.join('\n'))]
        },
      },
      async execute(args) {
        return doScan(config, args || {}, guard, store)
      },
    }),
  )

  const planSchema = {
    type: 'object',
    properties: {
      kind: { type: 'string' },
      target: { type: 'string' },
      rule: { type: 'string' },
      totalFiles: { type: 'integer' },
      totalBytes: { type: 'integer' },
      groups: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            folder: { type: 'string' },
            files: { type: 'integer' },
            bytes: { type: 'integer' },
          },
          required: ['label', 'folder', 'files', 'bytes'],
          additionalProperties: false,
        },
      },
      preview: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            size: { type: 'string' },
            to: { type: 'string' },
          },
          required: ['name', 'size', 'to'],
          additionalProperties: false,
        },
      },
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            path: { type: 'string' },
            size: { type: 'integer' },
            files: { type: 'integer' },
            measured: { type: 'boolean' },
            truncated: { type: 'boolean' },
          },
          required: ['name', 'path', 'size', 'files', 'measured', 'truncated'],
          additionalProperties: false,
        },
      },
      renames: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            path: { type: 'string' },
            size: { type: 'string' },
            ok: { type: 'boolean' },
            note: { type: 'string' },
          },
          required: ['from', 'to', 'path', 'size', 'ok', 'note'],
          additionalProperties: false,
        },
      },
      dupeGroups: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            hash: { type: 'string' },
            size: { type: 'integer' },
            files: { type: 'array', items: { type: 'string' } },
          },
          required: ['hash', 'size', 'files'],
          additionalProperties: false,
        },
      },
      residueItems: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string' },
            name: { type: 'string' },
            scope: { type: 'string' },
          },
          required: ['kind', 'name', 'scope'],
          additionalProperties: false,
        },
      },
      omitted: { type: 'integer' },
      truncated: { type: 'boolean' },
      hint: { type: 'string' },
      code: { type: 'string' },
    },
    required: [
      'kind',
      'target',
      'rule',
      'totalFiles',
      'totalBytes',
      'groups',
      'preview',
      'candidates',
      'renames',
      'dupeGroups',
      'residueItems',
      'omitted',
      'truncated',
      'hint',
    ],
    additionalProperties: false,
  }

  ctx.effect(() =>
    tools.register({
      name: 'tidy_plan',
      description:
        'Build a read-only plan for one folder: classify files by type or month (kind=organize), list subdirectories that could be merged into archive folders (kind=folders), or validate proposed new file names (kind=rename). Nothing is moved. Use before tidy_apply.',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['organize', 'clean', 'folders', 'rename', 'empty', 'dupes', 'residue'],
            description:
              'organize (default), clean (junk only), folders (list subdirectories to merge), rename (validate new file names), empty (find empty directories), dupes (find duplicate files), residue (user-level leftovers that can be removed).',
          },
          target: { type: 'string', description: 'Folder to organize, or the parent folder for kind=folders.' },
          rule: { type: 'string', enum: ['by-type', 'by-date'], description: 'Classification rule. Default by-type.' },
          subfolders: { type: 'boolean', description: 'Include subfolders (up to 3 levels). Default false.' },
          limit: { type: 'integer', description: 'Preview rows to return, 1-60. Default 15.' },
          targets: { type: 'array', items: { type: 'string' }, description: 'For clean: junk ids to include (e.g. recycle-c).' },
          renames: {
            type: 'array',
            description: 'For kind=rename: [{ path, name }] — the file and its new English basename.',
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, name: { type: 'string' } },
              required: ['path', 'name'],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: planSchema,
        render(_args, value) {
          const lines = []
          const groups = Array.isArray(value?.groups) ? value.groups : []
          if (value?.kind === 'folders') {
            const candidates = Array.isArray(value?.candidates) ? value.candidates : []
            lines.push(
              `陛下，目录归并候选（${value?.target || '（未指定）'}）：共 ${fmtCount(value?.totalFiles ?? 0)} 个子目录，合计 ${fmtSize(value?.totalBytes ?? 0)}。`,
            )
            for (const row of candidates.slice(0, 15)) {
              if (!row.measured) {
                lines.push(`  • ${row.name}  未量（本次没轮到，可单独指定目录再看）`)
                continue
              }
              const tag = row.truncated ? '（体积未量全）' : ''
              lines.push(`  • ${row.name}  ${fmtSize(row.size)}  ${fmtCount(row.files)} 个文件${tag}`)
            }
            if ((value?.omitted ?? 0) > 0) lines.push(`  … 还有 ${fmtCount(value.omitted)} 个未列出`)
          } else if (value?.kind === 'rename') {
            const rows = Array.isArray(value?.renames) ? value.renames : []
            lines.push(`陛下，改名预览：${fmtCount(value?.totalFiles ?? 0)} 个文件可改。`)
            for (const row of rows.slice(0, 15)) {
              if (row.ok) lines.push(`  ${row.from}  →  ${row.to}`)
              else lines.push(`  ${row.from}  ✗ ${row.note}`)
            }
            if (rows.length > 15) lines.push(`  … 另有 ${rows.length - 15} 条`)
          } else if (value?.kind === 'empty') {
            const candidates = Array.isArray(value?.candidates) ? value.candidates : []
            lines.push(`陛下，空目录清理方案（${value?.target || ''}）：共 ${fmtCount(value?.totalFiles ?? 0)} 个空目录。`)
            for (const row of candidates.slice(0, 15)) lines.push(`  • ${row.path}`)
            if ((value?.omitted ?? 0) > 0) lines.push(`  … 还有 ${fmtCount(value.omitted)} 个`)
          } else if (value?.kind === 'dupes') {
            const groups = Array.isArray(value?.dupeGroups) ? value.dupeGroups : []
            lines.push(
              `陛下，查重结果（${value?.target || ''}）：${fmtCount(groups.length)} 组重复，可回收 ${fmtSize(value?.totalBytes ?? 0)}。`,
            )
            for (const group of groups.slice(0, 8)) {
              lines.push(`  • ${fmtSize(group.size)} × ${group.files.length} 份`)
              for (const file of group.files.slice(0, 3)) lines.push(`      ${file}`)
            }
          } else if (value?.kind === 'residue') {
            const items = Array.isArray(value?.residueItems) ? value.residueItems : []
            const userItems = items.filter((item) => item.scope === 'user')
            const adminItems = items.filter((item) => item.scope === 'admin')
            lines.push(`陛下，残留清单：可直接移除 ${userItems.length} 条，需管理员 ${adminItems.length} 条。`)
            for (const item of userItems.slice(0, 12)) lines.push(`  • [可移除] ${item.kind} · ${item.name}`)
            for (const item of adminItems.slice(0, 8)) lines.push(`  • [需管理员] ${item.kind} · ${item.name}`)
            if (items.length > 20) lines.push(`  … 另有 ${items.length - 20} 条`)
          } else if (value?.kind === 'clean') {
            lines.push(`陛下，清理方案：${fmtCount(value?.totalFiles ?? 0)} 个文件，合计 ${fmtSize(value?.totalBytes ?? 0)}。`)
            for (const group of groups.slice(0, 8)) {
              lines.push(`  • ${group.label} ${fmtSize(group.bytes)}（${fmtCount(group.files)} 个文件）· ${group.folder}`)
            }
          } else {
            lines.push(
              `陛下，整理方案（${value?.rule === 'by-date' ? '按月份' : '按类型'} · ${value?.target || '（未指定目录）'}）：`,
            )
            if ((value?.totalFiles ?? 0) === 0) {
              lines.push('  这个目录没有需要整理的文件。')
            } else {
              lines.push(`  共 ${fmtCount(value.totalFiles)} 个文件，合计 ${fmtSize(value.totalBytes)}，归入 ${groups.length} 个文件夹。`)
              for (const group of groups.slice(0, 10)) {
                lines.push(`  • ${group.label}\\ ${fmtCount(group.files)} 个 · ${fmtSize(group.bytes)}`)
              }
              const preview = Array.isArray(value?.preview) ? value.preview : []
              if (preview.length > 0) {
                lines.push('【前几条】')
                for (const row of preview.slice(0, 10)) lines.push(`  ${row.name}  ${row.size}  →  ${row.to}`)
              }
              if ((value?.omitted ?? 0) > 0) lines.push(`  … 还有 ${fmtCount(value.omitted)} 个未列出`)
            }
          }
          if (value?.truncated) lines.push('  （文件太多，只算了一部分；可缩小目录或加参数分批做）')
          if (value?.hint) lines.push(`下一步：${value.hint}`)
          return [text(lines.join('\n'))]
        },
      },
      async execute(args) {
        const kind = args && args.kind
        let result
        if (kind === 'folders') result = doPlanFolders(args || {}, guard, store)
        else if (kind === 'rename') result = doPlanRename(args || {}, guard)
        else if (kind === 'empty') result = doPlanEmpty(args || {}, guard, store)
        else if (kind === 'dupes') result = doPlanDupes(args || {}, guard, store)
        else if (kind === 'residue') result = doPlanResidue(args || {}, guard, store)
        else result = doPlan(config, args || {}, guard, store)
        // 兜底补齐 schema 要求的所有数组字段，避免某个分支漏字段导致 invalid output
        return { candidates: [], renames: [], dupeGroups: [], residueItems: [], preview: [], groups: [], ...result }
      },
    }),
  )

  const applySchema = {
    type: 'object',
    properties: {
      applied: { type: 'boolean' },
      kind: { type: 'string' },
      moved: { type: 'integer' },
      deletedFiles: { type: 'integer' },
      freedBytes: { type: 'integer' },
      skipped: { type: 'integer' },
      errors: { type: 'array', items: { type: 'string' } },
      blockers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            kind: { type: 'string' },
            detail: { type: 'string' },
          },
          required: ['name', 'kind', 'detail'],
          additionalProperties: false,
        },
      },
      manifest: { type: 'string' },
      remaining: { type: 'integer' },
      hint: { type: 'string' },
      code: { type: 'string' },
    },
    required: [
      'applied',
      'kind',
      'moved',
      'deletedFiles',
      'freedBytes',
      'skipped',
      'errors',
      'blockers',
      'manifest',
      'remaining',
      'hint',
    ],
    additionalProperties: false,
  }

  ctx.effect(() =>
    tools.register({
      name: 'tidy_apply',
      description:
        'Execute a planned operation: kind=organize moves files into category folders; kind=folders merges whole directories into a destination; kind=rename applies new file names; kind=clean deletes only whitelisted temp locations (the only irreversible kind). All moves are recorded and reversible via tidy_undo. Requires confirm:true — never call it before the human approved the plan.',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['organize', 'clean', 'folders', 'rename', 'empty', 'dupes', 'residue'],
            description:
              'organize (default), clean, folders (merge whole directories), rename, empty (delete empty directories), dupes (move duplicate copies into quarantine), residue (remove user-level leftovers).',
          },
          target: { type: 'string', description: 'Folder to organize (organize only).' },
          rule: { type: 'string', enum: ['by-type', 'by-date'], description: 'Must match the plan.' },
          subfolders: { type: 'boolean', description: 'Must match the plan.' },
          conflict: { type: 'string', enum: ['rename', 'skip'], description: 'On name clash: rename (default) or skip.' },
          maxFiles: { type: 'integer', description: 'Per-run cap, 1-2000. Default 300.' },
          targets: { type: 'array', items: { type: 'string' }, description: 'For clean: junk ids to delete.' },
          items: {
            type: 'array',
            description: 'For kind=folders: [{ from: absolute source dir, into: absolute destination dir, name?: new folder name }].',
            items: {
              type: 'object',
              properties: { from: { type: 'string' }, into: { type: 'string' }, name: { type: 'string' } },
              required: ['from', 'into'],
              additionalProperties: false,
            },
          },
          renames: {
            type: 'array',
            description: 'For kind=rename: [{ path, name }] — the file and its new basename.',
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, name: { type: 'string' } },
              required: ['path', 'name'],
              additionalProperties: false,
            },
          },
          confirm: { type: 'boolean', description: 'Must be true. Only after the human approved the plan.' },
          force: {
            type: 'boolean',
            description:
              'For kind=folders: move even when services / startup entries / scheduled tasks / start-menu shortcuts still reference the folder. Default false — such folders are reported as blockers instead.',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: applySchema,
        render(_args, value) {
          if (!value?.applied) return [text(value?.hint || '未执行。')]
          const lines = []
          if (value?.kind === 'residue') {
            lines.push(`陛下，已移除用户级残留 ${fmtCount(value?.moved ?? 0)} 条。`)
            if (value?.manifest) lines.push(`  清单：${value.manifest}`)
          } else if (value?.kind === 'dupes') {
            lines.push(`陛下，已把 ${fmtCount(value?.moved ?? 0)} 份重复副本移入隔离区（共 ${fmtSize(value?.freedBytes ?? 0)}）。`)
            if (value?.manifest) lines.push(`  清单：${value.manifest}`)
          } else if (value?.kind === 'empty') {
            lines.push(`陛下，已清理 ${fmtCount(value?.moved ?? 0)} 个空目录。`)
            if ((value?.skipped ?? 0) > 0) lines.push(`  跳过 ${fmtCount(value.skipped)} 个（占用或权限不足）。`)
          } else if (value?.kind === 'clean') {
            lines.push(`陛下，已办妥：删除 ${fmtCount(value?.deletedFiles ?? 0)} 个临时文件，释放 ${fmtSize(value?.freedBytes ?? 0)}。`)
          } else if (value?.kind === 'folders') {
            lines.push(`陛下，已归并 ${fmtCount(value?.moved ?? 0)} 个目录，体量 ${fmtSize(value?.freedBytes ?? 0)}。`)
            if (value?.manifest) lines.push(`  清单：${value.manifest}`)
          } else if (value?.kind === 'rename') {
            lines.push(`陛下，已改名 ${fmtCount(value?.moved ?? 0)} 个文件。`)
            if (value?.manifest) lines.push(`  清单：${value.manifest}`)
          } else {
            lines.push(`陛下，已办妥：移动 ${fmtCount(value?.moved ?? 0)} 个文件，合计 ${fmtSize(value?.freedBytes ?? 0)} 归档。`)
            if (value?.manifest) lines.push(`  清单：${value.manifest}`)
          }
          if ((value?.skipped ?? 0) > 0) lines.push(`  跳过 ${fmtCount(value.skipped)} 个（占用中或重名）。`)
          const errors = Array.isArray(value?.errors) ? value.errors : []
          if (errors.length > 0) {
            lines.push('  未成的：')
            for (const error of errors.slice(0, 5)) lines.push(`    ${error}`)
            if (errors.length > 5) lines.push(`    … 另有 ${errors.length - 5} 条，用 tidy_status 看`)
          }
          const blockers = Array.isArray(value?.blockers) ? value.blockers : []
          if (blockers.length > 0) {
            lines.push('  被引用、臣没动：')
            for (const item of blockers.slice(0, 6)) lines.push(`    ${item.name} ← ${item.kind}：${item.detail}`)
            if (blockers.length > 6) lines.push(`    … 另有 ${blockers.length - 6} 条`)
          }
          if (value?.hint) lines.push(value.hint)
          return [text(lines.join('\n'))]
        },
      },
      async execute(args) {
        const kind = args && args.kind
        let result
        if (kind === 'folders') result = doApplyFolders(args || {}, guard, store)
        else if (kind === 'rename') result = doApplyRename(args || {}, guard, store)
        else if (kind === 'empty') result = doApplyEmpty(args || {}, guard, store)
        else if (kind === 'dupes') result = doApplyDupes(args || {}, guard, store)
        else if (kind === 'residue') result = doApplyResidue(args || {}, guard, store)
        else result = doApply(config, args || {}, guard, store)
        return { blockers: [], errors: [], ...result }
      },
    }),
  )

  const undoSchema = {
    type: 'object',
    properties: {
      applied: { type: 'boolean' },
      restored: { type: 'integer' },
      skipped: { type: 'integer' },
      errors: { type: 'array', items: { type: 'string' } },
      manifest: { type: 'string' },
      hint: { type: 'string' },
      code: { type: 'string' },
    },
    required: ['applied', 'restored', 'skipped', 'errors', 'manifest', 'hint'],
    additionalProperties: false,
  }

  ctx.effect(() =>
    tools.register({
      name: 'tidy_undo',
      description:
        'Undo the most recent organization run (or a named manifest) by moving files back. Only organize is reversible; clean deletes are permanent. Requires confirm:true.',
      parameters: {
        type: 'object',
        properties: {
          confirm: { type: 'boolean', description: 'Must be true.' },
          manifest: { type: 'string', description: 'Manifest file name, e.g. organize-20261027-184500.json. Default latest.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: undoSchema,
        render(_args, value) {
          if (!value?.applied) return [text(value?.hint || '未撤销。')]
          const lines = [`陛下，已还原：移回 ${fmtCount(value?.restored ?? 0)} 个文件。`]
          if ((value?.skipped ?? 0) > 0) lines.push(`  跳过 ${fmtCount(value.skipped)} 个。`)
          const errors = Array.isArray(value?.errors) ? value.errors : []
          for (const error of errors.slice(0, 5)) lines.push(`  ${error}`)
          if (value?.hint) lines.push(value.hint)
          return [text(lines.join('\n'))]
        },
      },
      async execute(args) {
        return doUndo(store, args || {})
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'tidy_status',
      description: 'Diagnostics for the tidy plugin: data dir, manifest count, last apply/undo, protection count, limits.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            ready: { type: 'boolean' },
            unavailableReason: { type: 'string' },
            storeDir: { type: 'string' },
            manifests: { type: 'integer' },
            lastApply: { type: 'string' },
            lastUndo: { type: 'string' },
            logEntries: { type: 'integer' },
            protectCount: { type: 'integer' },
            limits: { type: 'string' },
            notices: { type: 'array', items: { type: 'string' } },
            inventoryEntries: { type: 'integer' },
            inventoryActive: { type: 'integer' },
            inventoryRemoved: { type: 'integer' },
            inventoryStale: { type: 'integer' },
          },
          required: [
            'ready',
            'storeDir',
            'manifests',
            'lastApply',
            'lastUndo',
            'logEntries',
            'protectCount',
            'limits',
            'notices',
            'inventoryEntries',
            'inventoryActive',
            'inventoryRemoved',
            'inventoryStale',
          ],
          additionalProperties: false,
        },
        render(_args, value) {
          const lines = [
            `整理记录：${fmtCount(value?.manifests ?? 0)} 份 · 流水 ${fmtCount(value?.logEntries ?? 0)} 条`,
            `数据目录：${value?.storeDir ?? '?'}`,
            `上次操作：${value?.lastApply || '（还没有）'}`,
            `红线目录：${fmtCount(value?.protectCount ?? 0)} 个（系统目录、插件源码、学习空间等）`,
            `台账：${fmtCount(value?.inventoryEntries ?? 0)} 条（在用 ${fmtCount(value?.inventoryActive ?? 0)} · 已卸载 ${fmtCount(value?.inventoryRemoved ?? 0)} · 待核对 ${fmtCount(value?.inventoryStale ?? 0)}）`,
            `限额：${value?.limits ?? '—'}`,
          ]
          for (const notice of Array.isArray(value?.notices) ? value.notices : []) lines.push(notice)
          if (value?.ready === false) lines.unshift(`不可用：${value?.unavailableReason || '未知原因'}`)
          return [text(lines.join('\n'))]
        },
      },
      async execute() {
        return doStatus(config, store, guard)
      },
    }),
  )

  // ── 安装 / 卸载台账：四个工具（只写 storeDir/inventory.json 与 inventory.md）

  ctx.effect(() =>
    tools.register({
      name: 'inventory_add',
      description:
        'Register one installed app/plugin in the uninstall ledger (inventory.json + inventory.md human view): name, kind, path, version, source, uninstall command, data dirs. Optionally scans services / startup / scheduled tasks / shortcuts / PATH / registry keys that reference the path, so it can be uninstalled cleanly months later.',
      parameters: inventoryAddParameters,
      output: {
        schema: inventoryAddSchema,
        render: renderInventoryAdd,
      },
      async execute(args) {
        return doInventoryAdd(args || {}, store)
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'inventory_list',
      description:
        'List uninstall-ledger entries (active by default; filter by kind/status). Read-only. Returns entry counts, the ledger location and a bounded size estimate of the plugin data directory.',
      parameters: inventoryListParameters,
      output: {
        schema: inventoryListSchema,
        render: renderInventoryList,
      },
      async execute(args) {
        return doInventoryList(args || {}, store)
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'plan_uninstall',
      description:
        'Read-only uninstall dry-run. Find the ledger entry by name or path, then report affected references (services / startup / scheduled tasks / shortcuts / PATH / registry keys), target and data-dir sizes, running processes, red-line warnings and suggested steps. Deletes nothing.',
      parameters: planUninstallParameters,
      output: {
        schema: planUninstallSchema,
        render: renderPlanUninstall,
      },
      async execute(args) {
        return doPlanUninstall(args || {}, store, guard)
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'inventory_check',
      description:
        'Read-only ledger reconcile: for every (or one) active entry, checks whether path and data dirs still exist and whether references are left behind. Splits results into missing / leftover-reference / ok. Can flag obviously gone entries as stale, or move confirmed ones to removed history (only inventory.json changes; records are never deleted).',
      parameters: inventoryCheckParameters,
      output: {
        schema: inventoryCheckSchema,
        render: renderInventoryCheck,
      },
      async execute(args) {
        return doInventoryCheck(args || {}, store)
      },
    }),
  )
}
