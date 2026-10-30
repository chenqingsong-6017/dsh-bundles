/**
 * dsh-subagent-brief 行为测试（v2：agent/pre-step 机制）
 *
 * 三层：
 *   1) 结构合规：runSmoke
 *   2) 纯函数：summarizeNotice / buildFooter / isSummarized / cutAt / 归一化
 *   3) 端到端：makeMockContext + 真实 apply，喂 agent/pre-step 事件，
 *      断言「正常消息不动、短结算不动、长结算截断带尾注、Structured result 保留、
 *      多条结算都处理、无 source 不动、幂等、enabled=false、非法 maxChars 回落」
 */
import assert from 'node:assert/strict'
import { makeMockContext, runSmoke } from '../plugin-smoke.mjs'

let passed = 0
const ok = (label, extra = '') => {
  passed += 1
  console.log('  ✓ ' + label + (extra ? '  ' + extra : ''))
}

// ---- 1) 结构合规 ----
await runSmoke('dsh-subagent-brief')
ok('结构合规（package.json / patch / locale / icon / 入口 export）、apply 可挂载')

const mod = await import('../../dsh-subagent-brief/index.js')
const {
  summarizeNotice,
  buildFooter,
  isSummarized,
  cutAt,
  normalizeMaxChars,
  normalizeSourceKinds,
  totalTextLength,
  findClosingMarker,
  isBodyPart,
  SUMMARY_HEAD,
  SUMMARY_TAIL,
  CLOSING_MARKER,
} = mod

// ---- 造数据 ----
const SUMMARY_TEXT = '子会话 sub-1 已结束：改了 3 个文件，测试通过。'
const bodyOf = (lines) =>
  Array.from({ length: lines }, (_, index) => '第 ' + (index + 1) + ' 行：子 agent 汇报的细节内容，不该整段回灌主干。').join('\n')
const settle = (bodyParts, options = {}) => ({
  role: 'user',
  content: [
    { type: 'text', text: SUMMARY_TEXT },
    { type: 'text', text: CLOSING_MARKER },
    ...bodyParts,
  ],
  source: { kind: 'subagent-settled', form: 'notice', summary: '子会话已结束', senderSessionId: 'sub-1' },
  ...(options.message ?? {}),
})

const LONG_BODY = bodyOf(120)
assert.ok(LONG_BODY.length > 1200, '长报告要真的超过 1200，实际 ' + LONG_BODY.length)

// ---- 2) 纯函数 ----
{
  assert.equal(buildFooter(3512), SUMMARY_HEAD + '3512' + SUMMARY_TAIL)
  assert.equal(isSummarized(buildFooter(3512)), true)
  assert.equal(isSummarized('正文里提到 已按摘要契约截断 但结尾不是尾注'), false)
  assert.equal(isSummarized('普通文本'), false)
  ok('buildFooter / isSummarized：只认结尾的完整尾注')

  for (const bad of [0, -5, Number.NaN, null, undefined, '', ' ', {}]) {
    assert.equal(normalizeMaxChars(bad), 1200, '非法阈值回落到 1200')
  }
  assert.equal(normalizeMaxChars(3000), 3000)
  assert.equal(normalizeMaxChars('1500'), 1500)
  assert.equal(normalizeMaxChars(12.7), 12)
  ok('maxChars：默认 1200，非法值一律回落')

  assert.deepEqual(normalizeSourceKinds(undefined), ['subagent-settled'])
  assert.deepEqual(normalizeSourceKinds([' a ', 'a', '', 3, 'b']), ['a', 'b'])
  assert.deepEqual(normalizeSourceKinds([]), [])
  ok('sourceKinds：默认 subagent-settled，去空白去重，空数组=全放行')

  assert.equal(cutAt('a'.repeat(1300), 0).length, 1200, '非法阈值回落到 1200')
  const line = '这一行是要被保留的内容。\n'
  const cut = cutAt(line.repeat(200), 1200)
  assert.ok(cut.endsWith('。'), '应断在最后一个换行处（不留半行）')
  assert.equal(cut, line.repeat(92).slice(0, -1))
  const crlf = cutAt('内容\r\n'.repeat(400), 100)
  assert.ok(!crlf.endsWith('\r'), 'CRLF 不应留下半截 \\r')
  const emoji = cutAt('x'.repeat(9) + '😀' + 'y'.repeat(200), 10)
  assert.equal(emoji, 'x'.repeat(9), '代理对不能被切一半')
  ok('cutAt：断行 / CRLF / emoji 代理对都照顾到')
}

