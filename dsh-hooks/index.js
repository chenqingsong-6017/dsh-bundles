/**
 * dsh-hooks —— 用户级 hooks：把「纪律」写成 JSON 配置文件，而不是再写一个插件。
 *
 * 为什么需要：
 *   2026 年头部 harness 的分水岭是「审批自动化 + 纪律内建」。Claude Code 有 17 个
 *   生命周期事件的 hooks（PreToolUse / Stop / WorktreeCreate…），用户不必写代码就能
 *   在危险命令前拦一道、在回合结束前跑一次自检。DSH 的事件底座比它更硬
 *   （tools/pre-execute 可 allow/deny/ask/cancel），但只对插件作者开放 ——
 *   普通用户想加一条「rm -rf 前先问」得自己写插件。
 *
 *   本插件把那层能力产品化：一个 hooks.json，一张事件表，两种动作（shell / 提示）。
 *
 * 支持四个事件（别名兼容 Claude Code 的叫法）：
 *   tool.pre        → tools/pre-execute   可 allow / deny / ask（**唯一能拦动作的**）
 *   tool.post       → tools/post-execute  只观察；stdout 会作为提示回灌给模型
 *   session.start   → agent/created       观察（日志 / 通知）
 *   turn.stop       → agent/turn-stopping 观察（**不能否决回合**；要否决请用 dsh-proof 的验证门）
 *
 * 钩子进程契约（照 Unix 惯例，不发明协议）：
 *   stdin  : 一行 JSON（event / tool / agent / cwd / timestamp）
 *   stdout : 空 → 放行；JSON {"decision":"deny|ask|allow","reason":"…","message":"…"} → 采纳
 *   exit 2 : 视为 deny，stderr 当理由
 *   exit ≠0: 按 onError（默认 allow）处理，并记进 hooks_status
 *   超时   : 默认 5 秒，按 onError 处理
 *
 * 安全边界：钩子是**用户自己写的** shell 命令，等价于用户自己的终端权限。
 * 本插件不提供任何内置放行策略，也不联网。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-hooks'
export const inject = ['tools']

const MAX_OUTPUT = 64 * 1024
const DEFAULT_TIMEOUT = 5000
const MAX_TIMEOUT = 60_000
const DEFAULT_HOOKS = 50
const LOG_LIMIT = 40
const MESSAGE_LIMIT = 2000

export const EVENT_NAMES = ['tool.pre', 'tool.post', 'session.start', 'turn.stop']

const EVENT_ALIASES = {
  'tool.pre': 'tool.pre',
  pretooluse: 'tool.pre',
  'pre-tool': 'tool.pre',
  'tool-pre': 'tool.pre',
  before_tool: 'tool.pre',
  'tool.post': 'tool.post',
  posttooluse: 'tool.post',
  'post-tool': 'tool.post',
  'tool-post': 'tool.post',
  after_tool: 'tool.post',
  'session.start': 'session.start',
  sessionstart: 'session.start',
  'session-start': 'session.start',
  'agent.start': 'session.start',
  'turn.stop': 'turn.stop',
  stop: 'turn.stop',
  'turn-stop': 'turn.stop',
  'turn-stopping': 'turn.stop',
  turnstop: 'turn.stop',
}

const text = (value) => ({ type: 'text', text: value })
const clampNumber = (value, min, max, fallback) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback

/** 事件名归一化：接受 'tool.pre' / 'PreToolUse' / 'stop' 等写法，认不出返回空串。 */
export function normalizeEvent(value) {
  const key = String(value ?? '')
    .trim()
    .toLowerCase()
  return EVENT_ALIASES[key] ?? ''
}

/**
 * 解析 hooks 配置文本。返回 { hooks, errors }，**永不抛错**：
 * 一条坏 hook 不应该让整个文件失效，更不应该让会话崩掉。
 */
