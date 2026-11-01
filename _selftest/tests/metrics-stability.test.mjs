// metrics-stability.test.mjs — 错误签名归一化与「跨天复发」汇总（G3 稳定性指标）
// 口径：repeatErrorShare = 跨 ≥2 天的签名所占总错误数 / 总错误数；worst 按次数降序。
import assert from 'node:assert/strict'
import { signature, summarizeRepeat } from '../metrics/error-stats.mjs'

let passed = 0
const ok = (label) => { passed += 1; console.log('  ✓ ' + label) }

{
  // 归一化：路径 / 长 id / 三位以上数字都抹平，同一句话合并成一个签名
  const a = signature('Error: cannot modify "D:\\\\AI\\\\x\\\\y.js": file has not been read — read the file, then retry')
  const b = signature('Error: cannot modify "C:\\\\tmp\\\\z.md": file has not been read — read the file, then retry')
  assert.equal(a, b, '路径不同但签名相同')
  assert.match(a, /<path>/)
  const c = signature('Error: deadline reached at 120000 ms')
  assert.match(c, /<n> ms/, '三位以上独立数字归一为 <n>')
  assert.equal(signature('  多行\n  空白   '), '多行 空白', '空白折叠')
  ok('signature() 归一化')
}

{
  // 没有跨天（全在同一天）→ repeatSignatures=0，不影响结论
  const oneDay = new Map([
    ['sig-a', new Map([['2026-11-01', 3]])],
    ['sig-b', new Map([['2026-11-01', 1]])],
  ])
  const r = summarizeRepeat(oneDay)
  assert.equal(r.signatures, 2)
  assert.equal(r.repeatSignatures, 0)
  assert.equal(r.repeatErrorShare, 0)
  assert.equal(r.maxDays, 1)
  assert.deepEqual(r.worst, [])
  ok('同一天内重复不算复发')
}

{
  // 跨 3 天 vs 跨 2 天：只按天数≥2 计，worst 按错误次数降序
  const cross = new Map([
    ['sig-a', new Map([['2026-11-01', 2], ['2026-11-02', 1], ['2026-11-03', 1]])], // 4 次 / 3 天
    ['sig-b', new Map([['2026-11-01', 5], ['2026-11-02', 1]])],                     // 6 次 / 2 天
    ['sig-c', new Map([['2026-11-01', 4]])],                                          // 4 次 / 1 天
  ])
  const r = summarizeRepeat(cross)
  assert.equal(r.signatures, 3)
  assert.equal(r.repeatSignatures, 2, 'sig-a 与 sig-b 跨天')
  assert.equal(r.repeatErrors, 10, '4 + 6')
  assert.equal(r.totalErrors, 14)
  assert.equal(r.repeatErrorShare, 0.7143, '10/14 四舍五入到 4 位')
  assert.equal(r.maxDays, 3)
  assert.deepEqual(r.worst.map((w) => w.sig), ['sig-b', 'sig-a'], '按次数降序')
  assert.equal(r.worst[0].days, 2)
  ok('跨天复发汇总与排序')
}

{
  // 兼容两种输入形态（Set / {count, days}）与空输入
  const asSet = summarizeRepeat(new Map([['s', new Set(['2026-11-01', '2026-11-02'])]]))
  assert.equal(asSet.repeatSignatures, 1)
  assert.equal(asSet.repeatErrors, 2)
  const asObj = summarizeRepeat(new Map([['s', { count: 7, days: ['2026-11-01'] }]]))
  assert.equal(asObj.repeatSignatures, 0)
  const empty = summarizeRepeat(new Map())
  assert.equal(empty.signatures, 0)
  assert.equal(empty.repeatErrorShare, 0)
  assert.equal(empty.maxDays, 0)
  ok('输入形态兼容与空输入')
}

console.log('metrics-stability: ' + passed + ' 组通过')
