/**
 * dsh-repomap —— 代码库地图 + 符号纲要 + 符号定位。
 *
 * 学谁（GitHub 上的成熟做法）：
 *   - Aider 的 repo map：用 tree-sitter 解析符号，按"被引用程度"给文件排序，再按 token 预算
 *     裁剪出最相关的那部分塞给模型。
 *   - Serena 的 symbol 工具：不读整文件，先按符号浏览/定位。
 *
 * 本插件的取舍（取长补短，但按 DSH 的边界落地）：
 *   - DSH 插件是纯 JS、无常驻构建，装 tree-sitter + 预编译 wasm 代价太大 → 用**按语言的正则抽取**
 *     代替 AST。精度不如 tree-sitter，但零依赖、启动快、对 JS/TS/Python/Go/Rust 等够用。
 *   - 排序不做完整 PageRank，用"跨文件被引用次数"做一遍加权（Aider 图排序的廉价近似）。
 *   - **按需调用**，不往每轮提示里注入：地图很吃 token，需要时让 agent 自己调 `repo_map`。
 *   - 预算单位用**字符**（maxChars）而不是 token：DSH 没有统一 tokenizer，字符是稳定可验的。
 *
 * 三个工具：
 *   - `repo_map`          按热度排序的文件地图（默认 8000 字符预算）
 *   - `repo_outline`      单个文件的符号纲要（带行号）
 *   - `repo_find_symbol`  在全库找某个符号的定义位置
 *
 * 已知边界：
 *   - 符号抽取是启发式：宏、装饰器生成的名字、动态定义、压缩代码会漏；
 *   - 只扫源码扩展名白名单；不读 .gitignore（用常见目录黑名单代替）；
 *   - 超大文件（>512 KiB）跳过；单根目录扫描上限 maxFiles（默认 4000）。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

export const name = 'dsh-repomap'
// workingDirectory 必须声明：不声明就拿不到会话工作目录，默认根会落到插件进程 cwd（profile 目录）。
export const inject = ['tools', 'workingDirectory']

const MAX_FILE_BYTES = 512 * 1024
const MAX_SYMBOLS_PER_FILE = 60
const MAX_SCAN_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_CACHE_ENTRIES = 8
const MAX_CACHE_ENTRIES_LIMIT = 256

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'output',
  'vendor',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'target',
  'bin',
  'obj',
  '.idea',
  '.vscode',
  '.cache',
  '.turbo',
  '.gradle',
  'Pods',
  'DerivedData',
  '.dart_tool',
])

const JS_TS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'])
const PY = new Set(['.py', '.pyi'])
const GO = new Set(['.go'])
const RUST = new Set(['.rs'])
const JVM = new Set(['.java', '.cs', '.kt', '.scala', '.swift'])
const C_FAMILY = new Set(['.c', '.h', '.cc', '.cpp', '.hpp', '.cxx', '.hh'])
const RUBY = new Set(['.rb'])
const PHP = new Set(['.php'])

const SUPPORTED = new Set([...JS_TS, ...PY, ...GO, ...RUST, ...JVM, ...C_FAMILY, ...RUBY, ...PHP])

const PATTERNS = {
  js: [
    { kind: 'function', re: /^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm },
    { kind: 'class', re: /^[ \t]*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm },
    { kind: 'const', re: /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm },
    { kind: 'type', re: /^[ \t]*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm },
  ],
  python: [
    { kind: 'def', re: /^[ \t]*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm },
    { kind: 'class', re: /^[ \t]*class\s+([A-Za-z_]\w*)/gm },
  ],
  go: [
    { kind: 'func', re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm },
    { kind: 'type', re: /^type\s+([A-Za-z_]\w*)/gm },
  ],
  rust: [
    { kind: 'fn', re: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?fn\s+([A-Za-z_]\w*)/gm },
    { kind: 'type', re: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type)\s+([A-Za-z_]\w*)/gm },
  ],
  jvm: [
    { kind: 'type', re: /^[ \t]*(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial|open|data|enum)\s+)*(?:class|interface|enum|record|struct|protocol)\s+([A-Za-z_]\w*)/gm },
    { kind: 'func', re: /^[ \t]*(?:(?:public|private|protected|internal|static|final|override|async|suspend)\s+)+[\w<>[\]?,\s]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/gm },
  ],
  c: [
    { kind: 'type', re: /^[ \t]*(?:typedef\s+)?(?:struct|class|enum|union)\s+([A-Za-z_]\w*)/gm },
    { kind: 'function', re: /^[A-Za-z_][\w \t*&:<>,]*?\s([A-Za-z_]\w*)\s*\([^;={]*\)\s*\{/gm },
  ],
  ruby: [
    { kind: 'def', re: /^[ \t]*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/gm },
    { kind: 'type', re: /^[ \t]*(?:class|module)\s+([A-Za-z_]\w*)/gm },
  ],
  php: [
    { kind: 'function', re: /^[ \t]*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+([A-Za-z_]\w*)/gm },
    { kind: 'type', re: /^[ \t]*(?:(?:abstract|final)\s+)*(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/gm },
  ],
}

function languageFor(ext) {
  if (JS_TS.has(ext)) return PATTERNS.js
  if (PY.has(ext)) return PATTERNS.python
  if (GO.has(ext)) return PATTERNS.go
  if (RUST.has(ext)) return PATTERNS.rust
  if (JVM.has(ext)) return PATTERNS.jvm
  if (C_FAMILY.has(ext)) return PATTERNS.c
  if (RUBY.has(ext)) return PATTERNS.ruby
  if (PHP.has(ext)) return PATTERNS.php
  return undefined
}

function lineStarts(content) {
  const starts = [0]
  for (let index = 0; index < content.length; index += 1) if (content.charCodeAt(index) === 10) starts.push(index + 1)
  return starts
}

function lineAt(starts, index) {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2)
    if (starts[mid] <= index) low = mid
    else high = mid - 1
  }
  return low + 1
}

const NOISE = new Set([
  // 打包器生成的 interop 辅助函数，出现在几乎每个 bundle 里，排序时会污染地图
  '__export',
  '__copyProps',
  '__toESM',
  '__toCommonJS',
  '__defProp',
  '__reExport',
  '__exportStar',
  '__async',
  '__spreadValues',
  '__spreadProps',
  '__publicField',
  '__name',
  '__require',
  '__dirname',
  '__filename',
])

/**
 * 抽取一个文件的符号（导出是为了单测；不依赖任何服务）。
 * 返回 `{ symbols, truncated, total }`：`truncated` 是被 60 上限截掉的符号数——
 * 上层必须把它报出来，否则地图会静默失真（报告 #50）。
 */
