/**
 * dsh-browser-bundle —— 配置型 bundle 的宿主半体：只做诊断，不碰挂载。
 *
 * 这个 bundle 的本体是 `cordis.patch.yml`（两行官方插件：browser-use 注册表 +
 * Playwright MCP 后端）。之前它没有 JS，所以工具面上问不到「浏览器能力现在到底通不通」。
 * 这里补一个最小的 `browser_status`，只报 ready / unavailableReason / 一行说明。
 *
 * 判据：`browserUse` 服务存在且已注册 provider（= Playwright MCP 后端启动成功）。
 * 刻意**不**把 `browserUse` 写进 inject —— 挂载失败时这一行仍要能加载，
 * 否则最需要诊断的时候反而没有工具可问。
 */

export const name = '@local/dsh-browser-bundle'
export const inject = ['tools']

const SERVICE = 'browserUse'
const LABEL = 'browser-use / browser-use-playwright（Playwright MCP → 本机 Edge）'

const text = (value) => ({ type: 'text', text: value })

/** 读挂载状态：服务在不在、provider 注册了没有。只读，不发网络、不启动浏览器。 */
function mountState(ctx) {
  let impl
  try {
    impl = ctx.get(SERVICE)
  } catch {
    impl = undefined
  }
  if (!impl) {
    return {
      ready: false,
      unavailableReason: `${SERVICE} 服务不存在：bundle 的挂载行没生效（profile 是否选中 dsh-browser-bundle）`,
      note: LABEL,
    }
  }
  const provider = typeof impl.providerName === 'string' ? impl.providerName : ''
  if (provider === '') {
    return {
      ready: false,
      unavailableReason: `${SERVICE} 服务在，但没有 provider 注册（Playwright MCP 后端没起来，看浏览器可执行文件路径）`,
      note: LABEL,
    }
  }
  return { ready: true, unavailableReason: '', note: `${LABEL} · provider=${provider}` }
}

export function apply(ctx) {
  const tools = ctx.tools
  ctx.effect(() =>
    tools.register({
      name: 'browser_status',
      description:
        'Diagnostics for the browser-use bundle: reports ready / unavailableReason / a one-line note about whether the Playwright MCP provider is mounted. Read-only; it never launches a browser.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            ready: { type: 'boolean' },
            unavailableReason: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['ready', 'unavailableReason', 'note'],
          additionalProperties: false,
        },
        render(_args, value) {
          if (value?.ready !== true) {
            return [text(`不可用：${value?.unavailableReason || '未知原因'}\n说明：${value?.note || '—'}`)]
          }
          return [text(`就绪：${value?.note || '（无更多说明）'}`)]
        },
      },
      async execute() {
        return mountState(ctx)
      },
    }),
  )
}
