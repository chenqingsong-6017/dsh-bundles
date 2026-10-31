/**
 * dsh-cost —— 成本与上下文的常驻可见（学 Claude Code statusline / opencode token HUD）
 *
 * 问题：DSH 的 token-meter 只计量，agent 自己看不到"这轮花了多少、上下文还剩多少"。
 * 结果是要么事后翻 usage_report，要么等爆上下文。
 *
 * 做法：每轮装配系统提示时，追加一行**极简**的成本/水位摘要：
 *   <cost>本会话 12 次 · in 45.2k out 8.1k 缓存 320k · 上下文 62.3k/128k(49%)</cost>
 *
 * 数据来源（全部来自当前会话，不落盘）：
 *   - assistant/message 事件的 usage.{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}
 *   - request/context 事件的 contextWindow
 *
 * 取舍：
 *   - 不落盘：重启后从当前会话事件重扫，天然准确，不引入额外存储
 *   - 首轮扫一遍全量事件建立基线，之后只增量累加（WeakMap + WeakSet，不泄漏）
 *   - 默认只报 token，不报钱（价格表可配；DSH 本机 dsh-usage 也没填价格）
 *   - 没有任何 usage 时不注入（空会话零成本）
 */

export const name = 'dsh-cost'
export const inject = ['tools', 'systemPrompt']

const CONTEXT_ORDER = 950
const DEFAULT_MAX_LINE = 220

const num = (value) => (Number.isFinite(value) ? value : 0)

import { readFileSync } from 'node:fs'

/**
 * v2026-10-31：价格表支持外部文件（与 dsh-usage 共用同一个 prices.json，改价只改一处）。
 * 读不到 / 坏了退回内联 prices —— 价格表读失败绝不能连累每轮的 HUD 行。
 */
export function resolvePrices(config) {
  const inline = config?.prices && typeof config.prices === 'object' ? config.prices : null
  const file = typeof config?.pricesFile === 'string' && config.pricesFile.trim() !== '' ? config.pricesFile.trim() : ''
  if (file === '') return inline
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const clean = {}
      for (const [key, value] of Object.entries(parsed)) {
        if (key.startsWith('_')) continue
        if (value !== null && typeof value === 'object') clean[key] = value
      }
      if (Object.keys(clean).length > 0) return clean
    }
  } catch (error) {
    // 静默退回内联
  }
  return inline
}

/**
 * 把「按模型分组」的价格表摊平成单个模型的四项价格。
 * prices.json 是 { 'deepseek-flash': {input,...} }（usage 用），cost 只需要当前模型那一组。
 * 兼容已经写成扁平的旧配置（{input,...}）——原样返回。
 */
export function flattenPrices(prices, model) {
  if (prices === null || prices === undefined || typeof prices !== 'object') return undefined
  if (typeof prices.input === 'number') return prices
  const key =
    typeof model === 'string' && prices[model] !== undefined
      ? model
      : Object.keys(prices).find((item) => prices[item] !== null && typeof prices[item] === 'object')
  return key === undefined ? undefined : prices[key]
}

/** 12345 -> 12.3k；1234567 -> 1.23M；128000 -> 128k。去掉无意义的 .0，保持一眼可读。 */
export function fmtTokens(value) {
  const n = num(value)
  const trim = (text) => (text.includes('.') ? text.replace(/\.?0+$/, '') : text)
  if (n >= 1_000_000) return trim((n / 1_000_000).toFixed(2)) + 'M'
  if (n >= 1000) return trim((n / 1000).toFixed(n >= 10_000 ? 1 : 2)) + 'k'
  return String(Math.round(n))
}

const emptyStats = () => ({
  calls: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  lastContext: 0,
  contextWindow: 0,
})

