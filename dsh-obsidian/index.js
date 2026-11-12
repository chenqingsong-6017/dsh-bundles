/**
 * dsh-obsidian v0.4.1 —— Obsidian 库索引（P1 只读）+ 受控写（P2：白名单 / 默认不覆盖 / 冲突即放弃）。
 *
 * 为什么需要它：vault 是人的成品层，AI 要查画像/日志/调研结论时只能 glob + read 逐个翻；
 * 库一大就会问「哪张卡讲过 X」「断链断在哪」。这个插件把 vault 扫成一份索引（落在 D 盘），
 * 提供 search / note / status 三个只读工具。写入归 P2（受控写），另做。
 *
 * 三条约束（与 _research/obsidian-vault-plan-2026-11.md §5 一致）：
 * ① 写只走 obsidian_write：白名单内、create 绝不覆盖、hash/mtime 不符即放弃；索引写 <storeDir>/index.json（临时文件 + rename 原子替换）；
 * ② fail-safe：扫描/解析失败只记 lastError，绝不抛给会话；
 * ③ 不重复：检索用词项打分，够用就行；向量/图谱等有触发线再说。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'

export const name = 'dsh-obsidian'
export const inject = ['tools']

export const INDEX_VERSION = 2 // v0.5.0：收录目录摘要 .abstract.md（type=sidecar），旧索引必须重建
const DEFAULT_VAULT = 'D:\\AI-date\\obsidian\\vault'
const DEFAULT_STORE = 'D:\\AI\\dsh-data\\obsidian'
const DEFAULT_MEMORY = 'D:\\AI\\dsh-data\\memory\\memory.json'
const INDEX_FILE = 'index.json'
const MAX_NOTE_BYTES = 512 * 1024
const MAX_TEXT_CHARS = 8000
const MAX_SNIPPET = 160
const MAX_INDEX_BYTES = 32 * 1024 * 1024
const SKIP_DIRS = new Set(['.obsidian', '.git', 'node_modules', '.trash', '.dsh-vision-router'])
// v0.5.0（2026-11-12）：唯一允许进索引的点文件——目录摘要 L0（生成器 _ops/vault-abstract.mjs）。
// .overview.md 体积大、内容与正文重复，不收录（需要时 obsidian_note 直读文件）。
const SIDECAR_ABSTRACT = '.abstract.md'
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
      // v0.5.0（2026-11-12）：点文件只收录目录摘要 .abstract.md（L0）。之前 v0.2.x 一律跳过，
      // 后果是 sidecar 生成后检索侧完全看不见（2026-11-12 审计：17/17 未收录），「记忆只存 L0 指针」不成立。
      // 现在收录它、但标 type=sidecar 并让页面契约检查豁免；.overview.md 与其他点文件仍跳过。
      const isSidecar = entry.name === SIDECAR_ABSTRACT
      if (entry.name.startsWith('.') && !isSidecar) continue
      const ext = path.extname(entry.name).toLowerCase()
      // sidecar 不进 allNames：否则正文里的 [[.abstract]] 之类会解析到它（它不是可跳转的笔记）。
      if (!isSidecar) {
        allNames.add(entry.name.toLowerCase())
        allNames.add(baseName(entry.name).toLowerCase())
      }
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
    // v0.5.0：目录摘要没有 frontmatter，不能按页面契约解析；它的检索文本就是 L0 全文。
    if (file.name === SIDECAR_ABSTRACT) {
      let sidecarRaw = ''
      try {
        sidecarRaw = file.size > MAX_NOTE_BYTES ? '' : readFileSync(file.abs, 'utf8')
      } catch (error) {
        parseErrors.push({ path: file.rel, reason: errText(error).slice(0, 120) })
        continue
      }
      const l0 = compact(sidecarRaw, 200)
      const dirLabel = file.rel.includes('/') ? file.rel.slice(0, file.rel.lastIndexOf('/')) : ''
      const sidecarEntry = {
        path: file.rel,
        name: baseName(file.rel),
        title: l0 || dirLabel || '目录摘要',
        type: 'sidecar',
        domain: '',
        status: 'active',
        review: '',
        tier: '',
        confidence: '',
        id: '',
        tags: [],
        aliases: [],
        mtime: file.mtime,
        size: file.size,
        links: [],
        text: l0,
        oneLiner: true,
      }
      notes.push(sidecarEntry)
      byPath.set(sidecarEntry.path.toLowerCase(), sidecarEntry.path)
      byPath.set(sidecarEntry.path.toLowerCase().replace(/\.md$/, ''), sidecarEntry.path)
      continue
    }
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
      // 结论头在索引期算一次（剥掉 fenced code）；超大文件读不到正文 = null，lint 不拿它判定
      oneLiner: file.size > MAX_NOTE_BYTES ? null : hasOneLiner(stripFencedCode(parsed.body)),
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
  // v0.4.1（H3）：显式拒绝任何含 .. 段的输入（读路径也一视同仁，别让 ../ 之后再靠 relative 兜）
  if (hasTraversalSegment(rel)) return null
  const abs = path.resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) return null
  // v0.4.1（H3）：再按相对路径复核一次 —— 前缀比较足够挡「越出 vault」，
  // 但「vault 内的 ..」要靠 relative 判定才看得见（如 ai-drafts/../10-Life/x）。
  const back = path.relative(root, abs)
  if (back === '' || path.isAbsolute(back) || back.split(path.sep).includes('..')) return null
  return abs
}

export const DEFAULT_WRITE_ALLOWLIST = ['00-Inbox/ai-drafts/']
const WRITE_DENY_PREFIXES = ['.obsidian/', '90-Shared/91-Templates/']
const POINTER_RE = /vault:\/\/([^\s)\]"'，,；;。、：！？」）】]+)/g

/**
 * v0.4.1（H3）：路径里有没有父目录段（`..`）——含百分号编码绕过（`%2e%2e` = `..`）。
 * 为什么单独一个函数：`..` 穿越是写白名单唯一的绕过口（审计 global-audit-memory-2026-11-03 §1 H3），
 * 三处（normalize / isWriteAllowed / obsidian_write）都要用同一个判据，不能各写一套。
 */
