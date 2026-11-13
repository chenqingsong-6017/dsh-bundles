// 工具调用捕获（2026-11-13 从 index.js 抽出）：失败记 TOOL-ERROR；成功摘要记 TOOL-CALL（默认关，配置开）。
// 为什么单独成文件：index.js 是装配层（禁屎山：入口只装配），且事件捕获可独立单测。
// 质量闸要求单函数 ≤50 行 / CCN≤20，所以这里按职责拆成小函数，installToolCapture 只装配。
// 真实事件形状（2026-11-01 用 _selftest/metrics/tool-error-rate.mjs 反向确认，v0.1.0 读错字段）：
//   tool/call   data = { callId, name, ... }
//   tool/result data = { message: { isError, toolCallId, content: [{ type, text }], error? } }

/** 会话 id 归一（三种历史形状：id / header.id / sessionId）。 */
export function sessionIdOf(session) {
  return String(session?.id ?? session?.header?.id ?? session?.sessionId ?? '')
}

/** 取「人能看懂的那句」：content 优先、error.name 兜底（只有类名等于没记原因）。 */
export function textOf(candidate) {
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

export function errorTextOf(data, message) {
  const candidates = [message?.error, message?.content, data?.message, data?.content, data?.error]
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue
    const text = textOf(candidate)
    if (text !== '') return text
  }
  return ''
}

/** 失败判定：显式 isError:false 一律当成功；否则任一错误信号算失败（非致命 error 字段不误报）。 */
export function isFailed(message, data) {
  const explicitSuccess = message.isError === false || data.isError === false
  if (explicitSuccess) return false
  return message.isError === true || data.isError === true || message.error !== undefined || data.error !== undefined
}

/** 工具名归一：callId 映射 > payload.name > unknown。 */
export function toolNameOf(known, data, message) {
  return String(known?.name ?? data.name ?? message.name ?? 'unknown').slice(0, 64)
}

/** 记 callId → { name, startedAt }，供失败还原工具名、成功算耗时。 */
export function rememberToolCall(toolNames, data, maxToolCache) {
  const callId = data?.callId ?? data?.id
  const toolName = data?.name
  if (callId === undefined || callId === null || typeof toolName !== 'string' || toolName === '') return
  toolNames.set(String(callId), { name: toolName, startedAt: Date.now() })
  while (toolNames.size > maxToolCache) toolNames.delete(toolNames.keys().next().value)
}

/** 成功摘要事件：工具名 + 耗时 + 输出字符数（不存参数/输出全文）。 */
export function successEntry(session, toolName, known, callId, message) {
  const durationMs = Number.isFinite(known?.startedAt) ? Math.max(0, Date.now() - known.startedAt) : null
  const content = message.content
  const outputChars = Array.isArray(content)
    ? content.reduce((sum, item) => sum + (typeof item?.text === 'string' ? item.text.length : 0), 0)
    : 0
  return {
    level: 'info',
    channel: 'agent',
    code: 'TOOL-CALL',
    source: toolName,
    message: toolName + ' 成功' + (durationMs === null ? '' : '（' + durationMs + 'ms）') + (outputChars > 0 ? '，输出 ' + outputChars + ' 字符' : ''),
    data: { callId: String(callId ?? ''), duration_ms: durationMs, output_chars: outputChars },
    session: sessionIdOf(session),
  }
}

/** 失败事件：只取首行（调用栈不进 message）。 */
export function errorEntry(session, toolName, data, message) {
  const detail = (errorTextOf(data, message).split('\n')[0] || '').replace(/\s+/g, ' ').trim().slice(0, 240)
  return {
    level: 'warn',
    channel: 'agent',
    code: 'TOOL-ERROR',
    source: toolName,
    message: detail === '' ? toolName + ' 调用失败' : toolName + ' 调用失败：' + detail,
    session: sessionIdOf(session),
  }
}

/** 装配：订阅 session/event，tool/call 记映射、tool/result 记错误或成功摘要。 */
export function installToolCapture(ctx, deps) {
  const { append, captureToolErrors, captureToolCalls, noteError, maxToolCache } = deps
  const toolNames = new Map()
  ctx.effect(() =>
    ctx.on('session/event', (session, event) => {
      try {
        const type = event?.type
        if (type !== 'tool/call' && type !== 'tool/result') return
        const data = event?.data ?? {}
        if (type === 'tool/call') {
          rememberToolCall(toolNames, data, maxToolCache)
          return
        }
        const message = data.message ?? {}
        const callId = message.toolCallId ?? data.toolCallId ?? data.callId
        const known = callId === undefined || callId === null ? undefined : toolNames.get(String(callId))
        const toolName = toolNameOf(known, data, message)
        if (!isFailed(message, data)) {
          if (captureToolCalls === true) append(successEntry(session, toolName, known, callId, message))
          return
        }
        if (captureToolErrors === true) append(errorEntry(session, toolName, data, message))
      } catch (error) {
        noteError(error)
      }
    }),
  )
}
