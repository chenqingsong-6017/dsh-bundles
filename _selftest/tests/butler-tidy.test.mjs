/**
 * dsh-butler-tidy 测试：结构冒烟 + 安装 / 卸载台账行为。
 *
 * 为什么行为测试放这里：index.js 不导出内部函数，但 apply() 会把工具定义交给 ctx，
 * 所以可以 mock 一个 ctx 拿到工具，按真实 execute 驱动四个台账工具（不装进 profile）。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { makeMockContext, runSmoke } from '../plugin-smoke.mjs'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log('  ✓ ' + label)
}

// ── 1) 结构合规 + apply 能挂载
await runSmoke('dsh-butler-tidy')
ok('结构合规、apply 可挂载')

// ── 2) 挂假 ctx，拿九个工具的真实定义
const BUNDLE = 'D:\\AI\\dsh-bundles\\dsh-butler-tidy'
const DATA_ROOT = existsSync('D:\\AI\\dsh-data') ? 'D:\\AI\\dsh-data' : os.tmpdir()
const ROOT = mkdtempSync(path.join(DATA_ROOT, 'tidy-inv-test-'))
const STORE = path.join(ROOT, 'store')

const mod = await import(pathToFileURL(path.join(BUNDLE, 'index.js')).href + '?t=' + Date.now())
const { ctx, registered } = makeMockContext()
mod.apply(ctx, { storeDir: STORE })
const tools = new Map(registered.map((definition) => [definition.name, definition]))

const toolOf = (name) => {
  const definition = tools.get(name)
  assert.ok(definition, '缺工具 ' + name)
  return definition
}

/** 按 output.schema 严格核对返回值：required 齐、无多余字段、类型对 */
function assertSchema(schema, value, at) {
  if (schema.type === 'object') {
    assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), at + ' 应为对象')
    for (const key of schema.required || []) assert.ok(Object.hasOwn(value, key), at + ' 缺字段 ' + key)
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        assert.ok(Object.hasOwn(schema.properties || {}, key), at + ' 多出字段 ' + key)
      }
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

/** 跑一个工具：execute → 核对 schema → render 必须给出文本块 */
async function call(name, args) {
  const definition = toolOf(name)
  const value = await definition.execute(args)
  assertSchema(definition.output.schema, value, name)
  const rendered = definition.output.render(args, value)
  assert.ok(Array.isArray(rendered) && rendered.length > 0, name + ' render 应返回数组')
  for (const block of rendered) {
    assert.equal(block && block.type, 'text', name + ' render 块应为 text')
    assert.equal(typeof block.text, 'string', name + ' render text 应为字符串')
  }
  return { value, text: rendered[0].text }
}

const appDir = path.join(ROOT, 'fake-app')
const dataDir = path.join(ROOT, 'fake-app-data')
const secondDir = path.join(ROOT, 'second-app')
const storeFile = path.join(STORE, 'inventory.json')
const mdFile = path.join(STORE, 'inventory.md')
const readLedger = () => JSON.parse(readFileSync(storeFile, 'utf8'))
const readMd = () => readFileSync(mdFile, 'utf8')