export function extractSymbolsDetailed(ext, content) {
  const patterns = languageFor(ext)
  if (!patterns) return { symbols: [], truncated: 0, total: 0 }
  const starts = lineStarts(content)
  const seen = new Set()
  const symbols = []
  for (const pattern of patterns) {
    pattern.re.lastIndex = 0
    let match = pattern.re.exec(content)
    while (match !== null) {
      const symbolName = match[1]
      if (symbolName && !NOISE.has(symbolName) && !seen.has(symbolName)) {
        seen.add(symbolName)
        symbols.push({ name: symbolName, kind: pattern.kind, line: lineAt(starts, match.index) })
      }
      match = pattern.re.exec(content)
    }
  }
  symbols.sort((a, b) => a.line - b.line)
  const total = symbols.length
  const capped = symbols.slice(0, MAX_SYMBOLS_PER_FILE)
  return { symbols: capped, truncated: Math.max(0, total - capped.length), total }
}

/** 兼容旧签名：只要符号数组（单测/其它调用方都用这个）。 */
export function extractSymbols(ext, content) {
  return extractSymbolsDetailed(ext, content).symbols
}

function wordCounts(content) {
  const counts = new Map()
  const words = content.match(/[A-Za-z_$][\w$]*/g)
  if (!words) return counts
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1)
  return counts
}

