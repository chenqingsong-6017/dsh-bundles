/**
 * dsh-butler-tidy 自测：用假 ctx 直接驱动插件工具，验证
 *   盘点 → 方案 → 执行 → 撤销 全链路，并检查红线拦截。
 * 不装进 profile，只在工作区跑。用法：node tidy-selftest.mjs
 */
import { existsSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = 'D:\\AI\\dsh-data\\tidy-selftest'
const DESK = path.join(ROOT, 'desk')
const STORE = path.join(ROOT, 'store')

const failures = []
const check = (label, ok, extra = '') => {
  if (ok) console.log(`  ✓ ${label}`)
  else {
    failures.push(`${label} ${extra}`)
    console.log(`  ✗ ${label} ${extra}`)
  }
}

function resetFixture() {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(DESK, { recursive: true })
  const samples = [
    ['2026-发票.pdf', 2048],
    ['合同.docx', 4096],
    ['账目.xlsx', 1024],
    ['照片.jpg', 8192],
    ['录屏.mp4', 65536],
    ['备份.zip', 4096],
    ['安装程序.exe', 12288],
    ['脚本.py', 512],
    ['readme.txt', 256],
    ['奇怪.zzz', 128],
    ['快捷方式.lnk', 64],
    ['desktop.ini', 32],
  ]
  for (const [name, size] of samples) {
    writeFileSync(path.join(DESK, name), Buffer.alloc(size, 7))
  }
  mkdirSync(path.join(DESK, '子目录'), { recursive: true })
  writeFileSync(path.join(DESK, '子目录', '深层.pdf'), Buffer.alloc(1024, 7))
}

function makeCtx(registered) {
  return {
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => {}
      },
    },
    effect(fn) {
      fn()
    },
    get() {
      return undefined
    },
    logger() {
      return { debug() {}, info() {}, warn() {}, error() {} }
    },
  }
}

resetFixture()

const registered = new Map()
const mod = await import('../dsh-butler-tidy/index.js')
mod.apply(makeCtx(registered), { storeDir: STORE })

for (const tool of ['tidy_scan', 'tidy_plan', 'tidy_apply', 'tidy_undo', 'tidy_status']) {
  check(`注册工具 ${tool}`, registered.has(tool))
}

const plan = registered.get('tidy_plan')
const applyTool = registered.get('tidy_apply')
const undo = registered.get('tidy_undo')
const scan = registered.get('tidy_scan')
const status = registered.get('tidy_status')

// ── 1. 方案：按类型分类 ───────────────────────────────────────────
const planResult = await plan.execute({ kind: 'organize', target: DESK, rule: 'by-type' }, {})
console.log('\n[方案 · 按类型]')
console.log(plan.output.render({}, planResult)[0].text)
check('方案识别出 10 个待整理文件（跳过 .lnk 与 desktop.ini）', planResult.totalFiles === 10, `实际 ${planResult.totalFiles}`)
check('不递归时子目录文件不入列', planResult.preview.every((row) => !row.name.includes('子目录')))
check('分类含 文档/表格/图片/视频/压缩包/安装包/代码/其他', planResult.groups.length >= 6, `实际 ${planResult.groups.length}`)

// ── 2. 计划阶段不动文件 ─────────────────────────────────────────
check('方案阶段未移动任何文件', existsSync(path.join(DESK, '2026-发票.pdf')))

// ── 3. 未确认时拒绝执行 ─────────────────────────────────────────
const refused = await applyTool.execute({ kind: 'organize', target: DESK, confirm: false }, {})
check('无 confirm 时拒绝执行', refused.applied === false && refused.moved === 0)

// ── 4. 执行整理 ────────────────────────────────────────────────
const applied = await applyTool.execute({ kind: 'organize', target: DESK, rule: 'by-type', confirm: true }, {})
console.log('\n[执行 · 整理]')
console.log(applyTool.output.render({}, applied)[0].text)
check('移动 10 个文件', applied.moved === 10, `实际 ${applied.moved}`)
check('生成撤销清单', applied.manifest !== '' && existsSync(applied.manifest))
check('发票进了 Documents', existsSync(path.join(DESK, 'Documents', '2026-发票.pdf')))
check('图片进了 Images', existsSync(path.join(DESK, 'Images', '照片.jpg')))
check('未知后缀进了 Misc', existsSync(path.join(DESK, 'Misc', '奇怪.zzz')))
check('快捷方式留在原地', existsSync(path.join(DESK, '快捷方式.lnk')))
check('子目录未被递归搬走', existsSync(path.join(DESK, '子目录', '深层.pdf')))

// ── 5. 按日期规则（对子目录内文件）──────────────────────────────
const datePlan = await plan.execute({ kind: 'organize', target: DESK, rule: 'by-date', subfolders: true }, {})
check('按日期规则能出月份分组', datePlan.groups.every((group) => /^\d{4}-\d{2}$/.test(group.label) || group.label === '未知日期'))