try {
  // ── 3) 空台账
  const empty = await call('inventory_list', {})
  assert.equal(empty.value.total, 0)
  assert.equal(empty.value.entries.length, 0)
  assert.match(empty.value.hint, /inventory_add/)
  assert.match(empty.text, /台账还是空的/)
  ok('空台账：条目 0，提示如何登记第一条')

  // ── 4) add → list 往返
  mkdirSync(appDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(secondDir, { recursive: true })
  writeFileSync(path.join(appDir, 'app.exe'), Buffer.alloc(2048, 7))
  writeFileSync(path.join(dataDir, 'cfg.ini'), Buffer.alloc(512, 7))

  const added = await call('inventory_add', {
    name: '测试应用',
    kind: 'portable',
    path: appDir,
    version: '1.2.3',
    source: '自测',
    dataDirs: [dataDir],
    notes: '台账单测',
    scanRefs: false,
  })
  assert.equal(added.value.ok, true)
  assert.equal(added.value.created, true)
  assert.equal(added.value.id, 'inv-0001')
  assert.equal(added.value.entry.kind, 'portable')
  assert.deepEqual(added.value.entry.dataDirs, [dataDir])
  assert.equal(added.value.entry.status, 'active')
  assert.equal(added.value.refsScanned, false)

  const ledger1 = readLedger()
  assert.equal(ledger1.version, 1)
  assert.equal(ledger1.nextId, 2)
  assert.equal(ledger1.entries.length, 1)
  assert.equal(ledger1.entries[0].id, 'inv-0001')
  assert.ok(existsSync(mdFile), '应生成 inventory.md')
  assert.match(readMd(), /测试应用/)
  assert.match(readMd(), /便携版/)
  assert.equal(readdirSync(STORE).filter((name) => name.includes('.tmp-')).length, 0)
  ok('inventory_add：原子写台账 + 重生成 md，编号 inv-0001')

  const second = await call('inventory_add', {
    name: '第二个应用',
    kind: 'installer',
    path: secondDir,
    scanRefs: false,
  })
  assert.equal(second.value.created, true)
  assert.equal(second.value.id, 'inv-0002')
  ok('inventory_add：编号递增 inv-0002')

  const updated = await call('inventory_add', {
    name: '测试应用',
    kind: 'portable',
    path: appDir,
    version: '1.3.0',
    scanRefs: false,
  })
  assert.equal(updated.value.created, false, '同名再登记应为更新')
  assert.equal(updated.value.id, 'inv-0001')
  assert.equal(updated.value.entry.version, '1.3.0')
  assert.equal(readLedger().entries.length, 2)
  ok('inventory_add：同名再登记变更新，不新增条目')

  const listed = await call('inventory_list', {})
  assert.equal(listed.value.total, 2)
  assert.equal(listed.value.activeCount, 2)
  assert.equal(listed.value.removedCount, 0)
  assert.equal(listed.value.entries.length, 2)
  assert.ok(listed.value.storeBytes >= 0)
  const installers = await call('inventory_list', { kind: 'installer' })
  assert.equal(installers.value.total, 1)
  assert.equal(installers.value.entries[0].name, '第二个应用')
  ok('inventory_list：总数 / 状态统计 / 类型过滤')

  // ── 5) plan_uninstall 只读且给引用清单
  const beforePlan = readFileSync(storeFile, 'utf8')
  const plan = await call('plan_uninstall', { name: '测试应用' })
  assert.equal(plan.value.found, true)
  assert.equal(plan.value.entry.id, 'inv-0001')
  assert.equal(plan.value.removesNothing, true)
  assert.match(plan.value.notice, /只读/)
  assert.equal(plan.value.targetExists, true)
  assert.equal(plan.value.targetBytes, 2048)
  for (const field of ['services', 'startup', 'tasks', 'shortcuts', 'pathEntries', 'registryKeys']) {
    assert.ok(Array.isArray(plan.value.refs[field]), 'refs 缺 ' + field)
  }
  assert.equal(plan.value.dataDirs.length, 1)
  assert.equal(plan.value.dataDirs[0].exists, true)
  assert.equal(plan.value.dataBytes, 512)
  assert.ok(plan.value.steps.length >= 2, '应给出建议步骤')
  assert.ok(existsSync(appDir), 'plan_uninstall 不允许删目标目录')
  assert.equal(readFileSync(storeFile, 'utf8'), beforePlan, 'plan_uninstall 不允许改台账')
  ok('plan_uninstall：只读预演，六类引用 + 体积 + 步骤，目标与台账均未动')

  // ── 6) inventory_check 识别失联 + 引用残留
  // 手工补一条「路径没了、但登记时记录着服务引用」的条目，验证「引用残留」分类（不碰真实注册表）
  const deadPath = path.join(ROOT, 'gone-app')
  const ledgerNow = readLedger()
  ledgerNow.entries.push({
    id: 'inv-0003',
    name: '已消失的应用',
    kind: 'installer',
    path: deadPath,
    version: '',
    source: '',
    uninstallCmd: '',
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    dataDirs: [],
    refs: {
      services: [{ name: '残留服务甲', detail: 'C:\\Nowhere\\svc.exe' }],
      startup: [],
      tasks: [],
      shortcuts: [],
      pathEntries: [],
      registryKeys: [],
    },
    notes: '',
    status: 'active',
    removedAt: '',
    stale: false,
  })
  ledgerNow.nextId = 4
  writeFileSync(storeFile, JSON.stringify(ledgerNow, null, 2), 'utf8')

  const checked = await call('inventory_check', { scanRefs: false })
  assert.equal(checked.value.checked, 3)
  assert.equal(checked.value.missingCount, 1)
  assert.equal(checked.value.residueCount, 1)
  assert.equal(checked.value.okCount, 2)
  const missingRow = checked.value.missing.find((item) => item.name === '已消失的应用')
  assert.ok(missingRow, '应报出「记录有但已不在」')
  assert.match(missingRow.detail, /引用残留/)
  assert.equal(checked.value.residue[0].refKind, '服务')
  assert.equal(checked.value.staleMarked, 1)
  assert.equal(readLedger().entries.find((item) => item.id === 'inv-0003').stale, true)
  ok('inventory_check：分出「记录有但已不在 / 引用残留 / 正常」并标 stale')

  // 真删测试应用的目录后，复核应识别失联；确认干净后 markRemoved 收进历史
  rmSync(appDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
  const missing = await call('inventory_check', { name: '测试应用', scanRefs: false })
  assert.equal(missing.value.missingCount, 1)
  assert.match(missing.value.missing[0].detail, /数据目录都已不在/)
  const removed = await call('inventory_check', { name: '测试应用', scanRefs: false, markRemoved: true })
  assert.equal(removed.value.removedMarked, 1)
  const removedEntry = readLedger().entries.find((item) => item.id === 'inv-0001')
  assert.equal(removedEntry.status, 'removed')
  assert.ok(removedEntry.removedAt)
  assert.doesNotThrow(() => JSON.parse(readFileSync(storeFile, 'utf8')))
  ok('inventory_check：删目录后识别失联，markRemoved 进历史（记录不删）')

  // ── 7) 台账写坏时不覆盖原文件
  const broken = '{ 这不是 JSON'
  writeFileSync(storeFile, broken, 'utf8')
  const brokenAdd = await call('inventory_add', { name: '新应用', kind: 'portable', path: secondDir })
  assert.equal(brokenAdd.value.ok, false)
  assert.match(brokenAdd.value.error, /解析失败/)
  assert.match(brokenAdd.value.hint, /inventory\.json/)
  assert.equal(readFileSync(storeFile, 'utf8'), broken, '解析失败时不允许覆盖原文件')
  const brokenCheck = await call('inventory_check', {})
  assert.match(brokenCheck.value.error, /解析失败/)
  assert.equal(readFileSync(storeFile, 'utf8'), broken)
  ok('台账写坏：报错给路径，原文件一字未动')

  // ── 8) tidy_status 台账统计
  writeFileSync(storeFile, JSON.stringify(ledgerNow, null, 2), 'utf8')
  await call('inventory_check', { name: '测试应用', scanRefs: false, markRemoved: true })
  const status = await call('tidy_status', {})
  const ledgerFinal = readLedger()
  const activeCount = ledgerFinal.entries.filter((item) => item.status !== 'removed').length
  assert.equal(status.value.inventoryEntries, ledgerFinal.entries.length)
  assert.equal(status.value.inventoryActive, activeCount)
  assert.equal(status.value.inventoryRemoved, ledgerFinal.entries.length - activeCount)
  assert.equal(status.value.inventoryStale, ledgerFinal.entries.filter((item) => item.stale).length)
  assert.match(status.text, /台账：/)
  ok('tidy_status：台账统计（条目 / 在用 / 已卸载 / 待核对）')

  const allList = await call('inventory_list', { status: 'all' })
  assert.equal(allList.value.total, 3)
  assert.ok(allList.value.removedCount >= 1)
  ok('inventory_list：status=all 能看到历史条目')

  // ── 9) 危险动作锁回归（2026-11-03 全局审计 T1 confirm 击穿 / T2 红线绕过）
  // 9.1 confirm 必须是严格布尔 true：字符串 "false"/"true"、数字 1/0、对象一律视为「未确认」
  const sandbox = path.join(ROOT, 'tidy-lock')
  mkdirSync(sandbox, { recursive: true })
  writeFileSync(path.join(sandbox, 'a.txt'), 'a')
  writeFileSync(path.join(sandbox, 'b.pdf'), 'b')
  const beforeLock = readdirSync(sandbox).sort()
  for (const confirm of ['false', 'true', 1, 0, 'no', {}, null]) {
    const attempt = await call('tidy_apply', { kind: 'organize', target: sandbox, confirm })
    assert.equal(attempt.value.code, 'CONFIRM_REQUIRED', `confirm=${JSON.stringify(confirm)} 必须被拒绝`)
    assert.equal(attempt.value.moved, 0, `confirm=${JSON.stringify(confirm)} 不得移动任何文件`)
  }
  assert.deepEqual(readdirSync(sandbox).sort(), beforeLock, '非布尔 confirm 不得改动沙箱文件')
  ok('tidy_apply：confirm 只认布尔 true（"false"/"true"/1/0/{}/null 全部拒，文件未动）')

  // tidy_undo 同一缺陷：写一份假清单，confirm 非布尔时必须拒绝且不还原
  const manifestsDir = path.join(STORE, 'manifests')
  mkdirSync(manifestsDir, { recursive: true })
  const fakeManifest = 'organize-20260101-000000-000.json'
  writeFileSync(path.join(manifestsDir, fakeManifest), JSON.stringify({ at: new Date().toISOString(), moves: [] }), 'utf8')
  for (const confirm of ['false', 1, 'true']) {
    const undo = await call('tidy_undo', { manifest: fakeManifest, confirm })
    assert.equal(undo.value.code, 'CONFIRM_REQUIRED', `tidy_undo confirm=${JSON.stringify(confirm)} 必须被拒绝`)
    assert.equal(undo.value.restored, 0)
  }
  ok('tidy_undo：confirm 只认布尔 true（字符串/数字一律拒，未执行还原）')

  // 9.2 红线路径三种写法：junction / \\?\ 设备前缀 / \\localhost\D$ 管理共享
  const REDLINE = 'D:\\AI\\dsh-bundles\\dsh-checkpoint'
  const link = path.join(ROOT, 'redline-link')
  let linkCreated = false
  try {
    execFileSync('cmd', ['/c', 'mklink', '/J', link, REDLINE], { windowsHide: true, stdio: 'ignore' })
    linkCreated = true
    const jumped = await call('tidy_plan', { kind: 'organize', target: link })
    assert.equal(jumped.value.code, 'TARGET_REJECTED', 'junction 指向红线时 tidy_plan 必须拒绝出方案')
    assert.match(jumped.value.hint, /junction|符号链接|重解析点|红线/)

    const jumpedScan = await call('tidy_scan', { path: link })
    assert.equal(jumpedScan.value.inspect.verdict, 'forbidden', 'junction 指向红线时 tidy_scan 必须给「勿动」')
    ok('红线绕过 #1 junction：tidy_plan 拒绝出方案、tidy_scan 结论「勿动」')
  } finally {
    if (linkCreated) {
      // 只删链接本身，不跟随目标（本仓规矩：junction 一律 cmd /c rmdir）
      try {
        execFileSync('cmd', ['/c', 'rmdir', link], { windowsHide: true, stdio: 'ignore' })
      } catch {
        /* 断言失败时也要保证清掉链接 */
      }
    }
  }

  const devicePlan = await call('tidy_plan', { kind: 'organize', target: '\\\\?\\' + sandbox })
  assert.equal(devicePlan.value.code, 'TARGET_REJECTED', '\\\\?\\ 设备路径必须被拒绝')
  assert.match(devicePlan.value.hint, /不能安全判定/)
  ok('红线绕过 #2 \\\\?\\ 设备前缀：tidy_plan 直接拒（fail-closed）')

  const uncTarget = '\\\\localhost\\D$' + sandbox.slice(2)
  if (existsSync(uncTarget)) {
    const uncPlan = await call('tidy_plan', { kind: 'organize', target: uncTarget })
    assert.equal(uncPlan.value.code, 'TARGET_REJECTED', 'UNC 管理共享路径必须被拒绝')
    assert.match(uncPlan.value.hint, /不能安全判定/)
    ok('红线绕过 #3 \\\\localhost\\D$ 管理共享：tidy_plan 直接拒（fail-closed）')
  } else {
    console.log('  - 跳过 UNC 用例：本机访问不到 \\\\localhost\\D$')
  }

  // 反向保险：普通本地路径仍能正常出方案（别把红线修成「什么都不让动」）
  const normalPlan = await call('tidy_plan', { kind: 'organize', target: sandbox })
  assert.equal(normalPlan.value.code, undefined, '普通临时目录必须仍可出方案')
  assert.equal(normalPlan.value.totalFiles, 2)
  ok('反向保险：普通本地临时目录仍正常出方案（2 个文件）')
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}

console.log('butler-tidy: 结构合规 + 台账行为 ' + passed + ' 项通过')