/**
 * 只做 readdir + stat：收集候选源文件及其指纹（相对路径 + mtimeMs + size）。
 * 不读文件内容，所以"缓存命中"只需重新遍历目录、比对指纹，成本远低于重读 + 重解析。
 */
function collectEntries(root, options) {
  const entries = []
  const counters = { skippedLarge: 0, skippedUnsupported: 0, bytes: 0 }
  // 上限真的拦下东西时置位：地图要把「已跳过」说出来（报告 #50），不能静默少扫。
  let cappedHit = false

  const capped = () => {
    if (entries.length >= options.maxFiles || counters.bytes > options.maxBytes) {
      cappedHit = true
      return true
    }
    return false
  }

  const walk = (dir) => {
    if (capped()) return
    let list
    try {
      list = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      return
    }
    for (const entry of list) {
      if (capped()) return
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!SUPPORTED.has(ext)) {
        counters.skippedUnsupported += 1
        continue
      }
      let info
      try {
        info = statSync(full)
      } catch (error) {
        continue
      }
      if (info.size > MAX_FILE_BYTES) {
        counters.skippedLarge += 1
        continue
      }
      entries.push({
        full,
        rel: path.relative(root, full).replace(/\\/g, '/'),
        ext,
        size: info.size,
        mtimeMs: info.mtimeMs,
      })
      counters.bytes += info.size
    }
  }

  walk(root)
  // 排序有两个作用：readdir 顺序不保证稳定，而缓存指纹要求稳定；顺带让结果可复现
  entries.sort((a, b) => a.rel.localeCompare(b.rel))
  return {
    entries,
    skippedLarge: counters.skippedLarge,
    skippedUnsupported: counters.skippedUnsupported,
    capped: cappedHit,
  }
}

/** 由"每个文件的相对路径 + mtimeMs + size"算出扫描指纹。任一项变化，指纹就变。 */
function fingerprintOf(entries) {
  const hash = createHash('sha1')
  for (const entry of entries) {
    hash.update(entry.rel)
    hash.update('\0')
    hash.update(String(entry.mtimeMs))
    hash.update('\0')
    hash.update(String(entry.size))
    hash.update('\n')
  }
  return hash.digest('hex')
}

/** 照指纹列表读文件、抽符号、数词频——这是扫描里最贵的一段，只在指纹变化时做。 */
function readScannedFiles(entries, counters) {
  const files = []
  const state = {
    files: 0,
    skippedLarge: counters.skippedLarge,
    skippedUnsupported: counters.skippedUnsupported,
    scanCapped: counters.capped === true,
    bytes: 0,
    readErrors: 0,
  }
  for (const entry of entries) {
    let content
    try {
      content = readFileSync(entry.full, 'utf8')
    } catch (error) {
      state.readErrors += 1
      continue
    }
    const extracted = extractSymbolsDetailed(entry.ext, content)
    files.push({
      rel: entry.rel,
      ext: entry.ext,
      size: entry.size,
      symbols: extracted.symbols,
      symbolsTruncated: extracted.truncated,
      words: wordCounts(content),
    })
    state.files += 1
    state.bytes += entry.size
  }
  return { files, state }
}

/**
 * 内存级扫描缓存（不落盘，进程重启即失效）。
 *
 * 缓存 key = 工作目录 + 全部候选文件的指纹（相对路径 + mtimeMs + size 的哈希）。
 * 好处：
 *   - 文件内容（size 变）或 mtime 变 → 指纹变 → 必重扫，不会返回陈旧结果；
 *   - 新增 / 删除文件 → 参与指纹的文件集合变 → 必重扫；
 *   - 同内容但不同工作目录 → key 不同，互不串用；
 *   - 有文件读失败时这次结果可能是残缺快照，一律不缓存（宁可不命中，也不留假命中）。
 * 淘汰策略：LRU（Map 插入序，命中时删掉重插），上限 maxCacheEntries。
 *
 * 导出给单测用；工具层通过 apply() 拿同一个实例，所以同一会话里的重复调用共享缓存。
 */