export function parseHooksConfig(raw) {
  const errors = []
  let data
  try {
    data = JSON.parse(String(raw ?? ''))
  } catch (error) {
    return { hooks: [], errors: [`不是合法 JSON：${error instanceof Error ? error.message : String(error)}`] }
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.hooks) ? data.hooks : null
  if (!list) return { hooks: [], errors: ['顶层应是数组，或含 hooks 数组的对象'] }

  const hooks = []
  list.forEach((item, index) => {
    const at = `第 ${index + 1} 条`
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${at}：不是对象`)
      return
    }
    const event = normalizeEvent(item.event)
    if (event === '') {
      errors.push(`${at}：event 认不出（可用：${EVENT_NAMES.join(' / ')}）`)
      return
    }
    const run = typeof item.run === 'string' ? item.run.trim() : ''
    if (run === '') {
      errors.push(`${at}：缺 run（要执行的 shell 命令）`)
      return
    }
    let match = ''
    if (typeof item.match === 'string' && item.match.trim() !== '') {
      match = item.match.trim()
      try {
        // 只做校验，不保留编译结果（每轮配置可能变）
        new RegExp(match, 'i')
      } catch {
        errors.push(`${at}：match 不是合法正则：${match}`)
        return
      }
    }
    hooks.push({
      event,
      run,
      match,
      name: typeof item.name === 'string' && item.name.trim() !== '' ? item.name.trim() : `${event}#${index + 1}`,
      timeoutMs: clampNumber(item.timeoutMs, 100, MAX_TIMEOUT, DEFAULT_TIMEOUT),
      onError: item.onError === 'deny' ? 'deny' : 'allow',
      cwd: typeof item.cwd === 'string' && item.cwd.trim() !== '' ? item.cwd.trim() : '',
      enabled: item.enabled !== false,
    })
  })
  return { hooks, errors }
}

/** 判断一条 hook 是否适用于本次事件（事件 + 工具名匹配 + 未禁用）。 */
export function matchHook(hook, event, toolName) {
  if (!hook || hook.enabled === false || hook.event !== event) return false
  if (event !== 'tool.pre' && event !== 'tool.post') return true
  if (hook.match !== '') {
    try {
      return new RegExp(hook.match, 'i').test(String(toolName ?? ''))
    } catch {
      return false
    }
  }
  return true
}

/**
 * 把一次钩子进程的结局翻译成决策。
 * 规则见文件头；exit 2 = deny 是 Unix 里「惯例性拒绝」（grep/diff 同款）。
 */
export function interpretHookResult(run, event, onError = 'allow') {
  const fallback = onError === 'deny' ? 'deny' : 'allow'
  if (run?.timedOut) return { ok: false, decision: fallback, reason: '钩子超时', message: '' }
  if (run?.spawnError) return { ok: false, decision: fallback, reason: `钩子无法启动：${run.spawnError}`, message: '' }
  const stdout = String(run?.stdout ?? '').trim()
  const stderr = String(run?.stderr ?? '').trim()
  if (run?.code === 2) {
    return { ok: true, decision: 'deny', reason: stderr || stdout || '钩子拒绝（exit 2）', message: '' }
  }
  if (run?.code !== 0) {
    return {
      ok: false,
      decision: fallback,
      reason: `钩子退出码 ${run?.code ?? '?'}${stderr ? `：${stderr}` : ''}`,
      message: '',
    }
  }
  if (stdout.startsWith('{')) {
    try {
      const payload = JSON.parse(stdout)
      const decision = payload?.decision
      if (decision === 'deny' || decision === 'ask' || decision === 'allow') {
        return {
          ok: true,
          decision,
          reason: typeof payload.reason === 'string' ? payload.reason : '',
          message: typeof payload.message === 'string' ? payload.message : '',
        }
      }
    } catch {
      // 不是 JSON 就按普通 stdout 处理
    }
  }
  return { ok: true, decision: 'allow', reason: '', message: stdout }
}

/**
 * 解码钩子进程的输出。
 * Windows 的 cmd.exe 按控制台代码页（中文系统是 GBK/936）输出，直接当 UTF-8 读会乱码；
 * 所以先按 UTF-8 严格度试一次，出现替换符就回退 GBK。
 */
export function decodeOutput(buffer) {
  if (!buffer || buffer.length === 0) return ''
  const strict = new TextDecoder('utf-8').decode(buffer)
  if (!strict.includes('\uFFFD')) return strict
  try {
    return new TextDecoder('gbk').decode(buffer)
  } catch {
    return strict
  }
}