// ---- 3) summarizeNotice：纯函数边界 ----
{
  const plain = { role: 'user', content: [{ type: 'text', text: '你好，帮我看看这个。' }] }
  const plainOut = summarizeNotice(plain, 100)
  assert.equal(plainOut.changed, false)
  assert.equal(plainOut.message, plain, '没改动时原对象返回')
  assert.equal(plainOut.fromLen, plainOut.toLen)
  ok('普通用户消息：不动（没有结算标记）')

  const short = settle([{ type: 'text', text: '结论：三个文件改完，测试通过。' }])
  const shortOut = summarizeNotice(short, 1200)
  assert.equal(shortOut.changed, false)
  assert.equal(shortOut.message, short)
  ok('短结算消息：正文没超阈值，原样返回')

  const exact = settle([{ type: 'text', text: '甲'.repeat(100) }])
  assert.equal(summarizeNotice(exact, 100).changed, false, '刚好等于阈值不截')
  assert.equal(summarizeNotice(exact, 99).changed, true, '刚好多 1 字符就截')
  ok('阈值边界：等于不截、超过才截')

  const long = settle([{ type: 'text', text: LONG_BODY }])
  const longOut = summarizeNotice(long, 1200)
  assert.equal(longOut.changed, true)
  assert.notEqual(longOut.message, long, '返回新消息对象，不原地改外部对象')
  assert.equal(longOut.message.content[0], long.content[0], '结算摘要块原引用保留')
  assert.equal(longOut.message.content[1], long.content[1], 'Its closing message: 标记块原引用保留')
  assert.equal(longOut.message.role, long.role)
  assert.equal(longOut.message.source, long.source, 'source 一字不动')
  assert.deepEqual(longOut.message.source, long.source)

  const kept = longOut.message.content[2]
  assert.ok(kept.text.length <= 1200, '正文被截到阈值以内，实际 ' + kept.text.length)
  assert.ok(LONG_BODY.startsWith(kept.text), '保留的是正文前缀')
  const footer = longOut.message.content[3]
  assert.equal(footer.type, 'text')
  assert.ok(footer.text.endsWith(SUMMARY_TAIL))
  assert.ok(footer.text.includes('原文 ' + LONG_BODY.length + ' 字符'), '尾注里写明原文字符数')
  assert.ok(footer.text.includes('完整内容在子会话'))
  assert.ok(longOut.fromLen > longOut.toLen, '原长度 > 新长度')
  assert.equal(longOut.fromLen, totalTextLength(long.content))
  assert.equal(longOut.toLen, totalTextLength(longOut.message.content))
  ok(
    '长结算消息：正文截到 1200 + 中文尾注，摘要/source/其它字段不动',
    longOut.fromLen + ' → ' + longOut.toLen + ' 字符',
  )

  const structuredPart = { type: 'text', text: 'Structured result: {"ok":true,"files":["a.js","b.js"]}' }
  const diagPart = { type: 'text', text: 'Diagnostics: 12 次工具调用，3 次失败' }
  const withExtras = settle([{ type: 'text', text: LONG_BODY }, structuredPart, diagPart])
  const extrasOut = summarizeNotice(withExtras, 1200)
  assert.equal(extrasOut.changed, true)
  assert.equal(extrasOut.message.content.at(-2), structuredPart, 'Structured result 块原引用保留')
  assert.equal(extrasOut.message.content.at(-1), diagPart, '诊断块原引用保留')
  assert.equal(extrasOut.message.content[4], structuredPart, 'Structured result 仍在原位')
  assert.ok(extrasOut.message.content[2].text.length <= 1200, 'Structured result 不参与正文预算')
  ok('Structured result 块与诊断块：原样保留，不参与正文预算')

  const image = { type: 'image', data: 'BASE64'.repeat(10) }
  const mixed = settle([{ type: 'text', text: LONG_BODY }, image])
  const mixedOut = summarizeNotice(mixed, 1200)
  assert.equal(mixedOut.message.content.at(-1), image, '非 text 块原引用保留')
  ok('非 text 块（图片）：一字不动')

  const three = settle([
    { type: 'text', text: '甲'.repeat(60) },
    { type: 'text', text: '乙'.repeat(60) },
    { type: 'text', text: '丙'.repeat(60) },
  ])
  const threeOut = summarizeNotice(three, 100)
  const texts = threeOut.message.content.filter((part) => part.type === 'text').map((part) => part.text)
  assert.equal(texts.length, 5, '摘要 + 标记 + 两段保留正文 + 尾注')
  assert.equal(texts[2], '甲'.repeat(60), '第一段完整保留')
  assert.equal(texts[3], '乙'.repeat(40), '第二段按剩余预算（100-60）切')
  assert.equal(texts[4], buildFooter(180), '尾注按正文总长 180 算')
  assert.equal(threeOut.message.content.some((part) => part.text === '丙'.repeat(60)), false, '第三段（长报告本体）被丢弃')
  ok('多段正文：按剩余预算逐段保留，超出的正文块丢弃')

  const idem = summarizeNotice(longOut.message, 1200)
  assert.equal(idem.changed, false, '已带尾注的结算消息不再截')
  assert.equal(idem.message, longOut.message)
  ok('幂等：二次经过原样放行')

  const noMarker = { role: 'user', content: [{ type: 'text', text: 'x'.repeat(2000) }] }
  assert.equal(summarizeNotice(noMarker, 100).changed, false, '没有结算标记的消息不处理')
  ok('没有 Its closing message: 标记：不处理（保守放行）')

  const noColon = {
    role: 'user',
    content: [
      { type: 'text', text: '摘要' },
      { type: 'text', text: 'Its closing message' },
      { type: 'text', text: 'x'.repeat(2000) },
    ],
    source: { kind: 'subagent-settled' },
  }
  assert.equal(findClosingMarker(noColon.content), 1)
  assert.equal(summarizeNotice(noColon, 100).changed, true, '标记没有冒号也认')
  ok('分界块容错：带不带冒号、前后空白都能认')

  assert.deepEqual(summarizeNotice(null, 100), { message: null, changed: false, fromLen: 0, toLen: 0 })
  assert.equal(summarizeNotice({ content: 'not-an-array' }, 100).changed, false)
  assert.equal(summarizeNotice({}, 100).changed, false)
  ok('畸形消息（null / content 非数组 / 缺 content）不崩')

  assert.equal(isBodyPart({ type: 'text', text: 'Structured result: x' }), false)
  assert.equal(isBodyPart({ type: 'text', text: 'Diagnostics: x' }), false)
  assert.equal(isBodyPart({ type: 'text', text: '   ' }), false)
  assert.equal(isBodyPart({ type: 'text', text: '正常正文' }), true)
  assert.equal(isBodyPart({ type: 'image' }), false)
  ok('isBodyPart：只有真正的正文 text 块算正文')
}