// ── 6. 撤销 ───────────────────────────────────────────────────
const undone = await undo.execute({ confirm: true }, {})
console.log('\n[执行 · 撤销]')
console.log(undo.output.render({}, undone)[0].text)
check('撤销还原 10 个文件', undone.restored === 10, `实际 ${undone.restored}`)
check('发票回到原位', existsSync(path.join(DESK, '2026-发票.pdf')))
check('Documents 文件夹已空', !existsSync(path.join(DESK, 'Documents', '2026-发票.pdf')))

// ── 7. 红线拦截 ───────────────────────────────────────────────
const blocked = await plan.execute({ kind: 'organize', target: 'C:\\Windows\\Temp', rule: 'by-type' }, {})
check('红线目录被拒', blocked.totalFiles === 0 && blocked.hint.includes('红线'))
const blockedRoot = await plan.execute({ kind: 'organize', target: 'C:\\', rule: 'by-type' }, {})
check('C 盘根目录被拒', blockedRoot.totalFiles === 0 && blockedRoot.hint.includes('系统盘'))

// ── 8. 盘点（只读）────────────────────────────────────────────
const scanResult = await scan.execute({ drive: 'both' }, {})
console.log('\n[盘点]')
console.log(scan.output.render({}, scanResult)[0].text)
check('盘点了 C/D 两个盘', scanResult.drives.length === 2)
check('盘点给出可清空间字段', Number.isInteger(scanResult.cleanableBytes))

// ── 9. 诊断 ──────────────────────────────────────────────────
const statusResult = await status.execute({}, {})
console.log('\n[诊断]')
console.log(status.output.render({}, statusResult)[0].text)
check('诊断报告记录数', statusResult.manifests >= 1)
check('诊断报告红线目录数', statusResult.protectCount >= 8)

// ── 10. 清理只碰白名单（用临时伪造目录验证策略映射）──────────────
const cleanPlan = await plan.execute({ kind: 'clean' }, {})
check('清理方案默认只含安全项', cleanPlan.groups.every((group) => group.folder === '可清'), JSON.stringify(cleanPlan.groups.map((g) => g.folder)))

// ── 11. 目录归并 ─────────────────────────────────────────────
mkdirSync(path.join(DESK, 'old-app'), { recursive: true })
writeFileSync(path.join(DESK, 'old-app', 'a.txt'), Buffer.alloc(100, 7))
mkdirSync(path.join(DESK, 'cache-dir'), { recursive: true })
writeFileSync(path.join(DESK, 'cache-dir', 'b.bin'), Buffer.alloc(200, 7))
const archive = path.join(ROOT, 'archive')
mkdirSync(archive, { recursive: true })

const foldersPlan = await plan.execute({ kind: 'folders', target: DESK }, {})
console.log('\n[方案 · 目录归并]')
console.log(plan.output.render({}, foldersPlan)[0].text)
check('目录归并列出了子目录', foldersPlan.candidates.some((row) => row.name === 'old-app'))

const foldersApplied = await applyTool.execute(
  { kind: 'folders', confirm: true, items: [{ from: path.join(DESK, 'old-app'), into: archive }] },
  {},
)
console.log('\n[执行 · 目录归并]')
console.log(applyTool.output.render({}, foldersApplied)[0].text)
check('目录归并成功', foldersApplied.moved === 1 && existsSync(path.join(archive, 'old-app', 'a.txt')))
check('原位置已空', !existsSync(path.join(DESK, 'old-app')))

const foldersUndo = await undo.execute({ confirm: true }, {})
check('目录归并可撤销', foldersUndo.restored === 1 && existsSync(path.join(DESK, 'old-app', 'a.txt')))

// ── 12. 改名（中文名 → 英文名）────────────────────────────────
const cnFile = path.join(DESK, '中文名.pdf')
writeFileSync(cnFile, Buffer.alloc(64, 7))

const renamePlan = await plan.execute({ kind: 'rename', renames: [{ path: cnFile, name: 'chinese-name' }] }, {})
console.log('\n[方案 · 改名]')
console.log(plan.output.render({}, renamePlan)[0].text)
check('改名预览保留原扩展名', renamePlan.renames[0].to === 'chinese-name.pdf')

const badRename = await plan.execute({ kind: 'rename', renames: [{ path: cnFile, name: 'a/b' }] }, {})
check('改名拒绝带路径的名字', badRename.renames[0].ok === false)

const renameRefused = await applyTool.execute({ kind: 'rename', confirm: false, renames: [{ path: cnFile, name: 'chinese-name' }] }, {})
check('改名无 confirm 拒绝执行', renameRefused.applied === false)

