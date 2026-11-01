#!/usr/bin/env node
/**
 * 保留策略执行器 —— 让「过时的东西不留」变成一条命令，而不是靠记性。
 *
 * 用户规则（2026-10-30，硬规则）：删除三查——①是否过时 ②以后是否还有用 ③是否还有价值。
 * 三条全中才删，任何一条存疑就留。时长只是「拿出来重审」的筛子，不是删除理由。
 * 唯一例外：随时可重新获取的东西（可重下的 clone / 压缩包）价值天然为零，免三查。
 *
 * 用法：
 *   node cleanup.mjs                    # 只报告：分「免审可删」与「需三查」两段（默认，安全）
 *   node cleanup.mjs --apply            # 只删「免审可删」那一段；需三查的一项都不动
 *   node cleanup.mjs --only 2           # 删需三查清单里的第 2 项（你点头之后才用）
 *   node cleanup.mjs --only <路径片段>  # 同上，按路径片段指定
 *
 * 为什么这么设计：一条命令全删等于跳过三查。所以 --apply 只覆盖「删了也能立刻重拿」的部分，
 * 需要判断的那部分永远要人（或 agent 拿着三查表问过用户）逐条点名。
 *
 * 红线：D:\AI-date\workbuddy-date\学习 是用户的学习资料仓库，永不触碰。
 */
import { existsSync, readdirSync, statSync, rmSync, lstatSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const DAY = 24 * 60 * 60 * 1000
const now = Date.now()

/** 阈值：照下面注释改，别在调用处改 */
const CLONE_DAYS = 1        // updater 学习台 clone 超过 1 天 → 候选（updater_study 可重下）
const IMAGE_DAYS = 3        // 工作区顶层过程截图超过 3 天 → 候选
const LOG_KEEP = 10         // 插件管理器日志留最近 10 次
const MEM_BAK_KEEP = 2      // 记忆自动备份留最近 2 份
const PROFILE_BAK_KEEP = 1  // profile 里每类 *.bak-* 留最近 1 份
const MIGRATION_BAK_DAYS = 3 // 迁移/改造前留的整目录备份（如 profiles.bak-*）超过 3 天 → 候选

/** 工作区：只清顶层的过程截图（.md 与源码一个不碰） */
const WORKSPACES = ['D:\\AI-date\\dsh-date\\dsh-创建']
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const PROTECT = ['workbuddy-date\\学习']

/** plan: { target, why, bytes, files, free, tri } */
const plan = []

function blocked(p) {
  return PROTECT.some((frag) => p.includes(frag))
}

function sizeOf(p) {
  try {
    const st = statSync(p)
    if (!st.isDirectory()) return { bytes: st.size, files: 1 }
  } catch {
    return { bytes: 0, files: 0 }
  }
  let bytes = 0
  let files = 0
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else {
        try {
          bytes += statSync(full).size
        } catch {}
        files += 1
      }
    }
  }
  walk(p)
  return { bytes, files }
}

/**
 * 登记一项。
 * free=true：因为「随时可重新获取」，价值天然为零，免三查，--apply 会删。
 * free=false：只进候选，三查表里要人点头。
 * hint：给三查表的提示（过时/有用/价值各一句），帮人判断，不代替判断。
 */
function add(target, why, free, hint) {
  if (blocked(target)) return
  if (!existsSync(target)) return
  const { bytes, files } = sizeOf(target)
  plan.push({ target, why, bytes, files, free: !!free, hint: hint || '' })
}