// ---- 4) 端到端：agent/pre-step ----
const mount = (config) => {
  const { ctx, registered, listeners } = makeMockContext()
  mod.apply(ctx, config)
  const pre = listeners.find((entry) => entry.name === 'agent/pre-step')
  assert.ok(pre !== undefined, '应注册 agent/pre-step')
  assert.equal(
    listeners.some((entry) => entry.name === 'tools/post-execute'),
    false,
    '不应再注册 tools/post-execute',
  )
  const status = registered.find((tool) => tool.name === 'subagent_brief_status')
  assert.ok(status !== undefined, '应注册 subagent_brief_status')
  return { ctx, pre, status }
}

const fire = async (pre, messages, options = {}) => {
  const payload = { messages, turn: 3, step: 7, signal: undefined }
  const base = options.decision ?? { kind: 'enter', messages }
  const out = await pre.handler(payload, async () => base)
  return { payload, base, out }
}

{
  const { pre, status } = mount({})

  const plainMessage = { role: 'user', content: [{ type: 'text', text: '帮我查一下这个函数在哪调用。' }] }
  const plain = await fire(pre, [plainMessage])
  assert.equal(plain.out, plain.base, '正常用户消息：decision 原样返回')
  ok('pre-step：正常用户消息不动')

  const longSettle = settle([{ type: 'text', text: LONG_BODY }])
  const one = await fire(pre, [plainMessage, longSettle])
  assert.notEqual(one.out, one.base, '有截断时返回新 decision')
  assert.equal(one.out.kind, 'enter', 'kind 仍是 enter')
  assert.equal(one.out.messages[0], plainMessage, '非结算消息原引用透传')
  assert.notEqual(one.out.messages[1], longSettle, '结算消息被替换成新对象')
  assert.ok(one.out.messages[1].content.some((part) => typeof part.text === 'string' && part.text.includes(SUMMARY_HEAD)))
  ok('pre-step：inbox 里的结算消息被截断，其它消息原样')

  const again = await fire(pre, [one.out.messages[1]])
  assert.equal(again.out, again.base, '幂等：第二次不再改')
  ok('pre-step：幂等')

  const noSource = { role: 'user', content: settle([{ type: 'text', text: LONG_BODY }]).content }
  const noSourceOut = await fire(pre, [noSource])
  assert.equal(noSourceOut.out, noSourceOut.base, '没有 source.kind 的消息不动')
  ok('pre-step：无 source 的消息不动')

  const otherSource = settle([{ type: 'text', text: LONG_BODY }], { message: { source: { kind: 'other' } } })
  const otherOut = await fire(pre, [otherSource])
  assert.equal(otherOut.out, otherOut.base, 'source.kind 不在白名单不动')
  ok('pre-step：其它来源的消息不动')

  const two = await fire(pre, [
    settle([{ type: 'text', text: LONG_BODY }], { message: { source: { kind: 'subagent-settled', senderSessionId: 'a' } } }),
    settle([{ type: 'text', text: bodyOf(80) }], { message: { source: { kind: 'subagent-settled', senderSessionId: 'b' } } }),
  ])
  assert.notEqual(two.out.messages[0].content, two.base.messages[0].content)
  assert.notEqual(two.out.messages[1].content, two.base.messages[1].content)
  ok('pre-step：同一步里多条结算消息都处理')

  const rejected = await fire(pre, [settle([{ type: 'text', text: LONG_BODY }])], {
    decision: { kind: 'reject', reason: '用户打断' },
  })
  assert.equal(rejected.out, rejected.base, 'decision.kind 不是 enter 时原样返回')
  ok('pre-step：reject 决策原样返回')

  const malformed = await fire(pre, undefined)
  assert.equal(malformed.out, malformed.base, 'payload 没有 messages 不崩')
  ok('pre-step：payload 畸形不崩')

  const value = await status.execute({})
  assert.deepEqual(
    Object.keys(value).sort(),
    ['charsSaved', 'enabled', 'lastSeen', 'maxChars', 'recent', 'sourceKinds', 'truncatedCount'],
    '返回值与 output schema 严格一致',
  )
  assert.equal(value.enabled, true)
  assert.equal(value.maxChars, 1200)
  assert.deepEqual(value.sourceKinds, ['subagent-settled'])
  assert.equal(value.truncatedCount, 3, '截断次数：1 + 2')
  assert.ok(value.charsSaved > 0)
  assert.equal(value.recent[0].kind, 'subagent-settled', '记录来源 kind')
  assert.deepEqual(Object.keys(value.recent[0]).sort(), ['from', 'kind', 'time', 'to'])
  for (const item of value.recent) {
    assert.match(item.time, /^\d{2}:\d{2}:\d{2}$/, '时间用 HH:MM:SS')
    assert.equal(typeof item.kind, 'string')
    assert.ok(item.from > item.to, '记录是 原长度 → 新长度')
  }
  assert.equal(value.lastSeen.time !== '', true, '应记下最近一次 pre-step')
  assert.equal(value.lastSeen.turn, 3)
  assert.equal(value.lastSeen.step, 7)
  assert.equal(value.lastSeen.messageCount, 1)
  assert.deepEqual(value.lastSeen.kinds, ['subagent-settled'])
  ok('status：阈值 / 来源 / 截断计数 / recent / lastSeen 都对')

  assert.equal((await status.execute({ limit: 1 })).recent.length, 1)
  assert.equal((await status.execute({ limit: 999 })).recent.length, 3)
  ok('status：limit 生效并夹在 1..20')

  const rendered = status.output.render({}, value)[0].text
  assert.match(rendered, /摘要契约：已启用/)
  assert.match(rendered, /超过 1,200 字符/)
  assert.match(rendered, /拦截来源：subagent-settled/)
  assert.match(rendered, /上次 pre-step：\d{2}:\d{2}:\d{2}/)
  assert.match(rendered, /本次运行截断 3 次/)
  assert.match(rendered, /最近记录：/)
  assert.ok(!/\bundefined\b/.test(rendered), '主输出里不该出现 undefined')
  ok('status 主输出说人话（结论 + 来源 + pre-step 概览 + 列表）', '“' + rendered.split('\n')[0] + '”')
}

