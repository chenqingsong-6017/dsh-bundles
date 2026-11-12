/**
 * dsh-negative-asset 测试：结构冒烟 + 只读扫描行为 + 红线 fail-closed + 反例自检。
 *
 * 为什么要有「反例自检」：红线检查如果永远绿，它就是装饰。这里把 guard 清空再跑一次，
 * 断言同一个判定函数必须报错——证明 protected>0 来自红线本身，不是凭空为真。
 *
 * 临时目录落在 D:\AI\dsh-data\_selftest-negative-asset-*（不在 %TEMP%，因为 %TEMP% 在
 * AppData 红线内，扫描会 fail-closed 整根拒扫），gate 的 sweepAllTestDirs 会兜底清理。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { makeMockContext, runSmoke } from '../plugin-smoke.mjs'

const BUNDLE = 'D:\\AI\\dsh-bundles\\dsh-negative-asset'
const TIDY = 'D:\\AI\\dsh-bundles\\dsh-butler-tidy'
const DATA_ROOT = existsSync('D:\\AI\\dsh-data') ? 'D:\\AI\\dsh-data' : os.tmpdir()
const ROOT = mkdtempSync(path.join(DATA_ROOT, '_selftest-negative-asset-'))
const STORE = path.join(ROOT, 'store')
const OLD = new Date(Date.now() - 60 * 86400000)

let passed = 0
const ok = (label) => {
  passed += 1
  console.log('  ✓ ' + label)
}

function cleanup() {
  try {
    rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    /* 交给 gate 的 sweepAllTestDirs 兜底 */
  }
}
process.on('exit', cleanup)

/** 文件数 / 目录数 / 字节数快照（跳过 reparse point，与扫描器口径一致） */
function snapshot(target) {
  let files = 0
  let dirs = 0
  let bytes = 0
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        dirs += 1
        walk(full)
      } else if (entry.isFile()) {
        try {
          const info = statSync(full)
          files += 1
          bytes += info.size
        } catch {
          /* 快照期间的瞬时失败不影响结论 */
        }
      }
    }
  }
  walk(target)
  return { files, dirs, bytes }
}

function assertSchema(schema, value, at) {
  if (schema.type === 'object') {
    assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), at + ' 应为对象')
    for (const key of schema.required || []) assert.ok(Object.hasOwn(value, key), at + ' 缺字段 ' + key)
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) assert.ok(Object.hasOwn(schema.properties || {}, key), at + ' 多出字段 ' + key)
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) assertSchema(child, value[key], at + '.' + key)
    }
    return
  }
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value), at + ' 应为数组')
    value.forEach((item, index) => assertSchema(schema.items, item, at + '[' + index + ']'))
    return
  }
  if (schema.type === 'integer') return assert.ok(Number.isInteger(value), at + ' 应为整数')
  if (schema.type === 'number') return assert.ok(typeof value === 'number' && Number.isFinite(value), at + ' 应为数字')
  if (schema.type === 'boolean') return assert.ok(typeof value === 'boolean', at + ' 应为布尔')
  if (schema.type === 'string') return assert.ok(typeof value === 'string', at + ' 应为字符串')
}

// ── 1) 结构合规 + apply 能挂载 ──
await runSmoke('dsh-negative-asset')
ok('结构合规、apply 可挂载')

