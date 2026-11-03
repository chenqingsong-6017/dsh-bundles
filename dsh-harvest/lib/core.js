/**
 * dsh-harvest 核心 v0.1.0
 *
 * 我们自己的取舍（学完七家后定的，不是照抄任何一家）：
 * 1. 只榨事实级内容：规则 / 纠正 / 偏好。流程与坑交给技能，不在这里收。
 * 2. 每条候选必须带证据（session / seq / time）；无证据不收。
 * 3. 只写候选，不自动写 memory；复核后由人或 agent 用 memory_add 采纳。
 * 4. 零依赖、零模型调用；规则可读可改，成本为零。
 * 5. 幂等：按会话文件 mtime + state 跳过；重复跑不产垃圾。
 * 6. 会话只读；数据落 D 盘；不引入向量库/图库（不预建昂贵结构）。
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export const DEFAULT_STORE = 'D:\\AI\\dsh-data\\harvest'
export const CANDIDATE_FILE = 'candidates.jsonl'
export const EPISODE_FILE = 'episodes.jsonl'
export const STATE_FILE = 'state.json'
export const SESSION_FILE_NAME = 'session.v4.jsonl.zstd'

const SENTENCE_SPLIT = /(?<=[。！？!?；;])|\n+/
const RULES = [
  { type: 'rule', re: /(硬规则|铁律|必须|禁止|不得|不许|不准|一律|绝不)/ },
  { type: 'correction', re: /(不对|错了|不是这样|别这样|不要这样|纠正|改成|应该是|搞错|说瞎话|说慌|撒谎|糊弄|敷衍|粉饰|负资产|落后)/ },
  { type: 'preference', re: /(以后|记住|每次|习惯|偏好|我喜欢|我讨厌|最讨厌|懒得|别用|不要用)/ },
]
const MIN_LEN = 8
const MAX_LEN = 240
const DUP_THRESHOLD = 0.82

export function zstdReady() {
  return typeof zstdDecompressSync === 'function'
}

export function defaultSessionsRoot() {
  const home = process.env.DSH_HOME || 'C:\\Users\\cqs6017\\.dsh'
  return path.join(home, 'sessions')
}

export function walkSessionFiles(root) {
  const out = []
  const visit = (dir, depth) => {
    if (depth > 4) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch (error) { return }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full, depth + 1)
      else if (entry.name === SESSION_FILE_NAME) out.push(full)
    }
  }
  visit(root, 0)
  return out
}

export function readSession(file) {
  const events = []
  const raw = zstdDecompressSync(readFileSync(file)).toString('utf8')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try { events.push(JSON.parse(trimmed)) } catch (error) { /* 坏行跳过，不影响其它事件 */ }
  }
  const meta = { id: '', cwd: '', createdAt: 0 }
  for (const event of events) {
    if (event.type === 'session' && event.id) {
      meta.id = String(event.id)
      meta.cwd = String(event.cwd || '')
      meta.createdAt = Number(event.createdAt) || 0
      break
    }
  }
  return { meta, events }
}

export function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[\s\p{P}]/gu, '')
}

export function bigramSet(value) {
  const set = new Set()
  const text = normalizeText(value)
  for (let index = 0; index + 1 < text.length; index = index + 1) set.add(text.slice(index, index + 2))
  return set
}

export function similarity(left, right) {
  const a = bigramSet(left)
  const b = bigramSet(right)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared = shared + 1
  return shared / (a.size + b.size - shared)
}

function classify(sentence) {
  for (const rule of RULES) if (rule.re.test(sentence)) return rule.type
  return ''
}

