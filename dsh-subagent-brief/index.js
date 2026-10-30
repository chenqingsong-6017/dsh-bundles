/**
 * dsh-subagent-brief —— 子 agent 摘要契约（agent/pre-step 版）
 *
 * 学谁：Claude Code 的 subagent —— 子 agent 在自己的上下文里干完活，
 * 回给主 agent 的是一份短摘要，原始长输出留在子会话里。
 *
 * 拦截点（2026-10-30 从 app.asar 源码确认，不是猜）：
 * DSH 0.2.1-rc.5 里子会话结果**不走** tools/post-execute，而是由
 * @deepseek-ai/dsh-subagent 的 createSettlementMessage() 构造一条 user 消息
 * 投递给父会话：
 *
 *   content: [
 *     { type: 'text', text: <结算摘要> },
 *     { type: 'text', text: 'Its closing message:' },
 *     ...子 agent 的最终文本块,                         ← 只有这些算「正文」
 *     { type: 'text', text: 'Structured result: ...' }, ← 保留
 *     ...诊断块                                          ← 保留
 *   ]
 *   source: { kind: 'subagent-settled', form: 'notice', summary, senderSessionId }
 *
 * 这条消息进入父 agent 的 inbox，每一步之前经过 agent/pre-step waterfall
 * （@deepseek-ai/dsh-agent-loop，payload = { messages, turn, step, signal }，
 * 默认返回 { kind: 'enter', messages }）。本插件就在这里做「限高杆」：
 * 正文累计超过 maxChars 就截断，并在正文位置追加一句可操作尾注。
 *
 * 已知边界（刻意不做）：
 *   - 只处理 source.kind 在 sourceKinds 里的消息（默认 subagent-settled）
 *   - 只截 'Its closing message:' 之后的正文 text 块；摘要块 / 标记块 /
 *     Structured result 块 / 诊断块原样保留
 *   - 不改 summary、source 与消息其它字段；不做语义压缩、不调模型
 */

export const name = 'dsh-subagent-brief'
export const inject = ['tools']

/** 默认阈值：结算消息里的子 agent 正文超过这么多字符就收成摘要。 */
export const DEFAULT_MAX_CHARS = 1200
/** 默认只处理 subagent 服务投递的结算消息。 */
export const DEFAULT_SOURCE_KINDS = ['subagent-settled']
/** 结算消息里「摘要 / 正文」的分界块（createSettlementMessage 写死的英文标记）。 */
export const CLOSING_MARKER = 'Its closing message:'
/** 结构化结果块开头：它不是正文，截断时原样保留。 */
export const STRUCTURED_PREFIX = 'Structured result:'
/** 截断尾注的头尾。幂等判断靠它，改文案要同步改 README 与测试。 */
export const SUMMARY_HEAD = '（已按摘要契约截断：原文 '
export const SUMMARY_TAIL = ' 字符，完整内容在子会话，需要细节请让子 agent 只报关键结论）'
/**
 * 截断位置要落在「最后一个换行」上，但换行太靠前就不值当（会白丢一大截）。
 * 只有换行落在最后 50% 区间里才按行断。
 */
const MIN_NEWLINE_RATIO = 0.5
/** 最近记录上限（R6：列表默认不超过 20 条）。 */
const MAX_RECENT = 20
const DEFAULT_LIMIT = 12
/** pre-step 概览里最多列多少个来源 kind（防刷屏）。 */
const MAX_SEEN_KINDS = 30

const textPart = (value) => ({ type: 'text', text: value })

const isTextPart = (part) =>
  part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string'

/** 阈值归一化：非正数 / 非数字 / 缺失都回落到默认值。 */
export function normalizeMaxChars(value) {
  const num = typeof value === 'string' ? Number(value.trim()) : value
  if (typeof num === 'number' && Number.isFinite(num) && num >= 1) {
    return Math.max(1, Math.floor(num))
  }
  return DEFAULT_MAX_CHARS
}

/** 来源 kind 归一化：去空白、丢非字符串、去重；显式空数组表示「一个都不拦」。 */
export function normalizeSourceKinds(value) {
  if (!Array.isArray(value)) return [...DEFAULT_SOURCE_KINDS]
  const seen = new Set()
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/** 截断尾部提示：必须让模型知道「内容不全、要细节就再问」。 */
export function buildFooter(originalLength) {
  return SUMMARY_HEAD + String(originalLength) + SUMMARY_TAIL
}

/** 这段文本是不是已经带我们的尾注（幂等判断，避免二次截断）。 */
export function isSummarized(value) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  if (!text.endsWith(SUMMARY_TAIL)) return false
  const tailStart = Math.max(0, text.length - 320)
  return text.lastIndexOf(SUMMARY_HEAD, text.length) >= tailStart
}