export function createScanCache(options = {}) {
  const maxFiles =
    Number.isInteger(options.maxFiles) && options.maxFiles > 0 ? Math.min(options.maxFiles, 20000) : 4000
  const maxBytes =
    Number.isInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : MAX_SCAN_BYTES
  const maxCacheEntries =
    Number.isInteger(options.maxCacheEntries) && options.maxCacheEntries > 0
      ? Math.min(options.maxCacheEntries, MAX_CACHE_ENTRIES_LIMIT)
      : DEFAULT_MAX_CACHE_ENTRIES
  const cache = new Map()
  const stats = { hits: 0, misses: 0 }

  const evict = () => {
    while (cache.size > maxCacheEntries) {
      const oldest = cache.keys().next()
      if (oldest.done) break
      cache.delete(oldest.value)
    }
  }

  function scan(root) {
    const resolvedRoot = path.resolve(root)
    const collected = collectEntries(resolvedRoot, { maxFiles, maxBytes })
    const key = `${resolvedRoot}\u0000${fingerprintOf(collected.entries)}`

    const cached = cache.get(key)
    if (cached !== undefined) {
      cache.delete(key)
      cache.set(key, cached)
      stats.hits += 1
      return cached
    }

    stats.misses += 1
    const { files, state } = readScannedFiles(collected.entries, collected)
    const value = { files, state }
    if (state.readErrors === 0) {
      cache.set(key, value)
      evict()
    }
    return value
  }

  return {
    scan,
    stats: () => ({ hits: stats.hits, misses: stats.misses, size: cache.size }),
    clear: () => cache.clear(),
  }
}

function rankFiles(files) {
  const global = new Map()
  for (const file of files) {
    for (const [word, count] of file.words) global.set(word, (global.get(word) ?? 0) + count)
  }
  for (const file of files) {
    let score = 0
    for (const symbol of file.symbols) {
      const total = global.get(symbol.name) ?? 0
      const own = file.words.get(symbol.name) ?? 0
      score += Math.max(0, total - own)
    }
    file.score = score
  }
  return [...files].sort((a, b) => b.score - a.score || b.symbols.length - a.symbols.length || a.rel.localeCompare(b.rel))
}

const text = (value) => ({ type: 'text', text: value })