function usable(sentence) {
  if (sentence.length < MIN_LEN || sentence.length > MAX_LEN) return false
  if (/https?:\/\//i.test(sentence)) return false
  if (/[?？]$/.test(sentence)) return false
  if (/^(嗯|哦|好|可以|行|是|对)[，。！]?$/.test(sentence)) return false
  // 文档碎片：注入记忆/AGENTS/代码块/列表符号，不是用户自己的话
  if (/(📌|→vault:\/\/|```|\*\*|<\/?system-reminder>)/.test(sentence)) return false
  if (/^[-|>#]/.test(sentence)) return false
  // 问句但没有问号：不当事实收
  if (/(有没有|是不是|能不能|要不要|为什么|为啥)/.test(sentence) && !/[。.]/.test(sentence)) return false
  // 疑问式句子当规则收会误报：开头疑问词、或以『什么/哪些/如何』收尾
  if (/^(哪些|什么|怎么|如何|为什么|为啥)/.test(sentence)) return false
  if (/(什么|哪些|如何)[。.]$/.test(sentence)) return false
  return true
}

function candidateId(sessionId, seq, type, sentence) {
  const digest = createHash('sha1').update(sessionId + '|' + seq + '|' + type + '|' + normalizeText(sentence)).digest('hex')
  return 'h-' + digest.slice(0, 16)
}

export function extractSession(session) {
  const meta = session.meta || { id: '', cwd: '', createdAt: 0 }
  const events = Array.isArray(session.events) ? session.events : []
  const episode = { session: meta.id, cwd: meta.cwd, title: '', createdAt: meta.createdAt, lastAt: 0, userMsgs: 0, turns: 0, deliverables: [] }
  const candidates = []
  for (const event of events) {
    if (event.time && event.time > episode.lastAt) episode.lastAt = event.time
    if (event.type === 'session/title' && event.data && event.data.title && episode.title === '') episode.title = String(event.data.title)
    else if (event.type === 'turn/start') episode.turns = episode.turns + 1
    else if (event.type === 'deliverables/presented' && event.data && Array.isArray(event.data.files)) {
      for (const file of event.data.files) if (file && file.path) episode.deliverables.push(String(file.path))
    } else if (event.type === 'user/message') {
      const source = event.data && event.data.source ? event.data.source : null
      if (source && source.kind && source.kind !== 'user') continue
      episode.userMsgs = episode.userMsgs + 1
      const content = event.data && Array.isArray(event.data.content) ? event.data.content : []
      for (const part of content) {
        if (!part || part.type !== 'text' || typeof part.text !== 'string') continue
        for (const rawSentence of part.text.split(SENTENCE_SPLIT)) {
          const sentence = rawSentence.replace(/\s+/g, ' ').trim().replace(/^[「『“"（(]+|[」』”"）)]+$/g, '')
          if (!usable(sentence)) continue
          const type = classify(sentence)
          if (type === '') continue
          candidates.push({
            id: candidateId(meta.id, event.seq, type, sentence),
            type: type,
            text: sentence,
            evidence: { session: meta.id, seq: event.seq, time: event.time || 0, role: 'user' },
            cwd: meta.cwd,
            status: 'pending',
            createdAt: Date.now(),
          })
        }
      }
    }
  }
  return { episode, candidates }
}

export function ensureStore(storeDir) {
  mkdirSync(storeDir, { recursive: true })
}

export function readJsonl(file) {
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try { out.push(JSON.parse(trimmed)) } catch (error) { /* 坏行跳过 */ }
  }
  return out
}

export function appendJsonl(file, records) {
  if (!Array.isArray(records) || records.length === 0) return
  appendFileSync(file, records.map((item) => JSON.stringify(item)).join('\n') + '\n')
}

export function loadState(storeDir) {
  const file = path.join(storeDir, STATE_FILE)
  if (!existsSync(file)) return { version: 1, sessions: {}, updatedAt: 0 }
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'))
    if (!state || typeof state !== 'object' || !state.sessions) return { version: 1, sessions: {}, updatedAt: 0 }
    return state
  } catch (error) {
    return { version: 1, sessions: {}, updatedAt: 0 }
  }
}

export function saveState(storeDir, state) {
  const file = path.join(storeDir, STATE_FILE)
  const tmp = file + '.tmp'
  const payload = Object.assign({ version: 1 }, state, { updatedAt: Date.now() })
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n')
  renameSync(tmp, file)
}

export function normalizePath(value) {
  return String(value || '').replace(/[\\/]+$/, '').toLowerCase()
}

export function normalizeSessionId(value) {
  const raw = String(value || '').trim()
  if (raw === '') return ''
  return /^[0-9a-fA-F-]{36}$/.test(raw) ? 'session-' + raw : raw
}

export function scan(options) {
  const opts = options || {}
  const sessionsRoot = opts.sessionsRoot || defaultSessionsRoot()
  const storeDir = opts.storeDir || DEFAULT_STORE
  const workspace = String(opts.workspace || '')
  const sessionId = normalizeSessionId(opts.sessionId || '')
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 0
  const redo = opts.redo === true
  const result = { ok: false, scanned: 0, skipped: 0, candidatesAdded: 0, episodesAdded: 0, pendingTotal: 0, processedSessions: 0, samples: [], errors: [] }
  if (!zstdReady()) {
    result.errors.push('node:zlib 没有 zstd 解压能力，读不了会话')
    return result
  }
  ensureStore(storeDir)
  const files = walkSessionFiles(sessionsRoot)
  if (files.length === 0) {
    result.errors.push('sessions 目录下没有会话文件: ' + sessionsRoot)
    return result
  }
  const state = loadState(storeDir)
  const existing = readJsonl(path.join(storeDir, CANDIDATE_FILE))
  const seenIds = new Set(existing.map((item) => item.id))
  const seenTexts = existing.map((item) => item.text)
  const picked = []
  for (const file of files) {
    if (limit > 0 && result.scanned >= limit) break
    let session = null
    try { session = readSession(file) } catch (error) {
      result.errors.push(path.basename(path.dirname(file)) + ': ' + String((error && error.message) || error))
      continue
    }
    const meta = session.meta
    if (!meta.id) continue
    if (workspace !== '' && !normalizePath(meta.cwd).endsWith(normalizePath(workspace))) continue
    if (sessionId !== '' && meta.id !== sessionId) continue
    let mtime = 0
    try { mtime = statSync(file).mtimeMs } catch (error) { /* 读不到 mtime 就每次都榨 */ }
    const previous = state.sessions[meta.id]
    if (!redo && previous && Math.abs(Number(previous.mtime || 0) - mtime) < 1) {
      result.skipped = result.skipped + 1
      continue
    }
    const extracted = extractSession(session)
    const fresh = []
    for (const candidate of extracted.candidates) {
      if (seenIds.has(candidate.id)) continue
      let duplicate = false
      for (const text of seenTexts) {
        if (similarity(text, candidate.text) >= DUP_THRESHOLD) { duplicate = true; break }
      }
      if (duplicate) continue
      seenIds.add(candidate.id)
      seenTexts.push(candidate.text)
      fresh.push(candidate)
    }
    if (fresh.length > 0) appendJsonl(path.join(storeDir, CANDIDATE_FILE), fresh)
    if (!previous || redo || Number(previous.episodeAt || 0) !== Number(extracted.episode.lastAt || 0)) {
      const episodeRecord = Object.assign({}, extracted.episode, { extractedAt: Date.now() })
      appendJsonl(path.join(storeDir, EPISODE_FILE), [episodeRecord])
      result.episodesAdded = result.episodesAdded + 1
    }
    state.sessions[meta.id] = { file: file, mtime: mtime, at: Date.now(), candidates: fresh.length, episodeAt: extracted.episode.lastAt }
    result.scanned = result.scanned + 1
    result.candidatesAdded = result.candidatesAdded + fresh.length
    for (const item of fresh.slice(0, 5)) picked.push(item)
  }
  saveState(storeDir, state)
  const all = readJsonl(path.join(storeDir, CANDIDATE_FILE))
  result.pendingTotal = all.filter((item) => (item.status || 'pending') === 'pending').length
  result.processedSessions = Object.keys(state.sessions || {}).length
  result.samples = picked
  result.ok = result.errors.length === 0
  return result
}

export function readCandidates(options) {
  const opts = options || {}
  const storeDir = opts.storeDir || DEFAULT_STORE
  const status = String(opts.status || 'pending')
  const keyword = String(opts.keyword || '').toLowerCase()
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, 200) : 20
  const items = readJsonl(path.join(storeDir, CANDIDATE_FILE))
  const matched = items.filter((item) => {
    const itemStatus = item.status || 'pending'
    if (status !== 'all' && itemStatus !== status) return false
    if (keyword !== '' && !String(item.text || '').toLowerCase().includes(keyword)) return false
    return true
  })
  return { matched: matched.length, total: items.length, items: matched.slice(0, limit) }
}

export function status(options) {
  const opts = options || {}
  const sessionsRoot = opts.sessionsRoot || defaultSessionsRoot()
  const storeDir = opts.storeDir || DEFAULT_STORE
  const files = walkSessionFiles(sessionsRoot)
  let state = { sessions: {} }
  try { state = loadState(storeDir) } catch (error) { /* status 也要 fail-safe */ }
  let items = []
  try { items = readJsonl(path.join(storeDir, CANDIDATE_FILE)) } catch (error) { /* 同上 */ }
  const pending = items.filter((item) => (item.status || 'pending') === 'pending').length
  let unavailableReason = ''
  if (!zstdReady()) unavailableReason = 'node:zlib 缺少 zstd 解压能力'
  else if (!existsSync(sessionsRoot)) unavailableReason = 'sessions 目录不存在: ' + sessionsRoot
  else if (files.length === 0) unavailableReason = 'sessions 目录里没有会话文件'
  return {
    ready: unavailableReason === '',
    unavailableReason: unavailableReason,
    sessionsRoot: sessionsRoot,
    storeDir: storeDir,
    sessionFiles: files.length,
    processedSessions: Object.keys(state.sessions || {}).length,
    candidates: items.length,
    pending: pending,
    lastError: '',
  }
}

export function gate(options) {
  const opts = options || {}
  const storeDir = opts.storeDir || DEFAULT_STORE
  const ids = Array.isArray(opts.sessionIds) ? opts.sessionIds : []
  const state = loadState(storeDir)
  const covered = []
  const missing = []
  for (const raw of ids) {
    const id = normalizeSessionId(raw)
    if (id === '') continue
    if (state.sessions && state.sessions[id]) covered.push(id)
    else missing.push(id)
  }
  const allowed = ids.length > 0 && missing.length === 0
  return {
    allowed: allowed,
    checked: ids.length,
    covered: covered,
    missing: missing,
    hint: allowed ? '这些会话都有 harvest 记录，可以删。' : '先跑 harvest_run 覆盖这些会话；没有产物不许删。',
  }
}