/**
 * 在 maxChars 处断开，尽量落在最后一个换行上（成行的报告才有自然断点）。
 * 顺手处理三个边界：CRLF 残留的 \r、被切一半的 emoji（代理对）。
 */
export function cutAt(value, maxChars) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const limit = normalizeMaxChars(maxChars)
  let head = text.slice(0, limit)
  const newline = head.lastIndexOf('\n')
  if (newline > 0 && newline >= limit * MIN_NEWLINE_RATIO) head = head.slice(0, newline)
  if (head.endsWith('\r')) head = head.slice(0, -1)
  const lastCode = head.length === 0 ? 0 : head.charCodeAt(head.length - 1)
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) head = head.slice(0, -1)
  return head
}

/** content 里所有 text 块的总长度（status 里的「原长度 / 新长度」就是这个口径）。 */
export function totalTextLength(content) {
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const part of content) {
    if (isTextPart(part)) total += part.text.length
  }
  return total
}

/**
 * 找「摘要 / 正文」的分界块下标；找不到返回 -1。
 * 兼容带不带冒号、前后空白（createSettlementMessage 目前写的是 'Its closing message:'）。
 */
export function findClosingMarker(content) {
  if (!Array.isArray(content)) return -1
  for (let index = 0; index < content.length; index += 1) {
    const part = content[index]
    if (!isTextPart(part)) continue
    const text = part.text.trim().replace(/[:：]\s*$/, '')
    if (text === CLOSING_MARKER.replace(/[:：]\s*$/, '')) return index
  }
  return -1
}

/**
 * 这个块算不算「子 agent 正文」。
 * 不是正文的一律原样保留：非 text 块、空文本、Structured result、诊断块、
 * 以及已经带我们尾注的块（幂等）。
 */
export function isBodyPart(part) {
  if (!isTextPart(part)) return false
  const text = part.text.trim()
  if (text === '') return false
  if (text.startsWith(STRUCTURED_PREFIX)) return false
  if (/^diagnostic(s)?\b/i.test(text)) return false
  if (text.startsWith('诊断')) return false
  if (text.includes(SUMMARY_HEAD)) return false
  return true
}

/**
 * 纯函数：把一条结算消息的正文收成摘要。
 * 返回 { message, changed, fromLen, toLen }：
 *   - message：没改动时是**原对象**，改动时是新对象（不动外部传入的消息）
 *   - fromLen / toLen：消息里所有 text 块的总长度（前 / 后），差就是省下的上下文
 * 找不到分界块、正文没超阈值、已经截过 —— 都原样返回。
 */
export function summarizeNotice(message, maxChars = DEFAULT_MAX_CHARS) {
  const limit = normalizeMaxChars(maxChars)
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return { message, changed: false, fromLen: 0, toLen: 0 }
  }
  const content = Array.isArray(message.content) ? message.content : null
  if (content === null) return { message, changed: false, fromLen: 0, toLen: 0 }

  const fromLen = totalTextLength(content)
  const unchanged = { message, changed: false, fromLen, toLen: fromLen }
  const markerIndex = findClosingMarker(content)
  if (markerIndex < 0) return unchanged

  // 幂等：正文里已经有我们的尾注，就不再截（哪怕它仍比阈值长）。
  for (let index = markerIndex + 1; index < content.length; index += 1) {
    const part = content[index]
    if (isTextPart(part) && part.text.includes(SUMMARY_HEAD)) return unchanged
  }

  let bodyTotal = 0
  for (let index = markerIndex + 1; index < content.length; index += 1) {
    const part = content[index]
    if (isBodyPart(part)) bodyTotal += part.text.length
  }
  if (bodyTotal <= limit) return unchanged

  const nextContent = content.slice(0, markerIndex + 1)
  let remaining = limit
  let lastBodyPos = -1
  for (let index = markerIndex + 1; index < content.length; index += 1) {
    const part = content[index]
    if (!isBodyPart(part)) {
      nextContent.push(part)
      continue
    }
    if (remaining <= 0) continue // 超出预算的正文块直接丢弃（长报告本体）
    if (part.text.length <= remaining) {
      nextContent.push(part)
      remaining -= part.text.length
    } else {
      const head = cutAt(part.text, remaining)
      nextContent.push({ ...part, text: head })
      remaining = 0
    }
    lastBodyPos = nextContent.length - 1
  }

  const footer = textPart(buildFooter(bodyTotal))
  // 尾注紧跟在最后一段保留的正文后面（后面的 Structured result / 诊断块仍原样留在原位）。
  nextContent.splice(lastBodyPos >= 0 ? lastBodyPos + 1 : markerIndex + 1, 0, footer)

  const outMessage = { ...message, content: nextContent }
  return { message: outMessage, changed: true, fromLen, toLen: totalTextLength(nextContent) }
}