// ── 2) 源码静态断言：P0 只读，不许有删除 / 移动 / 改名 API ──
const sourceFiles = ['index.js', 'lib/scan.js', 'lib/format.js', 'lib/path-safety.js']
const allSource = sourceFiles.map((file) => readFileSync(path.join(BUNDLE, file), 'utf8')).join('\n')
const FORBIDDEN = [
  /\bunlinkSync\b/,
  /\bunlink\s*\(/,
  /\brmSync\b/,
  /\brmdirSync\b/,
  /\brmdir\s*\(/,
  /\btruncateSync\b/,
  /\brenameSync\b/,
  /\bcopyFileSync\b/,
  /\bcpSync\b/,
  /\basset_apply\b/,
]
for (const pattern of FORBIDDEN) assert.ok(!pattern.test(allSource), 'P0 源码不许出现删除/移动/改名 API：' + pattern)
ok('源码零删除/移动/改名 API（unlink / rm / rmdir / rename / copy 全无），也没有 asset_apply')

// ── 3) 红线 fail-closed：UNC / 设备路径 / junction / 空值 ──
const safety = await import(pathToFileURL(path.join(BUNDLE, 'lib', 'path-safety.js')).href)
const guard = safety.protectedDirs({})
assert.ok(guard.length >= 9, '默认红线不得少于 9 项（实际 ' + guard.length + '；权威判据是下面第 4 节与 dsh-butler-tidy 逐项一致，别在这里写死数字）')
assert.equal(safety.isProtected('\\\\?\\D:\\AI\\dsh-bundles\\x', guard), true, '\\?\ 设备路径必须 fail-closed')
assert.equal(safety.isProtected('\\\\server\\share\\x', guard), true, 'UNC 必须 fail-closed')
assert.equal(safety.isProtected('D:\\AI\\dsh-bundles\\dsh-memory\\index.js', guard), true, '红线内子路径必须命中')
assert.equal(safety.isProtected('', guard), true, '空路径 fail-closed')
assert.equal(safety.isProtected(null, guard), true, 'null fail-closed')
assert.equal(safety.isProtected('D:\\AI\\dsh-data\\tmp', guard), false, '非红线正常路径不能误判')

const junctionTarget = path.join(ROOT, 'junction-target')
const junctionPath = path.join(ROOT, 'junction-link')
mkdirSync(junctionTarget, { recursive: true })
execFileSync('cmd', ['/c', 'mklink', '/J', junctionPath, junctionTarget], { windowsHide: true })
assert.equal(safety.hasReparsePoint(junctionPath), true, 'junction 必须被识别为 reparse point')
assert.equal(safety.realPathOf(junctionPath), '', 'junction 不能解析成真实路径')
assert.equal(safety.isProtected(junctionPath, guard), true, 'junction 哪怕不在红线内也必须 fail-closed（防绕过）')
ok('UNC / \\\\?\\ / junction / 空值 四种写法都判 protected（fail-closed），正常路径不误判')

// ── 4) 跨插件回归：两边红线清单必须逐项一致（不一致即 FAIL） ──
const tidySafety = await import(pathToFileURL(path.join(TIDY, 'lib', 'path-safety.js')).href)
assert.deepEqual([...safety.protectedDirs({})].sort(), [...tidySafety.protectedDirs({})].sort(), 'dsh-negative-asset 与 dsh-butler-tidy 的红线清单必须一致')
ok('红线清单与 dsh-butler-tidy 逐项一致（跨插件回归）')

// ── 5) 挂假 ctx，拿工具定义 ──
function writeOld(file, content) {
  writeFileSync(file, content)
  utimesSync(file, OLD, OLD)
}

const fixture = path.join(ROOT, 'fixture')
mkdirSync(fixture, { recursive: true })
mkdirSync(path.join(fixture, 'empty-old'))
utimesSync(path.join(fixture, 'empty-old'), OLD, OLD)
mkdirSync(path.join(fixture, 'empty-new'))
mkdirSync(path.join(fixture, 'deep'))
mkdirSync(path.join(fixture, 'deep', 'empty-deep-old'))
utimesSync(path.join(fixture, 'deep', 'empty-deep-old'), OLD, OLD)
writeOld(path.join(fixture, 'zero.dat'), '')
writeOld(path.join(fixture, 'run.tmp'), 'x'.repeat(100))
writeOld(path.join(fixture, 'dup-a.txt'), 'same-content-123')
writeOld(path.join(fixture, 'dup-b.txt'), 'same-content-123')
writeOld(path.join(fixture, 'archive.7z'), 'merged')
writeOld(path.join(fixture, 'archive.7z.001'), 'vol1')
writeOld(path.join(fixture, 'vol.r00'), 'v1')
writeOld(path.join(fixture, 'vol.r01'), 'v2')
writeOld(path.join(fixture, 'report.docx'), 'orig')
writeOld(path.join(fixture, 'report - copy.docx'), 'copy')
writeOld(path.join(fixture, 'lonely 副本.txt'), 'copyonly')
writeOld(path.join(fixture, 'photo.jpg'), 'photo-base')
writeOld(path.join(fixture, 'photo (1).jpg'), 'photo-copy')
writeOld(path.join(fixture, 'draft.txt'), 'draft-base')
writeOld(path.join(fixture, 'draft final_v2.txt'), 'draft-copy')
writeOld(path.join(fixture, 'plan.md'), 'plan-base')
writeOld(path.join(fixture, 'plan 最终版.md'), 'plan-copy')
writeFileSync(path.join(fixture, 'fresh.tmp'), 'brand-new')

const mod = await import(pathToFileURL(path.join(BUNDLE, 'index.js')).href + '?t=' + Date.now())
const mock = makeMockContext()
mod.apply(mock.ctx, { storeDir: STORE, roots: [] })
const byName = new Map(mock.registered.map((definition) => [definition.name, definition]))
const toolNames = [...byName.keys()].sort()
assert.deepEqual(toolNames, ['asset_scan', 'asset_status'], 'P0 只暴露两个只读工具')
ok('只注册 asset_scan / asset_status（没有 apply）')

async function call(name, args) {
  const definition = byName.get(name)
  assert.ok(definition, '缺工具 ' + name)
  const value = await definition.execute(args)
  assertSchema(definition.output.schema, value, name)
  const rendered = definition.output.render(args, value)
  assert.ok(Array.isArray(rendered) && rendered.length > 0, name + ' render 应返回数组')
  for (const block of rendered) {
    assert.equal(block && block.type, 'text', name + ' render 块应为 text')
    assert.equal(typeof block.text, 'string', name + ' render 应为字符串')
  }
  return { value, text: rendered[0].text }
}

// ── 6) 不给 roots：必须报错给指引，绝不默认扫全盘 ──
const noRoots = await call('asset_scan', {})
assert.equal(noRoots.value.scannedFiles, 0)
assert.equal(noRoots.value.scannedDirs, 0)
assert.deepEqual(noRoots.value.roots, [])
assert.equal(noRoots.value.items.length, 0)
assert.match(noRoots.value.errors[0].error, /roots/)
assert.match(noRoots.text, /没有扫描/)
ok('roots 为空：零扫描 + 引导去配置 roots（不默认扫全盘）')

// ── 7) 夹具扫描：六种信号 + 三查分层 ──
const before1 = snapshot(fixture)
const fixtureScan = await call('asset_scan', { roots: [fixture], minAgeDays: 30, maxRows: 200 })
const after1 = snapshot(fixture)
const scan = fixtureScan.value

assert.ok(scan.scannedFiles >= 16, '应扫到 16 个以上文件，实际 ' + scan.scannedFiles)
assert.deepEqual(before1, after1, '扫描前后文件数/目录数/字节数必须完全相同（只读）')
ok('只读证明：扫描前后 ' + before1.files + ' 文件 / ' + before1.bytes + ' 字节 完全一致')

const itemOf = (suffix) => scan.items.find((item) => item.path.toLowerCase().endsWith(suffix.toLowerCase()))
const required = {
  'empty-old': 'empty-dir',
  'zero.dat': 'zero-byte',
  'run.tmp': 'temp-artifact',
  'archive.7z.001': 'split-residue',
  'report - copy.docx': 'replica-name',
  'photo (1).jpg': 'replica-name',
  'draft final_v2.txt': 'replica-name',
  'plan 最终版.md': 'replica-name',
  'dup-b.txt': 'duplicate',
}
for (const [name, signal] of Object.entries(required)) {
  const item = itemOf(name)
  assert.ok(item, name + ' 应命中候选')
  assert.equal(item.signal, signal, name + ' 信号应为 ' + signal)
  assert.ok(item.reason.length > 10, name + ' 必须带理由，不许只有结论')
  assert.ok(item.reason.includes('·'), name + ' 理由应含三查结论')
  assert.ok(['tracked', 'untracked', 'unknown'].includes(item.gitTracked), name + ' gitTracked 取值非法')
  assert.ok(Number.isInteger(item.size) && Number.isInteger(item.ageDays), name + ' size/ageDays 应为整数')
}
assert.equal(scan.items.filter((item) => item.signal === 'duplicate').length, 1, '重复只留一个非保留份（保留 dup-a，候选 dup-b）')
assert.equal(itemOf('dup-a.txt'), undefined, '保留份（路径更短/更旧）不应进候选')
ok('六种信号全部命中：empty-dir / zero-byte / temp-artifact / duplicate / split-residue / replica-name')

// 未在 git 仓库内：可达性 unknown，只能是 doubt（绝不 SAFE）
assert.equal(scan.counts.safe, 0, '非 git 目录不允许出 SAFE（可达性 unknown）')
assert.ok(scan.counts.doubt > 0)
assert.match(itemOf('zero.dat').reason, /unknown/)
assert.equal(itemOf('archive.7z.001').layer, 'doubt', '已有合并主文件 → 只缺可达性 → 存疑')
assert.equal(itemOf('run.tmp').layer, 'doubt')
ok('非 git 目录：全部存疑（reason 写明 unknown），SAFE = 0')

// 唯一副本风险 → ask，只列出不建议删
assert.equal(itemOf('vol.r00').layer, 'ask')
assert.equal(itemOf('vol.r01').layer, 'ask')
assert.match(itemOf('vol.r00').reason, /唯一副本/)
assert.equal(itemOf('lonely 副本.txt').layer, 'ask')
assert.match(itemOf('lonely 副本.txt').reason, /唯一副本/)
ok('唯一副本风险（分卷无主文件 / 原文件已不在）→ 请旨，不出现 SAFE')

// 新鲜文件缺「过时」这一条 → doubt，理由写清缺哪条
assert.equal(itemOf('fresh.tmp').layer, 'doubt')
assert.match(itemOf('fresh.tmp').reason, /缺/)
assert.match(itemOf('fresh.tmp').reason, /过时/)
assert.equal(itemOf('empty-new').layer, 'doubt')
ok('未过时阈值：降层存疑，理由点名「缺 过时」')

assert.equal(scan.counts.safe + scan.counts.doubt + scan.counts.ask, scan.items.length, '计数应与候选行数一致')
assert.equal(scan.bytes.estimatedReclaim, scan.bytes.safeBytes)
assert.match(fixtureScan.text, /可清/)
assert.match(fixtureScan.text, /P0 只读/)
ok('返回值：计数自洽、render 说人话（可清/存疑/请旨 + P0 只读声明）')

// ── 8) 上限：maxRows / maxFiles / maxDepth ──
const limited = await call('asset_scan', { roots: [fixture], maxRows: 2, maxFiles: 5, minAgeDays: 30 })
assert.equal(limited.value.items.length, 2)
assert.equal(limited.value.truncated, true)
assert.ok(limited.value.scannedFiles <= 5, 'maxFiles 必须真的封顶')

const shallow = await call('asset_scan', { roots: [fixture], maxDepth: 0, minAgeDays: 30, maxRows: 200 })
assert.ok(!shallow.value.items.some((item) => item.path.toLowerCase().includes('empty-deep-old')), 'maxDepth=0 不许下潜')
assert.equal(shallow.value.truncated, true)
ok('上限生效：maxRows 截断 / maxFiles 封顶 / maxDepth 不下潜，且 truncated 如实置位')

// ── 9) 数据目录自扫排除 ──
const selfScan = await call('asset_scan', { roots: [ROOT], minAgeDays: 30, maxRows: 300 })
assert.ok(!selfScan.value.items.some((item) => item.path.toLowerCase().startsWith(STORE.toLowerCase())), '插件自己的数据目录不许进候选')
ok('插件自己的数据目录被排除，不会自扫自')

// ── 10) 红线：C:\Windows 与 D:\AI\dsh-bundles 整根 fail-closed ──
for (const root of ['C:\\Windows', 'D:\\AI\\dsh-bundles']) {
  const red = await call('asset_scan', { roots: [root], maxFiles: 500 })
  assert.ok(red.value.counts.protected > 0, root + ' 必须计入 protected')
  assert.equal(red.value.items.length, 0, root + ' 不许产出任何候选')
  assert.equal(red.value.scannedFiles, 0, root + ' 不许读进去')
  assert.match(red.value.errors[0].error, /红线/)
}
ok('红线真机验证：C:\\Windows 与 D:\\AI\\dsh-bundles → protected>0、items=0、scannedFiles=0')

// ── 11) 反例自检：把红线清单清空，同一个判定必须红 ──
const scanCore = await import(pathToFileURL(path.join(BUNDLE, 'lib', 'scan.js')).href)
const redCheck = (result) => {
  assert.ok(result.counts.protected > 0, '红线必须拦（protected > 0）')
  assert.equal(result.items.filter((item) => item.path.toLowerCase().startsWith('d:\\ai\\dsh-bundles')).length, 0, '红线内不许出候选')
}
// 正例来自第 10 步的真机结果；这里只验证「同一条判定在清空 guard 后必须红」
const realRed = await call('asset_scan', { roots: ['D:\\AI\\dsh-bundles'], maxFiles: 500 })
assert.doesNotThrow(() => redCheck(realRed.value))
const hollow = scanCore.scanAssets({ roots: ['D:\\AI\\dsh-bundles'], limits: { maxFiles: 200, maxDepth: 2, minAgeDays: 30, maxRows: 5 }, guard: [] })
assert.throws(() => redCheck(hollow), /红线必须拦/)
ok('反例自检：清空 guard 后同一判定必须报错（红线不是永远绿）')

// ── 12) 子目录红线（自定义 protectDirs）──
const redzone = path.join(ROOT, 'redzone')
mkdirSync(redzone, { recursive: true })
writeOld(path.join(redzone, 'junk.tmp'), 'x')
writeOld(path.join(redzone, 'zero.bin'), '')
const STORE_RED = path.join(ROOT, 'store-redzone')
const mockRed = makeMockContext()
mod.apply(mockRed.ctx, { storeDir: STORE_RED, protectDirs: [redzone] })
const redTool = mockRed.registered.find((definition) => definition.name === 'asset_scan')
assert.ok(redTool, '第二个实例也要挂上 asset_scan')
const redSubScan = await redTool.execute({ roots: [ROOT], minAgeDays: 30, maxRows: 300 })
assert.ok(redSubScan.counts.protected >= 1, '子目录红线必须计入 protected')
assert.equal(redSubScan.items.filter((item) => item.path.toLowerCase().startsWith(redzone.toLowerCase())).length, 0, '红线子目录里不许出候选')
ok('自定义 protectDirs：子目录命中红线即整棵跳过，counts.protected 增加')

// ── 13) git 可达性：SAFE 只在仓库内成立；被跟踪 → 存疑 ──
let gitReady = true
const repo = path.join(ROOT, 'repo')
mkdirSync(repo, { recursive: true })
try {
  execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true })
  writeFileSync(path.join(repo, 'keep.txt'), 'keep')
  execFileSync('git', ['-C', repo, 'add', 'keep.txt'], { windowsHide: true })
  writeOld(path.join(repo, 'stale.tmp'), 'junk-untracked')
  writeOld(path.join(repo, 'tracked.tmp'), 'junk-tracked')
  execFileSync('git', ['-C', repo, 'add', 'tracked.tmp'], { windowsHide: true })
  mkdirSync(path.join(repo, 'old-empty'))
  utimesSync(path.join(repo, 'old-empty'), OLD, OLD)
} catch {
  gitReady = false
}
if (gitReady) {
  const indexFile = path.join(repo, '.git', 'index')
  const indexBefore = statSync(indexFile).mtimeMs
  const repoScan = await call('asset_scan', { roots: [repo], minAgeDays: 30, maxRows: 50 })
  const indexAfter = statSync(indexFile).mtimeMs
  const safeItem = repoScan.value.items.find((item) => item.path.endsWith('stale.tmp'))
  assert.ok(safeItem, 'git 仓库内未跟踪的过期 .tmp 应进候选')
  assert.equal(safeItem.layer, 'SAFE', '过时 + git 未跟踪 + 无价值 → SAFE')
  assert.equal(safeItem.gitTracked, 'untracked')
  assert.ok(repoScan.value.bytes.safeBytes > 0)
  const trackedItem = repoScan.value.items.find((item) => item.path.endsWith('tracked.tmp'))
  assert.equal(trackedItem.layer, 'doubt', '仍被 git 跟踪 → 缺「以后无用」→ 存疑')
  assert.equal(trackedItem.gitTracked, 'tracked')
  assert.match(trackedItem.reason, /仍被跟踪|缺/)
  const emptyItem = repoScan.value.items.find((item) => item.path.endsWith('old-empty'))
  assert.equal(emptyItem.layer, 'SAFE', '仓库内过期空目录 → SAFE')
  assert.equal(indexBefore, indexAfter, 'git ls-files 不许写 .git/index（GIT_OPTIONAL_LOCKS=0）')
  ok('git 可达性：未跟踪过期物 = SAFE（' + repoScan.value.bytes.safeBytes + ' 字节）；被跟踪 = 存疑；.git/index 未被写')
} else {
  ok('git 不可用：跳过 SAFE 用例（该维度必须记 unknown）')
}

