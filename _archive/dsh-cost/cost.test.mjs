/**
 * dsh-cost 行为测试：
 *   - 纯函数：fmtTokens / absorbEvent / renderCostLine / costOf
 *   - 结构冒烟：runSmoke
 */
import assert from 'node:assert/strict'
import { makeMockContext, runSmoke } from '../plugin-smoke.mjs'

let passed = 0
const ok = (label, extra = '') => {
  passed += 1
  console.log('  ✓ ' + label + (extra ? '  ' + extra : ''))
}

await runSmoke('dsh-cost')
ok('结构合规、apply 可挂载')

const mod = await import('../../dsh-cost/index.js')

// fmtTokens
assert.equal(mod.fmtTokens(0), '0')
assert.equal(mod.fmtTokens(999), '999')
assert.equal(mod.fmtTokens(1234), '1.23k')
assert.equal(mod.fmtTokens(12345), '12.3k')
assert.equal(mod.fmtTokens(1234567), '1.23M')
ok('fmtTokens：一眼可读，不做浮点噪音')

// absorbEvent：累计 + 最近上下文
const stats = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, lastContext: 0, contextWindow: 0 }
mod.absorbEvent(stats, { type: 'assistant/message', data: { usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 0 } } })
mod.absorbEvent(stats, { type: 'request/context', data: { contextWindow: 128000 } })
mod.absorbEvent(stats, { type: 'assistant/message', data: { usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 950, cacheWriteTokens: 0 } } })
assert.equal(stats.calls, 2)
assert.equal(stats.input, 150)
assert.equal(stats.output, 30)
assert.equal(stats.cacheRead, 1850)
assert.equal(stats.lastContext, 1000, '最近一次请求的输入总量才是当前上下文占用')
assert.equal(stats.contextWindow, 128000)
ok('absorbEvent：累计 usage 并用最近一次输入估算上下文占用')

// 没有 usage 的事件不影响统计
const before = JSON.stringify(stats)
mod.absorbEvent(stats, { type: 'assistant/message', data: {} })
mod.absorbEvent(stats, { type: 'user/message', data: {} })
assert.equal(JSON.stringify(stats), before)
ok('无 usage 的事件不改统计')

// renderCostLine
assert.equal(mod.renderCostLine({ calls: 0 }), '')
assert.equal(mod.renderCostLine(undefined), '')
ok('零调用时不注入（空会话零成本）')
const line = mod.renderCostLine(stats, { currency: '¥' })
assert.ok(line.startsWith('<cost>'))
assert.ok(line.endsWith('</cost>'))
assert.ok(line.includes('本会话 2 次'))
assert.ok(line.includes('in 150'))
assert.ok(line.includes('上下文 1k/128k(1%)'), '上下文应带窗口与百分比：' + line)
ok('renderCostLine：次数 / 输入 / 输出 / 上下文水位')

// 缓存命中率
const cacheLine = mod.renderCostLine({ calls: 1, input: 100, output: 10, cacheRead: 900, cacheWrite: 0, lastContext: 1000, contextWindow: 0 })
assert.ok(cacheLine.includes('缓存 900(90%)'), '缓存命中率 = cacheRead / 总输入：' + cacheLine)
ok('缓存命中率按 cacheRead / (input+cacheRead+cacheWrite) 计算')

// 价格
const priced = mod.costOf({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, { input: 0.5 })
assert.equal(priced, 0.5)
assert.equal(mod.costOf({ input: 1_000_000 }, undefined), 0)
const moneyLine = mod.renderCostLine({ calls: 1, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, lastContext: 0, contextWindow: 0 }, { prices: { input: 0.5 }, currency: '¥' })
assert.ok(moneyLine.includes('¥'), '配置价格后应报钱：' + moneyLine)
ok('costOf：按每百万 token 单价换算，缺价格表时报 0')

// maxLine 截断
const longLine = mod.renderCostLine({ calls: 1, input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, lastContext: 1000, contextWindow: 128000 }, { maxLine: 40 })
assert.ok(longLine.length <= 40, '必须遵守 maxLine 硬上限，实际 ' + longLine.length)
ok('maxLine 硬上限截断')

// 端到端：注入回调真的会产出文本
{
  const { ctx } = makeMockContext()
  const contexts = []
  ctx.get = () => undefined
  ctx.systemPrompt = { context(definition) { contexts.push(definition); return () => {} } }
  mod.apply(ctx, {})
  assert.equal(contexts.length, 1, '应注册一个 systemPrompt.context')
  const session = { snapshotEvents: () => [{ type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } } }] }
  const text = contexts[0].text({ agent: { session } })
  assert.ok(text.startsWith('<cost>'), '有历史 usage 的会话应产出 HUD 行：' + text)
  ok('端到端：从会话事件建立基线并注入')
}

// cost_status：钱必须可追溯到价格表
{
  const { ctx, registered } = makeMockContext()
  ctx.get = () => undefined
  mod.apply(ctx, { prices: { input: 0.5, output: 8, cacheRead: 0.05, cacheWrite: 0.5 }, currency: '¥' })
  const statusTool = registered.find((tool) => tool.name === 'cost_status')
  assert.ok(statusTool !== undefined, '应注册 cost_status')
  const props = statusTool.output.schema.properties
  assert.ok(props.priceTable !== undefined, 'schema 必须暴露 priceTable，否则钱不可追溯')
  assert.deepEqual(Object.keys(props.priceTable.properties).sort(), ['cacheRead', 'cacheWrite', 'input', 'output'])
  ok('cost_status 暴露价格表明细（钱可追溯）')
}

// 手算复核：¥ 数字与价格表必须自洽
{
  const hand = mod.costOf({ input: 457500, output: 184700, cacheRead: 42860000, cacheWrite: 0 }, { input: 0.5, output: 8, cacheRead: 0.05, cacheWrite: 0.5 })
  assert.equal(hand.toFixed(2), '3.85', '手算：0.229 + 1.478 + 2.143 = 3.85，实际 ' + hand.toFixed(4))
  ok('成本数字可手算复核（与 HUD 的 ¥ 一致）')
}

console.log('\ncost: ' + passed + ' 项通过')