function strValue(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 工作区兜底：优先 config.workspaceDir，其次读 DSH 最近使用的 workspace
 * （<DSH_HOME>/storages/workspace.json）。插件进程 cwd 是 profile 目录，绝不能拿它当默认根。
 */
export function readActiveWorkspace(env) {
  try {
    const home = strValue(env?.DSH_HOME) || (strValue(env?.USERPROFILE) !== '' ? path.join(strValue(env.USERPROFILE), '.dsh') : '')
    if (home === '') return ''
    const file = path.join(home, 'storages', 'workspace.json')
    if (!existsSync(file)) return ''
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const workspaces = (parsed && parsed.tables && parsed.tables.workspaces) || {}
    let best = null
    for (const key of Object.keys(workspaces)) {
      const entry = workspaces[key]
      if (!entry || typeof entry.path !== 'string') continue
      const stamp = Date.parse(String(entry.updatedAt || entry.createdAt || ''))
      const score = Number.isFinite(stamp) ? stamp : 0
      if (!best || score > best.score) best = { score, path: entry.path }
    }
    return best ? String(best.path) : ''
  } catch {
    return ''
  }
}

/** 统一错误契约：所有抛出的错误都带 code（UPPER_SNAKE），调用方据此分支，不必解析中文文案。 */
function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export function apply(ctx, config) {
  const defaultMaxChars =
    Number.isInteger(config?.maxChars) && config.maxChars > 0 ? Math.min(config.maxChars, 64000) : 8000
  const maxFiles = Number.isInteger(config?.maxFiles) && config.maxFiles > 0 ? Math.min(config.maxFiles, 20000) : 4000
  const maxCacheEntries =
    Number.isInteger(config?.maxCacheEntries) && config.maxCacheEntries > 0
      ? Math.min(config.maxCacheEntries, MAX_CACHE_ENTRIES_LIMIT)
      : DEFAULT_MAX_CACHE_ENTRIES
  const tools = ctx.tools
  const workingDirectory = (typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined) ?? ctx.workingDirectory
  // 兜底工作区：config.workspaceDir → DSH 最近工作区。都拿不到时交给 resolveRoot 报错，
  // 绝不回落到 process.cwd()（那是 profile 目录，扫出来的 0 文件是假绿）。
  const configuredWorkspaceDir = (() => {
    const fromConfig = strValue(config?.workspaceDir)
    if (fromConfig !== '') return path.resolve(fromConfig)
    return readActiveWorkspace(process.env)
  })()
  // 一个插件实例一份缓存：同一会话里 repo_map / repo_find_symbol 共享扫描结果
  const scanner = createScanCache({ maxFiles, maxBytes: MAX_SCAN_BYTES, maxCacheEntries })
  // repo_outline 只涉及单个文件，用"文件路径 + mtimeMs + size"做 key 的小 LRU
  const outlineCache = new Map()

  function outlineFor(full) {
    let info
    try {
      info = statSync(full)
    } catch (error) {
      throw fail('REPO_FILE_UNREADABLE', `读不到文件：${full}`)
    }
    const key = `${full}\u0000${info.mtimeMs}\u0000${info.size}`
    const cached = outlineCache.get(key)
    if (cached !== undefined) {
      outlineCache.delete(key)
      outlineCache.set(key, cached)
      return cached
    }
    let content
    try {
      content = readFileSync(full, 'utf8')
    } catch (error) {
      throw fail('REPO_FILE_UNREADABLE', `读不到文件：${full}`)
    }
    const value = { path: full, symbols: extractSymbols(path.extname(full).toLowerCase(), content) }
    outlineCache.set(key, value)
    while (outlineCache.size > maxCacheEntries) {
      const oldest = outlineCache.keys().next()
      if (oldest.done) break
      outlineCache.delete(oldest.value)
    }
    return value
  }

  /**
   * 解析扫描根：显式 path 优先；否则用会话工作目录 → workspaceDir 兜底。
   * 返回 { root, source }，source 让 repo_status 能说清「这个根是哪来的」。
   * 两者都拿不到时抛 REPO_NO_WORKSPACE（不再静默用 process.cwd()）。
   */
  async function resolveRoot(exec, wantedPath) {
    const raw = typeof wantedPath === 'string' && wantedPath.trim() !== '' ? wantedPath.trim() : undefined
    let base = ''
    let source = ''
    if (workingDirectory !== undefined && workingDirectory !== null && typeof workingDirectory.ensure === 'function' && exec?.agent) {
      const ensured = await workingDirectory.ensure(exec.agent, exec.signal).catch(() => undefined)
      if (typeof ensured === 'string' && ensured.trim() !== '') {
        base = path.resolve(ensured.trim())
        source = 'workingDirectory'
      }
    }
    if (base === '' && configuredWorkspaceDir !== '') {
      base = configuredWorkspaceDir
      source = 'workspaceDir'
    }
    if (raw === undefined) {
      if (base === '') throw fail('REPO_NO_WORKSPACE', '拿不到会话工作目录，也没有配置 workspaceDir。请显式传 path，或在配置里设 workspaceDir（不会再回落到插件进程 cwd）。')
      return { root: base, source }
    }
    if (path.isAbsolute(raw)) return { root: path.resolve(raw), source: 'path' }
    if (base === '') throw fail('REPO_NO_WORKSPACE', '给的是相对路径但拿不到会话工作目录。请传绝对 path，或在配置里设 workspaceDir。')
    return { root: path.resolve(base, raw), source: 'relative' }
  }

  function buildMap(root, maxChars) {
    const { files, state } = scanner.scan(root)
    const ranked = rankFiles(files)
    const truncatedSymbols = ranked.reduce((sum, file) => sum + (file.symbolsTruncated ?? 0), 0)
    const notes = []
    if (state.skippedLarge > 0) notes.push(`已跳过超大文件 ${state.skippedLarge} 个（>512KB）`)
    if (truncatedSymbols > 0) notes.push(`已截断符号 ${truncatedSymbols} 个（单文件上限 ${MAX_SYMBOLS_PER_FILE}）`)
    const lines = []
    let used = 0
    let included = 0
    for (const file of ranked) {
      if (file.symbols.length === 0) continue
      const names = file.symbols.map((symbol) => symbol.name).slice(0, 8).join(', ')
      // 面向人的输出：不暴露内部评分，只按热度顺序给"文件 + 它定义了啥"
      const line = `${file.rel}  —  ${names}`
      if (used + line.length + 1 > maxChars) break
      lines.push(line)
      used += line.length + 1
      included += 1
    }
    return {
      root,
      scanned: state.files,
      skippedLarge: state.skippedLarge,
      truncatedSymbols,
      included,
      omitted: Math.max(0, ranked.filter((file) => file.symbols.length > 0).length - included),
      chars: used,
      entries: ranked
        .filter((file) => file.symbols.length > 0)
        .slice(0, included)
        .map((file) => ({ path: file.rel, score: file.score, symbols: file.symbols.map((symbol) => symbol.name) })),
      block: [notes.length ? `（${notes.join('；')}）` : '', lines.join('\n')].filter((line) => line !== '').join('\n'),
    }
  }

  // ---- repo_map ----
  ctx.effect(() =>
    tools.register({
      name: 'repo_map',
      description:
        'Show a ranked map of the workspace: source files ordered by how much their symbols are referenced elsewhere, with their top-level symbols, fitted to a character budget. Use it to decide which files matter before searching or reading.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Root directory (defaults to the session working directory).' },
          maxChars: { type: 'integer', description: 'Budget in characters for the rendered map.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            root: { type: 'string' },
            scanned: { type: 'integer' },
            skippedLarge: { type: 'integer' },
            truncatedSymbols: { type: 'integer' },
            included: { type: 'integer' },
            omitted: { type: 'integer' },
            chars: { type: 'integer' },
            block: { type: 'string' },
            entries: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  score: { type: 'integer' },
                  symbols: { type: 'array', items: { type: 'string' } },
                },
                required: ['path', 'score', 'symbols'],
                additionalProperties: false,
              },
            },
          },
          required: ['root', 'scanned', 'skippedLarge', 'truncatedSymbols', 'included', 'omitted', 'chars', 'block', 'entries'],
          additionalProperties: false,
        },
        render(_args, value) {
          const head = `代码库地图：${value?.root ?? '?'}\n按跨文件引用热度排序，前 ${value?.included ?? 0} 个文件最值得先看（扫描 ${value?.scanned ?? 0} 个源文件、省略 ${value?.omitted ?? 0} 个，${value?.chars ?? 0} 字符预算）`
          return [text(`${head}\n${value?.block ?? ''}`)]
        },
      },
      async execute(args, exec) {
        const { root } = await resolveRoot(exec, args?.path)
        const budget = Number.isInteger(args?.maxChars) && args.maxChars > 0 ? Math.min(args.maxChars, 64000) : defaultMaxChars
        return buildMap(root, budget)
      },
    }),
  )

  // ---- repo_outline ----
  ctx.effect(() =>
    tools.register({
      name: 'repo_outline',
      description:
        'List the symbols a single source file defines, with line numbers and kinds. Use it instead of reading a whole file when you only need its structure.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path (absolute, or relative to the working directory).' } },
        required: ['path'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            symbols: {
              type: 'array',
              items: {
                type: 'object',
                properties: { name: { type: 'string' }, kind: { type: 'string' }, line: { type: 'integer' } },
                required: ['name', 'kind', 'line'],
                additionalProperties: false,
              },
            },
          },
          required: ['path', 'symbols'],
          additionalProperties: false,
        },
        render(_args, value) {
          const symbols = Array.isArray(value?.symbols) ? value.symbols : []
          if (symbols.length === 0) return [text(`${value?.path ?? '?'}：没有识别到符号（也可能是空文件或不支持的语言）。`)]
          const lines = symbols.map((symbol) => `${String(symbol.line).padStart(5)}  ${symbol.kind} ${symbol.name}`)
          return [text(`${value?.path ?? '?'}（${symbols.length} 个符号）\n${lines.join('\n')}`)]
        },
      },
      async execute(args, exec) {
        const raw = typeof args?.path === 'string' ? args.path.trim() : ''
        if (raw === '') throw fail('REPO_ARG_MISSING', 'repo_outline 需要 path。')
        const { root } = await resolveRoot(exec, raw)
        return outlineFor(root)
      },
    }),
  )

  // ---- repo_find_symbol ----
  ctx.effect(() =>
    tools.register({
      name: 'repo_find_symbol',
      description:
        'Find where a symbol is defined across the workspace (files, lines, kinds). Cheaper than grepping for definitions when you only know the name.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact symbol name, e.g. "renderMemory".' },
          path: { type: 'string', description: 'Search root (defaults to the session working directory).' },
          limit: { type: 'integer', description: 'Max matches (default 20).' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            matches: {
              type: 'array',
              items: {
                type: 'object',
                properties: { path: { type: 'string' }, line: { type: 'integer' }, kind: { type: 'string' } },
                required: ['path', 'line', 'kind'],
                additionalProperties: false,
              },
            },
          },
          required: ['name', 'matches'],
          additionalProperties: false,
        },
        render(_args, value) {
          const matches = Array.isArray(value?.matches) ? value.matches : []
          if (matches.length === 0) return [text(`没有找到符号定义：${value?.name ?? '?'}`)]
          const lines = matches.map((match) => `${match.path}:${match.line}  (${match.kind})`)
          return [text(`${value?.name ?? '?'} 定义在 ${matches.length} 处：\n${lines.join('\n')}`)]
        },
      },
      async execute(args, exec) {
        const wanted = typeof args?.name === 'string' ? args.name.trim() : ''
        if (wanted === '') throw fail('REPO_ARG_MISSING', 'repo_find_symbol 需要 name。')
        const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 100) : 20
        const { root } = await resolveRoot(exec, args?.path)
        const { files } = scanner.scan(root)
        const matches = []
        for (const file of files) {
          for (const symbol of file.symbols) {
            if (symbol.name === wanted) {
              matches.push({ path: file.rel, line: symbol.line, kind: symbol.kind })
              if (matches.length >= limit) break
            }
          }
          if (matches.length >= limit) break
        }
        return { name: wanted, matches }
      },
    }),
  )

  // ---- repo_status：ready 由「扫描根存在 + 是目录 + 可读」现算，不写死 ----
  ctx.effect(() =>
    tools.register({
      name: 'repo_status',
      description:
        'Read-only health of the repo map: whether the scan root exists and is readable, how many source files it sees, and the scan-cache and budget settings. Call it when repo_map returns nothing or a path looks wrong.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Root directory to check (defaults to the session working directory).' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ready: { type: 'boolean' },
            unavailableReason: { type: 'string' },
            code: { type: 'string' },
            root: { type: 'string' },
            rootSource: { type: 'string' },
            exists: { type: 'boolean' },
            isDirectory: { type: 'boolean' },
            readable: { type: 'boolean' },
            sources: { type: 'integer' },
            skippedLarge: { type: 'integer' },
            skippedUnsupported: { type: 'integer' },
            cache: {
              type: 'object',
              properties: { hits: { type: 'integer' }, misses: { type: 'integer' }, size: { type: 'integer' } },
              required: ['hits', 'misses', 'size'],
              additionalProperties: false,
            },
            maxChars: { type: 'integer' },
            maxFiles: { type: 'integer' },
            maxCacheEntries: { type: 'integer' },
            configWarning: { type: 'string' },
            warning: { type: 'string' },
          },
          required: ['ready', 'root', 'rootSource', 'exists', 'isDirectory', 'readable', 'sources', 'cache', 'maxChars', 'maxFiles', 'maxCacheEntries'],
          additionalProperties: false,
        },
        render(_args, value) {
          if (value?.ready === false) return [text('不可用：' + (value?.unavailableReason || '未知原因'))]
          const cache = value?.cache ?? {}
          return [
            text(
              `代码库地图可用：扫描根 ${value?.root ?? '?'}（来源 ${value?.rootSource ?? '?'}），识别 ${value?.sources ?? 0} 个源文件` +
                `（跳过超大 ${value?.skippedLarge ?? 0}、不支持 ${value?.skippedUnsupported ?? 0}），` +
                `扫描缓存 ${cache.size ?? 0} 份（命中 ${cache.hits ?? 0} / 未命中 ${cache.misses ?? 0}），` +
                `预算 ${value?.maxChars ?? 0} 字符 / 上限 ${value?.maxFiles ?? 0} 个文件。`,
              (value?.warning ? `\n⚠ ${value.warning}` : ''),
            ),
          ]
        },
      },
      async execute(args, exec) {
        const resolved = await resolveRoot(exec, args?.path)
        const root = resolved.root
        const problems = []
        let code = ''
        const note = (nextCode, reason) => {
          problems.push(reason)
          if (code === '') code = nextCode
        }

        // 配置非法不改行为（仍按夹取后的默认值跑），但如实报出来。
        const configWarnings = []
        for (const [key, floor] of [
          ['maxChars', 64000],
          ['maxFiles', 20000],
          ['maxCacheEntries', MAX_CACHE_ENTRIES_LIMIT],
        ]) {
          const value = config?.[key]
          if (value !== undefined && !(Number.isInteger(value) && value > 0)) {
            configWarnings.push(`${key} 需要正整数，收到 ${JSON.stringify(value)}（已回落到默认值）`)
          } else if (Number.isInteger(value) && value > floor) {
            configWarnings.push(`${key}=${value} 超过上限 ${floor}（已夹取到 ${floor}）`)
          }
        }

        const exists = existsSync(root)
        let isDirectory = false
        let readable = false
        let sources = 0
        let skippedLarge = 0
        let skippedUnsupported = 0

        if (!exists) {
          note('REPO_ROOT_MISSING', '扫描根不存在：' + root)
        } else {
          try {
            isDirectory = statSync(root).isDirectory()
          } catch (error) {
            note('REPO_ROOT_UNREADABLE', '扫描根 stat 失败：' + (error?.message ?? 'unknown'))
          }
          if (exists && !isDirectory) note('REPO_ROOT_NOT_DIRECTORY', '扫描根不是目录：' + root)
        }

        if (exists && isDirectory) {
          // collectEntries 内部会吞掉 readdir 失败（正常扫描想要的宽容），所以可读性必须自己先真读一次。
          try {
            readdirSync(root)
            readable = true
          } catch (error) {
            note('REPO_ROOT_UNREADABLE', '扫描根不可读：' + (error?.message ?? 'unknown'))
          }
          if (readable) {
            try {
              // 只 readdir + stat，与 repo_map 的冷扫描同一段代码；不读文件内容，状态查询不贵。
              const collected = collectEntries(root, { maxFiles, maxBytes: MAX_SCAN_BYTES })
              sources = collected.entries.length
              skippedLarge = collected.skippedLarge
              skippedUnsupported = collected.skippedUnsupported
            } catch (error) {
              note('REPO_ROOT_UNREADABLE', '扫描根不可读：' + (error?.message ?? 'unknown'))
            }
          }
        }

        const ready = problems.length === 0
        const warning =
          ready && sources === 0 && resolved.source !== 'path'
            ? `默认扫描根（来源 ${resolved.source}）没有识别到源文件：${root}。若这不是你想要的目录，请显式传 path。`
            : ''
        return {
          ready,
          unavailableReason: problems.join('；'),
          ...(ready ? {} : { code }),
          root,
          rootSource: resolved.source,
          exists,
          isDirectory,
          readable,
          sources,
          skippedLarge,
          skippedUnsupported,
          cache: scanner.stats(),
          maxChars: defaultMaxChars,
          maxFiles,
          maxCacheEntries,
          ...(configWarnings.length > 0 ? { configWarning: configWarnings.join('；') } : {}),
          ...(warning !== '' ? { warning } : {}),
        }
      },
    }),
  )
}
