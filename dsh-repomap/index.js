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

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

export const name = 'dsh-repomap'
export const inject = ['tools']

const MAX_FILE_BYTES = 512 * 1024
const MAX_SYMBOLS_PER_FILE = 60
const CACHE_TTL_MS = 5000

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

/** 抽取一个文件的符号（导出是为了单测；不依赖任何服务） */
export function extractSymbols(ext, content) {
  const patterns = languageFor(ext)
  if (!patterns) return []
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
  return symbols.slice(0, MAX_SYMBOLS_PER_FILE)
}

function wordCounts(content) {
  const counts = new Map()
  const words = content.match(/[A-Za-z_$][\w$]*/g)
  if (!words) return counts
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1)
  return counts
}

function scanRoot(root, options) {
  const files = []
  const state = { files: 0, skippedLarge: 0, skippedUnsupported: 0, bytes: 0 }

  const walk = (dir) => {
    if (state.files >= options.maxFiles || state.bytes > options.maxBytes) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      return
    }
    for (const entry of entries) {
      if (state.files >= options.maxFiles || state.bytes > options.maxBytes) return
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
        state.skippedUnsupported += 1
        continue
      }
      let size = 0
      try {
        size = statSync(full).size
      } catch (error) {
        continue
      }
      if (size > MAX_FILE_BYTES) {
        state.skippedLarge += 1
        continue
      }
      let content
      try {
        content = readFileSync(full, 'utf8')
      } catch (error) {
        continue
      }
      files.push({
        rel: path.relative(root, full).replace(/\\/g, '/'),
        ext,
        size,
        symbols: extractSymbols(ext, content),
        words: wordCounts(content),
      })
      state.files += 1
      state.bytes += size
    }
  }

  walk(root)
  return { files, state }
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

export function apply(ctx, config) {
  const defaultMaxChars =
    Number.isInteger(config?.maxChars) && config.maxChars > 0 ? Math.min(config.maxChars, 64000) : 8000
  const maxFiles = Number.isInteger(config?.maxFiles) && config.maxFiles > 0 ? Math.min(config.maxFiles, 20000) : 4000
  const maxBytes = 64 * 1024 * 1024
  const tools = ctx.tools
  const workingDirectory = ctx.get('workingDirectory')
  const cache = new Map()

  async function resolveRoot(exec, wantedPath) {
    const raw = typeof wantedPath === 'string' && wantedPath.trim() !== '' ? wantedPath.trim() : undefined
    const cwd = workingDirectory && exec?.agent ? await workingDirectory.ensure(exec.agent, exec.signal).catch(() => undefined) : undefined
    return raw === undefined ? cwd ?? process.cwd() : path.resolve(cwd ?? process.cwd(), raw)
  }

  function scanCached(root) {
    const cached = cache.get(root)
    const now = Date.now()
    if (cached && now - cached.at < CACHE_TTL_MS) return cached.value
    const value = scanRoot(root, { maxFiles, maxBytes })
    cache.set(root, { at: now, value })
    if (cache.size > 8) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
    return value
  }

  function buildMap(root, maxChars) {
    const { files, state } = scanCached(root)
    const ranked = rankFiles(files)
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
      included,
      omitted: Math.max(0, ranked.filter((file) => file.symbols.length > 0).length - included),
      chars: used,
      entries: ranked
        .filter((file) => file.symbols.length > 0)
        .slice(0, included)
        .map((file) => ({ path: file.rel, score: file.score, symbols: file.symbols.map((symbol) => symbol.name) })),
      block: lines.join('\n'),
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
          required: ['root', 'scanned', 'skippedLarge', 'included', 'omitted', 'chars', 'block', 'entries'],
          additionalProperties: false,
        },
        render(_args, value) {
          const head = `代码库地图：${value?.root ?? '?'}\n按跨文件引用热度排序，前 ${value?.included ?? 0} 个文件最值得先看（扫描 ${value?.scanned ?? 0} 个源文件、省略 ${value?.omitted ?? 0} 个，${value?.chars ?? 0} 字符预算）`
          return [text(`${head}\n${value?.block ?? ''}`)]
        },
      },
      async execute(args, exec) {
        const root = await resolveRoot(exec, args?.path)
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
        if (raw === '') throw new Error('repo_outline 需要 path。')
        const cwd = workingDirectory && exec?.agent ? await workingDirectory.ensure(exec.agent, exec.signal).catch(() => undefined) : undefined
        const full = path.resolve(cwd ?? process.cwd(), raw)
        let content
        try {
          content = readFileSync(full, 'utf8')
        } catch (error) {
          throw new Error(`读不到文件：${full}`)
        }
        const ext = path.extname(full).toLowerCase()
        return { path: full, symbols: extractSymbols(ext, content) }
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
        if (wanted === '') throw new Error('repo_find_symbol 需要 name。')
        const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 100) : 20
        const root = await resolveRoot(exec, args?.path)
        const { files } = scanCached(root)
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
}
