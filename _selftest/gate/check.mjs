#!/usr/bin/env node
/**
 * DSH 验证门执行器 —— 给 dsh-proof 的 `check` script 用。
 *
 * 为什么需要这层：dsh-proof 的 autoDetect 只认 package.json 里的
 * typecheck / lint / test / check，而自研插件目录大多没有这些 scripts。
 * 所以工作区根目录挂一个只有 `check` 的 package.json，由本脚本按实际情况决定跑什么。
 *
 * 四道门，先快后慢：
 *   1. 语法门：`node --check` 每个插件入口（< 1 秒）
 *   2. 结构门：manifest / patch / 入口导出合规（< 1 秒）
 *   3. 测试门：全量跑 _selftest/tests/*.test.mjs（实测约 8 秒）
 *   4. 标准门：report-only（规则见工作区 工业级标准.md）
 *
 * 第五道「性能基线慢门」默认关闭，只有显式 `--perf` 才跑：
 *   - 门跑完后调 `_ops/baselines.mjs --compare`，比对本次自测指标与 _reports/baselines.json；
 *   - 判据是双条件（相对变化 >5% 且绝对增量 ≥ 有意义值）才 FAIL，来源 DeepSeek TileKernels
 *     tests/conftest.py:19-28 的四个显式变量（基线目录 / FAIL_MODE=regression / 0.05 / 最小增量）；
 *   - 不带 --perf 时整段不执行：输出与退出码跟改动前完全一致。
 *
 * 退出码：0 通过 / 1 失败。dsh-proof 只在非 0 时把输出 steer 回模型。
 *
 * 2026-10-29 改：测试门原本只跑「15 分钟内改过 index.js」的插件，结果 17 个测试
 * 平时只有 2–3 个会被执行，别的插件写好的回归保护等于不存在。实测全量 7.7 秒
 * （最慢 updater 4.1 秒），完全付得起，所以改成每次全跑。
 * 纯配置 bundle（只有 cordis.patch.yml、没有 index.js）不需要测试，单独列出来，不静默跳过。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BUNDLES_DIR = 'D:\\AI\\dsh-bundles'
const SELFTEST_DIR = path.join(BUNDLES_DIR, '_selftest', 'tests')
const MAX_OUTPUT_LINES = 60

// --perf 慢门用的基线脚本（DSH_BASELINES 可覆盖，便于换机；默认按本机绝对路径）。
const PERF = process.argv.includes('--perf')
const PERF_SCRIPT = process.env.DSH_BASELINES ?? 'D:\\AI-date\\dsh-date\\dsh-创建\\_ops\\baselines.mjs'

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
// syntaxMs 只用于 --perf 的性能基线（默认路径下多一次 Date.now()，无副作用）。
const syntaxStart = Date.now()
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
const syntaxMs = Date.now() - syntaxStart
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
    } else {
      // 只接受命名导出。官方 postmortem 0001 证明：export default 会让 Loader 的
      // unwrapExports 丢掉 inject —— 178 个单测全绿、产品完全不可用。门必须拦住这种写法。
      const source = readFileSync(entry, 'utf8')
      if (/^\s*export\s+default\b/m.test(source)) {
        failures.push('✗ ' + bundle + ': 入口用了 export default（Loader 会丢 inject，见官方 postmortem 0001）——只允许 export function apply')
      } else if (!/export\s+(async\s+)?function\s+apply/.test(source)) {
        failures.push('✗ ' + bundle + ': 入口没有 export function apply')
      }
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
const usedTestFiles = new Set()
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
  usedTestFiles.add(path.basename(testFile))
  testMs += result.ms
  if (!result.ok) {
    const tail = result.output.split('\n').filter((line) => line.trim() !== '').slice(-12)
    failures.push('✗ ' + bundle + ' 的测试失败（' + path.basename(testFile) + '，' + result.ms + 'ms）:\n' + tail.join('\n'))
  }
}

// 孤儿测试：文件名不映射任何插件（security-guards / *-oracle 等）。
// 2026-11-01 实测发现：旧版只跑「按插件名映射到的测试」，security-guards.test.mjs（65 条护栏回归）
// 从来没有被验证门跑过——AGENTS.md 却写着「验证门自动跑」。孤儿必须一起跑，否则「全量」是假的。
for (const name of foundTests) {
  if (usedTestFiles.has(name)) continue
  const testPath = path.join(SELFTEST_DIR, name)
  const result = run([testPath], SELFTEST_DIR)
  tested.push(name.replace(/\.test\.mjs$/, ''))
  usedTestFiles.add(name)
  testMs += result.ms
  if (!result.ok) {
    const tail = result.output.split('\n').filter((line) => line.trim() !== '').slice(-12)
    failures.push('✗ 孤儿测试失败（' + name + '，' + result.ms + 'ms）:\n' + tail.join('\n'))
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

// ---- 阶段 5：性能基线慢门（--perf，默认关闭） ----
// 阈值与判定逻辑都在 _ops/baselines.mjs：相对变化 >5% 且绝对增量 ≥ 有意义值，两条都满足才 FAIL。
// 不带 --perf 时整段不执行；带 --perf 时把本次自测指标写进临时文件交给它比较（避免递归再跑一次门）。
let perfVerdict = ''
if (PERF) {
  if (!existsSync(PERF_SCRIPT)) {
    perfVerdict = '执行失败'
    failures.push('✗ 性能门：找不到基线脚本 ' + PERF_SCRIPT + '（可用 DSH_BASELINES 覆盖路径）')
  } else {
    const metricsFile = path.join(os.tmpdir(), 'dsh-gate-metrics-' + process.pid + '-' + Date.now() + '.json')
    let status = null
    let output = ''
    try {
      writeFileSync(metricsFile, JSON.stringify({
        gateTotalMs: Date.now() - gateStart,
        syntaxGateMs: syntaxMs,
        testGateMs: testMs,
        testFiles: tested.length,
        testFilesOnDisk: foundTests.length,
        checkedEntries: checked,
        structuralChecked: structural,
        exitCode: failures.length === 0 ? 0 : 1,
      }, null, 2))
      const cmp = spawnSync(node, [PERF_SCRIPT, '--compare', '--current', metricsFile], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 300000,
      })
      status = cmp.status
      output = `${cmp.stdout ?? ''}${cmp.stderr ?? ''}`.trim()
    } catch (error) {
      status = -1
      output = '性能门执行异常：' + ((error && error.message) || String(error))
    } finally {
      try { rmSync(metricsFile, { force: true }) } catch {}
    }
    if (output) console.log(output)
    if (status === 0) {
      perfVerdict = /还没有基线/.test(output) ? '无基线，跳过（先跑 --write）' : '无回归'
    } else {
      perfVerdict = '有回归'
      const tail = output.split('\n').filter((line) => line.trim() !== '').slice(-8)
      failures.push('✗ 性能基线回归（' + PERF_SCRIPT + ' --compare 退出码 ' + status + '）:\n' + tail.join('\n'))
    }
  }
}
if (PERF && perfVerdict) lines.push('性能门（--perf）：' + perfVerdict)

// ---- 汇总 ----
const totalMs = Date.now() - gateStart
// DSH_GATE_METRICS 只给 _ops/baselines.mjs --write 采集阶段耗时；默认不设该变量 → 不写任何文件。
if (process.env.DSH_GATE_METRICS) {
  try {
    writeFileSync(process.env.DSH_GATE_METRICS, JSON.stringify({
      gateTotalMs: totalMs,
      syntaxGateMs: syntaxMs,
      testGateMs: testMs,
      testFiles: tested.length,
      testFilesOnDisk: foundTests.length,
      checkedEntries: checked,
      structuralChecked: structural,
      exitCode: failures.length === 0 ? 0 : 1,
    }, null, 2))
  } catch {}
}
const spent = '；总耗时 ' + (totalMs / 1000).toFixed(1) + 's'
if (failures.length === 0) {
  console.log('gate: 通过（' + lines.join('；') + spent + '）')
  process.exit(0)
}

const capped = failures.join('\n').split('\n').slice(0, MAX_OUTPUT_LINES)
console.error('gate: 失败 ' + failures.length + ' 项（' + lines.join('；') + spent + '）\n\n' + capped.join('\n'))
process.exit(1)
