#!/usr/bin/env node
/**
 * 工业级标准合规检查（规则见工作区 工业级标准.md）。
 * 默认 report 模式：只报告不阻断；加 --strict 时有不合格项就以 1 退出。
 * 用法：node _selftest/standard-check.mjs [插件根目录] [--strict]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const ROOT = args.find((a) => !a.startsWith('--')) ?? 'D:/AI/dsh-bundles'
const STRICT = args.includes('--strict')
const TESTS = path.join(ROOT, '_selftest', 'tests')
const read = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }

const dirs = readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith('dsh-'))
  .map((d) => d.name)
  .sort()

const rows = []
for (const dir of dirs) {
  const base = path.join(ROOT, dir)
  const problems = []
  let pkg = null
  const raw = read(path.join(base, 'package.json'))
  if (raw === null) problems.push('缺 package.json')
  else {
    try { pkg = JSON.parse(raw) } catch { problems.push('package.json 不是合法 JSON') }
  }
  if (pkg) {
    if (!pkg.name) problems.push('缺 name')
    if (!pkg.version) problems.push('缺 version')
    if (!pkg.description) problems.push('缺 description')
    const patch = pkg?.dsh?.bundle?.patch
    if (!patch) problems.push('缺 dsh.bundle.patch')
    else if (!existsSync(path.join(base, patch))) problems.push('patch 文件不存在')
  }
  const entry = path.join(base, 'index.js')
  const hasEntry = existsSync(entry)
  if (hasEntry) {
    const src = read(entry) ?? ''
    if (!/export\s+(async\s+)?function\s+apply/.test(src) && !/export\s+default/.test(src)) problems.push('index.js 没有 export apply')
  } else if (!(pkg && pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch)) {
    problems.push('既无 index.js 也非纯配置 bundle')
  }
  const readme = read(path.join(base, 'README.md'))
  if (readme === null) problems.push('缺 README.md')
  else if (!/验证/.test(readme)) problems.push('README 没有验证记录')
  const changelog = read(path.join(base, 'CHANGELOG.md'))
  if (changelog === null) problems.push('缺 CHANGELOG.md')
  else if (pkg && pkg.version && !changelog.includes(pkg.version)) problems.push('CHANGELOG 缺当前版本 ' + pkg.version)
  if (hasEntry) {
    const short = dir.replace(/^dsh-/, '')
    if (!existsSync(path.join(TESTS, short + '.test.mjs'))) problems.push('缺测试 ' + short + '.test.mjs')
  }
  rows.push({ dir, version: (pkg && pkg.version) || '-', problems })
}

let bad = 0
for (const row of rows) {
  if (row.problems.length === 0) {
    console.log('✓ ' + row.dir + '  ' + row.version)
  } else {
    bad += 1
    console.log('✗ ' + row.dir + '  ' + row.version + '  —— ' + row.problems.length + ' 项不合规')
    for (const p of row.problems) console.log('    · ' + p)
  }
}
console.log('')
console.log('共 ' + rows.length + ' 个插件：合规 ' + (rows.length - bad) + '，不合规 ' + bad + '（' + (STRICT ? 'strict' : 'report') + ' 模式）')
if (STRICT && bad > 0) process.exit(1)