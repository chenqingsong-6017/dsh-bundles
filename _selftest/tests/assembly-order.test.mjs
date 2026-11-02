/**
 * 装配顺序检查的测试（任务：pre-execute 拦截链顺序要有测试守，不能靠数组位置碰运气）。
 *
 * 证伪思路：先用「反序 profile」跑一遍，必须红；真实 profile 必须绿。
 * 依据：官方 docs/subsystems/tool-execution-pipeline.zh.md 的 waterfall 早停语义。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkAssembly, REQUIRED_ORDER } from '../assembly-order.mjs'

let passed = 0
const ok = (label) => { passed += 1; console.log('  ✓ ' + label) }
const script = path.join(import.meta.dirname, '..', 'assembly-order.mjs')

const profileOf = (names) => ({ dsh: { profile: { bundles: names } } })
const names = ['@local/dsh-checkpoint', '@local/dsh-hooks', '@local/dsh-auto-approve']

// 1) 正确顺序：绿
const good = checkAssembly(profileOf(['@deepseek-ai/dsh-base', ...names]))
assert.equal(good.ok, true)
assert.equal(good.order.map((item) => item.name).join(','), REQUIRED_ORDER.map((item) => item.name).join(','))
ok('正序 profile 通过，且顺序解析为 checkpoint → hooks → auto-approve')

// 2) hooks 与 auto-approve 反序：必须红，且说明早停语义
const swapped = checkAssembly(profileOf(['@local/dsh-checkpoint', '@local/dsh-auto-approve', '@local/dsh-hooks']))
assert.equal(swapped.ok, false)
assert.equal(swapped.code, 'ORDER_BROKEN')
assert.ok(swapped.problems.some((p) => p.includes('早停')), '问题描述必须说清早停会改变什么')
ok('hooks 在 auto-approve 之后 → 报警并解释 watermark 早停')

// 3) checkpoint 不在最后、但整条链缺失：必须红
const missing = checkAssembly(profileOf(['@local/dsh-hooks', '@local/dsh-auto-approve']))
assert.equal(missing.ok, false)
assert.ok(missing.problems.some((p) => p.includes('checkpoint')), '缺层必须点名')
ok('缺 checkpoint → 报警（少一层拦截不等于通过）')

// 4) 没有 bundles 数组：必须红（不是静默通过）
assert.equal(checkAssembly({}).ok, false)
assert.equal(checkAssembly({}).code, 'NO_BUNDLES')
ok('profile 结构不对 → 红，不静默放行')

// 5) CLI 端到端：好 profile 退出 0，坏 profile 退出 1（selfcheck 用的就是这条通路）
const dir = mkdtempSync(path.join(os.tmpdir(), 'assembly-order-'))
try {
  const goodFile = path.join(dir, 'good.json')
  const badFile = path.join(dir, 'bad.json')
  writeFileSync(goodFile, JSON.stringify(profileOf(names)), 'utf8')
  writeFileSync(badFile, JSON.stringify(profileOf([...names].reverse())), 'utf8')
  const goodRun = spawnSync(process.execPath, [script, '--profile', goodFile], { encoding: 'utf8' })
  const badRun = spawnSync(process.execPath, [script, '--profile', badFile], { encoding: 'utf8' })
  assert.equal(goodRun.status, 0, '正序应退出 0：' + goodRun.stderr)
  assert.equal(badRun.status, 1, '反序应退出 1')
  assert.ok(badRun.stderr.includes('早停'), 'CLI 失败信息要带原因')
  ok('CLI：正序 exit 0 / 反序 exit 1（selfcheck 第 5 层的接线可证伪）')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n' + passed + ' 项通过（装配顺序检查）')