/**
 * dsh-obsidian v0.1.0 —— Obsidian 库的只读索引（P1：只读，绝不写库）。
 *
 * 为什么需要它：vault 是人的成品层，AI 要查画像/日志/调研结论时只能 glob + read 逐个翻；
 * 库一大就会问「哪张卡讲过 X」「断链断在哪」。这个插件把 vault 扫成一份索引（落在 D 盘），
 * 提供 search / note / status 三个只读工具。写入归 P2（受控写），另做。
 *
 * 三条约束（与 _research/obsidian-vault-plan-2026-11.md §5 一致）：
 * ① 只读：绝不写 vault；唯一写入是 <storeDir>/index.json（临时文件 + rename 原子替换）；
 * ② fail-safe：扫描/解析失败只记 lastError，绝不抛给会话；
 * ③ 不重复：检索用词项打分，够用就行；向量/图谱等有触发线再说。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const name = 'dsh-obsidian'
export const inject = ['tools']

export const INDEX_VERSION = 1
const DEFAULT_VAULT = 'D:\\AI-date\\obsidian\\vault'
const DEFAULT_STORE = 'D:\\AI\\dsh-data\\obsidian'
const INDEX_FILE = 'index.json'
const MAX_NOTE_BYTES = 512 * 1024
const MAX_TEXT_CHARS = 8000
const MAX_SNIPPET = 160
const MAX_INDEX_BYTES = 32 * 1024 * 1024
const SKIP_DIRS = new Set(['.obsidian', '.git', 'node_modules', '.trash', '.dsh-vision-router'])
const ATTACHMENT_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf', '.canvas', '.mp3', '.mp4', '.zip', '.excalidraw'])

const text = (value) => ({ type: 'text', text: value })

function errText(error) {
  if (error === null || error === undefined) return ''
  if (error instanceof Error) return error.message
  return String(error)
}

function strValue(value) {
  if (typeof value !== 'string') return ''
  return value.trim()
}

function baseName(rel) {
  return path.basename(String(rel ?? '')).replace(/\.md$/i, '')
}

function stripQuotes(value) {
  const raw = String(value ?? '').trim()
  if (raw.length >= 2) {
    const first = raw[0]
    const last = raw[raw.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return raw.slice(1, -1)
  }
  return raw
}

export function scalar(value) {
  if (Array.isArray(value)) return value.length ? stripQuotes(value[0]) : ''
  if (value === null || value === undefined) return ''
  return stripQuotes(value)
}

export function toList(value) {
  if (Array.isArray(value)) return value.map((item) => stripQuotes(item)).filter((item) => item !== '')
  const one = stripQuotes(value)
  return one === '' ? [] : [one]
}

/** 拆 frontmatter：只认文件开头的 --- 块；未闭合就当整篇正文（不吞内容）。 */
export function splitFrontmatter(raw) {
  const src = String(raw ?? '')
  if (!src.startsWith('---')) return { frontmatter: null, body: src }
  const lines = src.split(/\r?\n/)
  if (lines[0].trim() !== '---') return { frontmatter: null, body: src }
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      return { frontmatter: lines.slice(1, i).join('\n'), body: lines.slice(i + 1).join('\n') }
    }
  }
  return { frontmatter: null, body: src }
}

function parseInline(value) {
  const raw = String(value ?? '').trim()
  if (!(raw.startsWith('[') && raw.endsWith(']'))) return stripQuotes(raw)
  const inner = raw.slice(1, -1).trim()
  if (inner === '') return []
  const out = []
  let current = ''
  let quote = ''
  for (const char of inner) {
    if (quote !== '') {
      if (char === quote) quote = ''
      else current += char
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === ',') { out.push(current.trim()); current = ''; continue }
    current += char
  }
  if (current.trim() !== '') out.push(current.trim())
  return out.map((item) => stripQuotes(item)).filter((item) => item !== '')
}

/** YAML-lite：够解析 Obsidian 属性用（标量 / 行内列表 / 缩进列表），不引第三方依赖。 */
export function parseFrontmatter(raw) {
  const split = splitFrontmatter(raw)
  const data = {}
  const errors = []
  if (split.frontmatter !== null) {
    let key = null
    for (const line of split.frontmatter.split('\n')) {
      if (line.trim() === '' || line.trim().startsWith('#')) continue
      const item = /^\s+-\s*(.*)$/.exec(line)
      if (item && key !== null) {
        if (!Array.isArray(data[key])) data[key] = []
        data[key].push(stripQuotes(item[1]))
        continue
      }
      const pair = /^([A-Za-z_][\w.-]*):\s?(.*)$/.exec(line)
      if (pair) {
        key = pair[1]
        const rest = pair[2].trim()
        data[key] = rest === '' ? [] : parseInline(rest)
        continue
      }
      errors.push(line.trim().slice(0, 80))
    }
  }
  return { data, body: split.body, hasFrontmatter: split.frontmatter !== null, errors }
}

