/**
 * dsh-computer-bundle 冒烟 + 契约测试。
 *
 * 同 browser-bundle：本体是 patch（两行官方插件），宿主半体只承担 `computer_status`。
 * 判据：① 结构合规（runSmoke）；② 契约字段齐全、不可用给原因、render 显示「不可用：」、
 * 返回值与 schema 严格同构（additionalProperties:false，多一个字段整次调用就失败）。
 */
import assert from 'node:assert/strict'
import { makeMockContext, runSmoke } from '../plugin-smoke.mjs'
import { apply } from '../../dsh-computer-bundle/index.js'

await runSmoke('dsh-computer-bundle')

const CONTRACT_KEYS = ['note', 'ready', 'unavailableReason']

// ---- 分支 A：服务不存在（mock ctx 的 get 恒 undefined）----
{
  const { ctx, registered } = makeMockContext()
  apply(ctx, {})
  const tool = registered.find((definition) => definition.name === 'computer_status')
  assert.ok(tool, 'computer_status 必须注册（统一契约：每个插件都要有能报 ready 的工具）')
  assert.deepEqual(tool.output.schema.required, ['ready', 'unavailableReason', 'note'], '三个契约字段都必须在 required 里')

  const value = await tool.execute({})
  assert.deepEqual(Object.keys(value).sort(), CONTRACT_KEYS, '返回值必须与 schema 严格同构')
  assert.equal(value.ready, false, '拿不到 computerUse 服务时必须如实报不可用，不能假装就绪')
  assert.ok(value.unavailableReason.length > 0, '不可用时必须给原因')
  assert.ok(value.note.length > 0, '必须带一行说明')

  const blocks = tool.output.render({}, value)
  assert.equal(blocks[0].type, 'text')
  assert.ok(blocks[0].text.startsWith('不可用：'), `render 要显示「不可用：<reason>」，实际：${blocks[0].text}`)
}

// ---- 分支 B：provider 已注册 ----
{
  const { ctx, registered } = makeMockContext()
  ctx.get = (name) => (name === 'computerUse' ? { providerName: 'cua-driver-native' } : undefined)
  apply(ctx, {})
  const value = await registered.find((definition) => definition.name === 'computer_status').execute({})
  assert.equal(value.ready, true, 'provider 注册了就报就绪')
  assert.equal(value.unavailableReason, '', '就绪时 unavailableReason 必须为空')
  assert.ok(value.note.includes('cua-driver-native'), '说明里要带 provider 名，便于排障')
}

console.log('computer-bundle: 结构合规 + computer_status 契约（可用/不可用两分支）✓')
