#!/usr/bin/env node
/**
 * 保留策略执行器 —— 让「过时的东西不留」变成一条命令，而不是靠记性。
 *
 * 用法：
 *   node cleanup.mjs            # 只报告（默认，安全）
 *   node cleanup.mjs --apply    # 真删
 *
 * 为什么这些规则：每次研究/升级都会留下「可重下但很占地方」的东西，
 * 而结论（md 文档、git 提交）才是要留的。默认阈值都偏保守，宁可少删。
 *
 * 红线：D:\AI-date\workbuddy-date\学习 是用户的学习资料仓库，永不触碰。
 */
import { existsSync, readdirSync, statSync, rmSync } from 'node:fs'
import path from 'node:path'

const APPLY = process.argv.includes('--apply')
const DAY = 24 * 60 * 60 * 1000
const now = Date.now()

/** 阈值：照下面注释改，别在调用处改 */
const CLONE_DAYS = 1        // updater 学习台 clone 超过 1 天 → 删（updater_study 可重下）
const IMAGE_DAYS = 3        // 工作区顶层过程截图超过 3 天 → 删
const LOG_KEEP = 10         // 插件管理器日志留最近 10 次
const MEM_BAK_KEEP = 2      // 记忆自动备份留最近 2 份
const PROFILE_BAK_KEEP = 1  // profile 里每类 *.bak-* 留最近 1 份

/** 工作区：只清顶层的过程截图（.md 与源码一个不碰） */
const WORKSPACES = ['D:\\AI-date\\dsh-date\\dsh-创建']
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const PROTECT = ['workbuddy-date\\学习']

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

function add(target, why) {
  if (blocked(target)) return
  if (!existsSync(target)) return
  const { bytes, files } = sizeOf(target)
  plan.push({ target, why, bytes, files })
}

// ---- 规则 1：updater 学习台 clone（最占地方，可重下）----
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
    if (age > CLONE_DAYS * DAY) add(full, 'updater 学习台 clone（超过 ' + CLONE_DAYS + ' 天，updater_study 可重下）')
  }
}

// ---- 规则 2：工作区顶层过程截图 ----
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
    if (age > IMAGE_DAYS * DAY) add(full, '工作区过程截图（超过 ' + IMAGE_DAYS + ' 天，文档不引用）')
  }
}

// ---- 规则 3：插件管理器日志 ----
const logRoot = 'C:\\Users\\cqs6017\\.dsh\\profiles\\desktop\\.plugin-manager\\logs'
if (existsSync(logRoot)) {
  const dirs = readdirSync(logRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
  for (const name of dirs.slice(0, Math.max(0, dirs.length - LOG_KEEP))) {
    add(path.join(logRoot, name), '插件管理器日志（只留最近 ' + LOG_KEEP + ' 次）')
  }
}

// ---- 规则 4：记忆自动备份 ----
const memRoot = 'D:\\AI\\dsh-data\\memory'
if (existsSync(memRoot)) {
  const baks = readdirSync(memRoot)
    .filter((n) => n.startsWith('memory.json.bak'))
    .map((n) => path.join(memRoot, n))
    .map((p) => ({ p, m: statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  for (const b of baks.slice(MEM_BAK_KEEP)) add(b.p, '记忆自动备份（只留最近 ' + MEM_BAK_KEEP + ' 份）')
}

// ---- 规则 5：profile 里的旧 .bak-* ----
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
    for (const item of list.slice(PROFILE_BAK_KEEP)) add(item.p, 'profile 旧备份（每类只留最近 ' + PROFILE_BAK_KEEP + ' 份）')
  }
}

// ---- 规则 6：tidy 的系统工具缓存 ----
// 注册表导出（一个 HKCU\SOFTWARE 就 13 MB）只在「改坏要回滚」的那几天有用；
// 同类只留最新一份；*.zip 是下载来的压缩包，解开后的 exe / 已就位，压缩包本身可丢。
const tidyTools = 'D:\\AI\\dsh-data\\tidy\\tools'
if (existsSync(tidyTools)) {
  const groups = new Map()
  for (const name of readdirSync(tidyTools)) {
    const full = path.join(tidyTools, name)
    if (name.toLowerCase().endsWith('.zip')) {
      add(full, 'tidy 下载的压缩包（解压后的工具已就位）')
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
    for (const item of list.slice(1)) add(item.p, 'tidy 注册表/扫描导出（同类只留最新 1 份）')
  }
}

// ---- 输出 ----
if (plan.length === 0) {
  console.log('cleanup: 没有该清的东西（保留策略全部满足）')
  process.exit(0)
}

let bytes = 0
let files = 0
for (const item of plan) {
  bytes += item.bytes
  files += item.files
  console.log('· ' + item.target)
  console.log('    ' + (item.bytes / 1024 / 1024).toFixed(1) + ' MB / ' + item.files + ' 文件 —— ' + item.why)
}
console.log('')
console.log('合计 ' + (bytes / 1024 / 1024).toFixed(1) + ' MB / ' + files + ' 文件，' + plan.length + ' 项')

if (!APPLY) {
  console.log('（dry-run：什么都没删。确认无误后加 --apply）')
  process.exit(0)
}

let failed = 0
for (const item of plan) {
  try {
    rmSync(item.target, { recursive: true, force: true })
  } catch (error) {
    failed += 1
    console.error('删除失败: ' + item.target + ' —— ' + error.message)
  }
}
console.log('已删除 ' + (plan.length - failed) + ' 项，释放 ' + (bytes / 1024 / 1024).toFixed(1) + ' MB')
process.exit(failed === 0 ? 0 : 1)