export function hasTraversalSegment(relPath) {
  const raw = String(relPath ?? '').replace(/\\/g, '/')
  const variants = [
    raw,
    // 只解 %2e/%2f/%5c 三种：不整串 decodeURIComponent（合法文件名里的 % 不该被判成穿越）
    raw.replace(/%2e/gi, '.').replace(/%2f|%5c/gi, '/'),
  ]
  return variants.some((value) => value.split('/').some((segment) => segment === '..'))
}

/** vault 相对路径归一：去引号 / 反斜杠转正斜杠 / 去前导 ./ 与 / / 折叠 . 与 .. / 自动补 .md
 *  v0.4.1（H3）：含 `..` 段的输入一律返回 ''（拒绝），调用方据此报错——不折叠成别的路径。 */
export function normalizeVaultPath(relPath) {
  let rel = String(relPath ?? '').trim().replace(/^["']+|["']+$/g, '').replace(/\\/g, '/')
  while (rel.startsWith('./')) rel = rel.slice(2)
  rel = rel.replace(/^\/+/, '')
  if (rel === '') return ''
  // 先拒绝父目录段，再做 posix.normalize（顺序不能反：normalize 会把 ai-drafts/../.. 悄悄折叠掉）
  if (hasTraversalSegment(rel)) return ''
  rel = path.posix.normalize(rel)
  if (rel === '' || rel === '.' || rel.startsWith('../')) return ''
  if (hasTraversalSegment(rel)) return ''
  if (!rel.toLowerCase().endsWith('.md')) rel += '.md'
  return rel
}

/** 写白名单判定：受保护前缀优先拒，其次必须命中 allowlist。
 *  2026-11-02 修 #21：Windows 路径大小写不敏感，比较前统一 toLowerCase()，
 *  否则 00-inbox/、00-Inbox/AI-Drafts/ 会被误拒，90-shared/91-templates/ 会绕过保护区判定。
 *  v0.4.1（H3）：判定前先规范化——`00-Inbox/ai-drafts/../../10-Life/x.md` 原本靠前缀命中被判 allow，
 *  实际写到 10-Life。现在：含 `..` 段直接拒；deny/allow 前缀都用规范化后的相对路径比对。 */
export function isWriteAllowed(relPath, allowlist) {
  const input = String(relPath ?? '').replace(/\\/g, '/')
  if (hasTraversalSegment(input)) return { allowed: false, reason: '路径含 .. 段（禁止穿越白名单）' }
  const normalized = path.posix.normalize(input.replace(/^\/+/, ''))
  if (normalized === '..' || normalized.startsWith('../')) return { allowed: false, reason: '路径越界（..）' }
  const rel = normalized.toLowerCase()
  const denied = WRITE_DENY_PREFIXES.find((prefix) => {
    const lower = prefix.toLowerCase()
    return rel === lower.slice(0, -1) || rel.startsWith(lower)
  })
  if (denied) return { allowed: false, reason: '受保护目录：' + denied }
  const list = Array.isArray(allowlist) && allowlist.length > 0 ? allowlist.map(String) : DEFAULT_WRITE_ALLOWLIST
  const hit = list.find((prefix) => rel.startsWith(String(prefix).replace(/\\/g, '/').toLowerCase()))
  if (!hit) return { allowed: false, reason: '不在写白名单内（允许写：' + list.join(' / ') + '）' }
  return { allowed: true, reason: '' }
}

/** 内容指纹：冲突检测用（Basic Memory 同源思路：sha256 作 generation） */
export function sha256(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')
}

/** 标题归一：去 # 前缀、首尾空白，以及尾随冒号（2026-11-02 修 #22：「观测：」等同「观测」） */
function normalizeHeading(value) {
  return String(value ?? '')
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/[\s:：]+$/, '')
    .trim()
}

/* ------------------------------------------------------------------
 * 锚点（heading slug）与「一句话」结论头：两条都是「同一种写法有多种变体」的问题。
 *
 * 借鉴卡 · github-slugger 2.0.0（ISC，https://github.com/Flet/github-slugger）
 *   机制：slug = 小写 → 按固定字符集去标点/符号/控制符（保留 _ 与 -）→ 空格逐个转 -。
 *   我们自实现（不引运行时依赖，插件是零依赖单文件），规则对齐它；期望值用它的实测输出写进
 *   _selftest/tests/obsidian.test.mjs，测试运行时**不依赖** tmp 目录里的 clone。
 *
 * 借鉴卡 · obsidian-linter（MIT，https://github.com/platers/obsidian-linter）
 *   机制：用 mdast 按**结构**判定 strong/emphasis（src/utils/mdast.ts:59 MDAstTypes、:661
 *   makeEmphasisOrBoldConsistent），而不是匹配某一种字面写法；同义的 **x** 与 __x__ 因此一视同仁。
 *   我们只借这个判断思路（「结论头是结构，不是字面量」），用一条正则覆盖 `*`/`_` 包裹与 `>` 引用前缀，
 *   不引 mdast/unified：为一个 8 字标记引一棵语法树不划算，且插件要能在任意 DSH 进程里零依赖跑。
 * ------------------------------------------------------------------ */

/** GitHub 风格 heading 锚点；与 github-slugger 2.0.0 实测一致（含「连续空格转 --，不塌缩」）。 */
export function slugifyHeading(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\p{C}\p{P}\p{S}]/gu, (char) => (char === '_' || char === '-' ? char : ''))
    .replace(/ /g, '-')
}

/** 标题的前导片段 slug（在标点 / 空白 / 连字符处断开）。
 *  'skill-forge 的接线位置' → ['skill', 'skill-forge']；'先查官方有没有，再自研' → ['先查官方有没有']。
 *  用途：区分「整词前缀」与「裸 startsWith」——skill 在前导片段里，skill-fo / forge 不在。 */
