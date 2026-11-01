/**
 * dsh-path-rules fitBudget 等价 oracle（参考实现等价断言）。
 *
 * 为什么有它：验证门只查语法/结构，预算装填这种纯逻辑改坏了不会红。
 * 依据：DualPipe 的 reference-implementation equivalence（参考实现逐条对拍）
 *      + smallpond 的确定性数据校验（固定样本、无随机、无时间）。
 *
 * 被测：dsh-path-rules/index.js 的 fitBudget(items, budget)（index.js:311-339）。
 * 参考：本文件的 naiveFitBudget —— 按传入顺序累加预算的朴素实现；两边独立写，靠断言对拍。
 * 断言面：blocks（header / text / entry / truncated）、used、omitted、truncated 全字段相等，
 *        外加「used = 块文本长度和」「used <= 预算」「块数 + 跳过数 = 输入条数」等不变量。
 * 样本覆盖：空数组 / 非数组 / 预算 0 / 单条超预算（截不动 & 可截断）/ 全部装得下 /
 *          刚好差 1 字符 / 相同长度打断 / 截断吃满预算 / 混合 / 字段非字符串。
 * 确定性：全部字面量，无随机、无当前时间、无文件系统；预期 < 100ms。
 */
import assert from 'node:assert/strict'
import { fitBudget } from '../../dsh-path-rules/index.js'

const started = Date.now()
let passed = 0
const ok = (label, extra = '') => {
  passed += 1
  console.log('  ✓ ' + label + (extra === '' ? '' : '  ' + extra))
}

// 生产实现的 MIN_KEEP_CHARS（index.js:49）；参考实现这里独立声明一份：
// 阈值改了而参考实现没同步，等价断言就会红——这正是我们要的护栏。
const MIN_KEEP_CHARS = 80

/**
 * naive 参考实现：与 fitBudget 语义等价的最朴素写法。
 * 只维护「已用预算」，顺序累加；整条装不下时先看剩余空间够不够截断，不够就整条跳过。
 */
function naiveFitBudget(items, budget) {
  const blocks = []
  let used = 0
  let omitted = 0
  let truncated = 0
  for (const item of Array.isArray(items) ? items : []) {
    const header = String(item.header)
    const body = String(item.body)
    const whole = header + '\n' + body
    if (used + whole.length <= budget) {
      blocks.push({ header, text: whole, entry: item.entry, truncated: false })
      used += whole.length
      continue
    }
    const room = budget - used - header.length - 1
    if (room < Math.min(MIN_KEEP_CHARS, body.length)) {
      omitted += 1
      continue
    }
    const marker = '\n…（正文已截断，原文 ' + body.length + ' 字符，超出本轮 ' + budget + ' 字符预算）'
    const keep = Math.max(0, room - marker.length)
    const chunk = header + '\n' + body.slice(0, keep) + marker
    blocks.push({ header, text: chunk, entry: item.entry, truncated: true })
    used += chunk.length
    truncated += 1
  }
  return { blocks, used, omitted, truncated }
}

const rule = (id, header, body) => ({ header, body, entry: { id } })

// 固定样本：边界 + 混合，全部字面量。
const SAMPLE_CASES = [
  { name: '空数组：全零', items: [], budget: 1000 },
  { name: '非数组输入：全零', items: null, budget: 1000 },
  { name: '预算 0：整条跳过', items: [rule('a', 'H', '正文'), rule('b', 'H', '正文')], budget: 0 },
  { name: '单条超预算且截不动：整条跳过', items: [rule('a', '验收', '长'.repeat(200))], budget: 60 },
  { name: '单条超预算但可截断：截到刚好用完预算', items: [rule('a', '验收', '长'.repeat(500))], budget: 200 },
  { name: '全部装得下（预算恰好等于总长）', items: [rule('a', 'A', 'aaa'), rule('b', 'B', 'bbb'), rule('c', 'C', 'ccc')], budget: 15 },
  { name: '差 1 个字符：最后一条整条跳过', items: [rule('a', 'A', 'aaa'), rule('b', 'B', 'bbb'), rule('c', 'C', 'ccc')], budget: 14 },
  { name: '同长度三条：第一条吃满预算，后两条跳过', items: [rule('a', 'H', 'x'.repeat(200)), rule('b', 'H', 'y'.repeat(200)), rule('c', 'H', 'z'.repeat(200))], budget: 260 },
  { name: '先截断吃满预算，后面整条跳过', items: [rule('a', 'H', 'x'.repeat(500)), rule('b', 'H', 'y'.repeat(500)), rule('c', 'H', 'z'.repeat(500))], budget: 250 },
  { name: '混合：装下一条 + 截断一条 + 跳过一条', items: [rule('a', 'P', 'p'.repeat(10)), rule('b', 'Q', 'q'.repeat(400)), rule('c', 'R', 'r'.repeat(400))], budget: 200 },
  { name: '字段非字符串：按 String 计数', items: [{ header: null, body: undefined, entry: { id: 'coerce' } }], budget: 100 },
]

