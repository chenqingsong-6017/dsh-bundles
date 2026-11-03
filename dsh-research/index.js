/**
 * dsh-research v0.1.0 —— 把「调研方法」变成可执行的流程，而不是一句口号。
 *
 * 为什么需要它：工作区规矩（.dsh/rules/research.md）写得很清楚——先写清决策问题、证伪优先、
 * 每条结论必须回到一行证据、回不去的标「推断」、出处分层。但靠人记就会漏：
 * 2026-10/11 的调研里就出现过「先找资料后想问题」「把搜索摘要当证据」。
 * 这个插件把规矩做成工具边界：决策问题不够清楚开不了任务；结论没有落点（url 或 文件:行）进不了证据表；
 * 有未取证的结论就不让出报告（除非显式标「不完整」）；文件引用会真的去查存在与行号。
 *
 * 三条约束：
 * ① 数据是纯 JSON（<storeDir>/store.json，原子写），报告是纯 Markdown，随时可导出/迁移；
 * ② fail-safe：读写失败只记 lastError，不抛；
 * ③ 不替你做判断：只做「缺什么」的机械检查，结论对不对仍由人/agent 负责。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'

export const name = 'dsh-research'
export const inject = ['tools']

export const SCHEMA_VERSION = 1
export const TIERS = ['paper', 'official', 'source', 'readme', 'search']
export const TIER_LABEL = { paper: '论文', official: '官方文档/博客', source: '源码', readme: '插件 README', search: '搜索摘要' }
const DEFAULT_STORE = 'D:\\AI\\dsh-data\\research'
const STORE_FILE = 'store.json'
const MAX_TASKS = 500
const MAX_EVIDENCE = 200
const MAX_CLAIM = 400
const MAX_QUOTE = 600
const MAX_DECISION = 400
const MAX_QUESTION = 240
const MAX_OUT_BYTES = 512 * 1024

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

function nowIso(ms) {
  return new Date(ms).toISOString()
}

/** child 是否在 parent 之内（含相等）；Windows 路径大小写不敏感，统一折叠后再比。 */
function isInsidePath(parent, child) {
  const fold = (value) => {
    const resolved = path.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  const relative = path.relative(fold(parent), fold(child))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** id：给了 slug 就用 slug-YYYYMMDD，否则 r-YYYYMMDD-随机 4 位。 */
export function makeId(slug, now = Date.now()) {
  const date = new Date(now)
  const pad = (value) => String(value).padStart(2, '0')
  const day = date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate())
  const clean = String(slug ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  if (clean !== '') return clean + '-' + day
  const rand = Math.random().toString(36).slice(2, 6)
  return 'r-' + day + '-' + rand
}

/** arXiv 编号：新式 YYMM.NNNNN(vN) 或旧式 archive[.CC]/YYMMNNN(vN)。 */
const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[a-z][a-z-]*(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?$/i
/** 会话 id：字母数字下划线与连字符，≤64 字符。 */
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/
/** git 提交：7-40 位十六进制。 */
const GIT_SHA = /^[0-9a-f]{7,40}$/i

/** 引用解析：http(s) 链接 / arXiv:编号 / session:id / git:sha / path:line / 纯文本（无落点）。
 *  2026-11-02 修 #25：论文编号、会话 id、commit sha 都是合法证据形态，不再一律判「无落点」。 */
export function parseRef(ref) {
  const raw = strValue(ref)
  if (raw === '') return { kind: 'none', value: '' }
  if (/^https?:\/\//i.test(raw)) return { kind: 'url', value: raw }
  const arxiv = /^arxiv:\s*(\S+)$/i.exec(raw)
  if (arxiv) {
    // 规范化为可点击的 abs 链接；编号不合法仍判无落点。
    return ARXIV_ID.test(arxiv[1])
      ? { kind: 'url', value: 'https://arxiv.org/abs/' + arxiv[1] }
      : { kind: 'none', value: raw }
  }
  const session = /^session:\s*(\S+)$/i.exec(raw)
  if (session) return SESSION_ID.test(session[1]) ? { kind: 'session', value: session[1] } : { kind: 'none', value: raw }
  const git = /^git:\s*(\S+)$/i.exec(raw)
  if (git) return GIT_SHA.test(git[1]) ? { kind: 'git', value: git[1].toLowerCase() } : { kind: 'none', value: raw }
  const match = /^(\.{0,2}[\\/]?.+?):(\d+)(?:-(\d+))?$/.exec(raw)
  if (match) {
    const start = Number(match[2])
    const end = match[3] === undefined ? start : Number(match[3])
    return { kind: 'file', value: match[1].trim(), start, end: Math.max(start, end) }
  }
  return { kind: 'none', value: raw }
}

export function normalizeTier(tier) {
  const raw = String(tier ?? '').toLowerCase()
  return TIERS.includes(raw) ? raw : ''
}

export function normalizeConfidence(value, tier) {
  const raw = String(value ?? '').toLowerCase()
  if (raw !== 'high' && raw !== 'medium' && raw !== 'low') return tier === 'search' ? 'medium' : 'high'
  // 搜索摘要按规矩只能是中/低：它是二手，且常常无法复核原文
  if (tier === 'search' && raw === 'high') return 'medium'
  return raw
}

/** 纯函数版 lint：文件存在性由 fileChecker 注入，便于单测与复用。 */
export function lintTask(task, fileChecker) {
  const evidence = Array.isArray(task?.evidence) ? task.evidence : []
  const tiers = {}
  const missing = []
  const inferred = []
  const uncheckedUrls = []
  const uncheckedRefs = []
  const brokenRefs = []
  const lowConfidence = []
  for (const item of evidence) {
    tiers[item.tier] = (tiers[item.tier] || 0) + 1
    if (item.inferred === true) { inferred.push(item); continue }
    const ref = parseRef(item.ref)
    if (ref.kind === 'none') { missing.push(item); continue }
    if (ref.kind === 'url') { uncheckedUrls.push(item); continue }
    // session / git 是格式合法的落点，没法像文件那样真去查行号：单独记账，不判定引用。
    if (ref.kind === 'session' || ref.kind === 'git') { uncheckedRefs.push(item); continue }
    const check = fileChecker(ref)
    if (check.ok !== true) brokenRefs.push({ item, reason: check.reason })
    if (item.confidence === 'low') lowConfidence.push(item)
  }
  return {
    total: evidence.length,
    tiers,
    missingEvidence: missing.length,
    missing,
    inferred: inferred.length,
    uncheckedUrls: uncheckedUrls.length,
    uncheckedRefs: uncheckedRefs.length,
    brokenRefs,
    lowConfidence: lowConfidence.length,
    canClose: evidence.length > 0 && missing.length === 0 && brokenRefs.length === 0,
  }
}

export function renderReport(task, now = Date.now()) {
  const lines = []
  lines.push('# ' + (task.title || task.question || task.id))
  lines.push('')
  lines.push('> 决策问题：' + (task.decision || '（未填）'))
  lines.push('> 任务 ID：' + task.id + ' · 生成于 ' + nowIso(now) + (task.tags && task.tags.length ? ' · 标签：' + task.tags.join(' / ') : ''))
  lines.push('')
  const evidence = Array.isArray(task.evidence) ? task.evidence : []
  const confirmed = evidence.filter((item) => item.inferred !== true && parseRef(item.ref).kind !== 'none')
  const inferred = evidence.filter((item) => item.inferred === true || parseRef(item.ref).kind === 'none')
  lines.push('## 结论（每条都能回到一行证据）')
  lines.push('')
  if (!confirmed.length) lines.push('（暂无已取证结论）')
  else {
    lines.push('| # | 结论 | 证据 | 层级 | 置信度 |')
    lines.push('|---|---|---|---|---|')
    confirmed.forEach((item, index) => {
      const quote = item.quote ? '（' + String(item.quote).replace(/\s+/g, ' ').slice(0, 80) + '）' : ''
      lines.push('| ' + (index + 1) + ' | ' + escapeCell(item.claim) + ' | ' + escapeCell(item.ref) + quote + ' | ' + (TIER_LABEL[item.tier] || item.tier) + ' | ' + (item.confidence || '') + ' |')
    })
  }
  lines.push('')
  lines.push('## 未验证 / 推断（不能当结论用）')
  lines.push('')
  if (!inferred.length) lines.push('（无）')
  else for (const item of inferred) lines.push('- ' + String(item.claim).replace(/\s+/g, ' ') + (item.ref ? '（落点：' + item.ref + '）' : '（无落点）'))
  lines.push('')
  lines.push('## 统计')
  lines.push('')
  const tiers = {}
  for (const item of evidence) tiers[item.tier] = (tiers[item.tier] || 0) + 1
  lines.push('- 证据 ' + evidence.length + ' 条：' + Object.keys(tiers).map((key) => (TIER_LABEL[key] || key) + ' ' + tiers[key]).join(' / '))
  lines.push('- 已取证 ' + confirmed.length + ' 条 / 推断 ' + inferred.length + ' 条')
  lines.push('')
  return lines.join('\n')
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 300)
}

/** 默认工作区：优先 config.workspaceDir；否则取 DSH 最近使用的 workspace（storages/workspace.json）；最后回落 cwd。
 *  2026-11-01 真机发现：插件进程 cwd 是 profile 目录（C:\\Users\\...\\.dsh\\profiles\\desktop），
 *  直接拿 cwd 当工作区会把报告写进 profile、相对引用也解析不到 —— 必须显式解析。 */
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
  } catch (error) {
    return ''
  }
}

export function apply(ctx, config) {
  const storeDir = strValue(config?.storeDir) || DEFAULT_STORE
  const workspaceDir = strValue(config?.workspaceDir) || readActiveWorkspace(process.env) || process.cwd()
  const defaultOutDir = strValue(config?.outDir) || path.join(workspaceDir, '_research')
  let lastError = ''

  const note = (error) => { lastError = errText(error).slice(0, 240) }
  const storeFile = () => path.join(storeDir, STORE_FILE)

  function emptyStore() {
    return { version: SCHEMA_VERSION, tasks: [] }
  }

  function loadStore() {
    try {
      if (!existsSync(storeFile())) return emptyStore()
      const parsed = JSON.parse(readFileSync(storeFile(), 'utf8'))
      if (!parsed || !Array.isArray(parsed.tasks)) return emptyStore()
      return { version: SCHEMA_VERSION, tasks: parsed.tasks }
    } catch (error) {
      note(error)
      return emptyStore()
    }
  }

  /**
   * status.ready 的真实判据：store.json 存在、解析得开、tasks 是数组。
   * 不存在不算「坏」而是「还没建」——但对调用方同样不可用，所以 ready:false + 原因。
   */
  function storeReadiness() {
    const file = storeFile()
    if (!existsSync(file)) return { ready: false, unavailableReason: 'store.json 不存在（' + file + '）：先跑一次 research_new' }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (!parsed || !Array.isArray(parsed.tasks)) return { ready: false, unavailableReason: 'store.json 结构不对（tasks 不是数组）：' + file }
      return { ready: true, unavailableReason: '' }
    } catch (error) {
      return { ready: false, unavailableReason: 'store.json 读不了：' + errText(error).slice(0, 160) }
    }
  }

  function saveStore(store) {
    try {
      mkdirSync(storeDir, { recursive: true })
      const payload = JSON.stringify({ version: SCHEMA_VERSION, tasks: store.tasks })
      const tmp = storeFile() + '.tmp-' + process.pid
      writeFileSync(tmp, payload, 'utf8')
      renameSync(tmp, storeFile())
      return true
    } catch (error) {
      note(error)
      try { unlinkSync(storeFile() + '.tmp-' + process.pid) } catch (ignored) { }
      return false
    }
  }

  /** 任务定位：显式 id 优先；否则取最近一个 open 任务。 */
  function pickTask(store, id) {
    const wanted = strValue(id)
    if (wanted !== '') {
      const hit = store.tasks.find((task) => task.id === wanted)
      return hit || null
    }
    const open = store.tasks.filter((task) => task.status === 'open')
    return open.length ? open[open.length - 1] : null
  }

  /** 文件引用核查：真的看文件在与不在、行号在不在范围内。 */
  function fileChecker(ref) {
    const base = workspaceDir
    const abs = path.isAbsolute(ref.value) ? ref.value : path.resolve(base, ref.value)
    if (!existsSync(abs)) return { ok: false, reason: '文件不存在：' + ref.value }
    let info = null
    try { info = statSync(abs) } catch (error) { return { ok: false, reason: errText(error).slice(0, 120) } }
    if (!info.isFile()) return { ok: false, reason: '不是文件：' + ref.value }
    if (info.size > 8 * 1024 * 1024) return { ok: true, note: '文件较大（' + info.size + ' 字节），未逐行核对' }
    let lines = 0
    try { lines = readFileSync(abs, 'utf8').split(/\r?\n/).length } catch (error) { return { ok: false, reason: errText(error).slice(0, 120) } }
    if (ref.start < 1 || ref.end > lines) return { ok: false, reason: '行号越界：' + ref.value + ' 只有 ' + lines + ' 行' }
    return { ok: true }
  }

  function taskSummary(task) {
    const lint = lintTask(task, fileChecker)
    return {
      ok: true,
      id: task.id,
      question: task.question,
      decision: task.decision,
      status: task.status,
      createdAt: task.createdAt,
      tags: task.tags || [],
      evidence: lint.total,
      tiers: lint.tiers,
      missingEvidence: lint.missingEvidence,
      inferred: lint.inferred,
      uncheckedUrls: lint.uncheckedUrls,
      uncheckedRefs: lint.uncheckedRefs,
      brokenRefs: lint.brokenRefs.map((entry) => ({ claim: entry.item.claim, reason: entry.reason })),
      lowConfidence: lint.lowConfidence,
      canClose: lint.canClose,
      lastError,
    }
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: 'research_new',
      description: 'Start a research task. Requires the decision question ("what will this conclusion decide?") — vague questions are rejected, which is the whole point of the method rule.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'What you are trying to find out (one line).' },
          decision: { type: 'string', description: 'What this research will decide. Must be concrete (>= 8 chars), not "了解一下".' },
          slug: { type: 'string', description: 'Optional ascii slug for the id, e.g. obsidian-bridge.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
        },
        required: ['question', 'decision'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, code: { type: 'string' }, id: { type: 'string' }, question: { type: 'string' }, decision: { type: 'string' }, createdAt: { type: 'string' }, lastError: { type: 'string' } },
          required: ['ok'],
          additionalProperties: true,
        },
        render(_args, value) {
          return [text(value.ok === true ? '已开任务 ' + value.id + '（决策：' + value.decision + '）' : '开任务失败：' + (value.lastError || '未知原因'))]
        },
      },
      async execute(args) {
        try {
          const question = strValue(args?.question).slice(0, MAX_QUESTION)
          const decision = strValue(args?.decision).replace(/\s+/g, ' ').slice(0, MAX_DECISION)
          if (question.length < 4) return { ok: false, code: 'QUESTION_TOO_SHORT', lastError: 'question 太短（至少 4 字），先把要找什么说清' }
          if (decision.length < 8) return { ok: false, code: 'DECISION_TOO_SHORT', lastError: 'decision 太短（至少 8 字）：这条结论要决定什么？含糊的问题不开工' }
          const store = loadStore()
          if (store.tasks.length >= MAX_TASKS) return { ok: false, code: 'TASK_LIMIT', lastError: '任务数已达上限 ' + MAX_TASKS + '，先把旧任务收尾' }
          const tags = Array.isArray(args?.tags) ? args.tags.map((item) => strValue(item)).filter((item) => item !== '').slice(0, 8) : []
          const task = {
            id: makeId(args?.slug),
            question,
            decision,
            tags,
            status: 'open',
            createdAt: nowIso(Date.now()),
            evidence: [],
          }
          store.tasks.push(task)
          if (!saveStore(store)) return { ok: false, code: 'STORE_WRITE_FAILED', lastError: lastError || '写 store 失败' }
          return { ok: true, code: '', id: task.id, question: task.question, decision: task.decision, createdAt: task.createdAt, lastError }
        } catch (error) {
          note(error)
          return { ok: false, code: 'UNEXPECTED_FAILURE', lastError }
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'research_evidence',
      description: 'Add one conclusion with its evidence. Needs a resolvable ref (http(s) URL, or file:line in the workspace) — bare claims are rejected unless marked inferred:true, which files them under "unverified".',
      parameters: {
        type: 'object',
        properties: {
          claim: { type: 'string', description: 'One-sentence conclusion (<= 400 chars).' },
          tier: { type: 'string', enum: TIERS, description: 'paper | official | source | readme | search' },
          ref: { type: 'string', description: 'Evidence pointer: https://... or _research/x.md:12 (optionally :12-20).' },
          quote: { type: 'string', description: 'Optional short excerpt backing the claim.' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Default high; search tier is capped at medium.' },
          inferred: { type: 'boolean', description: 'true = 推断/未取证，进「未验证」区，不能当结论.' },
          item: { type: 'string', description: 'Task id; omit to use the latest open task.' },
        },
        required: ['claim', 'tier'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' }, code: { type: 'string' }, id: { type: 'string' }, evidenceId: { type: 'string' }, claim: { type: 'string' },
            refKind: { type: 'string' }, verified: { type: 'boolean' }, note: { type: 'string' }, lastError: { type: 'string' },
          },
          required: ['ok'],
          additionalProperties: true,
        },
        render(_args, value) {
          if (value.ok !== true) return [text('记证据失败：' + (value.lastError || '未知原因'))]
          const tail = value.verified === true ? '已核对' : (value.note || '未核对')
          return [text('已记证据（' + value.id + '）· ' + value.refKind + ' · ' + tail)]
        },
      },
      async execute(args) {
        try {
          const claim = strValue(args?.claim).replace(/\s+/g, ' ').slice(0, MAX_CLAIM)
          if (claim.length < 4) return { ok: false, code: 'CLAIM_TOO_SHORT', lastError: 'claim 太短（至少 4 字）' }
          const tier = normalizeTier(args?.tier)
          if (tier === '') return { ok: false, code: 'INVALID_TIER', lastError: 'tier 必须是 ' + TIERS.join(' / ') }
          const store = loadStore()
          const task = pickTask(store, args?.item)
          if (!task) return { ok: false, code: 'NO_TASK', lastError: '没有可用的任务：先用 research_new 建一个' }
          if (task.status !== 'open') return { ok: false, code: 'TASK_CLOSED', lastError: '任务 ' + task.id + ' 已关闭，先 reopen 或新建' }
          if (!Array.isArray(task.evidence)) task.evidence = []
          if (task.evidence.length >= MAX_EVIDENCE) return { ok: false, code: 'EVIDENCE_LIMIT', lastError: '该任务证据已达上限 ' + MAX_EVIDENCE }
          const inferred = args?.inferred === true
          const ref = strValue(args?.ref)
          const parsed = parseRef(ref)
          if (!inferred && parsed.kind === 'none') {
            return { ok: false, code: 'EVIDENCE_UNVERIFIABLE', lastError: '证据必须能回到一行：给 http(s) 链接、arXiv:编号、session:id、git:sha 或 文件:行；确实没取证就传 inferred:true（会进未验证区）' }
          }
          const confidence = normalizeConfidence(args?.confidence, tier)
          const item = {
            id: 'e' + (task.evidence.length + 1),
            claim,
            tier,
            ref,
            quote: strValue(args?.quote).slice(0, MAX_QUOTE),
            confidence,
            inferred,
            addedAt: nowIso(Date.now()),
          }
          let verified = false
          let noteText = ''
          if (!inferred) {
            if (parsed.kind === 'url') { verified = false; noteText = '链接未联网核对（离线环境只校验格式）' }
            else if (parsed.kind === 'session' || parsed.kind === 'git') {
              verified = false
              noteText = (parsed.kind === 'git' ? '提交 sha' : '会话 id') + '格式合法，未核对（插件不做 git / 会话日志查询）'
            } else {
              const check = fileChecker(parsed)
              verified = check.ok === true
              noteText = check.ok === true ? (check.note || '文件与行号已核对') : String(check.reason || '')
            }
          } else {
            noteText = '标了 inferred，进未验证区'
          }
          task.evidence.push(item)
          if (!saveStore(store)) return { ok: false, code: 'STORE_WRITE_FAILED', lastError: lastError || '写 store 失败' }
          return { ok: true, code: '', id: task.id, evidenceId: item.id, claim, refKind: parsed.kind, verified, note: noteText, lastError }
        } catch (error) {
          note(error)
          return { ok: false, code: 'UNEXPECTED_FAILURE', lastError }
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'research_check',
      description: 'Mechanical audit of one research task: how many conclusions have no resolvable evidence, which file refs are broken, what is still inferred. Use before writing the report.',
      parameters: { type: 'object', properties: { item: { type: 'string', description: 'Task id; omit for the latest open task.' } }, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' }, code: { type: 'string' }, id: { type: 'string' }, evidence: { type: 'integer' }, missingEvidence: { type: 'integer' },
            inferred: { type: 'integer' }, uncheckedUrls: { type: 'integer' }, uncheckedRefs: { type: 'integer' }, lowConfidence: { type: 'integer' },
            brokenRefs: { type: 'array', items: { type: 'object', additionalProperties: true } },
            canClose: { type: 'boolean' }, tiers: { type: 'object', additionalProperties: true }, lastError: { type: 'string' },
          },
          required: ['ok'],
          additionalProperties: true,
        },
        render(_args, value) {
          if (value.ok !== true) return [text('检查失败：' + (value.lastError || '未知原因'))]
          const extra = value.uncheckedRefs > 0 ? '，格式未核 ' + value.uncheckedRefs : ''
          return [text('任务 ' + value.id + '：证据 ' + value.evidence + ' 条，无落点 ' + value.missingEvidence + '，推断 ' + value.inferred + '，断引用 ' + (value.brokenRefs || []).length + extra + '，可收尾=' + value.canClose)]
        },
      },
      async execute(args) {
        try {
          const store = loadStore()
          const task = pickTask(store, args?.item)
          if (!task) return { ok: false, code: 'NO_TASK', lastError: '任务不存在（也没有 open 任务）' }
          return taskSummary(task)
        } catch (error) {
          note(error)
          return { ok: false, code: 'UNEXPECTED_FAILURE', lastError }
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'research_report',
      description: 'Render the task into a Markdown conclusion doc (evidence table + unverified section). Refuses when a conclusion has no evidence unless allowIncomplete is set.',
      parameters: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'Task id; omit for the latest open task.' },
          title: { type: 'string', description: 'Report title (default: the question).' },
          outPath: { type: 'string', description: 'Where to write the .md (default <workspace>/_research/research-<id>.md). Relative paths resolve from workspaceDir; by default the result must stay inside the configured outDir (<workspace>/_research), otherwise RESEARCH_OUTPATH_INVALID.' },
          allowOutsideWorkspace: { type: 'boolean', description: 'Opt-in (default false): allow outPath outside <workspace>/_research when the user explicitly wants to write elsewhere (e.g. a vault folder).' },
          allowIncomplete: { type: 'boolean', description: 'Write the report even when some conclusions lack evidence (they land in the unverified section).' },
          close: { type: 'boolean', description: 'Mark the task closed after writing. Default false.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' }, code: { type: 'string' }, id: { type: 'string' }, path: { type: 'string' }, bytes: { type: 'integer' },
            evidence: { type: 'integer' }, inferred: { type: 'integer' }, closed: { type: 'boolean' },
            blockedBy: { type: 'array', items: { type: 'string' } }, lastError: { type: 'string' },
          },
          required: ['ok'],
          additionalProperties: true,
        },
        render(_args, value) {
          if (value.ok !== true) return [text('出报告失败：' + (value.lastError || '未知原因') + (value.blockedBy && value.blockedBy.length ? '（' + value.blockedBy.join('；') + '）' : ''))]
          return [text('报告已写：' + value.path + '（证据 ' + value.evidence + ' 条 / 推断 ' + value.inferred + ' 条，' + value.bytes + ' 字节）')]
        },
      },
      async execute(args) {
        try {
          const store = loadStore()
          const task = pickTask(store, args?.item)
          if (!task) return { ok: false, code: 'NO_TASK', lastError: '任务不存在（也没有 open 任务）' }
          const lint = lintTask(task, fileChecker)
          if (!lint.canClose && args?.allowIncomplete !== true) {
            const blocked = []
            if (lint.missingEvidence > 0) blocked.push(lint.missingEvidence + ' 条结论没有可核对的落点')
            if (lint.brokenRefs.length > 0) blocked.push(lint.brokenRefs.length + ' 条文件引用查不到')
            if (lint.total === 0) blocked.push('还没有任何证据')
            return { ok: false, code: 'UNVERIFIED_BLOCKED', id: task.id, blockedBy: blocked, lastError: '先补齐证据，或用 allowIncomplete:true 明确标注不完整' }
          }
          const visible = Object.assign({}, task, { title: strValue(args?.title) || task.question })
          const markdown = renderReport(visible, Date.now())
          if (markdown.length > MAX_OUT_BYTES) return { ok: false, code: 'REPORT_TOO_LARGE', lastError: '报告过大（> ' + MAX_OUT_BYTES + ' 字节）' }
          // 2026-11-03 审计 M6：outPath 原本可写任意路径。默认只允许落在 outDir
          // （<workspace>/_research），越界（绝对路径 / .. 穿越）直接拒；写外部必须显式 opt-in。
          const rawOut = strValue(args?.outPath)
          const allowOutside = args?.allowOutsideWorkspace === true
          const outDir = path.resolve(defaultOutDir)
          const outPath = rawOut !== '' ? (path.isAbsolute(rawOut) ? path.resolve(rawOut) : path.resolve(workspaceDir, rawOut)) : path.join(defaultOutDir, 'research-' + task.id + '.md')
          if (!allowOutside && !isInsidePath(outDir, outPath)) {
            return {
              ok: false,
              code: 'RESEARCH_OUTPATH_INVALID',
              id: task.id,
              lastError:
                'outPath 越界：报告默认只能写到 ' + outDir + '（本次解析为 ' + outPath + '）。' +
                '相对路径先按 workspaceDir 解析；确实要写到外部目录，请显式传 allowOutsideWorkspace:true。',
            }
          }
          mkdirSync(path.dirname(outPath), { recursive: true })
          const tmp = outPath + '.tmp-' + process.pid
          writeFileSync(tmp, markdown + '\n', 'utf8')
          renameSync(tmp, outPath)
          let closed = false
          if (args?.close === true) { task.status = 'closed'; closed = saveStore(store) }
          return { ok: true, code: '', id: task.id, path: outPath, bytes: Buffer.byteLength(markdown, 'utf8'), evidence: lint.total - lint.missingEvidence, inferred: lint.inferred, closed, lastError }
        } catch (error) {
          note(error)
          return { ok: false, code: 'UNEXPECTED_FAILURE', lastError }
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'research_status',
      description: 'Read-only health of the research store: task counts, evidence totals per tier, stale/incomplete tasks, store path, last error.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' }, code: { type: 'string' }, storeDir: { type: 'string' }, storeFile: { type: 'string' }, storeBytes: { type: 'integer' },
            ready: { type: 'boolean' }, unavailableReason: { type: 'string' },
            tasks: { type: 'integer' }, open: { type: 'integer' }, closed: { type: 'integer' },
            evidenceTotal: { type: 'integer' }, inferredTotal: { type: 'integer' }, tiers: { type: 'object', additionalProperties: true },
            latest: { type: 'string' }, lastError: { type: 'string' },
          },
          required: ['ok', 'ready', 'unavailableReason', 'tasks', 'open', 'evidenceTotal'],
          additionalProperties: true,
        },
        render(_args, value) {
          if (value.ready === false) return [text('不可用：' + (value.unavailableReason || value.lastError || '未知原因'))]
          return [text('research：任务 ' + value.tasks + '（open ' + value.open + '）/ 证据 ' + value.evidenceTotal + ' 条 / 推断 ' + value.inferredTotal + ' 条')]
        },
      },
      async execute() {
        try {
          const readiness = storeReadiness()
          const store = loadStore()
          const tiers = {}
          let evidenceTotal = 0
          let inferredTotal = 0
          for (const task of store.tasks) {
            for (const item of task.evidence || []) {
              evidenceTotal += 1
              tiers[item.tier] = (tiers[item.tier] || 0) + 1
              if (item.inferred === true) inferredTotal += 1
            }
          }
          let bytes = 0
          try { bytes = existsSync(storeFile()) ? statSync(storeFile()).size : 0 } catch (error) { note(error) }
          const openTasks = store.tasks.filter((task) => task.status === 'open')
          const latest = store.tasks.length ? store.tasks[store.tasks.length - 1].id : ''
          return {
            ok: true,
            code: '',
            storeDir,
            storeFile: storeFile(),
            storeBytes: bytes,
            ready: readiness.ready,
            unavailableReason: readiness.unavailableReason,
            tasks: store.tasks.length,
            open: openTasks.length,
            closed: store.tasks.length - openTasks.length,
            evidenceTotal,
            inferredTotal,
            tiers,
            latest,
            lastError,
          }
        } catch (error) {
          note(error)
          return { ok: false, code: 'STATUS_FAILED', storeDir, storeFile: storeFile(), storeBytes: 0, ready: false, unavailableReason: '读取状态失败：' + lastError, tasks: 0, open: 0, closed: 0, evidenceTotal: 0, inferredTotal: 0, tiers: {}, latest: '', lastError }
        }
      },
    }),
  )
}