function prefixSlugs(text) {
  const clean = String(text ?? '').replace(/\s+#+\s*$/, '').trim()
  if (clean === '') return []
  const boundary = /[\s，,、;；:：/／|·…\-（）()【】\[\]]/
  const out = []
  for (let i = 0; i < clean.length; i += 1) {
    if (!boundary.test(clean[i])) continue
    const prefix = slugifyHeading(clean.slice(0, i))
    if (prefix !== '' && !out.includes(prefix)) out.push(prefix)
  }
  return out
}

/** 正文标题清单（跳过 fenced code；frontmatter 由调用方先剥）。number = 标题前导节号（如 3.2 / 2 / 10）。 */
export function headingAnchors(body) {
  const out = []
  let inFence = false
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    const raw = match[2].replace(/\s+#+\s*$/, '').trim()
    if (raw === '') continue
    const numeric = /^(\d+(?:\.\d+)*)\.?(?=\s|$)/.exec(raw)
    out.push({ level: match[1].length, text: raw, slug: slugifyHeading(raw), number: numeric ? numeric[1] : '', prefixes: prefixSlugs(raw) })
  }
  return out
}

/** 锚点能不能落到某个标题上。三条规则（顺序即优先级）：
 *  ① slug 全等——GitHub / Obsidian 的标准写法（标题里带逗号也能对上：slug 会去掉标点）；
 *  ② 数字节号——锚点形如 2 / 3.2，命中标题前导节号（库里 `#2`、`#3.2` 就是这一条）；
 *  ③ 前导片段——锚点是标题在标点/空白/连字符处断开后的**前导片段**的 slug（skill-forge 之于
 *     skill-forge 的接线位置；先查官方有没有 之于 先查官方有没有，再自研）。
 *     与裸 startsWith 的区别：skill-fo 不算（半截词）、forge 不算（不在前导片段里）、记忆清理 不算
 *     （它不是「3.2 记忆清理红线」的前导片段——前导片段从标题第一个字开始）。
 *  为什么不用严格 GitHub 规则：2026-11-02 实测真实 25 条指针，严格规则只过 4 条、误报 21 条；
 *  ②③ 是我们的指针约定（见 README「记忆指针约定」），不是 GitHub 的语义，所以分开实现并写进测试。 */
export function matchHeadingAnchor(anchor, headings) {
  const raw = String(anchor ?? '').trim()
  if (raw === '') return { ok: false, by: '' }
  const needle = raw.toLowerCase()
  const needleSlug = slugifyHeading(raw)
  const list = Array.isArray(headings) ? headings : []
  // ① 用「锚点 slug」比「标题 slug」：锚点里带逗号/标点也能对上（GitHub 链接里锚点本来就是 slug 化后的）
  for (const head of list) if (head.slug !== '' && head.slug === needleSlug) return { ok: true, by: 'slug' }
  const numeric = /^\d+(?:\.\d+)*$/.test(needle)
  if (numeric) {
    for (const head of list) if (head.number !== '' && head.number === needle) return { ok: true, by: 'section-number' }
  }
  if (needleSlug.length >= 2) {
    for (const head of list) {
      const prefixes = Array.isArray(head.prefixes) ? head.prefixes : prefixSlugs(head.text)
      if (prefixes.some((prefix) => prefix === needleSlug)) return { ok: true, by: 'slug-prefix' }
    }
  }
  return { ok: false, by: '' }
}

/** 去掉 fenced code 块：代码块里的示例文本不算结论头。 */
function stripFencedCode(body) {
  return String(body ?? '').replace(/^\s*(```|~~~)[^\n]*\n[\s\S]*?^\s*(```|~~~)[^\n]*$/gm, '')
}

/** 「一句话」结论头：按**结构**判，不认字面量 `**一句话**`。
 *  过：`> 一句话：…` / `> **一句话**：…` / `> __一句话__：…` / `> **一句话**: …`；
 *  不过：标题 `## 5. 一句话结论`、正文里提到「一句话，」这类（标记后面必须紧跟冒号）。 */
const ONE_LINER_RE = /(?:^|[\s>])[*_]{0,2}一句话[*_]{0,2}[：:]/
export function hasOneLiner(value) {
  return ONE_LINER_RE.test(String(value ?? ''))
}

/** 定位 section 区间：标题行之后到下一个同级或更高级标题之前 */
export function sectionRange(body, section) {
  const bare = normalizeHeading(section)
  if (bare === '') return null
  const lines = String(body ?? '').split(/\r?\n/)
  let start = -1
  let level = 0
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i])
    if (!match || normalizeHeading(match[2]) !== bare) continue
    start = i
    level = match[1].length
    break
  }
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    const match = /^(#{1,6})\s+/.exec(lines[i])
    if (match && match[1].length <= level) { end = i; break }
  }
  return { startLine: start, endLine: end, level }
}

/** 按 section 局部替换，返回新正文；找不到标题返回 null（绝不整篇覆盖） */
export function applySection(body, section, content) {
  const range = sectionRange(body, section)
  if (!range) return null
  const lines = String(body ?? '').split(/\r?\n/)
  const blockLines = String(content ?? '').replace(/\r\n/g, '\n').split('\n')
  const merged = [...lines.slice(0, range.startLine + 1), '', ...blockLines, '', ...lines.slice(range.endLine)]
  const out = []
  for (const line of merged) {
    if (line === '' && out.length > 0 && out[out.length - 1] === '') continue
    out.push(line)
  }
  return out.join('\n').replace(/\n+$/, '') + '\n'
}

/** 从记忆文本里抽 vault:// 指针（约定写法：vault://相对路径） */
export function parseMemoryPointers(value) {
  const found = new Set()
  const source = String(value ?? '')
  POINTER_RE.lastIndex = 0
  let match
  while ((match = POINTER_RE.exec(source)) !== null) {
    const cleaned = match[1].replace(/[.,;:!?]+$/, '')
    if (cleaned !== '') found.add(cleaned)
  }
  return [...found]
}

/**
 * 记忆条目读取（单一入口，口径与 _ops/metric-probes.mjs:54-87 一致）：
 * v4.1 起权威存储是同目录的 SQLite `memory.db`（memory.json 已冻结）；没有 DB / 打不开 → 回退 memory.json。
 * 返回 { entries, source, file, error? }：entries 为 null 表示两处都读不到（由调用方判空，fail-safe）；
 * source = 'sqlite' | 'json'，file = 实际读取的文件——诊断用，防止「以为读了 db、其实读了 json」。
 * 为什么要有它：2026-11-02 前 memoryPointerReport 直读 memory.json，报的是旧快照。
 * v0.4.1（M4）：DB 能打开但 0 条时**不再当正常**——可能是「回滚 storage:json 后 DB 冻结」或空 schema 库，
 *   此时若 memory.json 有条目就回退 JSON，并在 note 里写明原因（原实现只判 existsSync(memory.db)，
 *   空库会让断链检查报「0 条 0 断 ok:true」，即假绿）。
 */