{
  // payload 没有 messages 时回落到 decision.messages（lastSeen 也要记到）
  const { pre, status } = mount({})
  const onlyDecision = { kind: 'enter', messages: [settle([{ type: 'text', text: LONG_BODY }])] }
  const out = await pre.handler({ turn: 1, step: 2 }, async () => onlyDecision)
  assert.notEqual(out, onlyDecision, 'payload 无 messages 时仍处理 decision.messages')
  const value = await status.execute({})
  assert.equal(value.truncatedCount, 1)
  assert.equal(value.lastSeen.messageCount, 1)
  assert.deepEqual(value.lastSeen.kinds, ['subagent-settled'])
  assert.equal(value.lastSeen.decision, 'enter')
  ok('pre-step：payload 缺 messages 时回落到 decision.messages')
}

{
  // 配置：maxChars 覆盖 + 自定义 sourceKinds
  const { pre, status } = mount({ maxChars: 300, sourceKinds: ['my-kind'] })
  const value = await status.execute({})
  assert.equal(value.maxChars, 300)
  assert.deepEqual(value.sourceKinds, ['my-kind'])

  const standard = settle([{ type: 'text', text: bodyOf(40) }])
  assert.ok(totalTextLength(standard.content) > 300, '构造的消息要超过 300')
  const standardOut = await fire(pre, [standard])
  assert.equal(standardOut.out, standardOut.base, 'sourceKinds 里没有 subagent-settled 时不处理')

  const custom = settle([{ type: 'text', text: bodyOf(40) }], { message: { source: { kind: 'my-kind' } } })
  const customOut = await fire(pre, [custom])
  assert.notEqual(customOut.out, customOut.base, '自定义来源会被处理')
  const customContent = customOut.out.messages[0].content
  assert.ok(customContent[2].text.length <= 300, '按自定义 maxChars 300 截')
  ok('配置生效：maxChars 与 sourceKinds 可覆盖默认值')
}

