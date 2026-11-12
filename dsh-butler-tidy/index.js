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
import { text, MB, GB, fmtSize, fmtCount, pad2, stampOf, hhmmss } from './lib/format.js'
import { UNSAFE_PATH_PREFIX, isUnsafePath, hasReparsePoint, realPathOf, norm, isUnder, lockHint, storeLocation, protectedDirs, isProtected } from './lib/path-safety.js'
import { inventoryStats, doInventoryAdd, doInventoryList, doPlanUninstall, doInventoryCheck, renderInventoryAdd, renderInventoryList, renderPlanUninstall, renderInventoryCheck, inventoryAddSchema, inventoryAddParameters, inventoryListSchema, inventoryListParameters, planUninstallSchema, planUninstallParameters, inventoryCheckSchema, inventoryCheckParameters } from './lib/inventory.js'
import { detectDependencies, inspectTarget, probeHealth, probeEvents, probeResidue } from './lib/probe.js'
import { doPlanResidue, doApplyResidue, runPowerShellJson } from './lib/residue.js'

export const name = 'dsh-butler-tidy'
export const inject = ['tools']

const SCAN_MAX_ENTRIES = 80000
const SCAN_DEADLINE_MS = 7000
const PLAN_MAX_FILES = 5000
const DEFAULT_MAX_APPLY = 300

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

// ───────────────────────────── 目录度量 ─────────────────────────────

/**
 * 度量目录大小（有界：条目数与时间双上限，避免扫全盘卡死）。
 * 符号链接一律不跟随，避免循环。
 */