function readJsonEntries(memFile) {
  if (!existsSync(memFile)) return { entries: null, source: 'json', file: memFile, error: '记忆文件不存在：' + memFile }
  try {
    const parsed = JSON.parse(readFileSync(memFile, 'utf8'))
    if (!Array.isArray(parsed?.entries)) return { entries: null, source: 'json', file: memFile, error: '记忆文件没有 entries 数组：' + memFile }
    return { entries: parsed.entries, source: 'json', file: memFile }
  } catch (error) {
    return { entries: null, source: 'json', file: memFile, error: errText(error).slice(0, 200) }
  }
}

export function readMemoryEntries(memoryPath) {
  const memFile = String(memoryPath ?? '')
  const dbFile = path.join(path.dirname(memFile), 'memory.db')
  if (existsSync(dbFile)) {
    try {
      const requireModule = createRequire(import.meta.url)
      const { DatabaseSync } = requireModule('node:sqlite')
      const database = new DatabaseSync(dbFile, { readOnly: true })
      try {
        const rows = database.prepare('SELECT payload FROM entries ORDER BY seq').all()
        const entries = []
        for (const row of rows) {
          try {
            const parsed = JSON.parse(row.payload)
            if (parsed !== null && typeof parsed === 'object' && typeof parsed.text === 'string') entries.push(parsed)
          } catch (error) {
            // 单条坏 payload 跳过（与插件加载口径一致）
          }
        }
        if (entries.length > 0) return { entries, source: 'sqlite', file: dbFile, entryCount: entries.length }
        // v0.4.1（M4）：空 DB 不再当成「0 条正常」——先看 memory.json，有货就回退并留 note。
        const fallback = readJsonEntries(memFile)
        if (fallback.entries !== null && fallback.entries.length > 0) {
          return {
            ...fallback,
            dbFile,
            entryCount: fallback.entries.length,
            note: `memory.db 可打开但 0 条，已回退 memory.json（${fallback.entries.length} 条）：DB 可能是回滚前的冻结快照或空库`,
          }
        }
        return {
          entries,
          source: 'sqlite',
          file: dbFile,
          dbFile,
          entryCount: 0,
          note: 'memory.db 0 条，memory.json 也没有可用条目（断链检查将显示 0 条）',
        }
      } finally {
        database.close()
      }
    } catch (error) {
      // node:sqlite 不可用 / DB 打不开：回退 JSON（fail-safe，读取方自己判空）
      return { ...readJsonEntries(memFile), dbFile, note: 'memory.db 打不开（' + errText(error).slice(0, 120) + '），已回退 memory.json' }
    }
  }
  return readJsonEntries(memFile)
}

/** 页面契约检查：只做五条能从「找得到/信得过/改得动」倒推出来的规则 */
export function lintIndex(index, options) {
  const opts = options || {}
  const skipPrefixes = Array.isArray(opts.skipPrefixes)
    ? opts.skipPrefixes.map((item) => String(item).toLowerCase())
    : ['90-shared/91-templates/', '95-archive/']
  const pointerTargets = opts.pointerTargets || null
  const issues = []
  const idSeen = new Map()
  for (const entry of index.notes) {
    const rel = String(entry.path ?? '')
    const lower = rel.toLowerCase()
    if (skipPrefixes.some((prefix) => prefix !== '' && lower.startsWith(prefix))) continue
    // v0.5.0：目录摘要不是页面（无 frontmatter / 无 id / 无「一句话」），契约检查豁免它。
    if (String(entry.type ?? '').toLowerCase() === 'sidecar') continue
    const isIndex = /(^|\/)_index\.md$/i.test(rel)
    const type = String(entry.type ?? '').toLowerCase()
    for (const field of ['type', 'domain', 'status']) {
      if (String(entry[field] ?? '').trim() === '') issues.push({ level: 'error', code: 'missing_field', path: rel, detail: '缺 ' + field })
    }
    if (isIndex && type !== '' && type !== 'index') issues.push({ level: 'warn', code: 'index_named_content', path: rel, detail: '文件名是 _index.md，但 type=' + type + '（内容页占了导航名）' })
    if (!isIndex && type === 'index' && rel.includes('/')) issues.push({ level: 'warn', code: 'content_named_index', path: rel, detail: 'type=index，但文件名不是 _index.md（根级导航页如 Home.md 豁免）' })
    // 结论头：认结构不认字面量（`> 一句话：` 与 `> **一句话**：`、`__` 加粗、半角冒号都算过）
    // oneLiner=false 由索引期算出（已剥 fenced code）；旧索引没有该字段时退回扁平文本判断
    const oneLinerFlag = entry.oneLiner
    const hasConclusion = oneLinerFlag === true || (oneLinerFlag === undefined && hasOneLiner(entry.text))
    if (!isIndex && type !== 'index' && type !== 'journal' && !hasConclusion) issues.push({ level: 'warn', code: 'missing_one_liner', path: rel, detail: '正文缺「一句话」结论头（接受 `> 一句话：` / `> **一句话**：` 等写法；journal 免检：日志是过程记录）' })
    const id = String(entry.id ?? '').trim()
    if (id !== '') {
      if (idSeen.has(id)) issues.push({ level: 'error', code: 'duplicate_id', path: rel, detail: 'id 重复（先出现于 ' + idSeen.get(id) + '）：' + id })
      else idSeen.set(id, rel)
    }
    if (pointerTargets !== null && pointerTargets.has(lower) && String(entry.status ?? '').trim() !== 'active') {
      issues.push({ level: 'error', code: 'pointer_to_inactive', path: rel, detail: '被记忆指针指向，但 status=' + (String(entry.status ?? '').trim() || '(空)') + '（指向草稿/归档 = 指向未定）' })
    }
  }
  const errorCount = issues.filter((issue) => issue.level === 'error').length
  return { total: index.notes.length, errorCount, warnCount: issues.length - errorCount, issues }
}