/** 把一条会话事件揉进统计（纯函数，便于测试）。 */
export function absorbEvent(stats, event) {
  if (stats === null || typeof stats !== 'object' || event === null || typeof event !== 'object') return stats
  if (event.type === 'assistant/message') {
    const usage = event.data?.usage
    if (usage !== undefined && usage !== null) {
      stats.calls += 1
      stats.input += num(usage.inputTokens)
      stats.output += num(usage.outputTokens)
      stats.cacheRead += num(usage.cacheReadTokens)
      stats.cacheWrite += num(usage.cacheWriteTokens)
      // 最近一次请求的输入总和 ≈ 当前上下文占用量（Claude Code statusline 同款口径）
      stats.lastContext = num(usage.inputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens)
    }
  } else if (event.type === 'request/context') {
    const window = event.data?.contextWindow
    if (Number.isFinite(window) && window > 0) stats.contextWindow = window
  }
  return stats
}

/** 渲染一行摘要；没有任何调用时返回空串（不注入）。 */
export function renderCostLine(stats, options) {
  if (stats === null || typeof stats !== 'object' || num(stats.calls) === 0) return ''
  const parts = ['本会话 ' + stats.calls + ' 次']
  parts.push('in ' + fmtTokens(stats.input))
  parts.push('out ' + fmtTokens(stats.output))
  if (num(stats.cacheRead) > 0 || num(stats.cacheWrite) > 0) {
    const read = num(stats.cacheRead)
    const totalInput = num(stats.input) + read + num(stats.cacheWrite)
    const hit = totalInput > 0 ? Math.round((read / totalInput) * 100) : 0
    parts.push('缓存 ' + fmtTokens(read) + (hit > 0 ? '(' + hit + '%)' : ''))
  }
  const cost = costOf(stats, options?.prices)
  if (cost > 0) parts.push(options?.currency + (cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)))
  if (num(stats.lastContext) > 0) {
    const used = fmtTokens(stats.lastContext)
    const window = num(stats.contextWindow)
    parts.push(window > 0 ? '上下文 ' + used + '/' + fmtTokens(window) + '(' + Math.round((stats.lastContext / window) * 100) + '%)' : '上下文 ' + used)
  }
  const line = '<cost>' + parts.join(' · ') + '</cost>'
  const max = Number.isInteger(options?.maxLine) && options.maxLine > 0 ? options.maxLine : DEFAULT_MAX_LINE
  if (line.length <= max) return line
  // 截断时给收尾标签留位置，保证总长度不超过硬上限
  const tail = '…</cost>'
  if (max <= tail.length) return tail.slice(-max)
  return line.slice(0, max - tail.length) + tail
}

/** 按每百万 token 单价算钱；prices 缺省时返回 0（只报 token）。 */
export function costOf(stats, prices) {
  if (prices === null || typeof prices !== 'object') return 0
  const per = (value) => num(value) / 1_000_000
  return (
    num(stats.input) * per(prices.input) +
    num(stats.output) * per(prices.output) +
    num(stats.cacheRead) * per(prices.cacheRead) +
    num(stats.cacheWrite) * per(prices.cacheWrite)
  )
}

