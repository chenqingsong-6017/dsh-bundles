/**
 * dsh-staleness-watch v0.2
 *
 * 运行时陈旧检测:把"动作后必须重新观察"从提示词约束变成事件级策略。
 *
 * 两个挂载点:
 *   tools/post-execute  观测并告警(永远不打断)
 *   tools/guard         强制阻断(可选,由 config 控制)
 *
 * 两种模式:
 *   mode: 'warn'   —— 只在结果里追加告警,不改变执行结果
 *   mode: 'block'  —— 连续盲操作达到阈值后,拦截下一次输入操作,要求先快照
 *
 * 为什么强制用 guard 而不是 post-execute:
 *   post 阶段动作已经发生,拦不住;guard 在动作之前运行,返回字符串即拒绝。
 */

export const name = 'staleness-watch'
export const inject = ['tools']

const MUTATING = [
  /click/i,
  /type_text/i,
  /press_key/i,
  /hotkey/i,
  /scroll/i,
  /drag/i,
  /set_value/i,
  /launch_app/i,
  /bring_to_front/i,
]

const SNAPSHOT = [
  /get_window_state/i,
  /get_browser_state/i,
  /get_desktop_state/i,
  /verify_state/i,
]

const matches = (patterns, name) => patterns.some((re) => re.test(name))

function targetKey(args) {
  const a = args ?? {}
  const pid = a.pid ?? a.target?.pid
  if (pid === undefined || pid === null) return null
  const windowId = a.window_id ?? a.target?.window_id ?? '-'
  return `${pid}|${windowId}`
}

function carriedTokens(args) {
  const a = args ?? {}
  const out = []
  for (const field of ['element_token', 'snapshot_id']) {
    if (typeof a[field] === 'string' && a[field].length > 0) out.push(field)
  }
  return out
}

const text = (value) => ({ type: 'text', text: value })

export function apply(ctx, config) {
  const mode = config?.mode === 'block' ? 'block' : 'warn'
  const limit = Number.isInteger(config?.maxBlindActions) && config.maxBlindActions > 0
    ? config.maxBlindActions
    : 3

  /** key -> { stale: boolean, blind: number } */
  const state = new Map()
  const read = (key) => state.get(key) ?? { stale: false, blind: 0 }

  // ---- 强制层:动作之前拦截 ----
  ctx.tools.guard((exec) => {
    if (mode !== 'block') return undefined
    const toolName = String(exec?.name ?? '')
    if (!matches(MUTATING, toolName)) return undefined
    if (matches(SNAPSHOT, toolName)) return undefined

    const key = targetKey(exec?.arguments ?? {})
    if (key === null) return undefined

    const current = read(key)
    if (current.blind < limit) return undefined

    const [pid, windowId] = key.split('|')
    return (
      `staleness-watch 已拦截:目标 pid=${pid} window=${windowId} 已连续 ${current.blind} 次输入操作未重新观察。` +
      `请先调用 get_window_state(pid=${pid}, window_id=${windowId}) 取得新快照,确认页面/窗口的实际状态后再继续。`
    )
  })

  // ---- 观测层:结果之后告警 ----
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept') return decision
    if (decision.value !== undefined) return decision

    const toolName = String(exec?.name ?? '')
    const args = exec?.arguments ?? {}
    const key = targetKey(args)
    if (key === null) return decision

    const warnings = []
    const current = read(key)

    if (matches(SNAPSHOT, toolName)) {
      state.set(key, { stale: false, blind: 0 })
      return decision
    }

    if (matches(MUTATING, toolName)) {
      const tokens = carriedTokens(args)

      if (current.stale && tokens.length > 0) {
        warnings.push(
          `⚠️ 陈旧快照告警:本次调用使用了 ${tokens.join(' / ')},但该目标自上次快照后已经发生过输入操作。` +
            `如果结果与预期不符,请先重新 get_window_state 再重试,不要复用旧 token。`,
        )
      } else if (current.blind >= limit - 1) {
        warnings.push(
          `⚠️ 连续盲操作告警:同一目标已连续 ${current.blind + 1} 次输入操作,中间没有重新观察。` +
            `建议在下一步动作前取一次 get_window_state,用截图 + 元素树核对实际状态。`,
        )
      }

      state.set(key, { stale: true, blind: current.blind + 1 })
    }

    if (warnings.length === 0) return decision

    const base = decision.content ?? result.content ?? []
    return { kind: 'accept', content: [...warnings.map(text), ...base] }
  })
}