/** [[目标|别名#标题]] 与 ![[嵌入]]；返回顺序即出现顺序。 */
export function extractLinks(markdown) {
  const out = []
  const re = /(!?)\[\[([^\]]+)\]\]/g
  let match = re.exec(String(markdown ?? ''))
  while (match) {
    const inner = match[2]
    const target = inner.split('|')[0].split('#')[0].trim()
    if (target !== '') out.push({ embed: match[1] === '!', target })
    match = re.exec(String(markdown ?? ''))
  }
  return out
}

export function normalizeTarget(target) {
  return String(target ?? '').trim().replace(/\\/g, '/').replace(/\.md$/i, '')
}

function firstHeading(body) {
  const match = /^#\s+(.+)$/m.exec(String(body ?? ''))
  return match ? match[1].trim() : ''
}

function compact(value, max = MAX_TEXT_CHARS) {
  const flat = String(value ?? '').replace(/\r/g, '').split('\n').map((line) => line.trim()).filter((line) => line !== '').join(' ')
  return flat.length > max ? flat.slice(0, max) : flat
}

export function listVault(vaultDir) {
  const root = path.resolve(String(vaultDir ?? ''))
  const notes = []
  const bases = []
  const dirs = []
  const failures = []
  const allNames = new Set()
  let attachments = 0
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch (error) { failures.push({ path: dir, reason: errText(error).slice(0, 120) }); return }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      const rel = path.relative(root, abs).split(path.sep).join('/')
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        dirs.push(rel)
        walk(abs)
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      allNames.add(entry.name.toLowerCase())
      allNames.add(baseName(entry.name).toLowerCase())
      if (ext === '.md') {
        try {
          const info = statSync(abs)
          notes.push({ rel, abs, name: entry.name, size: info.size, mtime: info.mtimeMs })
        } catch (error) {
          failures.push({ path: rel, reason: errText(error).slice(0, 120) })
        }
        continue
      }
      if (ext === '.base') { bases.push(rel); continue }
      if (ATTACHMENT_EXT.has(ext)) attachments += 1
    }
  }
  walk(root)
  return { root, notes, bases, dirs, attachments, failures, allNames }
}

function resolveTarget(target, byPath, byName, allNames) {
  const key = normalizeTarget(target).toLowerCase()
  if (key === '') return ''
  if (key.includes('/')) {
    const hit = byPath.get(key) || byPath.get(key + '.md')
    if (hit) return hit
  }
  const list = byName.get(path.basename(key))
  if (list && list.length) return list[0]
  if (allNames.has(key) || allNames.has(path.basename(key))) return '__asset__'
  return ''
}

export function buildIndex(vaultDir, now = Date.now(), listing) {
  const files = listing || listVault(vaultDir)
  const parseErrors = files.failures.slice(0, 50)
  const byPath = new Map()
  const byName = new Map()
  const notes = []
  for (const file of files.notes) {
    let raw = ''
    try {
      if (file.size > MAX_NOTE_BYTES) raw = ''
      else raw = readFileSync(file.abs, 'utf8')
    } catch (error) {
      parseErrors.push({ path: file.rel, reason: errText(error).slice(0, 120) })
      continue
    }
    const parsed = parseFrontmatter(raw)
    if (parsed.errors.length) parseErrors.push({ path: file.rel, reason: 'frontmatter: ' + parsed.errors[0] })
    const data = parsed.data
    const tags = toList(data.tags)
    const aliases = toList(data.aliases)
    const entry = {
      path: file.rel,
      name: baseName(file.rel),
      title: firstHeading(parsed.body) || scalar(data.title) || baseName(file.rel),
      type: scalar(data.type),
      domain: scalar(data.domain),
      status: scalar(data.status),
      review: scalar(data.review),
      tier: scalar(data.tier),
      confidence: scalar(data.confidence),
      id: scalar(data.id),
      tags,
      aliases,
      mtime: file.mtime,
      size: file.size,
      links: extractLinks(parsed.body).map((link) => ({ embed: link.embed, target: normalizeTarget(link.target) })),
      text: compact(parsed.body),
    }
    notes.push(entry)
    byPath.set(entry.path.toLowerCase(), entry.path)
    byPath.set(entry.path.toLowerCase().replace(/\.md$/, ''), entry.path)
    const nameKey = entry.name.toLowerCase()
    byName.set(nameKey, (byName.get(nameKey) || []).concat([entry.path]))
  }
  let total = 0
  let broken = 0
  const brokenSample = []
  for (const entry of notes) {
    for (const link of entry.links) {
      total += 1
      const resolved = resolveTarget(link.target, byPath, byName, files.allNames)
      link.resolved = resolved
      if (resolved === '') {
        broken += 1
        if (brokenSample.length < 50) brokenSample.push({ from: entry.path, target: link.target })
      }
    }
  }
  const newestMtime = notes.reduce((max, entry) => Math.max(max, entry.mtime), 0)
  return {
    version: INDEX_VERSION,
    vault: files.root,
    builtAt: now,
    newestMtime,
    counts: { notes: notes.length, bases: files.bases.length, attachments: files.attachments, dirs: files.dirs.length },
    links: { total, broken, brokenSample },
    parseErrors: parseErrors.slice(0, 50),
    notes,
  }
}

