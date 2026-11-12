#!/usr/bin/env node
/**
 * DSH 验证门执行器 —— 给 dsh-proof 的 `check` script 用。
 *
 * 为什么需要这层：dsh-proof 的 autoDetect 只认 package.json 里的
 * typecheck / lint / test / check，而自研插件目录大多没有这些 scripts。
 * 所以工作区根目录挂一个只有 `check` 的 package.json，由本脚本按实际情况决定跑什么。
 *
 * 四道门，先快后慢：
 *   1. 语法门：`node --check` 每个插件入口与它的 lib/ 模块（< 1 秒）
 *   2. 结构门：manifest / patch / 入口导出合规（< 1 秒）
 *   3. 测试门：全量跑 _selftest/tests/*.test.mjs（2026-11-12 实测约 50 秒 / 45 个测试）
 *   4. 标准门：report-only（规则见工作区 工业级标准.md）
 *
 * --fast 快门（2026-11-12）：跳过测试门，给「每次编辑都跑」（dsh-proof 的 check）用，实测 ~3s；
 *   全门用 npm run check:full——本脚本不带参数 = 全量，行为与改动前一致。
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
 *
 * 2026-11-01 改：补三个「门可被掏空」的洞（证据见 _research/deepseek-repos/05c-harness-adr-practice.md §4.2）：
 *   1. 插件目录不存在或 0 个插件 → 失败（exit 1），不再打印「跳过」后 exit 0；
 *      DSH_ALLOW_EMPTY_BUNDLES=1 是仅给 gate-hollow 测试用的逃生口。
 *   2. 有入口无测试 → 棘轮：不在 _selftest/tests/coverage-baseline.json 白名单内即失败；
 *      baseline 只能收紧（新增插件必须补测试，或显式加白名单并写理由）。
 *   3. DSH_BUNDLES_DIR 可覆盖仓库路径，让测试能在临时假目录上跑真门。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sweepAllTestDirs } from '../tests/_tmp-dirs.mjs'

// DSH_BUNDLES_DIR 给 gate-hollow 测试造临时假目录用；不设时仍是本机默认路径。
const BUNDLES_DIR_ENV = process.env.DSH_BUNDLES_DIR
const BUNDLES_DIR = BUNDLES_DIR_ENV ? path.resolve(BUNDLES_DIR_ENV) : 'D:\\AI\\dsh-bundles'
const SELFTEST_DIR = path.join(BUNDLES_DIR, '_selftest', 'tests')
const COVERAGE_BASELINE = path.join(SELFTEST_DIR, 'coverage-baseline.json')
const MAX_OUTPUT_LINES = 60

// --perf 慢门用的基线脚本（DSH_BASELINES 可覆盖，便于换机；默认按本机绝对路径）。
const PERF = process.argv.includes('--perf')
// --fast 快门（2026-11-12）：跳过测试门，给「每轮编辑都跑」用（dsh-proof）。全门用 npm run check:full。
const FAST = process.argv.includes('--fast')
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
  // 洞 1：路径写错/插件仓被移走时，旧版打印「跳过」后 exit 0 —— 门是绿的但什么都没查。
  const where = BUNDLES_DIR_ENV
    ? 'DSH_BUNDLES_DIR=' + BUNDLES_DIR_ENV + '（解析为 ' + BUNDLES_DIR + '）'
    : '默认路径 ' + BUNDLES_DIR
  if (process.env.DSH_ALLOW_EMPTY_BUNDLES === '1') {
    console.log('gate: 插件目录为空（' + where + '），但 DSH_ALLOW_EMPTY_BUNDLES=1 —— 仅供测试，跳过')
    process.exit(0)
  }
  console.error('gate: 失败 1 项（插件目录为空 = 门被掏空）\n\n' +
    '✗ 找不到任何插件目录：' + where + '\n' +
    '  目录存在=' + existsSync(BUNDLES_DIR) + '。这通常意味着 DSH_BUNDLES_DIR/默认路径写错、插件仓被移走，或目录里没有插件。')
  process.exit(1)
}

// ---- 阶段 1：语法门 ----
// syntaxMs 只用于 --perf 的性能基线（默认路径下多一次 Date.now()，无副作用）。
const syntaxStart = Date.now()
let checked = 0
// 语法失败信息的统一提取：node --check 输出形如「<路径>:<行>\n<源码行>\n  ^\n\nSyntaxError: …」，
// 第一行只是路径，真正的错因在后面的 SyntaxError 行，所以要挑出来。
const syntaxFailure = (label, result) => {
  const outLines = result.output.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const reason = outLines.find((line) => /Error|error:/i.test(line)) ?? outLines[outLines.length - 1] ?? '语法错误'
  const where = outLines[0] ?? label
  return '✗ ' + label + ' —— ' + reason + '\n  在 ' + where
}
// 递归收集 lib/ 下的 .js：2026-11-05 起 dsh-memory / dsh-butler-tidy 把代码拆进 lib/，
// 只查入口会漏掉整个模块树，拆得越干净越查不到。
const libFilesOf = (dir) => {
  const libDir = path.join(dir, 'lib')
  if (!existsSync(libDir)) return []
  const found = []
  const walk = (current) => {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, item.name)
      if (item.isDirectory()) walk(full)
      else if (item.name.endsWith('.js')) found.push(full)
    }
  }
  walk(libDir)
  return found
}
for (const bundle of bundles) {
  const dir = path.join(BUNDLES_DIR, bundle)
  const entry = path.join(dir, 'index.js')
  if (!existsSync(entry)) continue
  const files = [entry, ...libFilesOf(dir)]
  for (const file of files) {
    checked += 1
    const result = run(['--check', file], dir)
    if (!result.ok) failures.push(syntaxFailure(bundle + '/' + path.relative(dir, file).split(path.sep).join('/'), result))
  }
}
const syntaxMs = Date.now() - syntaxStart
lines.push('语法门：检查 ' + checked + ' 个 JS 文件（插件入口 + lib/ 模块）')

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

  // 包契约（对齐官方 publish.md 组合包标准，2026-11-10 补）：
  // engines.dsh 声明支持的 DSH 版本范围（官方 app-boot 用它单独判定兼容，semver includePrerelease:true）；
  // main 显式声明入口（官方组合包要求 main: index.js）。缺了 = 版本兼容/入口不可验收。
  if (typeof pkg?.engines?.dsh !== 'string' || pkg.engines.dsh.trim() === '') {
    failures.push('✗ ' + bundle + ': 缺 engines.dsh（组合包须声明 DSH 版本范围，见官方 publish.md）')
  }
  if (typeof pkg?.main !== 'string' || pkg.main.trim() === '') {
    failures.push('✗ ' + bundle + ': 缺 main（组合包须显式声明入口，官方 publish.md 要求 main: index.js）')
  }

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

// ---- 阶段 2b：locale/*.json 必须能解析（2026-11-02 补） ----
// 实测事故：dsh-obsidian/locale/zh.json 里写了一条未转义的 Windows 路径
// （"把 D:\AI-date\obsidian\vault 扫成索引"），`\A` 不是合法转义，JSON.parse 抛
// `Bad escaped character in JSON at position 67`，插件列表上直接显示「包元信息错误」。
// 旧门只 parse package.json，locale 文件从没被读过，所以这个错误一路绿灯到界面。
// 这条只在「文件真坏了」时才会红，正反两向断言见 gate-hollow.test.mjs 用例 (v)/(vi)。
let localeChecked = 0
for (const bundle of bundles) {
  const localeDir = path.join(BUNDLES_DIR, bundle, 'locale')
  if (!existsSync(localeDir)) continue
  for (const name of readdirSync(localeDir).filter((entry) => entry.endsWith('.json')).sort()) {
    localeChecked += 1
    const file = path.join(localeDir, name)
    try {
      JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    } catch (error) {
      failures.push('✗ ' + bundle + '/locale/' + name + ' 不是合法 JSON：' + ((error && error.message) || String(error)) +
        '\n  （常见原因：description 里直接写了 Windows 路径，反斜杠要写成 \\\\）')
    }
  }
}
if (localeChecked > 0) lines.push('结构门：检查 ' + localeChecked + ' 个 locale 文件')
// ---- 阶段 2c：工具契约（对齐官方 defineTool，2026-11-10 补） ----
//
// 官方 adding-a-tool.md：面向模型的工具必须声明 output.schema（返回规范 JSON 值）+ output.render（渲染成人话）。
// 臣的插件用 raw ctx.tools.register（官方允许，但要求「自行负责输入校验」），output.schema/render 仍须显式声明；
// 缺了 = 返回契约不可验收、模型看到原始 JSON。本门只查「有 execute 的工具块」，webServer 路由等非工具注册块跳过。
// 两个健壮性要点（2026-11-10 实测踩过）：
//   1) 入口按 package.json 的 main 定位，不能硬编码 index.js（dsh-reasoning-slider 的入口是 lib/index.js）；
//   2) 注册写法按 /\.register\s*\(/ 匹配，不能硬编码 tools.register(（dsh-subagent-brief 用 toolService.register）。
const extractRegisterBlocks = (source) => {
  const blocks = []
  const re = /\.register\s*\(/g
  let m
  while ((m = re.exec(source)) !== null) {
    const open = source.indexOf('(', m.index)
    let depth = 0
    let j = open
    let inStr = null
    for (; j < source.length; j += 1) {
      const c = source[j]
      if (inStr) { if (c === '\\') { j += 1; continue } if (c === inStr) inStr = null; continue }
      if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
      if (c === '(') depth += 1
      else if (c === ')') { depth -= 1; if (depth === 0) break }
    }
    blocks.push(source.slice(m.index, j + 1))
    re.lastIndex = j + 1
  }
  return blocks
}
let toolChecked = 0
for (const bundle of bundles) {
  const dir = path.join(BUNDLES_DIR, bundle)
  const pkgFile = path.join(dir, 'package.json')
  if (!existsSync(pkgFile)) continue
  let pkg
  try { pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) } catch { continue }
  const mainRel = typeof pkg.main === 'string' ? pkg.main : 'index.js'
  const entry = path.join(dir, mainRel)
  if (!existsSync(entry)) continue
  const source = readFileSync(entry, 'utf8')
  const toolBlocks = extractRegisterBlocks(source).filter((block) => /\bexecute\s*[(:]/.test(block))
  for (const block of toolBlocks) {
    toolChecked += 1
    const name = (block.match(/name\s*:\s*['"]([^'"]+)['"]/) || [])[1] || '(未命名)'
    if (!/output\s*:/.test(block)) failures.push('✗ ' + bundle + '/' + name + ': 工具缺 output（官方要求 output.schema + output.render）')
    else if (!/schema\s*:/.test(block)) failures.push('✗ ' + bundle + '/' + name + ': 工具 output 缺 schema')
    else if (!/render/.test(block)) failures.push('✗ ' + bundle + '/' + name + ': 工具 output 缺 render')
  }
}
if (toolChecked > 0) lines.push('工具契约：检查 ' + toolChecked + ' 个模型工具（output.schema + render）')

// 测试门前先扫掉上次运行遗留的测试临时目录（gate 串行跑测试，此刻扫到的都是旧账）。
// 2026-11-02：memory 测试曾 5 小时积 153 个目录；统一兜底后不管哪个测试文件漏，这里补扫。
sweepAllTestDirs()

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

// --fast 快门：测试门整段跳过（全门 npm run check:full 负责全量 45 个测试）。
// 块内保持原缩进，避免为加一层花括号产生 80 行纯缩进 diff（改动可在 git 里一眼看清）。
if (FAST) lines.push('测试门：fast 模式跳过（npm run check:full 跑全量）')
else {
for (const bundle of bundles) {
  const dir = path.join(BUNDLES_DIR, bundle)
  const short = bundle.replace(/^dsh-/, '')
  const testFile = [
    path.join(SELFTEST_DIR, short + '.test.mjs'),
    path.join(SELFTEST_DIR, bundle + '.test.mjs'),
  ].find((candidate) => existsSync(candidate))

  if (!testFile) {
    // 有入口却没测试 → 记缺口，循环后按 coverage-baseline.json 棘轮判定（洞 2）。
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
else {
  // 2026-11-03 全局审计：测试目录为空/被清空时，旧实现只打一行字、不失败（门被掏空仍绿）
  lines.push('测试门：_selftest/tests 里没有测试文件')
  failures.push('✗ 测试门：_selftest/tests 里没有测试文件 —— 门被掏空（目录被移走/清空时不应绿）')
}

// 洞 2：覆盖缺口棘轮。baseline 是「当前已欠账」的白名单，只允许收紧：
//   - 不在白名单里的「有入口无测试」→ 失败（新增插件必须补测试）；
//   - baseline 缺失/坏掉按空处理（宁严不宽）；
//   - 已补测试的插件留在 baseline 里只提示「可收紧」，不失败（避免别人补测试时被卡）。
let coverageAllow = []
try {
  const parsed = JSON.parse(readFileSync(COVERAGE_BASELINE, 'utf8'))
  coverageAllow = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.allow) ? parsed.allow : [])
} catch (error) {
  if (existsSync(COVERAGE_BASELINE)) {
    failures.push('✗ ' + COVERAGE_BASELINE + ' 不是合法 JSON：' + ((error && error.message) || String(error)))
  }
}
const allowSet = new Set(coverageAllow)
const uncovered = noTestWithEntry.filter((bundle) => !allowSet.has(bundle))
const staleAllow = coverageAllow.filter((bundle) => !noTestWithEntry.includes(bundle))
if (noTestWithEntry.length > 0) {
  lines.push('测试门：有入口但没测试 ' + noTestWithEntry.length + ' 个（baseline 豁免 ' + (noTestWithEntry.length - uncovered.length) + '）')
}
for (const bundle of uncovered) {
  failures.push('✗ ' + bundle + '：有入口但没测试，且不在 coverage-baseline.json —— 新增插件必须补测试；确实要欠账就把它加进 baseline 并在 _note 里写理由')
}
if (staleAllow.length > 0) {
  lines.push('测试门：baseline 可收紧（已有测试可移出）—— ' + staleAllow.join(', '))
}
}

// ---- 阶段 4：标准门（report-only，规则见工作区 工业级标准.md） ----
// 只报告不阻断：老插件缺 CHANGELOG 是已知欠账，按「改到谁就补谁」推进。
const standardScript = path.join(BUNDLES_DIR, '_selftest', 'standard-check.mjs')
if (existsSync(standardScript)) {
  const std = run([standardScript], BUNDLES_DIR)
  const summary = (std.output.split('\n').find((line) => line.startsWith('共 ')) ?? '').trim()
  lines.push('标准门（report）：' + (summary || (std.ok ? '已跑' : '执行异常，见 standard-check')))
} else {
  // 2026-11-03：脚本被改名/移走时旧实现静默跳过（与「空插件目录必须红」口径不一致）
  lines.push('标准门（report）：脚本缺失')
  failures.push('✗ 标准门：找不到 ' + standardScript + ' —— 脚本被改名/移走，不能静默跳过')
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