for (const sample of SAMPLE_CASES) {
  const actual = fitBudget(sample.items, sample.budget)
  const expected = naiveFitBudget(sample.items, sample.budget)
  assert.deepEqual(actual, expected, '参考实现不等价：' + sample.name)
  const list = Array.isArray(sample.items) ? sample.items : []
  assert.equal(actual.blocks.length + actual.omitted, list.length, '块数 + 跳过数 ≠ 输入条数：' + sample.name)
  assert.equal(
    actual.used,
    actual.blocks.reduce((sum, block) => sum + block.text.length, 0),
    'used ≠ 块文本长度和：' + sample.name,
  )
  assert.ok(actual.used <= sample.budget, 'used 超出预算：' + sample.name + '（' + actual.used + ' > ' + sample.budget + '）')
  assert.equal(
    actual.truncated,
    actual.blocks.filter((block) => block.truncated).length,
    'truncated 计数与块标记不一致：' + sample.name,
  )
  for (let i = 0; i < actual.blocks.length; i += 1) {
    assert.equal(actual.blocks[i].entry, list[i].entry, '块顺序 / entry 引用被改：' + sample.name)
  }
}
ok('固定样本 × ' + SAMPLE_CASES.length + '：生产实现与 naive 参考实现逐字段等价，且满足预算不变量')

{
  const exact = fitBudget([rule('a', 'A', 'aaa'), rule('b', 'B', 'bbb'), rule('c', 'C', 'ccc')], 15)
  assert.equal(exact.used, 15, '预算恰好等于总长时应全部装下并用满')
  assert.equal(exact.omitted, 0)
  assert.equal(exact.truncated, 0)
  assert.deepEqual(exact.blocks.map((block) => block.entry.id), ['a', 'b', 'c'])
  ok('边界：预算恰好等于总长 → 整条全装，used 正好等于预算')
}

{
  const zero = fitBudget([rule('a', 'H', '正文'), rule('b', 'H', '正文')], 0)
  assert.deepEqual(zero, { blocks: [], used: 0, omitted: 2, truncated: 0 })
  ok('边界：预算 0 → 不产出任何块，全部计入 omitted')
}

{
  const fitted = fitBudget([rule('a', '验收', '长'.repeat(500))], 200)
  assert.equal(fitted.blocks.length, 1)
  assert.equal(fitted.truncated, 1)
  assert.equal(fitted.omitted, 0)
  assert.equal(fitted.used, 200, '截断必须正好用满预算')
  const chunk = fitted.blocks[0].text
  assert.ok(chunk.startsWith('验收\n' + '长'.repeat(20)), '截断应保留正文开头')
  assert.ok(chunk.endsWith('字符预算）'), '截断块应带预算说明尾巴')
  assert.ok(chunk.includes('正文已截断，原文 500 字符，超出本轮 200 字符预算'), '截断说明应写清原文长度与预算')
  ok('边界：单条超预算但可截断 → 正文截到刚好用满预算，并留可复核的截断说明')
}

{
  const long = rule('long', 'L', 'x'.repeat(400))
  const short = rule('short', 'S', 'y'.repeat(5))
  const longFirst = fitBudget([long, short], 300)
  const shortFirst = fitBudget([short, long], 300)
  assert.equal(longFirst.blocks.length, 1)
  assert.equal(longFirst.truncated, 1)
  assert.equal(longFirst.omitted, 1, '低优先级先占满预算，后一条被整条跳过')
  assert.equal(shortFirst.blocks.length, 2)
  assert.equal(shortFirst.truncated, 1)
  assert.equal(shortFirst.omitted, 0, '短条先装下，长条仍可截断')
  ok('顺序即优先级：先装低优先级会把后面的整条挤掉（排序由 composeInjection 负责）')
}

{
  const coerced = fitBudget([{ header: null, body: undefined, entry: { id: 'coerce' } }], 100)
  assert.equal(coerced.blocks.length, 1)
  assert.equal(coerced.blocks[0].text, 'null\nundefined')
  ok('字段缺失：header / body 按 String 计数，不抛异常（行为已固定，改了要同步下游）')
}

{
  const first = fitBudget(SAMPLE_CASES[9].items, SAMPLE_CASES[9].budget)
  const again = fitBudget(SAMPLE_CASES[9].items, SAMPLE_CASES[9].budget)
  assert.deepEqual(again, first)
  ok('确定性：同一输入两次调用结果完全一致')
}

console.log('\npath-rules-oracle: ' + passed + ' 项通过（' + (Date.now() - started) + 'ms）')
