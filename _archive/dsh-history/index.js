/**
 * dsh-history —— 历史会话全文检索 + 阅读。
 *
 * 学谁：claude-mem 的"把历史会话语料化"思路（SQLite+FTS5 检索 observations/sessions），
 * 以及 Claude Code 的 `--resume` / 会话列表体验。
 *
 * 但 DSH 这边有个便宜得多的实现路径：会话日志本身就是 `~/.dsh/sessions/.../session.v4.jsonl.zstd`，
 * Node（≥22.15）自带 zstd 解压。所以不做索引库、不引入依赖：**按需解压 + 内存缓存（按 mtime/size 失效）**。
 * 7 个会话 ≈ 4 MB 压缩，扫一遍毫秒级。
 *
 * 三个工具：
 *   - `history_search`  全文搜：标题/用户消息/助手回复，返回会话 + 片段
 *   - `history_read`    读某个会话的最近若干条消息（按 id / id 前缀 / 标题片段定位）
 *   - `history_status`  看会话库位置、数量、每个会话的标题/工作区/更新时间
 *
 * 边界：只读本地日志，不写；不进 agent 的"会话事件流"（不新增事件类型）；搜索是子串匹配（不是语义搜索）；
 * 超大日志（>64 MB）跳过以免拖慢。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-history'
export const inject = ['tools']

const DEFAULT_MAX_RESULTS = 8
const DEFAULT_SNIPPET = 120
const MAX_MESSAGE_CHARS = 600
const MAX_LOG_BYTES = 64 * 1024 * 1024
const CACHE_LIMIT = 16

const text = (value) => ({ type: 'text', text: value })

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 会话日志是**多帧追加**的 zstd 流（每 flush 一帧）。某些 Node/Electron 版本的
 * `zstdDecompressSync` 只解第一帧——表现就是"只读出 session 头、消息全空"。
 * 这里按 magic 把缓冲切成帧逐个解压，再拼起来；magic 出现在压缩数据里造成假分界时，
 * 通过"把后续帧并进来重试"兜底。
 */
function decompressZstdAll(buffer) {
  const starts = []
  let at = 0
  while ((at = buffer.indexOf(ZSTD_MAGIC, at)) !== -1) {
    starts.push(at)
    at += ZSTD_MAGIC.length
  }
  if (starts.length <= 1) {
    try {
      return zstdDecompressSync(buffer)
    } catch (error) {
      return Buffer.alloc(0)
    }
  }
  const ranges = starts.map((start, index) => [start, index + 1 < starts.length ? starts[index + 1] : buffer.length])
  if (starts[0] !== 0) ranges.unshift([0, starts[0]])
  const parts = []
  let index = 0
  while (index < ranges.length) {
    let settled = false
    for (let extra = 0; extra < 3 && index + extra < ranges.length && !settled; extra += 1) {
      const [start] = ranges[index]
      const stop = index + extra < ranges.length ? ranges[index + extra][1] : buffer.length
      try {
        parts.push(zstdDecompressSync(buffer.subarray(start, stop)))
        index += extra + 1
        settled = true
      } catch (error) {
        /* 假分界：把下一帧并进来再试 */
      }
    }
    if (!settled) index += 1
  }
  return Buffer.concat(parts)
}

function sessionsRoot(override) {
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override.trim())
  if (process.env.DSH_HOME) return path.join(process.env.DSH_HOME, 'sessions')
  return path.join(os.homedir(), '.dsh', 'sessions')
}

function listSessionFiles(root) {
  const files = []
  const walk = (dir, depth) => {
    if (depth > 6) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (entry.isFile() && /^session.*\.jsonl\.zstd$/.test(entry.name)) files.push(full)
    }
  }
  walk(root, 0)
  return files
}

function blocksText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

const cache = new Map()

