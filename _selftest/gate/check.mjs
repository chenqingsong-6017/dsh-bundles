#!/usr/bin/env node
/**
 * DSH 验证门执行器 —— 给 dsh-proof 的 `check` script 用。
 *
 * 为什么需要这层：dsh-proof 的 autoDetect 只认 package.json 里的
 * typecheck / lint / test / check，而自研插件目录大多没有这些 scripts。
 * 所以工作区根目录挂一个只有 `check` 的 package.json，由本脚本按实际情况决定跑什么。
 *
 * 三道门，先快后慢：
 *   1. 语法门：`node --check` 每个插件入口（< 1 秒）
 *   2. 结构门：manifest / patch / 入口导出合规（< 1 秒）
 *   3. 测试门：全量跑 _selftest/tests/*.test.mjs（实测约 8 秒）
 *
 * 退出码：0 通过 / 1 失败。dsh-proof 只在非 0 时把输出 steer 回模型。
 *
 * 2026-10-29 改：测试门原本只跑「15 分钟内改过 index.js」的插件，结果 17 个测试
 * 平时只有 2–3 个会被执行，别的插件写好的回归保护等于不存在。实测全量 7.7 秒
 * （最慢 updater 4.1 秒），完全付得起，所以改成每次全跑。
 * 纯配置 bundle（只有 cordis.patch.yml、没有 index.js）不需要测试，单独列出来，不静默跳过。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const BUNDLES_DIR = 'D:\\AI\\dsh-bundles'
const SELFTEST_DIR = path.join(BUNDLES_DIR, '_selftest', 'tests')
const MAX_OUTPUT_LINES = 60

const node = process.execPath
const lines = []
const failures = []
const gateStart = Date.now()

function run(argv, cwd) {
  const started = Date.now()
  const result = spawnSync(node, argv, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120000 })
  return {
    ok: result.status === 0,
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
    ms: Date.now() - started,
  }
}

/** 列出所有插件目录（排除 `_` 与 `.` 开头的内部/隐藏目录）。 */
function listBundles() {
  if (!existsSync(BUNDLES_DIR)) return []
  return readdirSync(BUNDLES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
}

const bundles = listBundles()
if (bundles.length === 0) {
  console.log('gate: 没有找到任何插件目录，跳过')
  process.exit(0)
}

// ---- 阶段 1：语法门 ----
let checked = 0
for (const bundle of bundles) {
  const dir = path.join(BUNDLES_DIR, bundle)
  const entry = path.join(dir, 'index.js')
  if (!existsSync(entry)) continue
  checked += 1
  const result = run(['--check', entry], dir)
  if (!result.ok) {
    // node --check 的输出形如「<路径>:<行>\n<源码行>\n  ^\n\nSyntaxError: …」
    // 第一行只是路径，真正的错因在后面的 SyntaxError 行，所以要挑出来。
    const outLines = result.output.split('\n').map((line) => line.trim()).filter((line) => line !== '')
    const reason = outLines.find((line) => /Error|error:/i.test(line)) ?? outLines[outLines.length - 1] ?? '语法错误'
    const where = outLines[0] ?? bundle
    failures.push('✗ ' + bundle + '/index.js —— ' + reason + '\n  在 ' + where)
  }
}
lines.push('语法门：检查 ' + checked + ' 个插件入口')

// ---- 阶段 2：结构门（manifest 合规，零依赖） ----
//
// 不用通用 linter，是因为我们真正会踩的坑是「插件结构」而不是「代码风格」：
// 改错 package.json、patch 指错文件、入口忘了导出 apply —— 这些装上去才炸。
// locale / icon 只告警不失败：上游克隆的插件（如 eva-theme）本来就没有。
let structural = 0
for (const bundle of bundles) {
  const dir = path.join(BUNDLES_DIR, bundle)
  const pkgFile = path.join(dir, 'package.json')
  if (!existsSync(pkgFile)) {
    failures.push('✗ ' + bundle + ': 缺 package.json')
    continue
  }
  structural += 1
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  } catch {
    failures.push('✗ ' + bundle + ': package.json 不是合法 JSON')
    continue
  }
  if (typeof pkg?.name !== 'string') failures.push('✗ ' + bundle + ': package.json 缺 name')

  const patchRel = pkg?.dsh?.bundle?.patch
  if (typeof patchRel !== 'string') {
    failures.push('✗ ' + bundle + ': 缺 dsh.bundle.patch')
    continue
  }
  const patchFile = path.join(dir, patchRel)
  if (!existsSync(patchFile)) {
    failures.push('✗ ' + bundle + ': patch 文件不存在 ' + patchRel)
    continue
  }
  // patch 合法写法有三种：`- insert:`、`- override:`、以及裸行 `- id: xxx`（按 id 覆盖）。
  // 只看非注释行，避免被文件头的说明文字误判。
  const nonComment = readFileSync(patchFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
    .join('\n')
  if (!/(insert:|override:|^\s*-\s*id:)/m.test(nonComment)) {
    failures.push('✗ ' + bundle + ': patch 里既没有 insert / override，也没有裸行 id')
  }

  // 只有「自己就是插件」的包才有入口；纯配置 bundle 没有 index.js，跳过入口检查。
  const exported = pkg?.exports?.['.']
  const entryRel = typeof exported === 'string' ? exported : (exported?.default ?? exported?.import)
  if (typeof entryRel === 'string') {
    const entry = path.join(dir, entryRel)
    if (!existsSync(entry)) {
      failures.push('✗ ' + bundle + ': 入口不存在 ' + entryRel)
    } else if (!/export\s+(async\s+)?function\s+apply|export\s+default/.test(readFileSync(entry, 'utf8'))) {
      failures.push('✗ ' + bundle + ': 入口既没有 export function apply 也没有 export default')
    }
  }
}
lines.push('结构门：检查 ' + structural + ' 个 manifest')

// ---- 阶段 3：测试门（全量） ----
// 测试文件名惯例是去掉 `dsh-` 前缀（audit.test.mjs 对应 dsh-audit），
// 也兼容带前缀的写法，免得以后又踩「找不到测试」。
const foundTests = existsSync(SELFTEST_DIR)
  ? readdirSync(SELFTEST_DIR).filter((name) => name.endsWith('.test.mjs')).sort()
  : []

const tested = []
const noTestWithEntry = []
let testMs = 0

for (const bundle of bundles) {
  const dir = path.join(BUNDLES_DIR, bundle)
  const short = bundle.replace(/^dsh-/, '')
  const testFile = [
    path.join(SELFTEST_DIR, short + '.test.mjs'),
    path.join(SELFTEST_DIR, bundle + '.test.mjs'),
  ].find((candidate) => existsSync(candidate))

  if (!testFile) {
    // 有入口却没测试 → 是缺口，列出来（不判失败，但不能悄悄跳过）
    if (existsSync(path.join(dir, 'index.js'))) noTestWithEntry.push(bundle)
    continue
  }
  const result = run([testFile], SELFTEST_DIR)
  tested.push(short)
  testMs += result.ms
  if (!result.ok) {
    const tail = result.output.split('\n').filter((line) => line.trim() !== '').slice(-12)
    failures.push('✗ ' + bundle + ' 的测试失败（' + path.basename(testFile) + '，' + result.ms + 'ms）:\n' + tail.join('\n'))
  }
}

if (tested.length > 0) lines.push('测试门：全量跑了 ' + tested.length + ' 个测试（' + (testMs / 1000).toFixed(1) + 's）')
else lines.push('测试门：_selftest/tests 里没有测试文件')
if (noTestWithEntry.length > 0) lines.push('测试门：有入口但没测试 —— ' + noTestWithEntry.join(', '))

// ---- 阶段 4：标准门（report-only，规则见工作区 工业级标准.md） ----
// 只报告不阻断：老插件缺 CHANGELOG 是已知欠账，按「改到谁就补谁」推进。
const standardScript = path.join(BUNDLES_DIR, '_selftest', 'standard-check.mjs')
if (existsSync(standardScript)) {
  const std = run([standardScript], BUNDLES_DIR)
  const summary = (std.output.split('\n').find((line) => line.startsWith('共 ')) ?? '').trim()
  lines.push('标准门（report）：' + (summary || (std.ok ? '已跑' : '执行异常，见 standard-check')))
}

// ---- 汇总 ----
const totalMs = Date.now() - gateStart
const spent = '；总耗时 ' + (totalMs / 1000).toFixed(1) + 's'
if (failures.length === 0) {
  console.log('gate: 通过（' + lines.join('；') + spent + '）')
  process.exit(0)
}

const capped = failures.join('\n').split('\n').slice(0, MAX_OUTPUT_LINES)
console.error('gate: 失败 ' + failures.length + ' 项（' + lines.join('；') + spent + '）\n\n' + capped.join('\n'))
process.exit(1)