// ---------- 插件 ----------

export function apply(ctx, config) {
  const enabled = config?.enabled !== false
  const maxChars = normalizeMaxChars(config?.maxChars)
  const sourceKinds = normalizeSourceKinds(config?.sourceKinds)
  const sourceSet = new Set(sourceKinds)

  let truncatedCount = 0
  let charsSaved = 0
  const recent = []
  let lastSeen = null

  const pad2 = (num) => String(num).padStart(2, '0')
  const clock = () => {
    const now = new Date()
    return pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds())
  }
  const safeInt = (value) => {
    const num = Number(value)
    return Number.isFinite(num) ? Math.round(num) : 0
  }
  const kindLabel = (message) => {
    const kind = message?.source?.kind
    return typeof kind === 'string' && kind !== '' ? kind : '（无 source）'
  }

  const record = (kind, fromLen, toLen) => {
    truncatedCount += 1
    charsSaved += Math.max(0, fromLen - toLen)
    recent.push({ time: clock(), kind, from: fromLen, to: toLen })
    while (recent.length > MAX_RECENT) recent.shift()
  }

  // ---- 边界：父 agent 每一步之前，截断子 agent 的结算消息 ----
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()

    // 无论开没开都记一份概览：以后排查「到底有没有看到消息」就靠它。
    try {
      const messages = Array.isArray(payload?.messages)
        ? payload.messages
        : Array.isArray(decision?.messages)
          ? decision.messages
          : null
      if (messages !== null) {
        lastSeen = {
          time: clock(),
          turn: safeInt(payload?.turn),
          step: safeInt(payload?.step),
          decision: typeof decision?.kind === 'string' ? decision.kind : '',
          messageCount: messages.length,
          kinds: messages.slice(0, MAX_SEEN_KINDS).map(kindLabel),
        }
      }
    } catch (error) {
      ctx.logger?.warn?.('subagent-brief: 记录 pre-step 概览失败 %o', error)
    }

    if (!enabled) return decision
    if (decision === null || typeof decision !== 'object') return decision
    if (decision.kind !== 'enter') return decision
    const messages = Array.isArray(decision.messages) ? decision.messages : null
    if (messages === null || messages.length === 0) return decision

    try {
      let changed = false
      const out = messages.map((message) => {
        const kind = message?.source?.kind
        if (typeof kind !== 'string' || !sourceSet.has(kind)) return message
        const brief = summarizeNotice(message, maxChars)
        if (!brief.changed) return message
        changed = true
        record(kind, brief.fromLen, brief.toLen)
        return brief.message
      })
      return changed ? { ...decision, messages: out } : decision
    } catch (error) {
      ctx.logger?.warn?.('subagent-brief: 摘要失败 %o', error)
      return decision
    }
  })

  // ---- 工具：诊断 ----
  const toolService = ctx.tools
  if (toolService === undefined || toolService === null || typeof toolService.register !== 'function') return

  const humanNumber = (value) => {
    const num = Number(value)
    if (!Number.isFinite(num)) return '0'
    return String(Math.round(num)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  }

  const clampLimit = (value) => {
    const num = Number(value)
    if (!Number.isFinite(num)) return DEFAULT_LIMIT
    return Math.min(MAX_RECENT, Math.max(1, Math.floor(num)))
  }

  const emptySeen = () => ({
    time: '',
    turn: 0,
    step: 0,
    decision: '',
    messageCount: 0,
    kinds: [],
  })

  const statusSchema = {
    type: 'object',
    properties: {
      enabled: { type: 'boolean' },
      maxChars: { type: 'integer' },
      sourceKinds: { type: 'array', items: { type: 'string' } },
      truncatedCount: { type: 'integer' },
      charsSaved: { type: 'integer' },
      recent: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            time: { type: 'string' },
            kind: { type: 'string' },
            from: { type: 'integer' },
            to: { type: 'integer' },
          },
          required: ['time', 'kind', 'from', 'to'],
          additionalProperties: false,
        },
      },
      lastSeen: {
        type: 'object',
        properties: {
          time: { type: 'string' },
          turn: { type: 'integer' },
          step: { type: 'integer' },
          decision: { type: 'string' },
          messageCount: { type: 'integer' },
          kinds: { type: 'array', items: { type: 'string' } },
        },
        required: ['time', 'turn', 'step', 'decision', 'messageCount', 'kinds'],
        additionalProperties: false,
      },
    },
    required: ['enabled', 'maxChars', 'sourceKinds', 'truncatedCount', 'charsSaved', 'recent', 'lastSeen'],
    additionalProperties: false,
  }

  const seenLine = (seen) => {
    if (seen === null || seen.time === '') return '还没看到过 pre-step 事件（装好后至少跑一步才会有记录）。'
    const kinds = Array.isArray(seen.kinds) && seen.kinds.length > 0 ? seen.kinds.join('、') : '（无消息）'
    return (
      '上次 pre-step：' +
      seen.time +
      ' 第 ' +
      seen.turn +
      ' 回合第 ' +
      seen.step +
      ' 步，' +
      seen.messageCount +
      ' 条消息（来源：' +
      kinds +
      '）'
    )
  }

  const statusRender = (_args, value) => {
    const lines = []
    const seen = value?.lastSeen ?? emptySeen()
    if (value?.enabled === false) {
      lines.push('摘要契约：当前是关闭状态，子 agent 的长结算消息会原样回到主干。')
      lines.push('想开启：把配置里的 enabled 改回 true（默认就是开着的）。')
      lines.push(seenLine(seen))
      return [textPart(lines.join('\n'))]
    }
    lines.push(
      '摘要契约：已启用 —— 子 agent 结算消息的正文超过 ' +
        humanNumber(value?.maxChars ?? 0) +
        ' 字符就收成摘要。',
    )
    const kinds = Array.isArray(value?.sourceKinds) ? value.sourceKinds : []
    lines.push('拦截来源：' + (kinds.length === 0 ? '（一个都没配，等于全部放行）' : kinds.join('、')))
    lines.push(seenLine(seen))
    const count = Number(value?.truncatedCount ?? 0)
    if (count <= 0) {
      lines.push('本次运行还没有截断过：结算消息的正文都没超过阈值。')
    } else {
      lines.push('本次运行截断 ' + count + ' 次，共替你省下 ' + humanNumber(value?.charsSaved ?? 0) + ' 字符。')
    }
    const records = Array.isArray(value?.recent) ? value.recent : []
    if (records.length > 0) {
      lines.push('最近记录：')
      for (const item of records) {
        lines.push(
          '  ' +
            String(item?.time ?? '--:--:--') +
            '  ' +
            String(item?.kind ?? '-') +
            '  ' +
            humanNumber(item?.from) +
            ' 字符 → ' +
            humanNumber(item?.to) +
            ' 字符',
        )
      }
      const rest = count - records.length
      if (rest > 0) lines.push('… 还有 ' + rest + ' 次（用 limit 指定查看条数）')
    }
    return [textPart(lines.join('\n'))]
  }

  ctx.effect(() =>
    toolService.register({
      name: 'subagent_brief_status',
      description:
        'Diagnostics for the subagent-brief plugin: the truncation threshold, which settlement message source kinds are intercepted, how many subagent settlement messages were shortened in this run, the most recent truncations (time, source kind, original length -> new length), and a summary of the latest agent/pre-step payload seen (message count and source kinds). Read-only.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'How many recent truncations to show (1-20, default 12).' },
        },
        additionalProperties: false,
      },
      output: { schema: statusSchema, render: statusRender },
      async execute(args) {
        const limit = clampLimit(args?.limit)
        return {
          enabled,
          maxChars,
          sourceKinds,
          truncatedCount,
          charsSaved,
          recent: recent.slice(-limit).reverse(),
          lastSeen: lastSeen === null ? emptySeen() : { ...lastSeen, kinds: [...lastSeen.kinds] },
        }
      },
    }),
  )
}