export function tokenize(query) {
  const raw = String(query ?? '').toLowerCase()
  const parts = raw.split(/[\s,，。、;；:：!！?？()（）\[\]【】"']+/).map((item) => item.trim()).filter((item) => item !== '')
  return parts.length ? parts : [raw.trim()].filter((item) => item !== '')
}

function countOccurrences(haystack, needle) {
  if (needle === '') return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) { count += 1; index = haystack.indexOf(needle, index + needle.length) }
  return count
}

export function scoreNote(entry, terms) {
  if (!terms.length) return 0
  const title = String(entry.title ?? '').toLowerCase()
  const name = String(entry.name ?? '').toLowerCase()
  const body = String(entry.text ?? '').toLowerCase()
  const aliases = (entry.aliases || []).map((item) => String(item).toLowerCase())
  const tags = (entry.tags || []).map((item) => String(item).toLowerCase())
  let score = 0
  for (const rawTerm of terms) {
    const term = String(rawTerm).toLowerCase()
    if (term === '') continue
    if (name === term || title === term) score += 12
    else if (name.startsWith(term) || title.startsWith(term)) score += 8
    else if (title.includes(term) || name.includes(term)) score += 5
    if (aliases.some((item) => item === term)) score += 10
    else if (aliases.some((item) => item.includes(term))) score += 5
    if (tags.some((item) => item === term)) score += 7
    else if (tags.some((item) => item.includes(term))) score += 3
    const hits = countOccurrences(body, term)
    if (hits > 0) score += Math.min(6, 1 + Math.log2(hits))
  }
  return score
}

export function makeSnippet(entry, terms) {
  const body = String(entry.text ?? '')
  const lower = body.toLowerCase()
  let at = -1
  for (const term of terms) {
    const index = lower.indexOf(String(term).toLowerCase())
    if (index !== -1 && (at === -1 || index < at)) at = index
  }
  if (at === -1) return body.slice(0, MAX_SNIPPET)
  const start = Math.max(0, at - 40)
  return (start > 0 ? '...' : '') + body.slice(start, start + MAX_SNIPPET).trim()
}

export function safeResolve(vaultDir, relPath) {
  const root = path.resolve(String(vaultDir ?? ''))
  const rel = String(relPath ?? '').trim()
  if (rel === '' || rel.includes('\u0000')) return null
  const abs = path.resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) return null
  return abs
}