/** 起一个 shell 钩子，等它结束（有超时、有输出上限、绝不抛错）。 */
export function runShell(command, { timeoutMs = DEFAULT_TIMEOUT, input = '', cwd, env } = {}) {
  return new Promise((resolve) => {
    let settled = false
    const out = []
    const err = []
    let outBytes = 0
    let errBytes = 0
    let timedOut = false
    const finish = (payload) => {
      if (settled) return
      settled = true
      resolve({
        code: -1,
        stdout: decodeOutput(Buffer.concat(out)),
        stderr: decodeOutput(Buffer.concat(err)),
        timedOut: false,
        spawnError: '',
        ...payload,
      })
    }
    const collect = (chunk, sink, bytes) => {
      if (bytes >= MAX_OUTPUT) return bytes
      const room = MAX_OUTPUT - bytes
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk
      sink.push(part)
      return bytes + part.length
    }

    let child
    try {
      child = spawn(command, {
        shell: true,
        cwd: cwd || undefined,
        windowsHide: true,
        env: { ...process.env, ...(env ?? {}) },
      })
    } catch (error) {
      finish({ spawnError: error instanceof Error ? error.message : String(error) })
      return
    }

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {
        // 已经退出就算了
      }
      // 给 kill 一点时间；Windows 上子孙进程可能还活着，但不再阻塞调用方
      setTimeout(() => finish({ timedOut: true }), 250)
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => {
      outBytes = collect(chunk, out, outBytes)
    })
    child.stderr?.on('data', (chunk) => {
      errBytes = collect(chunk, err, errBytes)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ spawnError: error instanceof Error ? error.message : String(error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ code: code ?? -1, timedOut })
    })

    try {
      child.stdin?.end(typeof input === 'string' ? input : '')
    } catch {
      // stdin 关不上不影响结果
    }
  })
}

/** 配置来源：工作区 > 显式指定 > DSH_HOME > profile 目录。 */
export function candidateFiles(cwd, fileOverride) {
  const explicit = String(fileOverride ?? '').trim() || String(process.env.DSH_HOOKS_FILE ?? '').trim()
  if (explicit !== '') {
    // 显式指定时不再偷偷读别的文件（可预期比方便重要）
    return [path.resolve(explicit)]
  }
  const list = []
  if (typeof cwd === 'string' && cwd.trim() !== '') list.push(path.join(path.resolve(cwd), '.dsh', 'hooks.json'))
  const home = process.env.DSH_HOME
    ? path.join(process.env.DSH_HOME, 'hooks.json')
    : path.join(os.homedir(), '.dsh', 'hooks.json')
  list.push(home)
  if (process.env.DSH_PROFILE_DIR) list.push(path.join(process.env.DSH_PROFILE_DIR, 'hooks.json'))
  return list
}

function humanDeny(hook, reason) {
  const why = reason.trim() === '' ? '钩子拒绝了这次调用' : reason.trim()
  return (
    `dsh-hooks 拦截：${why}\n` +
    `来源：${hook.name}（${hook.event}）→ ${hook.run}\n` +
    `要放行这次操作：调整钩子规则或把它的 "enabled" 设为 false；要看清配置：调 hooks_status。`
  )
}

function humanAsk(hook, reason) {
  const why = reason.trim() === '' ? '钩子要求人工确认' : reason.trim()
  return `dsh-hooks 请求确认：${why}（来源：${hook.name}）`
}