export function measureDir(root, { maxEntries = SCAN_MAX_ENTRIES, deadlineMs = SCAN_DEADLINE_MS } = {}) {
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

function junkCatalog(extraDirs) {
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
    // 2026-11-12：内置项 = 管家职责白名单（trusted）。它们全是固定路径的系统垃圾区，
  // clean 时不再过红线复核；配置注入的 junkDirs 不标 trusted，仍过红线（防误配）。
  ].map((item) => ({ ...item, trusted: true }))

  // 配置注入的可清目录（2026-11-03）：id / path 必填，policy 只认 safe / cautious / admin。
  // 用于机器相关的自定义临时目录；默认 clean 只动 policy=safe 的项，点名要传 targets。
  if (Array.isArray(extraDirs)) {
    for (const item of extraDirs) {
      if (!item || typeof item !== 'object') continue
      const id = typeof item.id === 'string' ? item.id.trim() : ''
      const itemPath = typeof item.path === 'string' ? item.path.trim() : ''
      const policy = item.policy === 'cautious' || item.policy === 'admin' ? item.policy : 'safe'
      if (id === '' || itemPath === '') continue
      deletable.push({
        id,
        label: typeof item.label === 'string' && item.label.trim() !== '' ? item.label.trim() : itemPath,
        path: path.resolve(itemPath),
        policy,
        trusted: false,
      })
    }
  }

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

/** 移动文件或目录；跨卷时退回复制 + 删除。导出供单测验证「不静默覆盖」（2026-11-03 审计 T7）。 */
export function movePath(from, to) {
  // 注意：不能无条件 mkdir 父目录——目标是盘根（如 D:\）时 mkdirSync('D:\\') 会抛 EPERM
  const parent = path.dirname(to)
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
  // 2026-11-03 审计 T7：renameSync 会静默覆盖同名目标。方案期到执行期存在 TOCTOU 窗口
  //（同秒并发 / 外部程序刚写入），这里在真正移动前再判一次存在：命中即报 DEST_EXISTS，绝不覆盖。
  if (existsSync(to)) {
    const conflict = new Error('目标已存在，不覆盖')
    conflict.code = 'DEST_EXISTS'
    throw conflict
  }
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

export function appendLog(logFile, record) {
  try {
    mkdirSync(path.dirname(logFile), { recursive: true })
    writeFileSync(logFile, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' })
  } catch (error) {
    /* 日志失败不影响主流程 */
  }
}

/**
 * 写清单：临时文件 + rename 原子落位（2026-11-03 审计 T5）。
 * 直接 writeFileSync 写一半断电会留下半截 JSON；先写 `.tmp-<pid>` 再改名，
 * 读清单的一侧永远只会看到完整旧版或完整新版。
 */
function writeManifest(store, kind, payload) {
  mkdirSync(store.manifests, { recursive: true })
  const file = path.join(store.manifests, `${kind}-${stampOf()}.json`)
  const temp = `${file}.tmp-${process.pid}`
  try {
    writeFileSync(temp, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(temp, file)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch (ignored) {
      /* 临时文件删不掉不影响报错 */
    }
    throw error
  }
  return file
}

/** 清单写失败的统一出口：不把异常冒到工具层（那时文件已经动了，异常会丢掉「已移动」这个事实）。 */
export function tryWriteManifest(store, kind, payload) {
  try {
    return { file: writeManifest(store, kind, payload), error: '' }
  } catch (error) {
    return { file: '', error: lockHint(error) }
  }
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

  const catalog = junkCatalog(config?.junkDirs)
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
  let manifestError = ''
  if (records.length > 0) {
    const written = tryWriteManifest(store, 'folders', { at: new Date().toISOString(), moves: records })
    manifest = written.file
    manifestError = written.error
  }
  if (manifestError !== '') errors.push(`清单写失败：${manifestError}`)
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
    ...(manifestError !== '' ? { code: 'MANIFEST_WRITE_FAILED' } : {}),
    hint:
      manifestError !== ''
        ? `目录已归并 ${moved} 个，但清单写失败（${manifestError}）→ 这次无法用 tidy_undo 撤销，请人工核对。`
        : blockers.length > 0
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
  let manifestError = ''
  if (records.length > 0) {
    const written = tryWriteManifest(store, 'rename', { at: new Date().toISOString(), moves: records })
    manifest = written.file
    manifestError = written.error
  }
  if (manifestError !== '') errors.push(`清单写失败：${manifestError}`)
  appendLog(store.logFile, { at: new Date().toISOString(), kind: 'rename', moved, errors: errors.length })
  return {
    ...base,
    applied: true,
    moved,
    freedBytes: Math.round(bytes),
    skipped,
    errors,
    manifest,
    ...(manifestError !== '' ? { code: 'MANIFEST_WRITE_FAILED' } : {}),
    hint:
      manifestError !== ''
        ? `名字已改好 ${moved} 个，但清单写失败（${manifestError}）→ 这次无法用 tidy_undo 撤销，请人工核对。`
        : manifest
          ? '名字已改好，可 tidy_undo 撤回。'
          : '一个都没改成，看上面原因。',
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
    // 2026-11-03 审计 T6：``targets:[]`` 不能等价于「全删」。区分「没传」与「传了空数组」：
    // - 没传 targets：按默认策略（policy=safe）清理；
    // - 传了空数组：什么都不选 → EMPTY_TARGETS，不执行任何删除。
    const rawTargets = args && args.targets
    if (Array.isArray(rawTargets) && rawTargets.length === 0) {
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
        code: 'EMPTY_TARGETS',
        hint: 'targets 是空数组：这次一个都不删（空数组 ≠ 全选）。要清默认安全项就别传 targets；要清指定项请传具体 id。',
      }
    }
    const wanted = Array.isArray(rawTargets) ? rawTargets : undefined
    const catalog = junkCatalog(config?.junkDirs)
    const targets = catalog.deletable.filter((item) => {
      if (wanted) return wanted.includes(item.id) && item.policy !== 'admin'
      return item.policy === 'safe'
    })
    let deletedFiles = 0
    let freedBytes = 0
    let skipped = 0
    const errors = []
    // 2026-11-03 审计 T4：clean 原来不受 maxFiles 约束（实测一次 2321 个文件 / 675 MB，
    // README 却承诺 300）。这里把「条目数」也纳入上限：超过就截断，并如实回报剩余条数。
    const pending = []
    for (const item of targets) {
      if (!existsSync(item.path)) continue
      if (item.trusted !== true && isProtected(item.path, guard)) {
        skipped += 1
        errors.push(`${item.label}：在红线目录内，不清`)
        continue
      }
      let entries
      try {
        entries = readdirSync(item.path, { withFileTypes: true })
      } catch (error) {
        skipped += 1
        errors.push(`${item.label}：${lockHint(error)}`)
        continue
      }
      for (const entry of entries) pending.push({ item, entry })
    }
    let processed = 0
    for (let index = 0; index < pending.length; index += 1) {
      if (processed >= maxFiles) break
      const { item, entry } = pending[index]
      const full = path.join(item.path, entry.name)
      const before = entry.isDirectory() ? measureDir(full) : { bytes: safeSize(full), files: 1 }
      processed += 1
      try {
        rmSync(full, { recursive: true, force: true })
        deletedFiles += before.files
        freedBytes += before.bytes
      } catch (error) {
        skipped += 1
        if (errors.length < 8) errors.push(`${entry.name}：${lockHint(error)}`)
      }
    }
    const remaining = Math.max(0, pending.length - processed)
    appendLog(store.logFile, { at: new Date().toISOString(), kind, deletedFiles, freedBytes, skipped, remaining })
    return {
      applied: true,
      kind,
      moved: 0,
      deletedFiles,
      freedBytes: Math.round(freedBytes),
      skipped,
      errors,
      manifest: '',
      remaining,
      hint:
        remaining > 0
          ? `本次处理到上限 ${maxFiles} 条（删了 ${deletedFiles} 个文件），还有 ${remaining} 条未处理；再执行一次继续。`
          : skipped > 0
            ? '部分文件正被占用（多为正在运行的程序），关掉程序后可再清一次。'
            : '清理完成。',
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
  let manifestError = ''
  if (records.length > 0) {
    const written = tryWriteManifest(store, 'organize', {
      at: new Date().toISOString(),
      target: checked.resolved,
      rule,
      moves: records,
    })
    manifest = written.file
    manifestError = written.error
  }
  if (manifestError !== '') errors.push(`清单写失败：${manifestError}`)
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
    ...(manifestError !== '' ? { code: 'MANIFEST_WRITE_FAILED' } : {}),
    hint:
      manifestError !== ''
        ? `已移动 ${moved} 个文件，但清单写失败（${manifestError}）→ 这次无法用 tidy_undo 撤销，请人工核对。`
        : remaining > 0
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
  let manifestError = ''
  if (records.length > 0) {
    const written = tryWriteManifest(store, 'dupes', { at: new Date().toISOString(), moves: records })
    manifest = written.file
    manifestError = written.error
  }
  if (manifestError !== '') errors.push(`清单写失败：${manifestError}`)
  appendLog(store.logFile, { at: new Date().toISOString(), kind: 'dupes', moved, bytes: Math.round(bytes), errors: errors.length })
  return {
    ...base,
    applied: true,
    moved,
    freedBytes: Math.round(bytes),
    skipped,
    errors,
    manifest,
    ...(manifestError !== '' ? { code: 'MANIFEST_WRITE_FAILED' } : {}),
    hint:
      manifestError !== ''
        ? `已把 ${moved} 份副本移入隔离区 ${quarantine}，但清单写失败（${manifestError}）→ 这次无法用 tidy_undo 撤销，请人工核对。`
        : records.length > 0
          ? `已把 ${moved} 份多余副本移入隔离区：${quarantine}。确认没用再删该目录；想反悔可 tidy_undo。`
          : '没有可隔离的重复文件。',
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
export function readText(file) {
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
    limits: `单次最多 ${DEFAULT_MAX_APPLY} 条（organize 按文件数 / clean 按清理条目数，maxFiles 可调 1-2000）；盘点上限 ${fmtCount(SCAN_MAX_ENTRIES)} 项 / ${SCAN_DEADLINE_MS / 1000} 秒`,
    notices,
    inventoryEntries: inventory.entries,
    inventoryActive: inventory.active,
    inventoryRemoved: inventory.removed,
    inventoryStale: inventory.stale,
  }
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