const renameApplied = await applyTool.execute(
  { kind: 'rename', confirm: true, renames: [{ path: cnFile, name: 'chinese-name' }] },
  {},
)
console.log('\n[执行 · 改名]')
console.log(applyTool.output.render({}, renameApplied)[0].text)
check('改名成功', renameApplied.moved === 1 && existsSync(path.join(DESK, 'chinese-name.pdf')))

const renameUndo = await undo.execute({ confirm: true }, {})
check('改名可撤销', renameUndo.restored === 1 && existsSync(cnFile))

const finalStatus = await status.execute({}, {})
check('诊断能同时看到三类清单', finalStatus.manifests >= 3, `实际 ${finalStatus.manifests}`)

// ── 13. 目录改名 ─────────────────────────────────────────────
const cnDir = path.join(DESK, '中文目录')
mkdirSync(cnDir, { recursive: true })
writeFileSync(path.join(cnDir, 'x.txt'), Buffer.alloc(10, 7))
const dirRenamePlan = await plan.execute({ kind: 'rename', renames: [{ path: cnDir, name: 'chinese-folder' }] }, {})
check('目录改名预览不给目录补扩展名', dirRenamePlan.renames[0].to === 'chinese-folder')
const dirRenameApplied = await applyTool.execute(
  { kind: 'rename', confirm: true, renames: [{ path: cnDir, name: 'chinese-folder' }] },
  {},
)
check('目录改名成功', dirRenameApplied.moved === 1 && existsSync(path.join(DESK, 'chinese-folder', 'x.txt')))
const dirRenameUndo = await undo.execute({ confirm: true }, {})
check('目录改名可撤销', dirRenameUndo.restored === 1 && existsSync(path.join(cnDir, 'x.txt')))

// ── 14. 空目录清理 ───────────────────────────────────────────
const emptyRoot = path.join(ROOT, 'emptytest')
mkdirSync(path.join(emptyRoot, 'a', 'b'), { recursive: true })
mkdirSync(path.join(emptyRoot, 'c'), { recursive: true })
writeFileSync(path.join(emptyRoot, 'keep.txt'), 'x')

const emptyPlan = await plan.execute({ kind: 'empty', target: emptyRoot }, {})
console.log('\n[方案 · 空目录]')
console.log(plan.output.render({}, emptyPlan)[0].text)
check('识别出空目录', emptyPlan.totalFiles >= 2, `实际 ${emptyPlan.totalFiles}`)
const emptyRefused = await applyTool.execute({ kind: 'empty', target: emptyRoot, confirm: false }, {})
check('空目录删除无 confirm 拒绝', emptyRefused.applied === false)
const emptyApplied = await applyTool.execute({ kind: 'empty', target: emptyRoot, confirm: true }, {})
check('空目录已删除', emptyApplied.moved >= 2 && !existsSync(path.join(emptyRoot, 'a')))
check('非空文件保留', existsSync(path.join(emptyRoot, 'keep.txt')))

// ── 15. 重复文件检测 ─────────────────────────────────────────
const dupeRoot = path.join(ROOT, 'dupetest')
mkdirSync(dupeRoot, { recursive: true })
const payload = Buffer.alloc(8192, 42)
writeFileSync(path.join(dupeRoot, 'copy-1.bin'), payload)
writeFileSync(path.join(dupeRoot, 'copy-2.bin'), payload)
writeFileSync(path.join(dupeRoot, 'different.bin'), Buffer.alloc(8192, 7))

const dupePlan = await plan.execute({ kind: 'dupes', target: dupeRoot }, {})
console.log('\n[方案 · 查重]')
console.log(plan.output.render({}, dupePlan)[0].text)
check('发现 1 组重复', dupePlan.dupeGroups.length === 1, `实际 ${dupePlan.dupeGroups.length}`)
check('重复组含 2 个文件', dupePlan.dupeGroups[0]?.files.length === 2)
check('回收空间算得对', dupePlan.totalBytes === 8192, `实际 ${dupePlan.totalBytes}`)

const dupeApply = await applyTool.execute({ kind: 'dupes', target: dupeRoot, confirm: true }, {})
console.log('\n[执行 · 查重隔离]')
console.log(applyTool.output.render({}, dupeApply)[0].text)
check('隔离 1 份副本', dupeApply.moved === 1, `实际 ${dupeApply.moved}`)
check('原地只剩 1 份', readdirSync(dupeRoot).filter((name) => name.startsWith('copy-')).length === 1)
const dupeUndo = await undo.execute({ confirm: true }, {})
check(
  '隔离可撤销（副本回来了）',
  dupeUndo.restored === 1 && readdirSync(dupeRoot).filter((name) => name.startsWith('copy-')).length === 2,
)

rmSync(ROOT, { recursive: true, force: true })

console.log(`\n结果：${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`}`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
}
