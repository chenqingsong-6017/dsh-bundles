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
 *
 * status 契约(v0.3 统一):
 *   `staleness_status` 的 ready 是**真实判断**——配置合法 + 两个挂载点真的挂上了;
 *   任何一项落空都报 ready:false 并给出 unavailableReason 与 code。
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

/**
 * 目标 key：`pid|window_id`。
 *
 * 2026-11-02 修 #33：按官方推荐用 `element_token` 寻址时，参数里往往没有 window_id，
 * 原先会算成 `pid|-`，而 get_window_state(pid, window_id) 复位的是 `pid|12345`——
 * 同一个目标被拆成两个 key，block 模式下「刚快照过仍被拦」。
 * 现在：缺 window_id 时先按 pid 反查最近一次快照的 window_id；查不到才退回 pid 级 key（`pid|*`）。
 */
function resolveKey(args, snapshots) {
  const a = args ?? {}
  const pid = a.pid ?? a.target?.pid
  if (pid === undefined || pid === null) return null
  let windowId = a.window_id ?? a.target?.window_id
  if (windowId === undefined || windowId === null) {
    const cached = snapshots.byPid.get(String(pid))
    if (cached && cached.windowId !== undefined && cached.windowId !== null) windowId = cached.windowId
  }
  return `${pid}|${windowId ?? '*'}`
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
  // 配置非法不改行为（fail-safe：仍按默认值跑），但 staleness_status 会如实报不可用。
  const configProblems = []
  if (config?.mode !== undefined && config.mode !== 'warn' && config.mode !== 'block') {
    configProblems.push('mode 只能是 warn 或 block，收到 ' + JSON.stringify(config.mode))
  }
  if (
    config?.maxBlindActions !== undefined &&
    !(Number.isInteger(config.maxBlindActions) && config.maxBlindActions > 0)
  ) {
    configProblems.push('maxBlindActions 需要正整数，收到 ' + JSON.stringify(config.maxBlindActions))
  }

  const mode = config?.mode === 'block' ? 'block' : 'warn'
  const limit = Number.isInteger(config?.maxBlindActions) && config.maxBlindActions > 0
    ? config.maxBlindActions
    : 3

  /** key -> { stale: boolean, blind: number } */
  const state = new Map()
  /** 最近一次快照：pid -> { windowId, snapshotId }，用于给 element_token 寻址反查窗口 */
  const snapshots = { byPid: new Map() }
  const targetKey = (args) => resolveKey(args, snapshots)
  const read = (key) => state.get(key) ?? { stale: false, blind: 0 }
  // 挂载结果是 ready 的真实依据：没挂上就是没生效，不能假装可用。
  let guardMounted = false
  let postExecuteMounted = false

  // ---- 强制层:动作之前拦截 ----
  const guardHook = (exec) => {
    if (mode !== 'block') return undefined
    const toolName = String(exec?.name ?? '')
    if (!matches(MUTATING, toolName)) return undefined
    if (matches(SNAPSHOT, toolName)) return undefined

    const key = targetKey(exec?.arguments ?? {})
    if (key === null) return undefined

    const current = read(key)
    if (current.blind < limit) return undefined

    const [pid, windowId] = key.split('|')
    const target = windowId === '*' ? `pid=${pid}` : `pid=${pid} window=${windowId}`
    const nextStep = windowId === '*' ? `get_window_state(pid=${pid})` : `get_window_state(pid=${pid}, window_id=${windowId})`
    return (
      `staleness-watch 已拦截:目标 ${target} 已连续 ${current.blind} 次输入操作未重新观察。` +
      `请先调用 ${nextStep} 取得新快照,确认页面/窗口的实际状态后再继续。`
    )
  }
  if (typeof ctx.tools?.guard === 'function') {
    ctx.tools.guard(guardHook)
    guardMounted = true
  }

  // ---- 观测层:结果之后告警 ----
  const postHook = async (exec, result, next) => {
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
      // 记下该 pid 最近一次快照的窗口，供后续 element_token 寻址反查（#33 修）
      const pid = args.pid ?? args.target?.pid
      if (pid !== undefined && pid !== null) {
        snapshots.byPid.set(String(pid), {
          windowId: args.window_id ?? args.target?.window_id ?? null,
          snapshotId: typeof args.snapshot_id === 'string' ? args.snapshot_id : '',
        })
      }
      state.set(key, { stale: false, blind: 0 })
      // pid 级 key 也复位：同一次快照等于「该 pid 刚观察过」，不能因为是另一张 key 就继续拦
      if (pid !== undefined && pid !== null) {
        const pidKey = `${pid}|*`
        if (pidKey !== key) state.set(pidKey, { stale: false, blind: 0 })
      }
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
  }
  if (typeof ctx.on === 'function') {
    ctx.on('tools/post-execute', postHook)
    postExecuteMounted = true
  }

  // ---- staleness_status：ready 由「配置合法 + 两个挂载点真的挂上」现算 ----
  ctx.effect(() =>
    ctx.tools.register({
      name: 'staleness_status',
      description:
        'Health of the staleness-watch hooks: mode, blind-action threshold, whether the guard and post-execute hooks are actually mounted, and how many targets are tracked. Use it when warnings or block decisions stop appearing.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            ready: { type: 'boolean' },
            unavailableReason: { type: 'string' },
            code: { type: 'string' },
            mode: { type: 'string' },
            maxBlindActions: { type: 'integer' },
            guardMounted: { type: 'boolean' },
            postExecuteMounted: { type: 'boolean' },
            trackedTargets: { type: 'integer' },
            staleTargets: { type: 'integer' },
            blockedTargets: { type: 'integer' },
          },
          required: ['ready', 'mode', 'maxBlindActions', 'guardMounted', 'postExecuteMounted', 'trackedTargets'],
          additionalProperties: false,
        },
        render(_args, value) {
          if (value?.ready === false) return [text('不可用：' + (value?.unavailableReason || '未知原因'))]
          const policy = value?.mode === 'block' ? `连续 ${value?.maxBlindActions ?? 0} 次盲操作后拦截` : '只告警不拦截'
          return [
            text(
              `陈旧告警在跑（${value?.mode ?? '?'} 模式，${policy}）：跟踪 ${value?.trackedTargets ?? 0} 个目标，` +
                `其中 ${value?.staleTargets ?? 0} 个有陈旧快照、${value?.blockedTargets ?? 0} 个已达拦截阈值。`,
            ),
          ]
        },
      },
      async execute() {
        const problems = [...configProblems]
        if (!guardMounted) problems.push('ctx.tools.guard 不可用：强制层没挂上，block 模式不会拦截')
        if (!postExecuteMounted) problems.push('ctx.on 不可用：post-execute 观测层没挂上，告警不会出现')
        const ready = problems.length === 0
        const tracked = [...state.values()]
        return {
          ready,
          unavailableReason: problems.join('；'),
          ...(ready ? {} : { code: configProblems.length > 0 ? 'STALENESS_CONFIG_INVALID' : 'STALENESS_HOOKS_UNAVAILABLE' }),
          mode,
          maxBlindActions: limit,
          guardMounted,
          postExecuteMounted,
          trackedTargets: state.size,
          staleTargets: tracked.filter((item) => item.stale === true).length,
          blockedTargets: tracked.filter((item) => item.blind >= limit).length,
        }
      },
    }),
  )
}
