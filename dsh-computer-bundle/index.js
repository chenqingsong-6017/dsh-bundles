/**
 * dsh-computer-bundle —— 配置型 bundle 的宿主半体：只做诊断，不碰挂载。
 *
 * 本体是 `cordis.patch.yml`（两行官方插件：computer-use 注册表 + Cua Driver 原生后端）。
 * 这里补一个最小的 `computer_status`，只报 ready / unavailableReason / 一行说明。
 *
 * 判据：`computerUse` 服务存在且已注册 provider（= Cua Driver 后端启动成功）。
 * 刻意**不**把 `computerUse` 写进 inject —— 挂载失败时这一行仍要能加载，
 * 否则最需要诊断的时候反而没有工具可问。
 */

export const name = '@local/dsh-computer-bundle'
export const inject = ['tools']

const SERVICE = 'computerUse'
const LABEL = 'computer-use / computer-use-cua-native（Cua Driver 原生后端）'

const text = (value) => ({ type: 'text', text: value })

/** 读挂载状态：服务在不在、provider 注册了没有。只读，不动桌面、不启动进程。 */
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
      unavailableReason: `${SERVICE} 服务不存在：bundle 的挂载行没生效（profile 是否选中 dsh-computer-bundle）`,
      note: LABEL,
    }
  }
  const provider = typeof impl.providerName === 'string' ? impl.providerName : ''
  if (provider === '') {
    return {
      ready: false,
      unavailableReason: `${SERVICE} 服务在，但没有 provider 注册（Cua Driver 后端没起来，检查原生二进制是否装好）`,
      note: LABEL,
    }
  }
  return { ready: true, unavailableReason: '', note: `${LABEL} · provider=${provider}` }
}

export function apply(ctx) {
  const tools = ctx.tools
  ctx.effect(() =>
    tools.register({
      name: 'computer_status',
      description:
        'Diagnostics for the computer-use bundle: reports ready / unavailableReason / a one-line note about whether the Cua Driver native provider is mounted. Read-only; it never touches the desktop.',
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