{
  // 空 sourceKinds：一个都不拦
  const { pre } = mount({ sourceKinds: [] })
  const longSettle = settle([{ type: 'text', text: LONG_BODY }])
  const out = await fire(pre, [longSettle])
  assert.equal(out.out, out.base, 'sourceKinds: [] 等于全部放行')
  ok('空 sourceKinds：等于全部放行')
}

{
  // enabled: false
  const { pre, status } = mount({ enabled: false })
  const longSettle = settle([{ type: 'text', text: LONG_BODY }])
  const out = await fire(pre, [longSettle])
  assert.equal(out.out, out.base, 'enabled: false 时完全不处理')
  const value = await status.execute({})
  assert.equal(value.enabled, false)
  assert.equal(value.truncatedCount, 0)
  const disabledText = status.output.render({}, value)[0].text
  assert.match(disabledText, /当前是关闭状态/)
  assert.match(disabledText, /enabled 改回 true/, '失败信息要给下一步')
  ok('enabled: false 可整体关掉，status 说明怎么开回来')
}

{
  // 非法 maxChars 回落 1200：1199 不该截、1201 该截
  const { pre, status } = mount({ maxChars: 0 })
  assert.equal((await status.execute({})).maxChars, 1200)
  const short = settle([{ type: 'text', text: '甲'.repeat(1199) }])
  const shortOut = await fire(pre, [short])
  assert.equal(shortOut.out, shortOut.base, '1199 < 回落后的 1200，不截')
  const long = settle([{ type: 'text', text: '乙'.repeat(1201) }])
  const longOut = await fire(pre, [long])
  assert.notEqual(longOut.out, longOut.base, '1201 > 1200，要截')
  ok('非法 maxChars 回落 1200，按 1200 生效')
}

{
  // 空态文案
  const { status } = mount({})
  const value = await status.execute({})
  const rendered = status.output.render({}, value)[0].text
  assert.match(rendered, /本次运行还没有截断过/)
  assert.match(rendered, /还没看到过 pre-step 事件/)
  ok('状态空态：友好的“还没有截断过 / 还没看到 pre-step”')
}

console.log('\nsubagent-brief: ' + passed + ' 项通过')