export function apply(ctx, config) {
  const tools = ctx.tools
  const enabled = config?.enabled !== false
  const fileOverride = typeof config?.file === 'string' ? config.file : ''
  const maxHooks = clampNumber(config?.maxHooks, 1, 200, DEFAULT_HOOKS)
  const timeoutCeiling = clampNumber(config?.timeoutMs, 100, MAX_TIMEOUT, MAX_TIMEOUT)

  /** 文件路径 -> { mtimeMs, size, hooks, errors } */
  const cache = new Map()
  /** sessionId -> cwd（工作区级 hooks 靠它定位） */
  const sessionCwd = new Map()
  /** 最近执行记录（环形缓冲） */
  const recent = []
  let lastError = ''
  let runs = 0
  let denials = 0
  let asks = 0

  function record(entry) {
    recent.push(entry)
    if (recent.length > LOG_LIMIT) recent.shift()
  }

  function loadFile(file) {
    try {
      const stat = statSync(file)
      const cached = cache.get(file)
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached
      const parsed = parseHooksConfig(readFileSync(file, 'utf8'))
      const entry = { mtimeMs: stat.mtimeMs, size: stat.size, hooks: parsed.hooks, errors: parsed.errors, readable: true }
      cache.set(file, entry)
      return entry
    } catch (error) {
      return { mtimeMs: 0, size: 0, hooks: [], errors: [`读不到：${error instanceof Error ? error.message : String(error)}`], readable: false }
    }
  }

  function load(cwd) {
    const files = []
    const hooks = []
    const errors = []
    let unreadable = 0
    for (const file of candidateFiles(cwd, fileOverride)) {
      if (!existsSync(file)) continue
      const entry = loadFile(file)
      files.push(file)
      if (entry.readable === false) unreadable += 1
      for (const hook of entry.hooks) hooks.push({ ...hook, source: file })
      for (const error of entry.errors) errors.push(`${file}：${error}`)
    }
    return { files, hooks: hooks.slice(0, maxHooks), errors, unreadable }
  }

  function cwdFor(agentId) {
    const cwd = sessionCwd.get(String(agentId ?? ''))
    return typeof cwd === 'string' ? cwd : ''
  }

  function payloadFor(event, exec, cwd) {
    return JSON.stringify({
      event,
      tool: event === 'tool.pre' || event === 'tool.post'
        ? { name: String(exec?.name ?? ''), arguments: exec?.arguments ?? null }
        : null,
      agent: { id: String(exec?.agent?.id ?? '') },
      cwd: typeof cwd === 'string' ? cwd : '',
      timestamp: new Date().toISOString(),
      host: { platform: process.platform, pid: process.pid },
    })
  }

  async function runHooks(event, exec, cwd, hooks) {
    const payload = payloadFor(event, exec, cwd)
    const results = []
    for (const hook of hooks) {
      const startedAt = Date.now()
      const run = await runShell(hook.run, {
        timeoutMs: Math.min(hook.timeoutMs, timeoutCeiling),
        input: payload,
        cwd: hook.cwd || cwd || undefined,
        env: {
          DSH_HOOK_EVENT: event,
          DSH_HOOK_TOOL: String(exec?.name ?? ''),
          DSH_HOOK_SESSION: String(exec?.agent?.id ?? ''),
        },
      })
      const outcome = interpretHookResult(run, event, hook.onError)
      const ms = Date.now() - startedAt
      runs += 1
      if (outcome.decision === 'deny') denials += 1
      if (outcome.decision === 'ask') asks += 1
      if (!outcome.ok) lastError = `${hook.name}：${outcome.reason}`
      record({
        at: new Date().toISOString(),
        event,
        tool: String(exec?.name ?? ''),
        hook: hook.name,
        ms,
        decision: outcome.decision,
        code: run.code,
        ok: outcome.ok,
        reason: outcome.reason.slice(0, 500),
      })
      results.push({ hook, outcome, ms, code: run.code })
      if (outcome.decision === 'deny' && (event === 'tool.pre' || event === 'tool.post')) break
    }
    return results
  }

  // ---- 记住会话的工作目录（工作区级 hooks.json 靠它定位）----
  ctx.on('session/created', (session) => {
    const id = String(session?.id ?? '')
    const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : ''
    if (id !== '' && cwd !== '') sessionCwd.set(id, cwd)
  })
  ctx.on('session/disposed', (session) => {
    sessionCwd.delete(String(session?.id ?? ''))
  })

  // ---- tool.pre：唯一能拦动作的地方 ----
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!enabled) return next()
    const cwd = cwdFor(exec?.agent?.id)
    const { hooks } = load(cwd)
    const matching = hooks.filter((hook) => matchHook(hook, 'tool.pre', exec?.name))
    if (matching.length === 0) return next()

    let ask = null
    for (const result of await runHooks('tool.pre', exec, cwd, matching)) {
      if (exec?.signal?.aborted) return { kind: 'cancel' }
      if (result.outcome.decision === 'deny') return { kind: 'deny', reason: humanDeny(result.hook, result.outcome.reason) }
      if (result.outcome.decision === 'ask' && ask === null) ask = result.hook
    }
    if (ask) return { kind: 'ask', reason: humanAsk(ask, '') }
    return next()
  })

  // ---- tool.post：只观察；stdout 作为提示回灌 ----
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (!enabled) return decision
    if (decision.kind !== 'accept') return decision

    const cwd = cwdFor(exec?.agent?.id)
    const { hooks } = load(cwd)
    const matching = hooks.filter((hook) => matchHook(hook, 'tool.post', exec?.name))
    if (matching.length === 0) return decision

    const notes = []
    for (const { hook, outcome } of await runHooks('tool.post', exec, cwd, matching)) {
      const message = outcome.decision === 'deny'
        ? `dsh-hooks 提示（来自 ${hook.name}）：${outcome.reason}`
        : outcome.message !== ''
          ? `dsh-hooks 提示（来自 ${hook.name}）：\n${outcome.message.slice(0, MESSAGE_LIMIT)}`
          : ''
      if (message !== '') notes.push(message)
    }
    if (notes.length === 0) return decision

    const base = Array.isArray(decision.content) ? decision.content : Array.isArray(result?.content) ? result.content : []
    return { kind: 'accept', content: [...notes.map(text), ...base] }
  })

  // ---- session.start：观察 ----
  ctx.on('agent/created', async (payload) => {
    if (!enabled) return
    const agentId = String(payload?.agent?.id ?? '')
    const cwd = cwdFor(agentId)
    const { hooks } = load(cwd)
    const matching = hooks.filter((hook) => matchHook(hook, 'session.start', ''))
    if (matching.length === 0) return
    await runHooks('session.start', { name: '', arguments: { agent: agentId }, agent: { id: agentId } }, cwd, matching)
  })

  // ---- turn.stop：观察（不能否决回合）----
  ctx.on('agent/turn-stopping', async (payload) => {
    if (!enabled) return
    const agentId = String(payload?.agent?.id ?? '')
    const cwd = cwdFor(agentId)
    const { hooks } = load(cwd)
    const matching = hooks.filter((hook) => matchHook(hook, 'turn.stop', ''))
    if (matching.length === 0) return
    await runHooks('turn.stop', { name: '', arguments: { turn: payload?.turn ?? null }, agent: { id: agentId } }, cwd, matching)
  })

  // ---- 工具：诊断 ----
  ctx.effect(() =>
    tools.register({
      name: 'hooks_status',
      description:
        'Diagnostics for the user-level hooks plugin: where the config is read from, how many hooks are active per event, the most recent executions, and the last error. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'How many recent executions to show (1-40, default 12).' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ready: { type: 'boolean' },
            unavailableReason: { type: 'string' },
            enabled: { type: 'boolean' },
            configured: { type: 'boolean' },
            files: { type: 'array', items: { type: 'string' } },
            candidates: { type: 'array', items: { type: 'string' } },
            hookCount: { type: 'number' },
            byEvent: {
              type: 'object',
              properties: {
                'tool.pre': { type: 'number' },
                'tool.post': { type: 'number' },
                'session.start': { type: 'number' },
                'turn.stop': { type: 'number' },
              },
            },
            runs: { type: 'number' },
            denials: { type: 'number' },
            asks: { type: 'number' },
            recent: { type: 'array', items: { type: 'object', additionalProperties: true } },
            errors: { type: 'array', items: { type: 'string' } },
            lastError: { type: 'string' },
          },
          required: ['ready', 'unavailableReason', 'enabled', 'configured', 'files', 'candidates', 'hookCount', 'byEvent', 'runs', 'denials', 'asks', 'recent', 'errors', 'lastError'],
          additionalProperties: false,
        },
        render(_args, value) {
          if (value?.ready === false) {
            const lines = [`不可用：${value.unavailableReason || '未知原因'}`]
            if (!value?.configured) {
              lines.push(`配置写法：${value?.candidates?.[0] ?? '<DSH_HOME>/hooks.json'}`)
              lines.push(`最小示例：{"hooks":[{"event":"tool.pre","match":"^(bash|pwsh)$","run":"node check.mjs"}]}`)
              lines.push(`改完不用重启，下一次工具调用就会生效。`)
            }
            return [text(lines.join('\n'))]
          }
          const events = Object.entries(value.byEvent ?? {})
            .filter(([, count]) => count > 0)
            .map(([event, count]) => `${event} ${count} 条`)
            .join('、')
          const lines = [
            `已加载 ${value.hookCount} 条钩子${events ? `（${events}）` : ''}` +
              `${value.enabled ? '' : '，但插件当前是禁用状态'}。`,
            `配置文件：${value.files.join('；')}`,
          ]
          if (value.runs > 0) lines.push(`本轮共执行 ${value.runs} 次：拒绝 ${value.denials} 次、请求确认 ${value.asks} 次。`)
          if (value.lastError) lines.push(`最近一次异常：${value.lastError}`)
          if (Array.isArray(value.recent) && value.recent.length > 0) {
            lines.push('最近执行：')
            for (const item of value.recent.slice(0, 12)) {
              const time = String(item.at ?? '').slice(11, 19)
              lines.push(
                `  ${time}  ${item.event}  ${item.tool || '-'}  → ${item.decision}  ${item.ms}ms  ${item.hook}${item.ok ? '' : '（异常）'}`,
              )
            }
          }
          if (Array.isArray(value.errors) && value.errors.length > 0) {
            lines.push('配置问题：')
            for (const error of value.errors.slice(0, 8)) lines.push(`  ${error}`)
          }
          return [text(lines.join('\n'))]
        },
      },
      async execute(args) {
        const limit = clampNumber(args?.limit, 1, LOG_LIMIT, 12)
        const loaded = load('')
        const byEvent = Object.fromEntries(EVENT_NAMES.map((event) => [event, 0]))
        for (const hook of loaded.hooks) byEvent[hook.event] = (byEvent[hook.event] ?? 0) + 1
        const ready = loaded.files.length > 0 && loaded.hooks.length > 0 && loaded.unreadable === 0
        let unavailableReason = ''
        if (!ready) {
          if (loaded.files.length === 0) {
            unavailableReason = `没有找到 hooks.json（候选：${candidateFiles('', fileOverride).join(' / ')}）`
          } else if (loaded.unreadable > 0) {
            const first = loaded.errors.find((item) => item.includes('读不到：')) ?? loaded.errors[0] ?? '未知原因'
            unavailableReason = `hooks.json 读不了（${first}）`
          } else {
            unavailableReason = `hooks.json 里没有可用的钩子（0 条${loaded.errors.length > 0 ? `；首个问题：${loaded.errors[0]}` : ''}）`
          }
        }
        return {
          ready,
          unavailableReason,
          enabled,
          configured: loaded.files.length > 0,
          files: loaded.files,
          candidates: candidateFiles('', fileOverride),
          hookCount: loaded.hooks.length,
          byEvent,
          runs,
          denials,
          asks,
          recent: recent.slice(-limit).reverse(),
          errors: loaded.errors,
          lastError,
        }
      },
    }),
  )

  // ---- 工具：试跑（不执行真动作，只跑钩子）----
  ctx.effect(() =>
    tools.register({
      name: 'hooks_test',
      description:
        'Dry-run the configured hooks for one event without executing the real tool call: shows which hooks match, what each decides, and how long it took. Use it after editing the hooks config.',
      parameters: {
        type: 'object',
        properties: {
          event: { type: 'string', description: 'One of tool.pre / tool.post / session.start / turn.stop (PreToolUse / Stop etc. also accepted).' },
          tool: { type: 'string', description: 'Tool name to match against (tool.pre / tool.post only).' },
          arguments: { type: 'object', description: 'Fake tool arguments handed to the hook on stdin.', additionalProperties: true },
          cwd: { type: 'string', description: 'Directory hooks run in (defaults to this process cwd).' },
        },
        required: ['event'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            event: { type: 'string' },
            tool: { type: 'string' },
            matched: { type: 'number' },
            decision: { type: 'string' },
            code: { type: 'string' },
            results: { type: 'array', items: { type: 'object', additionalProperties: true } },
            notes: { type: 'array', items: { type: 'string' } },
          },
          required: ['event', 'tool', 'matched', 'decision', 'code', 'results', 'notes'],
          additionalProperties: false,
        },
        render(_args, value) {
          if (value.matched === 0) {
            return [text(`没有钩子匹配 ${value.event}${value.tool ? ` / ${value.tool}` : ''}。检查 event 与 match 正则。`)]
          }
          const lines = [`${value.matched} 条钩子匹配，最终决策：${value.decision}。`]
          for (const item of value.results ?? []) {
            const mark = item.ok ? '' : '（异常，按 onError 处理）'
            lines.push(`  ${item.hook}：${item.decision}  ${item.ms}ms  exit=${item.code}${mark}`)
            if (item.reason) lines.push(`    理由：${item.reason}`)
          }
          for (const note of value.notes ?? []) lines.push(note)
          return [text(lines.join('\n'))]
        },
      },
      async execute(args) {
        const event = normalizeEvent(args?.event)
        if (event === '') {
          return {
            event: String(args?.event ?? ''),
            tool: String(args?.tool ?? ''),
            matched: 0,
            decision: 'unknown',
            code: 'UNKNOWN_EVENT',
            results: [],
            notes: [`event 认不出，可用：${EVENT_NAMES.join(' / ')}`],
          }
        }
        const toolName = typeof args?.tool === 'string' ? args.tool : ''
        const cwd = typeof args?.cwd === 'string' && args.cwd.trim() !== '' ? args.cwd.trim() : process.cwd()
        const { hooks, errors } = load(cwd)
        const matching = hooks.filter((hook) => matchHook(hook, event, toolName))
        const fakeExec = { name: toolName, arguments: args?.arguments ?? null, agent: { id: '' } }
        const results = matching.length === 0 ? [] : await runHooks(event, fakeExec, cwd, matching)
        const decision = results.some((item) => item.outcome.decision === 'deny')
          ? 'deny'
          : results.some((item) => item.outcome.decision === 'ask')
            ? 'ask'
            : 'allow'
        return {
          event,
          tool: toolName,
          matched: matching.length,
          decision,
          code: '',
          results: results.map((item) => ({
            hook: item.hook.name,
            source: item.hook.source,
            decision: item.outcome.decision,
            ok: item.outcome.ok,
            reason: item.outcome.reason,
            message: item.outcome.message.slice(0, 500),
            ms: item.ms,
            code: item.code,
          })),
          notes: errors.length > 0 ? [`配置里有 ${errors.length} 处问题，见 hooks_status`] : [],
        }
      },
    }),
  )

  // ---- 工具：重载 ----
  ctx.effect(() =>
    tools.register({
      name: 'hooks_reload',
      description: 'Forget cached hooks config and re-read it from disk (normally unnecessary: the config reloads by mtime automatically).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            files: { type: 'array', items: { type: 'string' } },
            hookCount: { type: 'number' },
            code: { type: 'string' },
            errors: { type: 'array', items: { type: 'string' } },
          },
          required: ['files', 'hookCount', 'code', 'errors'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [
            text(
              value.hookCount === 0
                ? `重载完成，但没有读到任何钩子。${value.errors.length ? `问题：${value.errors[0]}` : '检查配置文件是否存在。'}`
                : `重载完成：${value.hookCount} 条钩子，来自 ${value.files.join('；')}。`,
            ),
          ]
        },
      },
      async execute() {
        cache.clear()
        const loaded = load('')
        const code = loaded.errors.length > 0
          ? 'CONFIG_INVALID'
          : loaded.files.length === 0
            ? 'CONFIG_MISSING'
            : loaded.hooks.length === 0
              ? 'NO_HOOKS'
              : ''
        return { files: loaded.files, hookCount: loaded.hooks.length, code, errors: loaded.errors }
      },
    }),
  )
}
