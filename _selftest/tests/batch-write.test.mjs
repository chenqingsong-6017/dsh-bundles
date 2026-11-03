/**
 * dsh-batch-write 行为测试：预演不落盘、apply 落盘并备份、歧义拒绝、保护路径拒绝。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeMockContext, runSmoke } from '../plugin-smoke.mjs'

let passed = 0
const ok = (label) => { passed += 1; console.log('  OK ' + label) }

await runSmoke('dsh-batch-write')
ok('结构合规、apply 可挂载')

const mod = await import('../../dsh-batch-write/index.js')

function mount(base, backup) {
  const { ctx, registered } = makeMockContext()
  mod.apply(ctx, { workspaceDir: base, backupDir: backup })
  const tool = registered.find((r) => r.name === 'batch_write')
  assert.ok(tool, '应注册 batch_write')
  return tool
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-batch-write-'))
const backup = path.join(dir, 'backup')
const fileA = path.join(dir, 'a.txt')
const fileB = path.join(dir, 'b.txt')
try {
  writeFileSync(fileA, 'alpha', 'utf8')
  writeFileSync(fileB, 'beta', 'utf8')
  const tool = mount(dir, backup)

  // 1) dry-run 不落盘
  const dry = await tool.execute({ ops: [{ path: 'a.txt', mode: 'replace', old: 'alpha', new: 'ALPHA' }] }, {})
  assert.equal(dry.applied, false)
  assert.equal(dry.changed, 1)
  assert.equal(dry.results[0].status, 'would-write')
  assert.equal(readFileSync(fileA, 'utf8'), 'alpha', 'dry-run 必须不落盘')
  ok('dry-run：报 would-write 但文件未变')

  // 2) apply 落盘 + 备份
  const applied = await tool.execute({ ops: [{ path: 'a.txt', mode: 'replace', old: 'alpha', new: 'ALPHA' }], apply: true }, {})
  assert.equal(applied.applied, true)
  assert.equal(readFileSync(fileA, 'utf8'), 'ALPHA')
  assert.ok(applied.backupDir !== '' && existsSync(applied.backupDir), '落盘必须产生备份目录')
  assert.equal(readFileSync(path.join(applied.backupDir, '0-a.txt'), 'utf8'), 'alpha', '备份内容应为改前内容')
  ok('apply：落盘且备份改前内容')

  // 3) replace 未命中 -> FAIL
  const miss = await tool.execute({ ops: [{ path: 'b.txt', mode: 'replace', old: '不存在的一段', new: 'x' }] }, {})
  assert.equal(miss.failed, 1)
  assert.equal(miss.results[0].status, 'FAIL')
  assert.match(miss.results[0].error, /BATCH_OLD_MISS/)
  ok('replace 未命中：拒绝并给 BATCH_OLD_MISS')

  // 4) 歧义 -> FAIL，除非 all:true
  writeFileSync(fileB, 'x x', 'utf8')
  const amb = await tool.execute({ ops: [{ path: 'b.txt', mode: 'replace', old: 'x', new: 'y' }] }, {})
  assert.equal(amb.failed, 1)
  assert.match(amb.results[0].error, /BATCH_OLD_AMBIGUOUS/)
  const all = await tool.execute({ ops: [{ path: 'b.txt', mode: 'replace', old: 'x', new: 'y', all: true }], apply: true }, {})
  assert.equal(all.changed, 1)
  assert.equal(readFileSync(fileB, 'utf8'), 'y y')
  ok('replace 歧义：默认拒绝，all:true 才替换全部')

  // 5) 保护路径拒绝
  const denied = await tool.execute({ ops: [{ path: path.join(dir, '.dsh/rules/core.md'), mode: 'write', content: 'x' }] }, {})
  assert.equal(denied.failed, 1)
  assert.match(denied.results[0].error, /BATCH_DENY/)
  ok('保护路径：规则文件一律拒绝')
} finally { rmSync(dir, { recursive: true, force: true }) }

console.log('batch-write.test.mjs: 通过 ' + passed + ' 组断言')