export function apply(ctx, config) {
  const vaultDir = strValue(config?.vaultDir) || DEFAULT_VAULT
  const storeDir = strValue(config?.storeDir) || DEFAULT_STORE
  const buildOnStart = config?.buildOnStart !== false
  let lastError = ''

  const note = (error) => { lastError = errText(error).slice(0, 240) }
  const indexFile = () => path.join(storeDir, INDEX_FILE)

  function writeIndex(index) {
    try {
      mkdirSync(storeDir, { recursive: true })
      const payload = JSON.stringify(index)
      if (payload.length > MAX_INDEX_BYTES) { note('index 超过 ' + MAX_INDEX_BYTES + ' 字节，已跳过写盘'); return { ok: false, bytes: 0 } }
      const tmp = indexFile() + '.tmp-' + process.pid
      writeFileSync(tmp, payload, 'utf8')
      renameSync(tmp, indexFile())
      return { ok: true, bytes: payload.length }
    } catch (error) {
      note(error)
      try { unlinkSync(indexFile() + '.tmp-' + process.pid) } catch (ignored) { }
      return { ok: false, bytes: 0 }
    }
  }

  function readIndex() {
    try {
      if (!existsSync(indexFile())) return null
      const parsed = JSON.parse(readFileSync(indexFile(), 'utf8'))
      if (!parsed || parsed.version !== INDEX_VERSION) return null
      return parsed
    } catch (error) {
      note(error)
      return null
    }
  }

  /** 索引缺失/库变过就重建（内存里给一次结果，同时落盘）。 */
  function ensureIndex(force) {
    const started = Date.now()
    // vault 不在就是配置错，不能当「空库」静默返回 0 条（2026-11-01 单测发现）
    if (!existsSync(vaultDir)) {
      note('vault 不存在：' + vaultDir)
      return { ok: false, index: null, rebuilt: false, listing: null, tookMs: Date.now() - started }
    }
    let listing = null
    try { listing = listVault(vaultDir) } catch (error) { note(error) }
    if (!listing) return { ok: false, index: null, rebuilt: false, listing: null, tookMs: Date.now() - started }
    const liveNewest = listing.notes.reduce((max, entry) => Math.max(max, entry.mtime), 0)
    const cached = force ? null : readIndex()
    const stale = !cached || cached.vault !== listing.root || liveNewest > (cached.newestMtime || 0)
    if (!stale) return { ok: true, index: cached, rebuilt: false, listing, tookMs: Date.now() - started }
    const index = buildIndex(vaultDir, Date.now(), listing)
    writeIndex(index)
    return { ok: true, index, rebuilt: true, listing, tookMs: Date.now() - started }
  }

  function indexSummary(index, extra) {
    return {
      ok: true,
      vault: index.vault,
      notes: index.counts.notes,
      bases: index.counts.bases,
      attachments: index.counts.attachments,
      dirs: index.counts.dirs,
      links: index.links.total,
      brokenLinks: index.links.broken,
      parseErrors: index.parseErrors.length,
      newestMtime: index.newestMtime,
      builtAt: index.builtAt,
      indexFile: indexFile(),
      ...(extra || {}),
    }
  }

  // 启动时顺带建一次索引（只读扫库，失败不影响启动）
  if (buildOnStart) {
    try { ensureIndex(false) } catch (error) { note(error) }
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: 'obsidian_status',
      description: 'Read-only health of the Obsidian vault index: counts, link breaks, parse errors, index freshness. Use it after rebuilding to prove the index matches the folder.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            vault: { type: 'string' },
            storeDir: { type: 'string' },
            vaultExists: { type: 'boolean' },
            notes: { type: 'integer' },
            bases: { type: 'integer' },
            attachments: { type: 'integer' },
            dirs: { type: 'integer' },
            links: { type: 'integer' },
            brokenLinks: { type: 'integer' },
            parseErrors: { type: 'integer' },
            indexBuiltAt: { type: 'string' },
            indexStale: { type: 'boolean' },
            indexBytes: { type: 'integer' },
            newestMtime: { type: 'string' },
            lastError: { type: 'string' },
          },
          required: ['ok', 'vault', 'notes', 'bases', 'attachments', 'links', 'brokenLinks', 'parseErrors'],
          additionalProperties: true,
        },
        render(_args, value) {
          return [text(value.ok === false ? 'Obsidian 索引不可用：' + (value.lastError || '未知原因') : 'Obsidian：' + value.notes + ' 篇笔记 / ' + value.bases + ' 个视图 / 链接 ' + value.links + '（断 ' + value.brokenLinks + '）/ 解析失败 ' + value.parseErrors)]
        },
      },
      async execute() {
        try {
          const exists = existsSync(vaultDir)
          if (!exists) return { ok: false, vault: vaultDir, storeDir, vaultExists: false, notes: 0, bases: 0, attachments: 0, dirs: 0, links: 0, brokenLinks: 0, parseErrors: 0, lastError: lastError || 'vault 不存在：' + vaultDir }
          const cached = readIndex()
          const listing = listVault(vaultDir)
          const liveNewest = listing.notes.reduce((max, entry) => Math.max(max, entry.mtime), 0)
          let bytes = 0
          try { bytes = existsSync(indexFile()) ? statSync(indexFile()).size : 0 } catch (error) { note(error) }
          return {
            ok: cached !== null,
            vault: vaultDir,
            storeDir,
            vaultExists: true,
            notes: cached ? cached.counts.notes : listing.notes.length,
            bases: cached ? cached.counts.bases : listing.bases.length,
            attachments: cached ? cached.counts.attachments : listing.attachments,
            dirs: cached ? cached.counts.dirs : listing.dirs.length,
            links: cached ? cached.links.total : 0,
            brokenLinks: cached ? cached.links.broken : 0,
            parseErrors: cached ? cached.parseErrors.length : 0,
            indexBuiltAt: cached ? new Date(cached.builtAt).toISOString() : '',
            indexStale: !cached || liveNewest > (cached.newestMtime || 0),
            indexBytes: bytes,
            newestMtime: liveNewest ? new Date(liveNewest).toISOString() : '',
            lastError,
            live: { notes: listing.notes.length, bases: listing.bases.length, attachments: listing.attachments },
          }
        } catch (error) {
          note(error)
          return { ok: false, vault: vaultDir, storeDir, vaultExists: false, notes: 0, bases: 0, attachments: 0, dirs: 0, links: 0, brokenLinks: 0, parseErrors: 0, lastError }
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'obsidian_index',
      description: 'Rebuild the read-only Obsidian index from the vault (writes only <storeDir>/index.json, never the vault). Returns counts and duration so the rebuild can be verified.',
      parameters: { type: 'object', properties: { force: { type: 'boolean', description: 'Rebuild even when the cached index looks fresh. Default false.' } }, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' }, vault: { type: 'string' }, notes: { type: 'integer' }, bases: { type: 'integer' },
            attachments: { type: 'integer' }, links: { type: 'integer' }, brokenLinks: { type: 'integer' },
            parseErrors: { type: 'integer' }, bytes: { type: 'integer' }, tookMs: { type: 'integer' },
            rebuilt: { type: 'boolean' }, indexFile: { type: 'string' }, lastError: { type: 'string' },
          },
          required: ['ok', 'notes', 'links', 'brokenLinks'],
          additionalProperties: true,
        },
        render(_args, value) {
          return [text(value.ok === true ? '索引已重建：' + value.notes + ' 篇 / 链接 ' + value.links + '（断 ' + value.brokenLinks + '）/ ' + value.tookMs + 'ms' : '索引重建失败：' + (value.lastError || '未知原因'))]
        },
      },
      async execute(args) {
        const started = Date.now()
        try {
          const result = ensureIndex(args?.force === true)
          if (!result.ok || !result.index) return { ok: false, lastError: lastError || 'vault 不可读', tookMs: Date.now() - started }
          const index = result.index
          let bytes = 0
          try { bytes = statSync(indexFile()).size } catch (error) { note(error) }
          return indexSummary(index, {
            bytes,
            tookMs: Date.now() - started,
            rebuilt: true,
            lastError,
          })
        } catch (error) {
          note(error)
          return { ok: false, lastError, tookMs: Date.now() - started }
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'obsidian_search',
      description: 'Search the Obsidian vault index (title/alias/tag/body scoring). Read-only; rebuilds the index in memory when it is missing or stale.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords; Chinese or English, space-separated is fine.' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max hits (default 10).' },
          type: { type: 'string', description: 'Filter by frontmatter type, e.g. person / journal / index.' },
          domain: { type: 'string', description: 'Filter by frontmatter domain, e.g. life / build.' },
          tag: { type: 'string', description: 'Filter by a tag.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' }, query: { type: 'string' }, total: { type: 'integer' }, matched: { type: 'integer' },
            rebuilt: { type: 'boolean' }, results: { type: 'array', items: { type: 'object', additionalProperties: true } },
            lastError: { type: 'string' },
          },
          required: ['ok', 'query', 'matched', 'results'],
          additionalProperties: true,
        },
        render(_args, value) {
          if (value.ok === false) return [text('检索失败：' + (value.lastError || '未知原因'))]
          if (!value.results.length) return [text('「' + value.query + '」没有命中（索引 ' + value.total + ' 篇）')]
          const lines = value.results.slice(0, 8).map((item) => '- ' + item.path + '（' + item.score + '）' + (item.snippet ? '：' + item.snippet.slice(0, 60) : ''))
          return [text('「' + value.query + '」命中 ' + value.matched + ' 条 / 索引 ' + value.total + ' 篇：\n' + lines.join('\n'))]
        },
      },
      async execute(args) {
        try {
          const query = strValue(args?.query)
          if (query === '') return { ok: false, query, total: 0, matched: 0, results: [], lastError: 'query 为空' }
          const limitRaw = Number(args?.limit)
          const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : 10
          const result = ensureIndex(false)
          if (!result.ok || !result.index) return { ok: false, query, total: 0, matched: 0, results: [], lastError: lastError || 'vault 不可读' }
          const index = result.index
          const terms = tokenize(query)
          const type = strValue(args?.type).toLowerCase()
          const domain = strValue(args?.domain).toLowerCase()
          const tag = strValue(args?.tag).toLowerCase()
          const pool = index.notes.filter((entry) => {
            if (type !== '' && String(entry.type ?? '').toLowerCase() !== type) return false
            if (domain !== '' && String(entry.domain ?? '').toLowerCase() !== domain) return false
            if (tag !== '' && !(entry.tags || []).some((item) => String(item).toLowerCase() === tag)) return false
            return true
          })
          const scored = []
          for (const entry of pool) {
            const score = scoreNote(entry, terms)
            if (score > 0) scored.push({ entry, score })
          }
          scored.sort((left, right) => right.score - left.score || String(left.entry.path).localeCompare(String(right.entry.path)))
          const results = scored.slice(0, limit).map((item) => ({
            path: item.entry.path,
            name: item.entry.name,
            title: item.entry.title,
            type: item.entry.type,
            domain: item.entry.domain,
            tags: item.entry.tags,
            score: Math.round(item.score * 100) / 100,
            snippet: makeSnippet(item.entry, terms),
          }))
          return { ok: true, query, total: pool.length, matched: scored.length, rebuilt: result.rebuilt, results, lastError }
        } catch (error) {
          note(error)
          return { ok: false, query: strValue(args?.query), total: 0, matched: 0, results: [], lastError }
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'obsidian_note',
      description: 'Read one note from the vault by vault-relative path (frontmatter + body + outgoing links). Path traversal is rejected; the vault is never written.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Vault-relative path, e.g. 10-Life/15-People/Me.md (or without .md).' },
          maxChars: { type: 'integer', minimum: 200, maximum: 60000, description: 'Body cap (default 20000).' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' }, path: { type: 'string' }, name: { type: 'string' },
            frontmatter: { type: 'object', additionalProperties: true }, body: { type: 'string' },
            links: { type: 'array', items: { type: 'object', additionalProperties: true } },
            truncated: { type: 'boolean' }, lastError: { type: 'string' },
          },
          required: ['ok', 'path'],
          additionalProperties: true,
        },
        render(_args, value) {
          if (value.ok === false) return [text('读取失败：' + (value.lastError || '未知原因'))]
          return [text(value.path + '（' + value.body.length + ' 字符' + (value.truncated ? '，已截断' : '') + '）')]
        },
      },
      async execute(args) {
        try {
          const rel = strValue(args?.path)
          if (rel === '') return { ok: false, path: '', lastError: 'path 为空' }
          const abs = safeResolve(vaultDir, rel)
          if (!abs) return { ok: false, path: rel, lastError: '路径越界：只允许 vault 内部路径' }
          const candidates = [abs, abs + '.md']
          let target = ''
          for (const candidate of candidates) {
            if (existsSync(candidate) && statSync(candidate).isFile()) { target = candidate; break }
          }
          if (target === '') return { ok: false, path: rel, lastError: '文件不存在：' + rel }
          if (path.extname(target).toLowerCase() !== '.md') return { ok: false, path: rel, lastError: '只支持 .md' }
          const info = statSync(target)
          if (info.size > MAX_NOTE_BYTES) return { ok: false, path: rel, lastError: '文件超过 ' + MAX_NOTE_BYTES + ' 字节' }
          const raw = readFileSync(target, 'utf8')
          const parsed = parseFrontmatter(raw)
          const capRaw = Number(args?.maxChars)
          const cap = Number.isInteger(capRaw) && capRaw > 0 ? Math.min(capRaw, 60000) : 20000
          const body = parsed.body.length > cap ? parsed.body.slice(0, cap) : parsed.body
          return {
            ok: true,
            path: path.relative(path.resolve(vaultDir), target).split(path.sep).join('/'),
            name: baseName(target),
            frontmatter: parsed.data,
            body,
            links: extractLinks(parsed.body).map((link) => ({ embed: link.embed, target: normalizeTarget(link.target) })),
            truncated: parsed.body.length > cap,
            lastError,
          }
        } catch (error) {
          note(error)
          return { ok: false, path: strValue(args?.path), lastError }
        }
      },
    }),
  )
}