export function apply(ctx, config) {
  const prices = flattenPrices(resolvePrices(config), typeof config?.model === 'string' ? config.model.trim() : '')
  const currency = typeof config?.currency === 'string' && config.currency !== '' ? config.currency + ' ' : ''
  const maxLine = Number.isInteger(config?.maxLine) && config.maxLine > 0 ? config.maxLine : DEFAULT_MAX_LINE

  const statsBySession = new WeakMap()
  const scanned = new WeakSet()

  const ensureBase = (session) => {
    if (session === undefined || session === null || scanned.has(session)) return statsBySession.get(session)
    const stats = emptyStats()
    try {
      if (typeof session.snapshotEvents === 'function') {
        for (const event of session.snapshotEvents()) absorbEvent(stats, event)
      }
    } catch (error) {
      ctx.logger?.warn?.('dsh-cost: 基线扫描失败 %o', error)
    }
    scanned.add(session)
    statsBySession.set(session, stats)
    return stats
  }

  const statsOf = (session) => {
    const base = ensureBase(session)
    if (base !== undefined) return base
    let stats = statsBySession.get(session)
    if (stats === undefined) {
      stats = emptyStats()
      statsBySession.set(session, stats)
    }
    return stats
  }

  // ---- 增量累计 ----
  ctx.on('session/event', (session, event) => {
    try {
      absorbEvent(statsOf(session), event)
    } catch (error) {
      ctx.logger?.warn?.('dsh-cost: 事件累计失败 %o', error)
    }
  })

  // ---- 注入：每轮一行 ----
  const systemPrompt = ctx.systemPrompt ?? (typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined)
  if (systemPrompt !== undefined && systemPrompt !== null && typeof systemPrompt.context === 'function') {
    ctx.effect(() =>
      systemPrompt.context({
        name: 'dsh-cost',
        order: CONTEXT_ORDER,
        text: (context) => {
          try {
            const session = context?.agent?.session
            if (session === undefined || session === null) return ''
            return renderCostLine(statsOf(session), { prices, currency, maxLine })
          } catch (error) {
            return ''
          }
        },
      }),
    )
  }

  // ---- 诊断 ----
  ctx.effect(() =>
    ctx.tools.register({
      name: 'cost_status',
      description:
        'Diagnose the cost HUD: current session token totals, cache hit ratio, context usage against the window, and the price table in effect.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            calls: { type: 'integer' },
            input: { type: 'integer' },
            output: { type: 'integer' },
            cacheRead: { type: 'integer' },
            cacheWrite: { type: 'integer' },
            contextUsed: { type: 'integer' },
            contextWindow: { type: 'integer' },
            cost: { type: 'number' },
            priced: { type: 'boolean' },
            priceTable: {
              type: 'object',
              properties: {
                input: { type: 'number' },
                output: { type: 'number' },
                cacheRead: { type: 'number' },
                cacheWrite: { type: 'number' },
              },
              required: ['input', 'output', 'cacheRead', 'cacheWrite'],
              additionalProperties: false,
            },
          },
          required: ['calls', 'input', 'output', 'cacheRead', 'cacheWrite', 'contextUsed', 'contextWindow', 'cost', 'priced', 'priceTable'],
          additionalProperties: false,
        },
        render(_args, value) {
          if (value.calls === 0) return [{ type: 'text', text: '本会话还没有模型调用，成本 HUD 暂不注入。' }]
          const lines = [
            '本会话 ' + value.calls + ' 次调用：输入 ' + fmtTokens(value.input) + ' / 输出 ' + fmtTokens(value.output) + ' / 缓存读 ' + fmtTokens(value.cacheRead) + ' / 缓存写 ' + fmtTokens(value.cacheWrite),
            value.contextWindow > 0
              ? '上下文：' + fmtTokens(value.contextUsed) + ' / ' + fmtTokens(value.contextWindow) + '（' + Math.round((value.contextUsed / value.contextWindow) * 100) + '%）'
              : '上下文：' + fmtTokens(value.contextUsed) + '（窗口大小未知）',
            value.priced
              ? '预估成本：' + currency + value.cost.toFixed(4) + '（按每百万 token：输入 ' + value.priceTable.input + ' / 输出 ' + value.priceTable.output + ' / 缓存读 ' + value.priceTable.cacheRead + ' / 缓存写 ' + value.priceTable.cacheWrite + '）'
              : '未配置价格表（只报 token，不报钱）',
          ]
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(_args, exec) {
        const session = exec?.agent?.session
        const stats = session !== undefined ? statsOf(session) : emptyStats()
        const cost = costOf(stats, prices)
        return {
          calls: num(stats.calls),
          input: Math.round(num(stats.input)),
          output: Math.round(num(stats.output)),
          cacheRead: Math.round(num(stats.cacheRead)),
          cacheWrite: Math.round(num(stats.cacheWrite)),
          contextUsed: Math.round(num(stats.lastContext)),
          contextWindow: Math.round(num(stats.contextWindow)),
          cost: Math.round(cost * 10000) / 10000,
          priced: prices !== undefined,
          priceTable: {
            input: num(prices?.input),
            output: num(prices?.output),
            cacheRead: num(prices?.cacheRead),
            cacheWrite: num(prices?.cacheWrite),
          },
        }
      },
    }),
  )
}