// ---- 规则 1：updater 学习台 clone（可重下 → 免审）----
const learnRoot = 'D:\\AI\\dsh-data\\updater\\learn'
if (existsSync(learnRoot)) {
  for (const e of readdirSync(learnRoot, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const full = path.join(learnRoot, e.name)
    let age = 0
    try {
      age = now - statSync(full).mtimeMs
    } catch {
      continue
    }
    if (age > CLONE_DAYS * DAY) {
      add(full, 'updater 学习台 clone（超过 ' + CLONE_DAYS + ' 天，updater_study 可重下）', true)
    }
  }
}

// ---- 规则 2：工作区顶层过程截图（需三查：可能被文档引用）----
for (const ws of WORKSPACES) {
  if (!existsSync(ws)) continue
  for (const e of readdirSync(ws, { withFileTypes: true })) {
    if (!e.isFile()) continue
    if (!IMAGE_EXT.has(path.extname(e.name).toLowerCase())) continue
    const full = path.join(ws, e.name)
    let age = 0
    try {
      age = now - statSync(full).mtimeMs
    } catch {
      continue
    }
    if (age > IMAGE_DAYS * DAY) {
      add(full, '工作区过程截图（超过 ' + IMAGE_DAYS + ' 天）', false, '截图多半是过程产物；但若某篇 md 还引用它，删了文档就断图')
    }
  }
}

// ---- 规则 3：插件管理器日志（需三查：排查时是唯一证据）----
const logRoot = 'C:\\Users\\cqs6017\\.dsh\\profiles\\desktop\\.plugin-manager\\logs'
if (existsSync(logRoot)) {
  const dirs = readdirSync(logRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
  for (const name of dirs.slice(0, Math.max(0, dirs.length - LOG_KEEP))) {
    add(path.join(logRoot, name), '插件管理器日志（只留最近 ' + LOG_KEEP + ' 次）', false, '出过一次装坏插件的故障后，这些日志就是唯一证据链')
  }
}

// ---- 规则 4：记忆自动备份（需三查：是回滚点）----
const memRoot = 'D:\\AI\\dsh-data\\memory'
if (existsSync(memRoot)) {
  const baks = readdirSync(memRoot)
    .filter((n) => n.startsWith('memory.json.bak'))
    .map((n) => path.join(memRoot, n))
    .map((p) => ({ p, m: statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  for (const b of baks.slice(MEM_BAK_KEEP)) {
    add(b.p, '记忆自动备份（只留最近 ' + MEM_BAK_KEEP + ' 份）', false, '记忆改坏时靠它回滚；最近 2 份已够，更早的一般可弃')
  }
}

// ---- 规则 5：profile 里的旧 .bak-*（需三查：配置回滚点）----
const pd = 'C:\\Users\\cqs6017\\.dsh\\profiles\\desktop'
if (existsSync(pd)) {
  const groups = new Map()
  for (const name of readdirSync(pd)) {
    const i = name.indexOf('.bak-')
    if (i < 0) continue
    const base = name.slice(0, i)
    const full = path.join(pd, name)
    if (!groups.has(base)) groups.set(base, [])
    groups.get(base).push({ p: full, m: statSync(full).mtimeMs })
  }
  for (const [, list] of groups) {
    list.sort((a, b) => b.m - a.m)
    for (const item of list.slice(PROFILE_BAK_KEEP)) {
      add(item.p, 'profile 旧备份（每类只留最近 ' + PROFILE_BAK_KEEP + ' 份）', false, '改配置前的回滚点；同类留 1 份即够')
    }
  }
}

// ---- 规则 6：tidy 的系统工具缓存 ----
// *.zip 是下载来的压缩包（解压后的工具已就位）→ 免审；.reg / .json / .txt 导出只对「改坏回滚」那几天有用 → 需三查。
const tidyTools = 'D:\\AI\\dsh-data\\tidy\\tools'
if (existsSync(tidyTools)) {
  const groups = new Map()
  for (const name of readdirSync(tidyTools)) {
    const full = path.join(tidyTools, name)
    if (name.toLowerCase().endsWith('.zip')) {
      add(full, 'tidy 下载的压缩包（解压后的工具已就位，可重下）', true)
      continue
    }
    const m = name.match(/^(.+?)-\d{8}-\d{6}\.(reg|json|txt)$/)
    if (!m) continue
    const key = m[1] + '.' + m[2]
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({ p: full, m: statSync(full).mtimeMs })
  }
  for (const [, list] of groups) {
    list.sort((a, b) => b.m - a.m)
    for (const item of list.slice(1)) {
      add(item.p, 'tidy 注册表/扫描导出（同类只留最新 1 份）', false, '改坏系统要回滚时才有用；同类的旧份基本没价值')
    }
  }
}

// ---- 规则 7：迁移/改造前留的整目录备份（需三查）----
const dshHome = 'C:\\Users\\cqs6017\\.dsh'
if (existsSync(dshHome)) {
  for (const name of readdirSync(dshHome)) {
    if (!name.includes('.bak')) continue
    const full = path.join(dshHome, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    if (now - st.mtimeMs > MIGRATION_BAK_DAYS * DAY) {
      add(full, '迁移/改造前的整目录备份（超过 ' + MIGRATION_BAK_DAYS + ' 天）', false, '迁移若还没验证稳定，这份是唯一退路')
    }
  }
}

// ---- 输出 ----
const freeItems = plan.filter((i) => i.free)
const reviewItems = plan.filter((i) => !i.free)

function mb(n) {
  return (n / 1024 / 1024).toFixed(1)
}

if (plan.length === 0) {
  console.log('cleanup: 没有该清的东西（保留策略全部满足）')
  process.exit(0)
}

if (freeItems.length > 0) {
  console.log('== A. 免审可删（随时可重新获取，价值天然为零）==')
  let b = 0
  let f = 0
  for (const i of freeItems) {
    b += i.bytes
    f += i.files
    console.log('· ' + i.target)
    console.log('    ' + mb(i.bytes) + ' MB / ' + i.files + ' 文件 —— ' + i.why)
  }
  console.log('  小计 ' + mb(b) + ' MB / ' + f + ' 文件，' + freeItems.length + ' 项')
  console.log('')
}

if (reviewItems.length > 0) {
  console.log('== B. 需三查（到点了，但要你点头；查完三条全中才删）==')
  console.log('')
  console.log('| # | 路径 | 体积 | 文件 | 成因 |')
  console.log('|---|---|---|---|---|')
  reviewItems.forEach((i, idx) => {
    console.log('| ' + (idx + 1) + ' | ' + i.target + ' | ' + mb(i.bytes) + ' MB | ' + i.files + ' | ' + i.why + ' |')
  })
  console.log('')
  console.log('三查提示（判断依据，不代替判断）：')
  reviewItems.forEach((i, idx) => {
    console.log('  ' + (idx + 1) + '. ' + i.target)
    console.log('     ① 过时？   ' + i.why)
    console.log('     ② 以后有用？ ' + (i.hint || '待判断'))
    console.log('     ③ 有价值？  若信息已进 md / git / 别处备份 → 无；否则留')
  })
  let b = 0
  let f = 0
  for (const i of reviewItems) {
    b += i.bytes
    f += i.files
  }
  console.log('')
  console.log('  小计 ' + mb(b) + ' MB / ' + f + ' 文件，' + reviewItems.length + ' 项')
  console.log('')
}

const totalBytes = plan.reduce((s, i) => s + i.bytes, 0)
const totalFiles = plan.reduce((s, i) => s + i.files, 0)
console.log('合计 ' + mb(totalBytes) + ' MB / ' + totalFiles + ' 文件，' + plan.length + ' 项（免审 ' + freeItems.length + ' / 需三查 ' + reviewItems.length + '）')

/** --only 选择要删的需三查项：支持 1-based 序号或路径片段，可重复 */
const onlyArgs = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--only' && argv[i + 1]) onlyArgs.push(argv[i + 1])
}
const approved = []
for (const sel of onlyArgs) {
  const asIdx = Number.parseInt(sel, 10)
  if (String(asIdx) === sel && asIdx >= 1 && asIdx <= reviewItems.length) {
    approved.push(reviewItems[asIdx - 1])
    continue
  }
  const hit = reviewItems.filter((i) => i.target.includes(sel))
  if (hit.length === 0) console.error('--only 没匹配到任何需三查项: ' + sel)
  approved.push(...hit)
}
const uniqApproved = [...new Set(approved)]

if (!APPLY) {
  console.log('')
  console.log('（dry-run：什么都没删）')
  console.log('  删 A 段（免审）：node cleanup.mjs --apply')
  console.log('  删 B 段（需先过三查）：node cleanup.mjs --apply --only <序号或路径片段>')
  process.exit(0)
}

const toDelete = [...freeItems, ...uniqApproved]
if (toDelete.length === 0) {
  console.log('')
  console.log('--apply 只删「免审可删」；本次没有这类项目，B 段需你逐条点名（--only）。')
  process.exit(0)
}

let failed = 0
let freed = 0

/**
 * 删除一项：目录 → `cmd /c rmdir /s /q <绝对路径>`，文件 → 非递归 rmSync。
 *
 * 为什么目录不用 Node 的 rmSync({ recursive: true })：目录里若含 junction / 符号链接，
 * 递归 API 可能顺着 reparse point 删到链接目标——插件仓源码正被 profile 里的 junction
 * 指着（AGENTS.md 的规定：删带 junction / 符号链接的目录，只用 cmd /c rmdir /s /q）。
 * rmdir 只处理目录项本身，不把链接目标当内容删。
 *
 * 返回 { ok, kind: 'dir' | 'file', error? }，让调用方区分「目录删失败」与「文件删失败」。
 */
function removeTarget(target) {
  let st
  try {
    st = lstatSync(target) // 用 lstat 判断这一项是目录还是文件（不跟随链接目标）
  } catch (error) {
    return { ok: false, kind: 'file', error }
  }
  if (!st.isDirectory()) {
    try {
      rmSync(target, { force: true }) // 非递归：只删文件；force 保留原来「不存在也不报错」的语义
      return { ok: true, kind: 'file' }
    } catch (error) {
      return { ok: false, kind: 'file', error }
    }
  }
  const res = spawnSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', path.resolve(target)], {
    windowsHide: true,
    encoding: 'utf8',
  })
  if (!res.error && res.status === 0) return { ok: true, kind: 'dir' }
  const message = res.error
    ? res.error.message
    : (res.stderr || res.stdout || '').trim() || 'rmdir 退出码 ' + res.status
  return { ok: false, kind: 'dir', error: new Error(message) }
}

for (const item of toDelete) {
  const result = removeTarget(item.target)
  if (result.ok) {
    freed += item.bytes
    continue
  }
  failed += 1
  const label = result.kind === 'dir' ? '目录删失败' : '文件删失败'
  console.error(label + ': ' + item.target + ' —— ' + result.error.message)
}
console.log('')
console.log('已删除 ' + (toDelete.length - failed) + ' 项（免审 ' + freeItems.length + ' + 点名 ' + uniqApproved.length + '），释放 ' + mb(freed) + ' MB')
if (reviewItems.length > uniqApproved.length) {
  console.log('未动的需三查项: ' + (reviewItems.length - uniqApproved.length) + ' 项 —— 三查没过的就该留着')
}
process.exit(failed === 0 ? 0 : 1)