// ── 14) 数据目录不可写：不崩，扫描照常，lastError 记下来 ──
const blocker = path.join(ROOT, 'blocker')
writeFileSync(blocker, 'not-a-dir')
const STORE_BAD = path.join(blocker, 'sub')
const mockBad = makeMockContext()
mod.apply(mockBad.ctx, { storeDir: STORE_BAD })
const badScan = mockBad.registered.find((definition) => definition.name === 'asset_scan')
const badStatus = mockBad.registered.find((definition) => definition.name === 'asset_status')
const badResult = await badScan.execute({ roots: [fixture], minAgeDays: 30 })
assert.ok(badResult.scannedFiles > 0, '数据目录坏了也必须完成扫描')
assert.ok(badResult.items.length > 0)
const badStatusValue = await badStatus.execute({})
assert.equal(badStatusValue.ready, false)
assert.ok(badStatusValue.unavailableReason.length > 0)
assert.match(badStatusValue.lastError, /写不进去/)
ok('数据目录不可写：扫描不崩、ready=false、lastError 记实（fail-safe）')

// ── 15) asset_status：首次 / 扫描后 ──
const STORE_STATUS = path.join(ROOT, 'store-status')
const mockStatus = makeMockContext()
mod.apply(mockStatus.ctx, { storeDir: STORE_STATUS })
const statusTool = mockStatus.registered.find((definition) => definition.name === 'asset_status')
const statusScan = mockStatus.registered.find((definition) => definition.name === 'asset_scan')
const fresh = await statusTool.execute({})
assert.equal(fresh.ready, true)
assert.equal(fresh.lastScanAt, '')
assert.equal(fresh.protectCount, guard.length, 'protectCount 必须等于默认红线数（与 dsh-butler-tidy 一致，不写死）')
assert.equal(fresh.storeDir, STORE_STATUS)
assert.equal(fresh.lastError, '')
assert.match(fresh.pathSafety, /path-safety/)
assert.ok(['available', 'unavailable'].includes(fresh.git))
assert.equal(statusTool.output.render({}, fresh)[0].type, 'text')

await statusScan.execute({ roots: [fixture], minAgeDays: 30 })
const after = await statusTool.execute({})
assert.ok(after.lastScanAt.length > 0, '扫描后应有上次扫描时间')
assert.ok(Number.isInteger(after.lastScanMs) && after.lastScanMs >= 0)
assert.deepEqual(after.lastScanRoots, [fixture])
assert.ok(existsSync(path.join(STORE_STATUS, 'last-scan.json')), 'last-scan.json 应落盘')
const statusText = statusTool.output.render({}, after)[0].text
assert.match(statusText, /上次扫描/)
assert.match(statusText, /红线目录/)
ok('asset_status：首次为空 → 扫描后报时间/耗时/根目录，诊断字段齐全')

console.log('\nnegative-asset: ' + passed + ' 组断言全部通过')