/**
 * 记忆指针落地检查（单一实现，导出给体检复用）：vault:// 指针能否落到真实文件与真实锚点。
 * 为什么抽出来：obsidian_status 与 _ops/system-health 必须同一口径，两处各写一份就会
 * 「一边说断、一边说不断」（2026-11-05 对抗性检查后收口）。
 * @param {string} memoryText 记忆正文（多条目换行拼接）
 * @param {string} vaultDir vault 根目录
 * @param {(abs:string)=>string[]|null} [headingReader] 可选注入的标题读取器（插件内传带缓存的版本）
 * @returns {{total:number, checked:boolean, fileMissing:number, anchorMissing:number, anchorChecked:number, anchorSkipped:number, broken:Array<{pointer:string, kind:string}>}}
 */
export function checkMemoryPointers(memoryText, vaultDir, headingReader) {
  const result = { total: 0, checked: true, fileMissing: 0, anchorMissing: 0, anchorChecked: 0, anchorSkipped: 0, broken: [] }
  const readHeads = typeof headingReader === 'function' ? headingReader : defaultHeadingReader
  const cache = new Map()
  const headsOf = (abs) => {
    if (!cache.has(abs)) cache.set(abs, readHeads(abs))
    return cache.get(abs)
  }
  for (const pointer of [...new Set(parseMemoryPointers(memoryText))]) {
    result.total += 1
    const raw = String(pointer)
    const hashAt = raw.indexOf('#')
    const clean = hashAt === -1 ? raw : raw.slice(0, hashAt)
    const anchor = hashAt === -1 ? '' : raw.slice(hashAt + 1)
    const abs = safeResolve(vaultDir, normalizeVaultPath(clean))
    if (abs === null || !existsSync(abs)) {
      result.fileMissing += 1
      result.broken.push({ pointer: raw, kind: 'file-missing' })
      continue
    }
    if (anchor === '') continue
    const heads = headsOf(abs)
    if (heads === null) {
      // 读不到正文 / 超限：这次不判锚点。宁可漏判，也不要把「读失败」说成「锚点缺失」。
      result.anchorSkipped += 1
      continue
    }
    result.anchorChecked += 1
    if (!matchHeadingAnchor(anchor, heads).ok) {
      result.anchorMissing += 1
      result.broken.push({ pointer: raw, kind: 'anchor-missing' })
    }
  }
  return result
}

/** 无缓存版标题读取（体检等一次性调用用） */
function defaultHeadingReader(abs) {
  try {
    const info = statSync(abs)
    if (info.size > MAX_NOTE_BYTES) return null
    return headingAnchors(parseFrontmatter(readFileSync(abs, 'utf8')).body)
  } catch {
    return null
  }
}

/** 记忆里 vault:// 指针指向的相对路径集合（剥锚点，统一小写） */
export function pointerTargetsOf(memoryText) {
  const set = new Set()
  for (const pointer of parseMemoryPointers(memoryText)) {
    // v0.4.1（H3）：含 .. 的指针归一后是 ''，不进目标集合（否则空串会和别的东西撞）
    const target = normalizeVaultPath(String(pointer).split('#')[0]).toLowerCase()
    if (target !== '') set.add(target)
  }
  return set
}

