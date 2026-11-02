// metrics-stability.test.mjs — 错误签名归一化与「跨天复发」汇总（G3 稳定性指标）
// 口径：repeatErrorShare = 跨 ≥2 天的签名所占总错误数 / 总错误数；worst 按次数降序。
import assert from 'node:assert/strict'
import { comparePhase, signature, summarizeRepeat } from '../metrics/error-stats.mjs'

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

// CLI 层 fail-safe（postmortem 0002）：空会话目录不得写 0 基线——0 样本会被误读成「错误率 0%」。
{
  const { spawnSync } = await import('node:child_process')
  const { mkdtempSync, mkdirSync, existsSync, rmSync } = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const cli = fileURLToPath(new URL('../metrics/tool-error-rate.mjs', import.meta.url))
  const dir = mkdtempSync(path.join(os.tmpdir(), 'metrics-empty-'))
  const emptyHome = path.join(dir, 'home')
  const outDir = path.join(dir, 'out')
  mkdirSync(emptyHome, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  const r = spawnSync(process.execPath, [cli, '--days', '30'], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: emptyHome, DSH_METRICS_DIR: outDir },
    timeout: 60000,
  })
  const out = (r.stdout || '') + (r.stderr || '')
  assert.equal(r.status, 2, '空会话应 exit 2：' + out)
  assert.match(out, /拒绝写空基线/)
  assert.equal(existsSync(path.join(outDir, 'tool-error-rate-baseline.json')), false, '空基线不得落盘')
  ok('空会话目录 → 拒绝写 0 基线')
  rmSync(dir, { recursive: true, force: true })
}
{
  const before = { calls: 1000, errors: 50, repeat: { repeatErrorShare: 0.5 } }
  const after = { calls: 1000, errors: 30, repeat: { repeatErrorShare: 0.2 } }
  const c = comparePhase(before, after)
  assert.equal(c.verdict, '改善')
  assert.equal(c.errorRateDelta, -0.02)
  assert.equal(c.repeatShareDelta, -0.3)
  ok('comparePhase 改善判定')
}

{
  const before = { calls: 1000, errors: 20, repeat: { repeatErrorShare: 0.1 } }
  const after = { calls: 1000, errors: 40, repeat: { repeatErrorShare: 0.3 } }
  assert.equal(comparePhase(before, after).verdict, '恶化')
  // 小样本抖动不算改善：-0.2pp 错误率、-1pp 复发占比都低于阈值
  const a = { calls: 10000, errors: 200, repeat: { repeatErrorShare: 0.10 } }
  const b = { calls: 10000, errors: 180, repeat: { repeatErrorShare: 0.09 } }
  assert.equal(comparePhase(a, b).verdict, '持平', '小变化不算改善，避免拿噪声邀功')
  ok('comparePhase 恶化/持平判定（含小样本保护）')
}
console.log('metrics-stability: ' + passed + ' 组通过')
