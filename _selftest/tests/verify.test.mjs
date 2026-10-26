import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { detectCheck } from '../../dsh-verify/index.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

const roots = []
const tempRoot = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-detect-'))
  roots.push(dir)
  return dir
}

const nodeRoot = tempRoot()
writeFileSync(path.join(nodeRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js', lint: 'eslint .' } }))
assert.equal(detectCheck(nodeRoot, 'auto').label, 'npm run test')
ok('package.json 里 auto 优先 test')

const lintRoot = tempRoot()
writeFileSync(path.join(lintRoot, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }))
assert.equal(detectCheck(lintRoot, 'auto').label, 'npm run lint')
ok('没有 test 时 auto 退到 lint')

const pnpmRoot = tempRoot()
writeFileSync(path.join(pnpmRoot, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }))
writeFileSync(path.join(pnpmRoot, 'pnpm-lock.yaml'), '')
assert.equal(detectCheck(pnpmRoot, 'auto').label, 'pnpm run test')
ok('有 pnpm 锁文件时用 pnpm')

const goRoot = tempRoot()
writeFileSync(path.join(goRoot, 'go.mod'), 'module x')
assert.equal(detectCheck(goRoot, 'auto').label, 'go test ./...')
ok('go.mod → go test')

const pyRoot = tempRoot()
writeFileSync(path.join(pyRoot, 'pyproject.toml'), '')
assert.equal(detectCheck(pyRoot, 'auto').label, 'python -m pytest -q')
ok('pyproject → pytest')

const emptyRoot = tempRoot()
assert.equal(detectCheck(emptyRoot, 'auto'), undefined)
ok('空目录 → 检测不到（不瞎猜）')

const custom = detectCheck(emptyRoot, 'auto', 'npm run my-check')
assert.equal(custom.kind, 'custom')
assert.equal(custom.shell, 'npm run my-check')
ok('customCommand 覆盖自动识别')

for (const dir of roots) rmSync(dir, { recursive: true, force: true })
console.log(`verify: ${passed} 项通过`)
