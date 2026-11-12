// 路径安全 + 红线目录 + 存储位置。
// 机械复制自 dsh-butler-tidy/lib/path-safety.js（2026-11-12）：红线清单（9 项）、fail-closed、
// junction / UNC / \\?\ 防护逐字节保留；唯一差异是 storeLocation（子目录名 tidy → negative-asset，返回字段只留 dir / lastScan）。
// 未使用的 lockHint / isUnder 也一并保留：与源文件 diff 审计时能一眼看出偏差。
import { lstatSync, realpathSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
// ───────────────────────────── 路径与保护 ─────────────────────────────

/**
 * Windows 设备前缀（`\\?\`、`\\.\`）与 UNC（`\\server\share`，含 `\\localhost\D$`
 * 这类本地管理共享）一律视为「不能安全判定」的写法。
 * 2026-11-03 审计 T2：`\\?\D:\AI\dsh-bundles\...` / `\\localhost\D$\...` 都能让纯
 * 字符串前缀比较判不出「在红线内」——这里直接 fail-closed。
 */
export const UNSAFE_PATH_PREFIX = /^[\\/]{2}/

/** 路径写法本身就不能安全判定（UNC / 设备路径 / 空值 / 含空字节） */
export function isUnsafePath(value) {
  if (typeof value !== 'string') return true
  const raw = value.trim()
  if (raw === '') return true
  if (UNSAFE_PATH_PREFIX.test(raw)) return true
  if (raw.includes('\u0000')) return true
  return false
}

/** 路径（含任一级祖先）是不是 reparse point：junction / 符号链接 / 其他重解析点 */
export function hasReparsePoint(resolvedPath) {
  let cursor = resolvedPath
  for (;;) {
    try {
      if (lstatSync(cursor).isSymbolicLink()) return true
    } catch {
      // 这一级不存在，继续往上看
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) return false
    cursor = parent
  }
}

/**
 * 真实路径：先拒绝 UNC / 设备前缀，再 realpath 解析 junction 与符号链接。
 * - 解析链条上任何一级是 reparse point → 返回 ''（调用方按红线/fail-closed 处理）；
 * - 路径不存在 → 逐级向上找最近可解析祖先再拼回剩余段（这样父目录的 junction 也能解析）；
 * - 全都不存在 → 退回 path.resolve（审计要求：不存在的路径用 resolve）。
 */
export function realPathOf(value) {
  if (isUnsafePath(value)) return ''
  const resolved = path.resolve(value.trim())
  if (hasReparsePoint(resolved)) return ''
  try {
    return realpathSync.native(resolved)
  } catch {
    let cursor = resolved
    const tail = []
    for (;;) {
      const parent = path.dirname(cursor)
      if (parent === cursor) return resolved
      tail.unshift(path.basename(cursor))
      cursor = parent
      try {
        return path.join(realpathSync.native(cursor), ...tail)
      } catch {
        // 继续向上
      }
    }
  }
}

/** 归一化：真实路径 + 小写 + 去尾部分隔符；不能安全判定时返回 '' */
export function norm(p) {
  const real = realPathOf(p)
  return real === '' ? '' : real.replace(/[\\/]+$/, '').toLowerCase()
}

export function isUnder(child, parent) {
  const c = norm(child)
  const p = norm(parent)
  if (c === '' || p === '') return false
  return c === p || c.startsWith(`${p}${path.sep}`)
}

/** 文件可能被锁：返回错误码人话 */
export function lockHint(err) {
  const code = err && err.code ? err.code : 'UNKNOWN'
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return '文件占用或权限不足'
  if (code === 'ENOENT') return '文件已不在了'
  if (code === 'ENOSPC') return '磁盘空间不足'
  if (code === 'EDUPLEFT') return '已复制到目标，但原目录没删净（有文件被占用），会留下重复，需人工确认'
  return code
}

export function storeLocation(configured) {
  const fallback = (() => {
    // 本机约定：插件数据落 D 盘；没有 D 盘的机器再退回 profile / 用户目录
    if (existsSync('D:\\')) return path.join('D:\\AI\\dsh-data', 'negative-asset')
    if (process.env.DSH_PROFILE_DIR) return path.join(process.env.DSH_PROFILE_DIR, 'dsh-negative-asset')
    return path.join(os.homedir(), '.dsh', 'dsh-negative-asset')
  })()
  const root = typeof configured === 'string' && configured.trim() !== '' ? path.resolve(configured.trim()) : fallback
  return { dir: root, lastScan: path.join(root, 'last-scan.json') }
}

/** 红线目录：整理/清理永不进入 */
export function protectedDirs(config) {
  const home = os.homedir()
  const base = [
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\ProgramData',
    path.join(home, 'AppData'),
    'D:\\AI\\dsh-bundles',
    'D:\\AI\\deepsek harness',
    'D:\\AI\\hermes-agent',
    'D:\\AI-date\\workbuddy-date\\学习',
  ]
  if (Array.isArray(config?.protectDirs)) {
    for (const item of config.protectDirs) {
      if (typeof item === 'string' && item.trim() !== '') base.push(item.trim())
    }
  }
  return [...new Set(base.map((item) => path.resolve(item)))]
}

/**
 * 目标是否落在红线（或根本无法安全判定）：
 * 写法不安全 / 含 reparse point / 解析不出真实路径 → 一律 true（fail-closed）。
 * 2026-11-03 审计 T2/T3：junction、`\\?\`、UNC 三种写法都曾绕过这里的字符串比较。
 */
export function isProtected(target, guard) {
  const c = norm(target)
  if (c === '') return true
  return guard.some((dir) => {
    const p = norm(dir)
    return p !== '' && (c === p || c.startsWith(`${p}${path.sep}`))
  })
}

