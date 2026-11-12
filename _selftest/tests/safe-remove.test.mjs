// safe-remove.test.mjs — junction 闸门的正反例（检查必须能失败）
// 反例：如果脚本顺着 junction 递归，precious 目录会被删 -> 断言失败；这就是本测试的可证伪点。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const WORKSPACE = process.env.DSH_WORKSPACE || 'D:/AI-date/dsh-date/dsh-创建'
const script = path.join(WORKSPACE, '_ops', 'safe-remove.mjs')
const node = process.execPath
const tmp = mkdtempSync(path.join(os.tmpdir(), 'safe-remove-'))
let passed = 0
const ok = (label) => { passed += 1; console.log('  OK ' + label) }

try {
  const precious = path.join(tmp, 'precious')
  mkdirSync(precious, { recursive: true })
  writeFileSync(path.join(precious, 'plugin-source.js'), 'do not delete me')
  const victim = path.join(tmp, 'victim')
  mkdirSync(path.join(victim, 'node_modules', '@local'), { recursive: true })
  writeFileSync(path.join(victim, 'cordis.patch.yml'), 'patch')
  symlinkSync(precious, path.join(victim, 'node_modules', '@local', 'linked'), 'junction')

  // 1) 没有 --break-links：必须拒绝（exit 2），且目标文件仍在
  const blocked = spawnSync(node, [script, victim, '--apply'], { encoding: 'utf8' })
  assert.equal(blocked.status, 2, '有 junction 时递归删除必须被拒绝: ' + blocked.stderr)
  assert.ok(existsSync(path.join(precious, 'plugin-source.js')), '被链接的目标文件必须原样存在')
  assert.ok(existsSync(victim), '拒绝时不得删任何东西')
  ok('junction 存在 → 拒绝删除，目标完好（反例：跟随链接会删目标）')

  // 2) --break-links：只断链接，再删树，目标完好
  const broken = spawnSync(node, [script, victim, '--apply', '--break-links'], { encoding: 'utf8' })
  assert.equal(broken.status, 0, 'break-links 应成功: ' + broken.stderr)
  assert.ok(!existsSync(victim), '待删目录应被移除')
  assert.ok(existsSync(path.join(precious, 'plugin-source.js')), '断链后目标仍必须完好')
  ok('--break-links → 只断链接、目标完好、待删目录移除')

  // 3) 普通目录：没有链接时直接删
  const plain = path.join(tmp, 'plain')
  mkdirSync(plain, { recursive: true })
  writeFileSync(path.join(plain, 'a.txt'), 'a')
  const removed = spawnSync(node, [script, plain, '--apply'], { encoding: 'utf8' })
  assert.equal(removed.status, 0, '普通目录应可删: ' + removed.stderr)
  assert.ok(!existsSync(plain))
  ok('无链接的普通目录照常删除')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log('safe-remove: ' + passed + ' 组通过')
