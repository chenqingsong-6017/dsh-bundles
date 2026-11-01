// contracts.test.mjs — 五层接口契约（ICD v1）与度量口径漂移的回归测试
// 被测对象：_ops/icd-check.mjs（工作区脚本）。判据：坏一处必须红，好的一处必须绿。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const WORKSPACE = 'D:\\AI-date\\dsh-date\\dsh-创建'
const CHECKER = path.join(WORKSPACE, '_ops', 'icd-check.mjs')

let passed = 0
const ok = (label) => { passed += 1; console.log('  ✓ ' + label) }
const run = (root, extra) => {
  const args = [CHECKER, '--root', root].concat(extra || [])
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 60000 })
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

const layer = (id, extra) => ({
  id,
  name: id + ' 层',
  owner: id === 'L3' ? '人' : 'AI',
  blocking: true,
  produces: [{ artifact: '产物', path: '.', format: 'test' }],
  consumes: [{ from: 'L1', artifact: '规则' }],
  contracts: [{ id: id + '-C1', rule: '测试契约', validate: { kind: 'tool', ref: 'path_rules_status' } }],
  failureModes: [{ symptom: '症状', detect: '检出' }],
  ...(extra || {}),
})

const makeFixture = (docText, opts) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'icd-fixture-'))
  mkdirSync(path.join(root, '_contracts'), { recursive: true })
  writeFileSync(path.join(root, '_contracts', 'layer-icd.json'), JSON.stringify({
    version: '1.0.0',
    layers: ['L1', 'L2', 'L3', 'L4', 'L5'].map((id) => layer(id)),
  }, null, 2))
  writeFileSync(path.join(root, '_contracts', 'metrics.json'), JSON.stringify({
    version: '1.0.0',
    docs: ['DOC.md'],
    metrics: [{
      id: 'toolErrorRate',
      name: '测试错误率',
      definition: '测试用',
      unit: 'ratio',
      format: { kind: 'percent', digits: 2 },
      window: '30 天',
      budgetingMethod: 'Occurrences',
      timeWindow: { durationDays: (opts && opts.durationDays) || 30, anchor: 'rolling' },
      emptyDayPolicy: 'no-data',
      source: { kind: 'file', path: 'baseline.json', field: 'errorRate', freshnessDays: 7 },
      thresholds: { warn: 0.05 },
      docKeywords: ['错误率'],
      ...((opts && opts.metricExtra) || {}),
    }],
  }, null, 2))
  writeFileSync(path.join(root, 'baseline.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    window: '30 天',
    totalCalls: 100,
    totalErrors: 4,
    errorRate: 0.04,
    windowDays: (opts && opts.windowDays) || 30,
  }))
  if (docText !== null) writeFileSync(path.join(root, 'DOC.md'), docText)
  if (opts && opts.dropBaseline) rmSync(path.join(root, 'baseline.json'))
  return root
}
const cleanup = (root) => { try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ } }

{
  const root = makeFixture('# 文档\n\n错误率 4.00%（与权威源一致）\n')
  const r = run(root)
  assert.equal(r.status, 0, '一致时应当通过：' + r.out)
  assert.match(r.out, /失败 0/)
  ok('契约结构与口径一致 → 通过')
  cleanup(root)
}

{
  const root = makeFixture('# 文档\n\n错误率 4.49%（历史手写值）\n')
  const r = run(root)
  assert.equal(r.status, 1, '手写值与权威源不一致必须失败')
  assert.match(r.out, /不一致/)
  assert.match(r.out, /DOC-DRIFT/)
  ok('手写数值漂移 → 失败')
  cleanup(root)
}

{
  const root = makeFixture('# 文档\n\n错误率 <!--metric:toolErrorRate-->4.49%<!--/metric-->\n')
  const r = run(root)
  assert.equal(r.status, 1, 'marker 里的旧值必须失败')
  assert.match(r.out, /权威源是 4.00%/)
  ok('marker 旧值 → 失败')
  // --fix 回填后应通过，且文件真的被改
  const fixed = run(root, ['--fix'])
  assert.equal(fixed.status, 0, '--fix 后应通过：' + fixed.out)
  assert.match(readFileSync(path.join(root, 'DOC.md'), 'utf8'), /<!--metric:toolErrorRate-->4\.00%<!--\/metric-->/)
  ok('--fix 回填 marker 后通过')
  cleanup(root)
}

{
  const root = makeFixture('# 文档\n\n工具错误率 > 6% 报警；目标 5% 以下\n')
  const r = run(root)
  assert.equal(r.status, 0, '阈值/报警线不是测量值，不该误判：' + r.out)
  ok('阈值行不误判')
  cleanup(root)
}

{
  const root = makeFixture('# 文档\n\n错误率 4.00%\n', { dropBaseline: true })
  const r = run(root)
  assert.equal(r.status, 1)
  assert.match(r.out, /不存在/)
  ok('权威源缺失 → 失败')
  cleanup(root)
}

{
  // 真工作区：契约与文档口径必须与当前基线一致（防止本次改动只在小 fixture 里成立）
  const r = run(WORKSPACE)
  assert.equal(r.status, 0, '真工作区契约应通过：' + r.out)
  assert.match(r.out, /失败 0/)
  ok('真工作区 icd-check 通过')
}

// 字段白名单（kubeconform -strict 语义）：拼错字段名必须红。
{
  const root = makeFixture('# 文档\n\n错误率 4.00%\n', { metricExtra: { tresholds: { warn: 0.05 } } })
  const r = run(root)
  assert.equal(r.status, 1, '未知字段必须失败')
  assert.match(r.out, /未知字段/)
  ok('未知字段 → 失败')
  cleanup(root)
}

// 结构化窗口与基线必须一致：差一天就是两份基线。
{
  const root = makeFixture('# 文档\n\n错误率 4.00%\n', { windowDays: 7 })
  const r = run(root)
  assert.equal(r.status, 1, '窗口不一致必须失败')
  assert.match(r.out, /两份基线/)
  ok('窗口与基线不一致 → 失败')
  cleanup(root)
}
console.log('contracts: ' + passed + ' 组通过')