function parseSession(file) {
  let stat
  try {
    stat = statSync(file)
  } catch (error) {
    return undefined
  }
  const key = `${stat.mtimeMs}:${stat.size}`
  const cached = cache.get(file)
  if (cached && cached.key === key) return cached.data
  if (stat.size > MAX_LOG_BYTES) return undefined

  const data = {
    id: path.basename(path.dirname(file)),
    file,
    cwd: '',
    createdAt: 0,
    agentPreset: '',
    title: '',
    messages: [],
    toolCalls: 0,
    bytes: stat.size,
    updatedAt: Math.round(stat.mtimeMs),
    rawEvents: 0,
    error: '',
  }
  try {
    const raw = decompressZstdAll(readFileSync(file)).toString('utf8')
    for (const line of raw.split('\n')) {
      if (line === '') continue
      let event
      try {
        event = JSON.parse(line)
      } catch (error) {
        continue
      }
      data.rawEvents += 1
      if (event.type === 'session') {
        if (typeof event.id === 'string') data.id = event.id
        if (typeof event.cwd === 'string') data.cwd = event.cwd
        if (typeof event.createdAt === 'number') data.createdAt = event.createdAt
        if (typeof event.agentPreset === 'string') data.agentPreset = event.agentPreset
        continue
      }
      if (event.type === 'session/title' && event.data && typeof event.data.title === 'string') {
        data.title = event.data.title
        continue
      }
      if (event.type === 'user/message') {
        const body = blocksText(event.data?.content)
        if (body !== '') data.messages.push({ role: 'user', text: body, time: event.time ?? 0 })
        continue
      }
      if (event.type === 'assistant/message') {
        const body = blocksText(event.data?.message?.content)
        if (body !== '') data.messages.push({ role: 'assistant', text: body, time: event.time ?? 0 })
        continue
      }
      if (event.type === 'tool/call') data.toolCalls += 1
    }
  } catch (error) {
    data.error = error instanceof Error ? error.message : String(error)
  }

  cache.set(file, { key, data })
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  return data
}

function formatTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function snippetAround(body, index, queryLength, maxSnippet) {
  const flat = body.replace(/\s+/g, ' ').trim()
  const ratio = body.length > 0 ? flat.length / body.length : 1
  const at = Math.max(0, Math.floor(index * ratio) - Math.floor(maxSnippet / 3))
  const slice = flat.slice(at, at + maxSnippet)
  return `${at > 0 ? '…' : ''}${slice}${at + maxSnippet < flat.length ? '…' : ''}`
}

function shortId(id) {
  return String(id).replace(/^session-/, '').slice(0, 8)
}

