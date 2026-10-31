/**
 * dsh-eventlog v0.1.0 —— 本地事件日志（照 Windows 事件查看器的模型）。
 *
 * 为什么需要它：dsh-audit 只记「agent 副作用调用」，memory 只记自己的变更，剩下的静默失败没人记：
 * 插件加载失败、工具报错、hooks 误拦、重启前后状态、依赖缺失——这些不报错、但行为已经不对的事，
 * 没日志就永远查不出来（本机真实教训：DSH 升级后 computer-use 工具静默归零、notify 全哑）。
 *
 * 三条约束：①不进上下文（永不注入系统提示，只在被问到时用 log_query 查）；
 * ②fail-safe（写失败绝不影响主流程，记账不抛）；③不重复（工具调用全量审计归 dsh-audit，这里只记错误与运维事件）。
 *
 * 数据：<storeDir>/events-YYYY-MM-DD.jsonl，每天一个文件，按 keepDays 清理。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'

export const name = 'dsh-eventlog'
export const inject = ['tools']

export const LEVELS = ['info', 'warn', 'error', 'fatal']
export const CHANNELS = ['system', 'plugin', 'memory', 'hook', 'agent', 'restart']
const LEVEL_RANK = { info: 1, warn: 2, error: 3, fatal: 4 }

const DEFAULT_STORE = 'D:\\AI\\dsh-data\\logs'
const DEFAULT_KEEP_DAYS = 30
const DEFAULT_MIN_LEVEL = 'info'
const MAX_MESSAGE = 400
const MAX_DATA_CHARS = 900
const MAX_LIMIT = 200
const MAX_SCAN_FILES = 200
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_TOOL_CACHE = 200
const DAY_MS = 86400000
const FILE_RE = /^events-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/

const text = (value) => ({ type: 'text', text: value })

/** 本地日历日（按机器时区，人看日志要跟桌面时钟对得上）。 */
export function localDay(now = Date.now()) {
  const date = new Date(now)
  const pad = (value) => String(value).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

export function levelRank(level) {
  return LEVEL_RANK[String(level ?? '').toLowerCase()] ?? 0
}

/** 统一事件形状：ts / level / channel / code / source / message / [session] / [data]。 */
export function normalizeEvent(input, now = Date.now()) {
  const levelRaw = String(input?.level ?? '').toLowerCase()
  const channelRaw = String(input?.channel ?? '').toLowerCase()
  const level = LEVELS.includes(levelRaw) ? levelRaw : 'info'
  const channel = CHANNELS.includes(channelRaw) ? channelRaw : 'system'
  const code = String(input?.code ?? '').trim().slice(0, 64) || 'GENERAL'
  const source = String(input?.source ?? 'dsh-eventlog').trim().slice(0, 64) || 'dsh-eventlog'
  const message = String(input?.message ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE)
  const out = { ts: new Date(now).toISOString(), time: now, level, channel, code, source, message }
  if (input?.session !== undefined && input.session !== null && String(input.session) !== '') out.session = String(input.session).slice(0, 64)
  if (input?.data !== undefined && input.data !== null) {
    let payload = ''
    try {
      payload = typeof input.data === 'string' ? input.data : JSON.stringify(input.data)
    } catch (error) {
      payload = String(input.data)
    }
    if (typeof payload === 'string' && payload.length > 0) out.data = payload.slice(0, MAX_DATA_CHARS)
  }
  return out
}

export function fileFor(storeDir, day) {
  return path.join(storeDir, 'events-' + day + '.jsonl')
}

export function parseLine(line) {
  const raw = String(line ?? '').trim()
  if (raw === '') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch (error) {
    return null
  }
}

/** 过滤：channel / level（≥）/ code / since / until / keyword。 */
export function matchesFilter(event, filter = {}) {
  if (!event || typeof event !== 'object') return false
  if (typeof filter.channel === 'string' && filter.channel !== '' && event.channel !== filter.channel) return false
  if (typeof filter.code === 'string' && filter.code !== '' && String(event.code).toUpperCase() !== filter.code.toUpperCase()) return false
  if (typeof filter.level === 'string' && filter.level !== '' && levelRank(event.level) < levelRank(filter.level)) return false
  const stamp = typeof event.time === 'number' ? event.time : Date.parse(String(event.ts ?? ''))
  if (typeof filter.since === 'number' && Number.isFinite(filter.since) && Number.isFinite(stamp) && stamp < filter.since) return false
  if (typeof filter.until === 'number' && Number.isFinite(filter.until) && Number.isFinite(stamp) && stamp > filter.until) return false
  if (typeof filter.keyword === 'string' && filter.keyword !== '') {
    const needle = filter.keyword.toLowerCase()
    const haystack = (String(event.code ?? '') + ' ' + String(event.source ?? '') + ' ' + String(event.message ?? '') + ' ' + String(event.data ?? '')).toLowerCase()
    if (!haystack.includes(needle)) return false
  }
  return true
}

/** 时间参数：ISO 时间 / YYYY-MM-DD / 相对（7d、12h）。解析不出来返回 null。 */
export function parseWhen(value, now = Date.now()) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const raw = value.trim()
  const rel = /^(\d+)([dh])$/.exec(raw)
  if (rel) {
    const amount = Number(rel[1])
    return now - amount * (rel[2] === 'd' ? DAY_MS : 3600000)
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return Date.parse(raw + 'T00:00:00')
  const stamp = Date.parse(raw)
  return Number.isFinite(stamp) ? stamp : null
}
export function apply(ctx, config) {
  const storeDir = typeof config?.storeDir === 'string' && config.storeDir.trim() !== '' ? config.storeDir.trim() : DEFAULT_STORE
  const keepDays = Number.isInteger(config?.keepDays) && config.keepDays > 0 ? Math.min(config.keepDays, 3650) : DEFAULT_KEEP_DAYS
  const minLevelRaw = String(config?.minLevel ?? '').toLowerCase()
  const minLevel = LEVELS.includes(minLevelRaw) ? minLevelRaw : DEFAULT_MIN_LEVEL
  const captureToolErrors = config?.captureToolErrors !== false
  let lastError = ''
  let written = 0

  const noteError = (error) => {
    lastError = error instanceof Error ? error.message : String(error)
  }

  function ensureDir() {
    try {
      mkdirSync(storeDir, { recursive: true })
      return true
    } catch (error) {
      noteError(error)
      return false
    }
  }

  function pruneOld(now = Date.now()) {
    let removed = 0
    try {
      for (const entry of readdirSync(storeDir)) {
        const match = FILE_RE.exec(entry)
        if (!match) continue
        const age = (now - Date.parse(match[1] + 'T00:00:00')) / DAY_MS
        if (age > keepDays) {
          try {
            unlinkSync(path.join(storeDir, entry))
            removed += 1
          } catch (error) {
            noteError(error)
          }
        }
      }
    } catch (error) {
      noteError(error)
    }
    return removed
  }

  function append(input) {
    const event = normalizeEvent(input)
    if (levelRank(event.level) < levelRank(minLevel)) return null
    if (!ensureDir()) return null
    const day = localDay(event.time)
    let file = fileFor(storeDir, day)
    try {
      if (existsSync(file) && statSync(file).size > MAX_FILE_BYTES) {
        let index = 1
        while (existsSync(path.join(storeDir, 'events-' + day + '.' + index + '.jsonl')) && index < 100) index += 1
        file = path.join(storeDir, 'events-' + day + '.' + index + '.jsonl')
      }
      appendFileSync(file, JSON.stringify(event) + '\n', 'utf8')
      written += 1
      return { event, file }
    } catch (error) {
      noteError(error)
      return null
    }
  }

  function filesNewestFirst() {
    if (!existsSync(storeDir)) return []
    const out = []
    try {
      for (const entry of readdirSync(storeDir)) {
        const match = FILE_RE.exec(entry)
        if (!match) continue
        out.push({ day: match[1], seq: match[2] === undefined ? 0 : Number(match[2]), file: path.join(storeDir, entry) })
      }
    } catch (error) {
      noteError(error)
      return []
    }
    out.sort((a, b) => (a.day === b.day ? b.seq - a.seq : a.day < b.day ? 1 : -1))
    return out.slice(0, MAX_SCAN_FILES)
  }

  // ---- 自动捕获：工具报错（静默失败里最常见的一类；全量调用审计归 dsh-audit） ----
  // 真实事件形状（2026-11-01 用 _selftest/metrics/tool-error-rate.mjs 反向确认，v0.1.0 读错字段）：
  //   tool/call   data = { callId, name, ... }
  //   tool/result data = { message: { isError, toolCallId, content: [{ type, text }], error? } }
  // 旧实现读 data.isError / data.name —— 真实 payload 里都没有，结果是 source=unknown、message=[object Object]。
  const toolNames = new Map()

  function rememberToolCall(data) {
    const callId = data?.callId ?? data?.id
    const toolName = data?.name
    if (callId === undefined || callId === null || typeof toolName !== 'string' || toolName === '') return
    toolNames.set(String(callId), toolName)
    while (toolNames.size > MAX_TOOL_CACHE) toolNames.delete(toolNames.keys().next().value)
  }

  // 取「人能看懂的那句」：真实 payload（2026-11-01 从会话日志反解）长这样：
  //   data.message.content = [{ type: 'text', text: 'Error: code run failed ... \n    at ...' }]
  //   data.error = { name: 'CodeRunFailedError', code: 'CODE_RUN_FAILED' }（只有类名，没有原因）
  // 所以顺序必须 content 优先、error.name 兜底，否则只记到类名，等于没记原因。
  function textOf(candidate) {
    if (typeof candidate === 'string') return candidate
    if (Array.isArray(candidate)) {
      return candidate
        .map((item) => (typeof item === 'string' ? item : item?.text))
        .filter((item) => typeof item === 'string' && item !== '')
        .join(' ')
    }
    if (candidate !== null && typeof candidate === 'object') {
      if (typeof candidate.text === 'string' && candidate.text !== '') return candidate.text
      if (typeof candidate.message === 'string' && candidate.message !== '') return candidate.message
      if (typeof candidate.name === 'string' && candidate.name !== '') return candidate.name
      try { return JSON.stringify(candidate) } catch (error) { return String(candidate) }
    }
    return ''
  }

  function errorTextOf(data, message) {
    const candidates = [message?.error, message?.content, data?.message, data?.content, data?.error]
    for (const candidate of candidates) {
      if (candidate === undefined || candidate === null) continue
      const text = textOf(candidate)
      if (text !== '') return text
    }
    return ''
  }

  ctx.effect(() =>
    ctx.on('session/event', (session, event) => {
      try {
        const type = event?.type
        if (type !== 'tool/call' && type !== 'tool/result') return
        if (captureToolErrors !== true) return
        const data = event?.data ?? {}
        if (type === 'tool/call') {
          rememberToolCall(data)
          return
        }
        const message = data.message ?? {}
        const failed = message.isError === true || data.isError === true || message.error !== undefined || data.error !== undefined
        if (!failed) return
        const callId = message.toolCallId ?? data.toolCallId ?? data.callId
        const known = callId === undefined || callId === null ? undefined : toolNames.get(String(callId))
        const toolName = String(known ?? data.name ?? message.name ?? 'unknown').slice(0, 64)
        // 只取首行：错误正文后面常带整段调用栈，塞进 message 没有信息增量
        const detail = (errorTextOf(data, message).split('\n')[0] || '').replace(/\s+/g, ' ').trim().slice(0, 240)
        append({
          level: 'warn',
          channel: 'agent',
          code: 'TOOL-ERROR',
          source: toolName,
          message: detail === '' ? toolName + ' 调用失败' : toolName + ' 调用失败：' + detail,
          session: String(session?.id ?? session?.header?.id ?? session?.sessionId ?? ''),
        })
      } catch (error) {
        noteError(error)
      }
    }),
  )

  // ---- 启动事件：解决「什么时候开始不对」 ----
  append({ level: 'info', channel: 'system', code: 'LOG-START', source: 'dsh-eventlog', message: '事件日志已启动（keepDays=' + keepDays + '，store=' + storeDir + '）' })
  pruneOld()

  // ---- 工具 1：写事件（给 agent / 其它插件的通用入口） ----
  ctx.effect(() =>
    ctx.tools.register({
      name: 'log_write',
      description:
        'Append one structured event to the local event log (Windows-Event-Viewer style: channel + level + stable code + message). Use it for operational milestones and silent failures that produce no error of their own.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Human-readable one-liner (<= 400 chars).' },
          level: { type: 'string', enum: LEVELS, description: 'info | warn | error | fatal. Default info.' },
          channel: { type: 'string', enum: CHANNELS, description: 'system | plugin | memory | hook | agent | restart. Default system.' },
          code: { type: 'string', description: 'Stable event code, e.g. PLUGIN-LOAD-FAIL / MEM-CONFLICT / RESTART-DONE.' },
          source: { type: 'string', description: 'Emitter: plugin name or module.' },
          data: { type: 'string', description: 'Optional small JSON payload (<= 900 chars). Never put secrets or long text here.' },
        },
        required: ['message'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, file: { type: 'string' }, code: { type: 'string' } },
          required: ['ok'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [text(value?.ok === true ? '已记录事件（' + (value.code ?? '') + '）' : '日志写入失败（不影响主流程，详见 log_status.lastError）')]
        },
      },
      async execute(args) {
        const result = append({
          level: args?.level,
          channel: args?.channel,
          code: args?.code,
          source: args?.source,
          message: args?.message,
          data: args?.data,
        })
        if (result === null) return { ok: false }
        return { ok: true, file: result.file, code: result.event.code }
      },
    }),
  )

  // ---- 工具 2：查事件（「需要的时候用」就是这一条） ----
  ctx.effect(() =>
    ctx.tools.register({
      name: 'log_query',
      description:
        'Query the local event log on demand (nothing is injected into the prompt). Filter by channel / level / code / time / keyword; newest first.',
      parameters: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Exact channel filter: system | plugin | memory | hook | agent | restart.' },
          level: { type: 'string', description: 'Minimum level: info | warn | error | fatal.' },
          code: { type: 'string', description: 'Exact event code filter, e.g. TOOL-ERROR.' },
          since: { type: 'string', description: 'Start time: ISO time, YYYY-MM-DD, or relative like 1d / 12h.' },
          until: { type: 'string', description: 'End time, same formats as since.' },
          keyword: { type: 'string', description: 'Case-insensitive substring over code/source/message/data.' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max events to return (default 20).' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            matched: { type: 'integer' },
            scanned: { type: 'integer' },
            entries: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  ts: { type: 'string' },
                  level: { type: 'string' },
                  channel: { type: 'string' },
                  code: { type: 'string' },
                  source: { type: 'string' },
                  message: { type: 'string' },
                },
                required: ['ts', 'level', 'channel', 'code', 'source', 'message'],
                additionalProperties: false,
              },
            },
          },
          required: ['matched', 'scanned', 'entries'],
          additionalProperties: false,
        },
        render(_args, value) {
          const entries = Array.isArray(value?.entries) ? value.entries : []
          if (entries.length === 0) return [text('事件日志里没有匹配项（扫了 ' + (value?.scanned ?? 0) + ' 条）')]
          const lines = entries.map((item) => '[' + item.level + '] ' + String(item.ts).slice(5, 19).replace('T', ' ') + ' ' + item.channel + '/' + item.code + ' ' + item.message)
          return [text('匹配 ' + (value?.matched ?? 0) + ' / ' + (value?.scanned ?? 0) + ' 条：\n' + lines.join('\n'))]
        },
      },
      async execute(args) {
        const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, MAX_LIMIT) : 20
        const now = Date.now()
        const filter = {
          channel: typeof args?.channel === 'string' ? args.channel.trim() : '',
          level: typeof args?.level === 'string' ? args.level.trim() : '',
          code: typeof args?.code === 'string' ? args.code.trim() : '',
          keyword: typeof args?.keyword === 'string' ? args.keyword.trim() : '',
          since: parseWhen(args?.since, now),
          until: parseWhen(args?.until, now),
        }
        let scanned = 0
        const hits = []
        for (const item of filesNewestFirst()) {
          if (hits.length >= limit) break
          let body = ''
          try {
            body = readFileSync(item.file, 'utf8')
          } catch (error) {
            noteError(error)
            continue
          }
          const lines = body.split('\n')
          for (let index = lines.length - 1; index >= 0; index -= 1) {
            const event = parseLine(lines[index])
            if (event === null) continue
            scanned += 1
            if (!matchesFilter(event, filter)) continue
            hits.push(event)
            if (hits.length >= limit) break
          }
        }
        return {
          matched: hits.length,
          scanned,
          entries: hits.map((event) => ({
            ts: String(event.ts ?? ''),
            level: String(event.level ?? ''),
            channel: String(event.channel ?? ''),
            code: String(event.code ?? ''),
            source: String(event.source ?? ''),
            message: String(event.message ?? ''),
          })),
        }
      },
    }),
  )

  // ---- 工具 3：日志健康（有没有在写、写到哪、要不要清） ----
  ctx.effect(() =>
    ctx.tools.register({
      name: 'log_status',
      description: 'Read-only health of the local event log: files, entries, size, oldest/newest, retention, last error, capture switches.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            storeDir: { type: 'string' },
            files: { type: 'integer' },
            entries: { type: 'integer' },
            bytes: { type: 'integer' },
            oldest: { type: 'string' },
            newest: { type: 'string' },
            keepDays: { type: 'integer' },
            minLevel: { type: 'string' },
            captureToolErrors: { type: 'boolean' },
            writtenThisRun: { type: 'integer' },
            lastError: { type: 'string' },
          },
          required: ['storeDir', 'files', 'entries', 'bytes', 'keepDays', 'minLevel', 'captureToolErrors', 'writtenThisRun', 'lastError'],
          additionalProperties: false,
        },
        render(_args, value) {
          const head = '事件日志：' + (value?.files ?? 0) + ' 个文件 / ' + (value?.entries ?? 0) + ' 条 / ' + Math.round((value?.bytes ?? 0) / 1024) + ' KB'
          const range = value?.oldest ? '，范围 ' + String(value.oldest).slice(0, 10) + ' → ' + String(value.newest).slice(0, 10) : ''
          const tail = '（保留 ' + (value?.keepDays ?? 0) + ' 天，最低级别 ' + (value?.minLevel ?? '') + '，本次已写 ' + (value?.writtenThisRun ?? 0) + ' 条）'
          const err = value?.lastError ? '\n⚠ 最近错误：' + value.lastError : ''
          return [text(head + range + tail + err)]
        },
      },
      async execute() {
        let files = 0
        let entries = 0
        let bytes = 0
        let oldest = ''
        let newest = ''
        for (const item of filesNewestFirst()) {
          files += 1
          try {
            bytes += statSync(item.file).size
            if (newest === '') newest = item.day
            oldest = item.day
          } catch (error) {
            noteError(error)
            continue
          }
          let body = ''
          try {
            body = readFileSync(item.file, 'utf8')
          } catch (error) {
            noteError(error)
            continue
          }
          for (const line of body.split('\n')) {
            if (line.trim() !== '') entries += 1
          }
        }
        return {
          storeDir,
          files,
          entries,
          bytes,
          oldest,
          newest,
          keepDays,
          minLevel,
          captureToolErrors,
          writtenThisRun: written,
          lastError,
        }
      },
    }),
  )
}