export function apply(ctx, config) {
  const vaultDir = strValue(config?.vaultDir) || DEFAULT_VAULT
  const storeDir = strValue(config?.storeDir) || DEFAULT_STORE
  const buildOnStart = config?.buildOnStart !== false
  const memoryPath = strValue(config?.memoryPath) || DEFAULT_MEMORY
  const writeEnabled = config?.writeEnabled !== false
  const writeAllowlist = Array.isArray(config?.writeAllowlist) && config.writeAllowlist.length > 0
    ? config.writeAllowlist.map(String)
    : DEFAULT_WRITE_ALLOWLIST
  let lastError = ''
  /** 指针锚点校验的标题缓存：一次 status 调用里同一文件只读一次 */
  const headingCache = new Map()

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

  /** 文件 -> 标题清单（锚点校验用）。读不到正文 / 超 MAX_NOTE_BYTES 返回 null：这次不判锚点，
   *  宁可漏判也不要把「读失败」说成「锚点缺失」（fail-safe）。 */
  function headingsOfNote(abs) {
    if (headingCache.has(abs)) return headingCache.get(abs)
    let heads = null
    try {
      const info = statSync(abs)
      if (info.size <= MAX_NOTE_BYTES) heads = headingAnchors(parseFrontmatter(readFileSync(abs, 'utf8')).body)
    } catch (error) {
      note(error)
      heads = null
    }
    headingCache.set(abs, heads)
    return heads
  }

  /** 记忆指针漂移检查：记忆库里的 vault:// 指针能不能落到真实文件**与真实锚点**（仿 Basic Memory sync_status）
   *  2026-11-02 修：原实现只判文件存在，`#锚点` 那半截被丢掉——「文件在、锚点不在」被当成 OK。
   *  2026-11-02 v0.4.0 修：数据源改走 readMemoryEntries（memory.db 权威、memory.json 已冻结），
   *  并加 source / storeFile / entryCount 三个诊断字段——「检查在跑、数字是旧快照」要能从输出上看出来。
   *  broken 用 kind 区分 file-missing / anchor-missing；pointer / memoryIds 保持向后兼容。 */
  function memoryPointerReport() {
    const report = { file: memoryPath, source: '', storeFile: '', entryCount: 0, checked: false, ok: true, total: 0, anchorChecked: 0, anchorSkipped: 0, fileMissing: 0, anchorMissing: 0, broken: [], sample: [], note: '' }
    try {
      const loaded = readMemoryEntries(memoryPath)
      report.source = loaded.source
      report.storeFile = loaded.file
      // v0.4.1（M4）：把「为什么读了这份数据」传给渲染层，否则空库/回滚场景看起来和正常一样。
      report.note = loaded.note ?? ''
      if (loaded.entries === null) { report.error = loaded.error || ('记忆文件不存在：' + memoryPath); return report }
      const entries = loaded.entries
      report.entryCount = entries.length
      // owners 只用于把断链指回记忆条目 id；判定本身交给 checkMemoryPointers（单一实现，体检也用它）
      const owners = new Map()
      for (const entry of entries) {
        for (const pointer of parseMemoryPointers(entry?.text)) {
          if (!owners.has(pointer)) owners.set(pointer, [])
          owners.get(pointer).push(String(entry?.id ?? ''))
        }
      }
      report.checked = true
      const checked = checkMemoryPointers(entries.map((entry) => String(entry?.text ?? '')).join('\n'), vaultDir, headingsOfNote)
      report.total = checked.total
      report.fileMissing = checked.fileMissing
      report.anchorMissing = checked.anchorMissing
      report.anchorChecked = checked.anchorChecked
      report.anchorSkipped = checked.anchorSkipped
      report.broken = checked.broken.map((item) => ({ ...item, memoryIds: (owners.get(item.pointer) ?? []).slice(0, 5) }))
      report.sample = [...owners.keys()].slice(0, 5)
      report.ok = report.broken.length === 0
    } catch (error) {
      note(error)
      report.ok = false
      report.error = lastError
    }
    return report
  }

  /** 读记忆库（优先 memory.db、回退 memory.json），取出所有指针目标（lint 用；读不到就当空集，不阻断） */
  function memoryPointerTargets() {
    try {
      const loaded = readMemoryEntries(memoryPath)
      if (loaded.entries === null) return new Set()
      const entries = loaded.entries
      const set = new Set()
      for (const entry of entries) {
        for (const pointer of parseMemoryPointers(entry?.text)) {
          // v0.4.1（H3）：含 .. 的指针归一后是 ''，跳过（不往目标集合塞空串）
          const target = normalizeVaultPath(String(pointer).split('#')[0]).toLowerCase()
          if (target !== '') set.add(target)
        }
      }
      return set
    } catch (error) {
      note(error)
      return new Set()
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
            ready: { type: 'boolean' },
            unavailableReason: { type: 'string' },
            code: { type: 'string' },
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
            memoryPointers: { type: 'object', additionalProperties: true },
            lastError: { type: 'string' },
          },
          required: ['ok', 'ready', 'vault', 'notes', 'bases', 'attachments', 'links', 'brokenLinks', 'parseErrors'],
          additionalProperties: true,
        },
        render(_args, value) {
          if (value.ready === false) return [text('不可用：' + (value.unavailableReason || value.lastError || '未知原因'))]
          if (value.ok === false) return [text('Obsidian 索引不可用：' + (value.lastError || '未知原因'))]
          let line = 'Obsidian：' + value.notes + ' 篇笔记 / ' + value.bases + ' 个视图 / 链接 ' + value.links + '（断 ' + value.brokenLinks + '）/ 解析失败 ' + value.parseErrors
          const pointer = value.memoryPointers
          if (pointer !== null && typeof pointer === 'object') {
            if (pointer.checked === false) {
              line += '；记忆指针未检查（' + (pointer.error || pointer.file || '未知原因') + '）'
            } else {
              const broken = Array.isArray(pointer.broken) ? pointer.broken : []
              line += '；记忆指针 ' + pointer.total + ' 条（断 ' + broken.length + '）'
              // v0.4.1（M4/L7）：数据源与条目数要露出来 —— 空库/回滚 JSON 场景下，
              // 「67 条（断 0）」看不出读的是哪份数据（审计 §2 M4 扩展）。
              if (pointer.source) line += '［源 ' + pointer.source + '，' + (pointer.entryCount ?? 0) + ' 条］'
              if (pointer.note) line += '｜' + pointer.note
              if (broken.length > 0) {
                // 断链要能看出是「文件没了」还是「文件在、锚点没了」——不然人不知道该去建卡还是改指针
                line += '：' + broken.slice(0, 3).map((item) => {
                  const kind = item?.kind === 'anchor-missing' ? '（锚点缺失）' : item?.kind === 'file-missing' ? '（文件缺失）' : ''
                  return String(item?.pointer ?? '') + kind
                }).join(' / ')
              }
            }
          }
          return [text(line)]
        },
      },
      async execute() {
        try {
          const exists = existsSync(vaultDir)
          if (!exists) {
            const reason = lastError || 'vault 不存在：' + vaultDir
            return { ok: false, ready: false, unavailableReason: reason, code: 'VAULT_MISSING', vault: vaultDir, storeDir, vaultExists: false, notes: 0, bases: 0, attachments: 0, dirs: 0, links: 0, brokenLinks: 0, parseErrors: 0, lastError: reason }
          }
          const cached = readIndex()
          const listing = listVault(vaultDir)
          const liveNewest = listing.notes.reduce((max, entry) => Math.max(max, entry.mtime), 0)
          let bytes = 0
          try { bytes = existsSync(indexFile()) ? statSync(indexFile()).size : 0 } catch (error) { note(error) }
          return {
            ok: cached !== null,
            ready: true,
            unavailableReason: '',
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
            memoryPointers: memoryPointerReport(),
            live: { notes: listing.notes.length, bases: listing.bases.length, attachments: listing.attachments },
          }
        } catch (error) {
          note(error)
          const message = lastError || (error instanceof Error ? error.message : String(error))
          return { ok: false, ready: false, unavailableReason: '读库失败：' + message, code: 'STATUS_ERROR', vault: vaultDir, storeDir, vaultExists: false, notes: 0, bases: 0, attachments: 0, dirs: 0, links: 0, brokenLinks: 0, parseErrors: 0, lastError: lastError || message }
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
            ok: { type: 'boolean' }, code: { type: 'string' }, vault: { type: 'string' }, notes: { type: 'integer' }, bases: { type: 'integer' },
            attachments: { type: 'integer' }, links: { type: 'integer' }, brokenLinks: { type: 'integer' },
            parseErrors: { type: 'integer' }, bytes: { type: 'integer' }, tookMs: { type: 'integer' },
            rebuilt: { type: 'boolean' }, indexFile: { type: 'string' }, code: { type: 'string' }, lastError: { type: 'string' },
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
          if (!result.ok || !result.index) return { ok: false, code: 'VAULT_UNREADABLE', lastError: lastError || 'vault 不可读', tookMs: Date.now() - started }
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
          return { ok: false, code: 'INDEX_ERROR', lastError: lastError || (error instanceof Error ? error.message : String(error)), tookMs: Date.now() - started }
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
            code: { type: 'string' }, lastError: { type: 'string' },
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
          if (query === '') return { ok: false, code: 'EMPTY_QUERY', query, total: 0, matched: 0, results: [], lastError: 'query 为空' }
          const limitRaw = Number(args?.limit)
          const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : 10
          const result = ensureIndex(false)
          if (!result.ok || !result.index) return { ok: false, code: 'VAULT_UNREADABLE', query, total: 0, matched: 0, results: [], lastError: lastError || 'vault 不可读' }
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
          return { ok: false, code: 'SEARCH_ERROR', query: strValue(args?.query), total: 0, matched: 0, results: [], lastError }
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
            truncated: { type: 'boolean' }, code: { type: 'string' }, lastError: { type: 'string' },
          },
          required: ['ok', 'path'],
          additionalProperties: true,
        },
        render(_args, value) {
          if (value.ok === false) return [text('读取失败：' + (value.lastError || '未知原因'))]
          const head = value.path + '（' + value.body.length + ' 字符' + (value.truncated ? '，已截断' : '') + '）'
          const fm = value.frontmatter && typeof value.frontmatter === 'object'
            ? Object.keys(value.frontmatter).map((key) => key + ': ' + JSON.stringify(value.frontmatter[key])).join('\n')
            : ''
          const links = Array.isArray(value.links) && value.links.length
            ? '出链 ' + value.links.length + ' 条：' + value.links.map((link) => (link.embed ? '!' : '') + '[[' + link.target + ']]').join('、')
            : ''
          return [text([head, fm ? 'frontmatter：\n' + fm : '', links, value.body].filter((part) => part !== '').join('\n\n'))]
        },
      },
      async execute(args) {
        try {
          const rel = strValue(args?.path)
          if (rel === '') return { ok: false, code: 'EMPTY_PATH', path: '', lastError: 'path 为空' }
          const abs = safeResolve(vaultDir, rel)
          if (!abs) return { ok: false, code: 'PATH_ESCAPE', path: rel, lastError: '路径越界：只允许 vault 内部路径' }
          const candidates = [abs, abs + '.md']
          let target = ''
          for (const candidate of candidates) {
            if (existsSync(candidate) && statSync(candidate).isFile()) { target = candidate; break }
          }
          if (target === '') return { ok: false, code: 'NOT_FOUND', path: rel, lastError: '文件不存在：' + rel }
          if (path.extname(target).toLowerCase() !== '.md') return { ok: false, code: 'UNSUPPORTED_TYPE', path: rel, lastError: '只支持 .md' }
          const info = statSync(target)
          if (info.size > MAX_NOTE_BYTES) return { ok: false, code: 'TOO_LARGE', path: rel, lastError: '文件超过 ' + MAX_NOTE_BYTES + ' 字节' }
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
          return { ok: false, code: 'NOTE_ERROR', path: strValue(args?.path), lastError: lastError || (error instanceof Error ? error.message : String(error)) }
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'obsidian_write',
      description: 'Controlled write into the vault (P2): only inside the write allowlist (default 00-Inbox/ai-drafts/), create mode never overwrites, and hash/mtime conflict aborts. Modes: create / append / section-replace. Use it to draft cards for human review, not to edit human-owned notes. Provide path before content in the arguments.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Vault-relative path, e.g. 00-Inbox/ai-drafts/2026-11-01-draft.md' },
          content: { type: 'string', description: 'Markdown to write; in section mode it replaces the body under that heading.' },
          mode: { type: 'string', enum: ['create', 'append', 'section'], description: 'create (default, fails when the file exists) / append (add to end) / section (replace one heading block).' },
          section: { type: 'string', description: 'Heading text for section mode, e.g. 观测 or ## 观测.' },
          expectedHash: { type: 'string', description: 'Optional sha256 of the current file; mismatch aborts with code=conflict.' },
          expectedMtime: { type: 'number', description: 'Optional current mtime in ms; mismatch aborts with code=conflict.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            code: { type: 'string' },
            path: { type: 'string' },
            absPath: { type: 'string' },
            action: { type: 'string' },
            created: { type: 'boolean' },
            bytesBefore: { type: 'integer' },
            bytesAfter: { type: 'integer' },
            hash: { type: 'string' },
            mtime: { type: 'string' },
            allowlist: { type: 'array', items: { type: 'string' } },
            lastError: { type: 'string' },
          },
          required: ['ok', 'path'],
          additionalProperties: true,
        },
        render(_args, value) {
          if (value.ok !== true) return [text('写入被拒：' + (value.code ? value.code + ' · ' : '') + (value.lastError || '未知原因'))]
          return [text(value.action + ' ' + value.path + '（' + value.bytesBefore + ' → ' + value.bytesAfter + ' 字节）')]
        },
      },
      async execute(args) {
        try {
          if (!writeEnabled) return { ok: false, code: 'WRITE_DISABLED', path: '', lastError: '受控写已关闭（writeEnabled=false）' }
          const rawPath = strValue(args?.path)
          const rel = normalizeVaultPath(rawPath)
          if (rel === '') {
            if (rawPath.trim() === '') return { ok: false, code: 'bad_path', path: '', lastError: 'path 为空' }
            // v0.4.1（H3）：归一失败几乎只有一种原因 —— 含 `..` 段。`..` 穿越是白名单唯一的绕过口：
            // 00-Inbox/ai-drafts/../../10-Life/x.md 原本靠前缀命中被判 allow，实际写到 10-Life。
            // 越出 vault 的仍报 ESCAPE（保留原语义），vault 内的穿越报 DENIED。
            const cleaned = rawPath.trim().replace(/^["']+|["']+$/g, '').replace(/\\/g, '/').replace(/^\/+/, '')
            const collapsed = path.posix.normalize(cleaned)
            if (path.isAbsolute(rawPath.trim()) || collapsed === '..' || collapsed.startsWith('../')) {
              return { ok: false, code: 'ESCAPE', path: rawPath.trim(), lastError: '路径越界：只允许 vault 内部路径' }
            }
            return {
              ok: false,
              code: 'DENIED',
              path: rawPath.trim(),
              allowlist: writeAllowlist,
              lastError: '路径含 .. 段（禁止穿越写白名单：只允许 vault 内 00-Inbox/ai-drafts/ 下的规范化路径）',
            }
          }
          const content = String(args?.content ?? '')
          if (content === '') return { ok: false, code: 'empty_content', path: rel, lastError: 'content 为空' }
          const abs = safeResolve(vaultDir, rel)
          if (!abs) return { ok: false, code: 'ESCAPE', path: rel, lastError: '路径越界：只允许 vault 内部路径' }
          const gate = isWriteAllowed(rel, writeAllowlist)
          if (!gate.allowed) return { ok: false, code: 'DENIED', path: rel, absPath: abs, allowlist: writeAllowlist, lastError: gate.reason }
          const mode = ['create', 'append', 'section'].includes(String(args?.mode)) ? String(args?.mode) : 'create'
          const exists = existsSync(abs)
          let before = ''
          let sizeBefore = 0
          let info = null
          if (exists) {
            info = statSync(abs)
            if (!info.isFile()) return { ok: false, code: 'not_a_file', path: rel, lastError: '目标不是普通文件' }
            if (info.size > MAX_NOTE_BYTES) return { ok: false, code: 'TOO_LARGE', path: rel, lastError: '文件超过 ' + MAX_NOTE_BYTES + ' 字节' }
            before = readFileSync(abs, 'utf8')
            sizeBefore = info.size
          }
          const expectedHash = strValue(args?.expectedHash).toLowerCase()
          if (expectedHash !== '' && sha256(before) !== expectedHash) {
            return { ok: false, code: 'CONFLICT', path: rel, lastError: '内容已变（expectedHash 不符），本次放弃写入' }
          }
          const expectedMtime = Number(args?.expectedMtime)
          if (exists && Number.isFinite(expectedMtime) && expectedMtime > 0 && Math.abs(info.mtimeMs - expectedMtime) > 1000) {
            return { ok: false, code: 'CONFLICT', path: rel, lastError: '文件在预期之外被改过（expectedMtime 不符），本次放弃写入' }
          }
          let next = ''
          let created = false
          if (!exists) {
            if (mode === 'section') return { ok: false, code: 'NO_FILE', path: rel, lastError: 'section 模式要求文件已存在' }
            next = content
            created = true
          } else if (mode === 'create') {
            return { ok: false, code: 'FILE_EXISTS', path: rel, lastError: '目标已存在；create 绝不覆盖（改内容请用 section 或 append）' }
          } else if (mode === 'append') {
            next = before.endsWith('\n') ? before + content : before + '\n' + content
          } else {
            const section = strValue(args?.section)
            if (section === '') return { ok: false, code: 'bad_section', path: rel, lastError: 'section 模式必须给 section 标题' }
            const replaced = applySection(before, section, content)
            if (replaced === null) return { ok: false, code: 'SECTION_NOT_FOUND', path: rel, lastError: '找不到标题：' + section }
            next = replaced
          }
          mkdirSync(path.dirname(abs), { recursive: true })
          const tmp = abs + '.tmp-' + process.pid
          writeFileSync(tmp, next, 'utf8')
          renameSync(tmp, abs)
          const after = statSync(abs)
          const action = created ? '新建' : mode === 'append' ? '追加' : '局部替换'
          return {
            ok: true,
            code: '',
            path: path.relative(path.resolve(vaultDir), abs).split(path.sep).join('/'),
            absPath: abs,
            action,
            created,
            bytesBefore: sizeBefore,
            bytesAfter: Buffer.byteLength(next, 'utf8'),
            hash: sha256(next),
            mtime: new Date(after.mtimeMs).toISOString(),
            allowlist: writeAllowlist,
            lastError,
          }
        } catch (error) {
          note(error)
          return { ok: false, code: 'error', path: strValue(args?.path), lastError }
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'obsidian_lint',
      description: 'Check the vault against the page contract: required frontmatter (type/domain/status), _index naming vs type, missing one-line summary, duplicate ids, and memory pointers aimed at non-active pages. Read-only; rebuilds the index first so the report matches disk.',
      parameters: {
        type: 'object',
        properties: {
          includeTemplates: { type: 'boolean', description: 'Also lint 90-Shared/91-Templates and 95-Archive (default false).' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            code: { type: 'string' },
            vault: { type: 'string' },
            total: { type: 'integer' },
            errorCount: { type: 'integer' },
            warnCount: { type: 'integer' },
            issues: { type: 'array', items: { type: 'object', additionalProperties: true } },
            tookMs: { type: 'integer' },
            lastError: { type: 'string' },
          },
          required: ['ok', 'total', 'errorCount', 'warnCount', 'issues'],
          additionalProperties: true,
        },
        render(_args, value) {
          if (value.ok === false) return [text('检查失败：' + (value.lastError || '未知原因'))]
          if (value.errorCount === 0 && value.warnCount === 0) return [text('库合规：' + value.total + ' 篇全过（' + value.tookMs + 'ms）')]
          const head = '库检查：' + value.total + ' 篇，' + value.errorCount + ' 错误 / ' + value.warnCount + ' 警告'
          const lines = value.issues.slice(0, 10).map((item) => '- [' + item.level + '] ' + item.path + '：' + item.detail)
          const tail = value.issues.length > 10 ? '\n…还有 ' + (value.issues.length - 10) + ' 条（完整看 issues）' : ''
          return [text(head + '\n' + lines.join('\n') + tail)]
        },
      },
      async execute(args) {
        const started = Date.now()
        try {
          const result = ensureIndex(true)
          if (!result.ok || !result.index) return { ok: false, code: 'VAULT_UNREADABLE', total: 0, errorCount: 0, warnCount: 0, issues: [], tookMs: Date.now() - started, lastError: lastError || 'vault 不可读' }
          const skipPrefixes = args?.includeTemplates === true ? [] : ['90-shared/91-templates/', '95-archive/']
          const report = lintIndex(result.index, { pointerTargets: memoryPointerTargets(), skipPrefixes })
          return {
            ok: true,
            vault: vaultDir,
            total: report.total,
            errorCount: report.errorCount,
            warnCount: report.warnCount,
            issues: report.issues,
            tookMs: Date.now() - started,
            lastError,
          }
        } catch (error) {
          note(error)
          return { ok: false, code: 'LINT_ERROR', total: 0, errorCount: 0, warnCount: 0, issues: [], tookMs: Date.now() - started, lastError: lastError || (error instanceof Error ? error.message : String(error)) }
        }
      },
    }),
  )
}
