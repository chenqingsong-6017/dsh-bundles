/**
 * dsh-reasoning-slider 冒烟 + 契约测试。
 *
 * Host 半体只承担一个诊断工具（滑条本身在 lib/client.js），所以测试价值在
 * ①「manifest / patch / locale / icon 是否还齐全」——改 UI 时最容易弄坏的部分；
 * ② `reasoning_status` 的三个契约字段（ready / unavailableReason / note）是否齐全。
 */
import assert from 'node:assert/strict'
import { makeMockContext, runSmoke } from '../plugin-smoke.mjs'
import { apply } from '../../dsh-reasoning-slider/lib/index.js'

await runSmoke('dsh-reasoning-slider')

// ---- 契约（统一规格 2026-11-01）：纯客户端插件也要能在工具面报 ready ----
const { ctx, registered } = makeMockContext()
apply(ctx, {})
const status = registered.find((definition) => definition.name === 'reasoning_status')
assert.ok(status, 'reasoning_status 必须注册（客户端插件报「无服务端工具」也要有工具可问）')
assert.deepEqual(status.output.schema.required, ['ready', 'unavailableReason', 'note'], '三个契约字段都必须在 required 里')
const value = await status.execute({})
assert.equal(value.ready, true, '纯客户端插件无外部依赖 → 恒为就绪')
assert.equal(value.unavailableReason, '', '就绪时 unavailableReason 必须为空')
assert.ok(value.note.includes('客户端插件'), `说明要讲清这是客户端插件，实际：${value.note}`)
assert.deepEqual(Object.keys(value).sort(), ['note', 'ready', 'unavailableReason'], '返回值必须与 schema 严格同构')

console.log('reasoning-slider: 结构合规、apply 可挂载、reasoning_status 契约 ✓')
