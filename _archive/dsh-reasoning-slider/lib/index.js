/**
 * Host half — this plugin is a pure browser surface. The slider lives in
 * `lib/client.js` and talks to the official Session model RPC through
 * `ctx.remote.session`; nothing has to run on the Host for the slider itself.
 *
 * 契约（统一规格 2026-11-01）：每个插件都要能用工具面回答「你ready吗」。
 * 所以宿主半体保留一个最小的 `reasoning_status`，只报 ready / unavailableReason /
 * 一行说明——它是诊断口，不是功能口；滑条行为一字未动。
 */

export const name = '@local/dsh-reasoning-slider'
export const inject = ['tools']

const NOTE = '客户端插件：滑条在 lib/client.js，走官方 Session RPC，无服务端工具'

const text = (value) => ({ type: 'text', text: value })

export function apply(ctx) {
  const tools = ctx.tools
  ctx.effect(() =>
    tools.register({
      name: 'reasoning_status',
      description:
        'Diagnostics for the reasoning-effort slider: reports ready / unavailableReason / a one-line note. The slider itself is a client-side surface with no server-side tools.',
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
        // 纯客户端插件：宿主这半边从来不需要外部依赖，所以恒为就绪。
        return { ready: true, unavailableReason: '', note: NOTE }
      },
    }),
  )
}