export function apply(ctx, config) {
  const maxResults =
    Number.isInteger(config?.maxResults) && config.maxResults > 0 ? Math.min(config.maxResults, 50) : DEFAULT_MAX_RESULTS
  const maxSnippet =
    Number.isInteger(config?.maxSnippet) && config.maxSnippet > 0 ? Math.min(config.maxSnippet, 400) : DEFAULT_SNIPPET
  const root = sessionsRoot(config?.sessionsDir)
  const tools = ctx.tools

  if (typeof zstdDecompressSync !== 'function') {
    ctx.effect(() =>
      tools.register({
        name: 'history_status',
        description: 'Report why session-history search is unavailable (the Node runtime has no zstd support).',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: { type: 'object', properties: { problem: { type: 'string' } }, required: ['problem'], additionalProperties: false },
          render(_args, value) {
            return [text(`历史检索不可用：${value?.problem ?? '未知原因'}`)]
          },
        },
        async execute() {
          return { problem: `当前 Node 不支持 zstd（需要 Node ≥ 22.15）；会话目录：${root}` }
        },
      }),
    )
    return
  }

  function allSessions() {
    return listSessionFiles(root)
      .map((file) => parseSession(file))
      .filter((session) => session !== undefined)
  }

  function resolveSession(ref) {
    const needle = String(ref).trim()
    const sessions = allSessions()
    const lowered = needle.toLowerCase()
    const byExact = sessions.filter((session) => session.id === needle)
    if (byExact.length === 1) return { session: byExact[0] }
    const byPrefix = sessions.filter((session) => session.id.startsWith(needle) || shortId(session.id) === lowered)
    if (byPrefix.length === 1) return { session: byPrefix[0] }
    const byTitle = sessions.filter((session) => session.title && session.title.toLowerCase().includes(lowered))
    if (byTitle.length === 1) return { session: byTitle[0] }
    const candidates = [...byPrefix, ...byTitle].slice(0, 8)
    if (candidates.length === 0) {
      const recent = sessions
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 6)
        .map((session) => `${shortId(session.id)}（${session.title || '无标题'}）`)
      return { error: `没找到会话：${needle}。最近的会话有：${recent.join('、')}` }
    }
    const list = candidates.map((session) => `${shortId(session.id)}（${session.title || '无标题'}）`).join('、')
    return { error: `匹配到多个会话：${list}。请用更长的 id 前缀。` }
  }

  ctx.effect(() =>
    tools.register({
      name: 'history_search',
      description:
        'Search past local sessions by text. Returns matching sessions with titles, workspaces and snippets. Use it to recall what was decided or built in an earlier conversation.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to look for (case-insensitive substring, at least 2 characters).' },
          limit: { type: 'integer', description: 'Max sessions to return (default 8).' },
          cwd: { type: 'string', description: 'Only sessions whose workspace equals this path.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            scanned: { type: 'integer' },
            query: { type: 'string' },
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  shortId: { type: 'string' },
                  title: { type: 'string' },
                  cwd: { type: 'string' },
                  updatedAt: { type: 'integer' },
                  matches: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        role: { type: 'string' },
                        time: { type: 'integer' },
                        snippet: { type: 'string' },
                      },
                      required: ['role', 'snippet'],
                      additionalProperties: false,
                    },
                  },
                },
                required: ['id', 'shortId', 'title', 'cwd', 'updatedAt', 'matches'],
                additionalProperties: false,
              },
            },
          },
          required: ['scanned', 'query', 'results'],
          additionalProperties: false,
        },
        render(_args, value) {
          const results = Array.isArray(value?.results) ? value.results : []
          if (results.length === 0) {
            return [text(`在 ${value?.scanned ?? 0} 个会话里没找到「${value?.query ?? ''}」。换个关键词试试。`)]
          }
          const total = results.reduce((sum, item) => sum + item.matches.length, 0)
          const lines = [`在 ${value.scanned} 个会话里找到 ${total} 条匹配（${results.length} 个会话，最近优先）：`]
          for (const item of results) {
            lines.push('')
            lines.push(`■ ${item.title || '（无标题）'}  ${formatTime(item.updatedAt)}  ${item.cwd || '—'}`)
            lines.push(`   id: ${item.shortId}`)
            for (const match of item.matches) {
              lines.push(`   [${match.role}] ${match.snippet}`)
            }
          }
          lines.push('')
          lines.push('要看全文用 history_read（传 id 前缀即可）。')
          return [text(lines.join('\n'))]
        },
      },
      async execute(args) {
        const query = typeof args?.query === 'string' ? args.query.trim() : ''
        if (query.length < 2) throw new Error('history_search 需要至少 2 个字符的 query。')
        const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 50) : maxResults
        const cwdFilter = typeof args?.cwd === 'string' && args.cwd.trim() !== '' ? path.resolve(args.cwd.trim()) : undefined
        const lowered = query.toLowerCase()
        const results = []
        for (const session of allSessions()) {
          if (cwdFilter && path.resolve(session.cwd || '') !== cwdFilter) continue
          const matches = []
          if (session.title && session.title.toLowerCase().includes(lowered)) {
            matches.push({ role: 'title', time: session.createdAt, snippet: session.title })
          }
          for (const message of session.messages) {
            if (matches.length >= 3) break
            const index = message.text.toLowerCase().indexOf(lowered)
            if (index < 0) continue
            matches.push({ role: message.role, time: message.time, snippet: snippetAround(message.text, index, query.length, maxSnippet) })
          }
          if (matches.length === 0) continue
          results.push({
            id: session.id,
            shortId: shortId(session.id),
            title: session.title,
            cwd: session.cwd,
            updatedAt: session.updatedAt,
            matches,
          })
        }
        results.sort((a, b) => b.updatedAt - a.updatedAt)
        return { scanned: allSessions().length, query, results: results.slice(0, limit) }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'history_read',
      description:
        'Read the most recent messages of one past session (locate it by id, id prefix or a title fragment). Returns the conversation digest without tool noise.',
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string', description: 'Session id, id prefix (e.g. "d3717208"), or a title fragment.' },
          limit: { type: 'integer', description: 'How many recent messages to show (default 20).' },
        },
        required: ['session'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            shortId: { type: 'string' },
            title: { type: 'string' },
            cwd: { type: 'string' },
            createdAt: { type: 'integer' },
            agentPreset: { type: 'string' },
            totalMessages: { type: 'integer' },
            messages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string' },
                  time: { type: 'integer' },
                  text: { type: 'string' },
                },
                required: ['role', 'text'],
                additionalProperties: false,
              },
            },
          },
          required: ['id', 'shortId', 'title', 'cwd', 'createdAt', 'agentPreset', 'totalMessages', 'messages'],
          additionalProperties: false,
        },
        render(_args, value) {
          const messages = Array.isArray(value?.messages) ? value.messages : []
          const head = `■ ${value?.title || '（无标题）'}\n   id: ${value?.shortId} · 工作区: ${value?.cwd || '—'} · 开始于 ${formatTime(value?.createdAt ?? 0)} · 共 ${value?.totalMessages ?? 0} 条消息`
          if (messages.length === 0) return [text(`${head}\n\n（这个会话没有可读的文本消息）`)]
          const lines = messages.map((message) => {
            const who = message.role === 'user' ? '用户' : '助手'
            return `[${who}] ${message.text.replace(/\s+/g, ' ').slice(0, MAX_MESSAGE_CHARS)}`
          })
          return [text(`${head}\n\n${lines.join('\n\n')}`)]
        },
      },
      async execute(args) {
        const ref = typeof args?.session === 'string' ? args.session.trim() : ''
        if (ref === '') throw new Error('history_read 需要 session（id、id 前缀或标题片段）。')
        const resolved = resolveSession(ref)
        if (resolved.error) throw new Error(resolved.error)
        const session = resolved.session
        const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 100) : 20
        const recent = session.messages.slice(-limit)
        return {
          id: session.id,
          shortId: shortId(session.id),
          title: session.title,
          cwd: session.cwd,
          createdAt: session.createdAt,
          agentPreset: session.agentPreset,
          totalMessages: session.messages.length,
          messages: recent.map((message) => ({
            role: message.role,
            ...(message.time ? { time: message.time } : {}),
            text: message.text.slice(0, MAX_MESSAGE_CHARS),
          })),
        }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'history_status',
      description: 'Show where session logs live, how many there are, and each session’s title, workspace and update time.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            sessionsDir: { type: 'string' },
            count: { type: 'integer' },
            sessions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  shortId: { type: 'string' },
                  title: { type: 'string' },
                  cwd: { type: 'string' },
                  updatedAt: { type: 'integer' },
                  messages: { type: 'integer' },
                  toolCalls: { type: 'integer' },
                  rawEvents: { type: 'integer' },
                  error: { type: 'string' },
                },
                required: ['shortId', 'title', 'cwd', 'updatedAt', 'messages', 'toolCalls'],
                additionalProperties: false,
              },
            },
          },
          required: ['sessionsDir', 'count', 'sessions'],
          additionalProperties: false,
        },
        render(_args, value) {
          const sessions = Array.isArray(value?.sessions) ? value.sessions : []
          const lines = [`历史会话库：${value?.sessionsDir ?? '?'}（${value?.count ?? 0} 个会话）`]
          for (const session of sessions) {
            lines.push(
              `■ ${session.title || '（无标题）'}  ${formatTime(session.updatedAt)}  ${session.messages} 条消息 / ${session.toolCalls} 次工具调用${session.error ? ` · 读取警告: ${session.error}` : ''}`,
            )
            lines.push(`   id: ${session.shortId} · ${session.cwd || '—'}`)
          }
          return [text(lines.join('\n'))]
        },
      },
      async execute() {
        const sessions = allSessions()
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((session) => ({
            shortId: shortId(session.id),
            title: session.title,
            cwd: session.cwd,
            updatedAt: session.updatedAt,
            messages: session.messages.length,
            toolCalls: session.toolCalls,
            rawEvents: session.rawEvents,
            error: session.error,
          }))
        return { sessionsDir: root, count: sessions.length, sessions }
      },
    }),
  )
}
