/**
 * dsh-checkpoint —— agent 文件改动的「写前快照 + 一键回滚」（v1.5）。
 *
 * 抓取原则：**只记用户/工作区文件，不记系统与插件自身目录**（excludeDirs = protectDirs + 数据目录）。
 *
 * v1.5 新增「按会话 / 按时间清理」：`checkpoint_prune` 只丢快照记录、从不读写用户文件；
 * 默认 dryRun（只报告会删几条），真正清理必须 `dryRun: false` + `confirm: true`；
 * protectDirs 里的快照永不清理（保护逻辑不被绕过）。为此记录里补了 `sessionId` 字段：
 * 旧存档缺字段按「未知会话/未知时间」处理——不报错，也不会被按会话/按时间清理命中。
 *
 * v2 相比 v1 解决的三件事：
 *   1. 持久化：快照落盘到 `config.storeDir`（默认 `~/.dsh/dsh-checkpoint/snapshots.json`），
 *      插件重载/进程重启后仍可回滚；
 *   2. 覆盖删除/移动：`pwsh`/`bash` 等 shell 工具里出现破坏性命令时，
 *      从命令行里提取路径候选，对**已存在**的文件先留底；
 *   3. 新建文件也能回滚：`write`/`edit` 的目标在写之前不存在就记成 `created`，
 *      回滚时直接删除（删除前按会话沙箱策略做边界校验）。
 *
 * 抓取时机仍是 `tools/pre-execute`：它是每次工具派发前都会经过的 waterfall，
 * `write`/`edit` 的参数里带目标路径，shell 工具的参数里带命令行。
 *
 * 仍然做不到的（不是实现问题，是边界问题）：
 *   - 外部进程 / IDE / 另一个插件绕开工具管线直接改文件，拦不到；
 *   - git 操作（`git checkout`、`git reset --hard`）恢复哪些文件取决于仓库状态，
 *     没有安全的通用快照方式，不处理；
 *   - 超过大小上限（默认单文件 1 MiB）或非文本文件不记录；
 *   - shell 命令里的路径靠正则提取，属于 best-effort：变量、通配符、管道拼接
 *     出来的路径可能漏抓。
 */

import { promises as fsp, writeFileSync, readFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-checkpoint'
export const inject = ['tools', 'fs']

const DEFAULT_MAX_BYTES = 1024 * 1024 // 单文件上限 1 MiB
const MAX_SNAPSHOTS = 200
const TOTAL_BUDGET = 64 * 1024 * 1024 // 快照总量上限 64 MiB
const DAY_MS = 24 * 60 * 60 * 1000
const TARGET_TOOLS = new Set(['write', 'edit'])
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'sh', 'shell', 'terminal'])
const DESTRUCTIVE =
  /\b(?:Remove-Item|del|erase|rmdir|rm|Move-Item|mv|ren|Rename-Item|Clear-Content|Set-Content|Add-Content|Out-File|truncate)\b|(?:^|[\s;&|])sed\s+(?:-\w+\s+)*-i\b|>>?\s*\S/i

const text = (value) => ({ type: 'text', text: value })

/** 错误契约：给抛出的错误挂机器可读 code（UPPER_SNAKE），人话消息原样保留 */
function failure(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** status 用：storeDir 真能写吗（建目录 + 写探针再删；不碰快照存档） */
function probeStoreWritable(dir) {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now()}`)
    writeFileSync(probe, 'ok', 'utf8')
    try {
      unlinkSync(probe)
    } catch {
      // 探针删不掉不影响「可写」判定
    }
    return { ready: true, reason: '' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ready: false, reason: `storeDir 不可写：${dir}（${message}）` }
  }
}

/** 路径归一化：Windows 大小写不敏感，统一分隔符 */
function normalizePath(value) {
  return String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function storeLocation(overrideDir) {
  // 优先 config.storeDir（可指到任意盘），其次 profile 目录，再退到用户级 ~/.dsh。
  const override = typeof overrideDir === 'string' ? overrideDir.trim() : ''
  const base =
    override !== ''
      ? path.resolve(override)
      : process.env.DSH_PROFILE_DIR
        ? path.join(process.env.DSH_PROFILE_DIR, 'dsh-checkpoint')
        : path.join(os.homedir(), '.dsh', 'dsh-checkpoint')
  return { dir: base, file: path.join(base, 'snapshots.json') }
}

/** `child` 是否在 `parent` 目录内（都按绝对路径比较，大小写不敏感） */
function isInside(parent, child) {
  const p = normalizePath(path.resolve(parent))
  const c = normalizePath(path.resolve(child))
  return c === p || c.startsWith(`${p}/`)
}

/**
 * 严格目标匹配（restore / forget / diff 专用）：只接受**全等**或**唯一后缀**。
 * 命中 ≥2 个直接抛 AMBIGUOUS_TARGET 并列出候选路径——宁可让人多传一段路径，
 * 也不能因为「文件名片段」把多个目标一起恢复/删除（2026-11-01 扫描 #29：
 * `checkpoint_restore({path:'index'})` 曾会逐个处理所有含 index 的快照，created 的直接删）。
 * `checkpoint_list` 不用它：只读，看全部无害。
 */
function strictTargets(records, needle) {
  const n = normalizePath(needle)
  const all = [...records.entries()]
  const exact = all.filter(([, record]) => normalizePath(record.path) === n)
  if (exact.length > 0) return exact
  const hits = all.filter(([, record]) => normalizePath(record.path).endsWith(`/${n}`))
  if (hits.length > 1) {
    const shown = hits.slice(0, 10).map(([, record]) => `  - ${record.path}`).join('\n')
    const more = hits.length > 10 ? `\n  … 还有 ${hits.length - 10} 个` : ''
    throw failure(
      'AMBIGUOUS_TARGET',
      `路径 "${needle}" 命中 ${hits.length} 个快照：为免恢复/删除错目标，这里不做模糊匹配。请传更长、唯一的路径（全等或唯一后缀）：\n${shown}${more}`,
    )
  }
  if (hits.length === 1) return hits
  // 后缀没命中时，再按「路径片段」只做歧义提示：命中 ≥2 个必须拒绝并列候选，
  // 唯一片段命中才放行（免得用户被迫抄全路径）。这是 #29 修复的兜底：绝不逐个处理多个目标。
  const fragments = all.filter(([, record]) => normalizePath(record.path).includes(`/${n}`))
  if (fragments.length > 1) {
    const shown = fragments.slice(0, 10).map(([, record]) => `  - ${record.path}`).join('\n')
    const more = fragments.length > 10 ? `\n  … 还有 ${fragments.length - 10} 个` : ''
    throw failure(
      'AMBIGUOUS_TARGET',
      `路径 "${needle}" 命中 ${fragments.length} 个快照：为免恢复/删除错目标，这里不做模糊匹配。请传更长、唯一的路径（全等或唯一后缀）：\n${shown}${more}`,
    )
  }
  return fragments
}

/** 从一段命令行里提取"看起来是路径"的候选（best-effort） */
function commandCandidates(command) {
  const found = new Set()
  const quoted = /"([^"\r\n]{1,400})"|'([^'\r\n]{1,400})'/g
  let match = quoted.exec(command)
  while (match !== null) {
    const value = match[1] ?? match[2]
    if (value) found.add(value)
    match = quoted.exec(command)
  }
  for (const raw of command.split(/[\s;|&()]+/)) {
    const token = raw.replace(/^["'(]+|["'),]+$/g, '')
    if (!token || token.startsWith('-') || token.includes('://')) continue
    if (token.includes('\\') || token.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(token)) found.add(token)
  }
  return [...found]
}

/**
 * 行级 diff（LCS）。导出是为了能在 Node 里单测。
 * 任一侧行数超过 maxLines 就退化成"只给统计"，不建 N×M 表。
 */
export function diffTextLines(before, after, maxLines = 600) {
  const a = String(before ?? '').split('\n')
  const b = String(after ?? '').split('\n')
  if (a.length > maxLines || b.length > maxLines) {
    return { truncated: true, ops: [], added: b.length, removed: a.length }
  }
  const n = a.length
  const m = b.length
  if (n === 0 && m === 0) return { truncated: false, ops: [], added: 0, removed: 0 }
  const width = m + 1
  const table = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + (j + 1)] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: 'keep', text: a[i] })
      i += 1
      j += 1
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      ops.push({ op: 'del', text: a[i] })
      i += 1
    } else {
      ops.push({ op: 'add', text: b[j] })
      j += 1
    }
  }
  while (i < n) {
    ops.push({ op: 'del', text: a[i] })
    i += 1
  }
  while (j < m) {
    ops.push({ op: 'add', text: b[j] })
    j += 1
  }
  let added = 0
  let removed = 0
  for (const op of ops) {
    if (op.op === 'add') added += 1
    else if (op.op === 'del') removed += 1
  }
  return { truncated: false, ops, added, removed }
}

/** 把 ops 折成带上下文的 hunk（默认前后各 2 行），并算出 1-based 行号。导出用于单测。 */
export function buildHunks(ops, context = 2) {
  const changeIndices = []
  for (let index = 0; index < ops.length; index += 1) if (ops[index].op !== 'keep') changeIndices.push(index)
  if (changeIndices.length === 0) return []

  const groups = []
  let start = changeIndices[0]
  let end = changeIndices[0]
  for (const index of changeIndices.slice(1)) {
    if (index - end <= context * 2) {
      end = index
    } else {
      groups.push([start, end])
      start = index
      end = index
    }
  }
  groups.push([start, end])

  const hunks = []
  for (const [from, to] of groups) {
    const begin = Math.max(0, from - context)
    const finish = Math.min(ops.length, to + context + 1)
    let oldLine = 1
    let newLine = 1
    for (let index = 0; index < begin; index += 1) {
      if (ops[index].op !== 'add') oldLine += 1
      if (ops[index].op !== 'del') newLine += 1
    }
    const lines = []
    let oldCount = 0
    let newCount = 0
    for (let index = begin; index < finish; index += 1) {
      const op = ops[index]
      if (op.op !== 'add') oldCount += 1
      if (op.op !== 'del') newCount += 1
      lines.push({ op: op.op === 'keep' ? 'context' : op.op, text: op.text })
    }
    hunks.push({ oldStart: oldLine, oldCount, newStart: newLine, newCount, lines })
  }
  return hunks
}

export function apply(ctx, config) {
  const maxBytes =
    Number.isInteger(config?.maxBytes) && config.maxBytes > 0 ? Math.min(config.maxBytes, 16 * 1024 * 1024) : DEFAULT_MAX_BYTES

  const fs = ctx.fs
  const tools = ctx.tools
  const workingDirectory = ctx.get('workingDirectory')
  const sandboxPolicy = ctx.get('sandboxPolicy')
  const sessions = ctx.get('sessions')
  const { dir: storeDir, file: storeFile } = storeLocation(config?.storeDir)

  /**
   * 内置红线目录（2026-11-03 全局审计 C1）：**永不采集、永不回滚**，即使传 confirm: true 也拒绝。
   * 与 tidy 的红线名单对齐：系统目录 / 学习空间 / DSH 安装目录 / `.dsh` 凭据目录。
   * 为什么是硬拒绝而不是 confirm 放行：红线是「根本不该被这个工具碰」的东西，
   * 而 checkpoint 恰好是唯一能把旧内容写回去、还能删掉「agent 新建文件」的回滚工具。
   */
  const BUILTIN_REDLINE = [
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\ProgramData',
    path.join(os.homedir(), 'AppData'),
    'D:\\AI-date\\workbuddy-date\\学习',
    'D:\\AI\\deepsek harness',
    path.dirname(process.execPath), // DSH 安装目录（运行时按真实可执行文件定位）
    path.join(os.homedir(), '.dsh'), // DSH 凭据目录（.credentials.yaml 等）
  ]
  const configuredProtectDirs = Array.isArray(config?.protectDirs)
    ? config.protectDirs.filter((dir) => typeof dir === 'string' && dir.trim() !== '').map((dir) => path.resolve(dir.trim()))
    : []
  const configuredRedlineDirs = Array.isArray(config?.redlineDirs)
    ? config.redlineDirs.filter((dir) => typeof dir === 'string' && dir.trim() !== '').map((dir) => path.resolve(dir.trim()))
    : []
  const redlineDirs = [...new Set([...BUILTIN_REDLINE, ...configuredRedlineDirs].map((dir) => path.resolve(dir)))]
  /** 受保护目录：红线 + 配置项。里面的目标回滚/删除需要 confirm（红线则直接拒绝）。 */
  const protectDirs = [...new Set([...redlineDirs, ...configuredProtectDirs])]
  /** 显式允许免 confirm 的额外根目录（默认只有会话工作区免 confirm） */
  const allowRestoreDirs = Array.isArray(config?.allowRestoreDirs)
    ? config.allowRestoreDirs.filter((dir) => typeof dir === 'string' && dir.trim() !== '').map((dir) => path.resolve(dir.trim()))
    : []

  /**
   * Windows 扩展前缀 / UNC 归一：`\\?\D:\x` → `D:\x`；UNC（`\\server\share`、`\\localhost\D$`）
   * 无法安全判定真实位置 → 返回 ''（调用方按红线处理）。
   */
  function normalizeGuardPath(value) {
    const raw = String(value ?? '')
    if (raw === '') return ''
    if (/^\\\\\?\\UNC\\/i.test(raw)) return ''
    if (/^\\\\\?\\/i.test(raw)) return raw.slice(4)
    if (/^\\\\[^\\]/i.test(raw)) return ''
    return raw
  }

  /** 目标是否落在内置/配置的红线目录里（回滚/删除一律拒绝，confirm 不放行） */
  function isRedline(osPath) {
    const normalized = normalizeGuardPath(osPath)
    if (normalized === '') return typeof osPath === 'string' && osPath !== ''
    return redlineDirs.some((dir) => isInside(dir, normalized))
  }

  /** 目标是否落在受保护目录里（回滚/删除需要 confirm） */
  function isProtected(osPath) {
    if (typeof osPath !== 'string' || osPath === '') return false
    const normalized = normalizeGuardPath(osPath)
    if (normalized === '') return true
    return protectDirs.some((dir) => isInside(dir, normalized))
  }

  // 采集排除（UX 优先）：受保护目录（含红线）+ 本插件自己的数据目录都不进账本。
  // 理由：用户不该因为"改插件源码"或"插件自己写数据"而看到一堆内部快照；
  // 红线内容更不该落进快照库（2026-11-03 审计 C1：`学习` 里的文件曾被抓进 snapshots.json）。
  const excludeDirs = [...protectDirs, path.resolve(storeDir)]

  function isExcluded(osPath) {
    if (typeof osPath !== 'string' || osPath === '') return false
    const normalized = normalizeGuardPath(osPath)
    if (normalized === '') return true
    return excludeDirs.some((dir) => isInside(dir, normalized))
  }

  /**
   * 清理判定（纯判断，不碰记录）：'match' | 'other-session' | 'unknown-session' | 'too-recent' | 'unknown-time'。
   * `sessionId` 与 `olderThanDays` 同时给时取交集；缺 sessionId / 时间戳坏掉的旧记录一律算未知，
   * 永远不命中（宁可留着，也不清掉拿不准的快照）。
   */
  function pruneVerdict(record, { sessionId, olderThanDays, now }) {
    if (sessionId !== undefined) {
      const owner = record.sessionId
      if (typeof owner !== 'string' || owner === '') return 'unknown-session'
      if (owner !== sessionId) return 'other-session'
    }
    if (olderThanDays !== undefined) {
      const capturedAtMs = Date.parse(String(record.capturedAt ?? ''))
      if (!Number.isFinite(capturedAtMs)) return 'unknown-time'
      if (now - capturedAtMs < olderThanDays * DAY_MS) return 'too-recent'
    }
    return 'match'
  }

  /** key(normalized path) -> { path, content: string | null, bytes, capturedAt, created, sessionId: string | null } */
  const records = new Map()
  const restoring = new Set()
  let totalBytes = 0
  let persistTimer = null

  const stats = {
    preExecute: 0,
    inspected: 0,
    shellScanned: 0,
    capturedCount: 0,
    droppedOnLoad: 0,
    skipped: { missing: 0, notFile: 0, tooLarge: 0, unreadable: 0, noPath: 0, outside: 0, excluded: 0 },
    lastSkip: null,
  }

  // ---------- 任务级检查点标记（B2 · 2026-11-03） ----------
  const marks = []
  const MAX_MARKS = 50

  // ---------- 持久化 ----------
  function serialize() {
    return JSON.stringify({
      version: 4,
      savedAt: new Date().toISOString(),
      records: [...records.values()],
      marks: marks,
    })
  }

  function persistNow() {
    try {
      mkdirSync(storeDir, { recursive: true })
      const body = serialize()
      const temp = `${storeFile}.tmp`
      writeFileSync(temp, body, 'utf8')
      // 原子替换：先写临时文件再 rename，避免半截 JSON
      try {
        renameSync(temp, storeFile)
      } catch (error) {
        writeFileSync(storeFile, body, 'utf8')
      }
    } catch (error) {
      stats.lastSkip = `persist: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  function schedulePersist() {
    if (persistTimer !== null) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      persistNow()
    }, 150)
    if (typeof persistTimer === 'object' && persistTimer !== null && 'unref' in persistTimer) persistTimer.unref()
  }

  function loadPersisted() {
    try {
      const raw = readFileSync(storeFile, 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || !Array.isArray(parsed.records)) return
      if (Array.isArray(parsed.marks)) {
        for (const m of parsed.marks) {
          if (m && typeof m.id === 'string' && typeof m.label === 'string' && typeof m.at === 'string') {
            marks.push({ id: m.id, label: m.label, at: m.at, snapshots: typeof m.snapshots === 'number' ? m.snapshots : 0 })
          }
        }
      }
      for (const item of parsed.records) {
        if (!item || typeof item.path !== 'string') continue
        const created = item.created === true
        const content = created ? null : typeof item.content === 'string' ? item.content : null
        if (!created && content === null) continue
        const key = normalizePath(item.path)
        records.set(key, {
          path: item.path,
          content,
          bytes: created ? 0 : content.length,
          capturedAt: typeof item.capturedAt === 'string' ? item.capturedAt : new Date().toISOString(),
          created,
          // v3 字段：旧存档没有 sessionId → null（未知会话）。不报错、也不被按会话清理命中。
          sessionId: typeof item.sessionId === 'string' && item.sessionId.trim() !== '' ? item.sessionId.trim() : null,
        })
        if (!created) totalBytes += content.length
      }
      // stale 清理：文件不存在、且父目录也不存在 → 这个位置已经整体消失（目录迁移 / 删除）。
      // 留着只会在 list 里制造噪音，误 restore 还会按旧路径重建目录（例如把文件写回 C 盘）。
      for (const [key, record] of [...records.entries()]) {
        if (existsSync(record.path)) continue
        if (!existsSync(path.dirname(record.path))) {
          records.delete(key)
          totalBytes -= record.bytes
          stats.droppedOnLoad += 1
        }
      }
    } catch (error) {
      // 没有存档 / 存档损坏：从空开始
    }
  }

  loadPersisted()

  function evictOldest() {
    const oldest = records.entries().next()
    if (oldest.done) return
    const [key, record] = oldest.value
    records.delete(key)
    totalBytes -= record.bytes
  }

  function remember(key, record) {
    while (records.size >= MAX_SNAPSHOTS || totalBytes + record.bytes > TOTAL_BUDGET) {
      const before = records.size
      evictOldest()
      if (records.size === before) break
    }
    records.set(key, record)
    totalBytes += record.bytes
    stats.capturedCount += 1
    schedulePersist()
  }

  // ---------- 抓取 ----------
  async function captureTarget(target, allowCreated, sessionId) {
    // sessionId 来自 exec.agent.id（DSH 会话 id）；拿不到就是 null（未知会话）。
    const owner = typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId.trim() : null
    const display = String(target?.displayPath ?? '')
    const key = normalizePath(display)
    if (key === '' || records.has(key) || restoring.has(key)) return
    // 排除系统/插件自身目录：不进账本，也就不会出现在 list / restore all 里
    try {
      const osPath = typeof fs.processPath === 'function' ? fs.processPath(target) : display
      if (isExcluded(osPath)) {
        stats.skipped.excluded += 1
        return
      }
    } catch (error) {
      // processPath 不可用就按 displayPath 判断
      if (isExcluded(display)) {
        stats.skipped.excluded += 1
        return
      }
    }
    try {
      const info = await fs.stat(target)
      if (!info) {
        if (!allowCreated) {
          stats.skipped.missing += 1
          return
        }
        remember(key, {
          path: display,
          content: null,
          bytes: 0,
          capturedAt: new Date().toISOString(),
          created: true,
          sessionId: owner,
        })
        return
      }
      if (info.type !== 'file') {
        stats.skipped.notFile += 1
        return
      }
      if (typeof info.size === 'number' && info.size > maxBytes) {
        stats.skipped.tooLarge += 1
        return
      }
      const content = await fs.readText(target)
      if (content.length > maxBytes) {
        stats.skipped.tooLarge += 1
        return
      }
      remember(key, {
        path: display,
        content,
        bytes: content.length,
        capturedAt: new Date().toISOString(),
        created: false,
        sessionId: owner,
      })
    } catch (error) {
      stats.skipped.unreadable += 1
      stats.lastSkip = error instanceof Error ? error.message : String(error)
    }
  }

  async function sessionCwd(exec) {
    if (!workingDirectory || !exec?.agent) return undefined
    try {
      return await workingDirectory.ensure(exec.agent, exec.signal)
    } catch (error) {
      return undefined
    }
  }

  /** 从工具执行上下文取会话 id（exec.agent.id）；取不到就是未知会话 */
  function sessionIdOf(exec) {
    const id = exec?.agent?.id
    return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined
  }

  async function captureFromToolArgs(exec) {
    const args = exec?.arguments ?? {}
    const raw = typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : undefined
    if (raw === undefined || raw.trim() === '') {
      stats.skipped.noPath += 1
      return
    }
    const cwd = await sessionCwd(exec)
    let target
    try {
      target = await fs.resolve(raw, cwd === undefined ? {} : { cwd })
    } catch (error) {
      stats.skipped.missing += 1
      return
    }
    await captureTarget(target, true, sessionIdOf(exec))
  }

  async function captureFromShell(exec) {
    const args = exec?.arguments ?? {}
    const command = typeof args.command === 'string' ? args.command : undefined
    if (command === undefined || !DESTRUCTIVE.test(command)) return
    stats.shellScanned += 1
    const cwd = await sessionCwd(exec)
    for (const candidate of commandCandidates(command)) {
      let target
      try {
        target = await fs.resolve(candidate, cwd === undefined ? {} : { cwd })
      } catch (error) {
        continue
      }
      await captureTarget(target, false, sessionIdOf(exec))
    }
  }

  // ---------- 回滚 ----------
  function resolveRestorePolicy(exec) {
    if (!sandboxPolicy || typeof sandboxPolicy.resolve !== 'function') return undefined
    try {
      const sessionId = exec?.agent?.id
      const session = sessions && sessionId && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
      return session ? sandboxPolicy.resolve({ session }) : sandboxPolicy.resolve({})
    } catch (error) {
      return undefined
    }
  }

  async function deleteFile(target, policy) {
    const osPath = typeof fs.processPath === 'function' ? fs.processPath(target) : String(target?.displayPath ?? '')
    if (policy && policy.mode === 'read-only') {
      throw failure('SANDBOX_READ_ONLY', '当前沙箱策略是 read-only，拒绝删除文件。')
    }
    if (policy && policy.mode === 'workspace-write' && !isInside(policy.workspaceRoot, osPath)) {
      throw failure('OUTSIDE_WORKSPACE', `目标不在工作区内，拒绝删除：${osPath}`)
    }
    try {
      await fsp.unlink(osPath)
    } catch (error) {
      if (error && error.code === 'ENOENT') return // 已经不在了，等同成功
      throw error
    }
  }

  // ---------- 钩子 ----------
  ctx.effect(() =>
    ctx.on('tools/pre-execute', async (exec, next) => {
      stats.preExecute += 1
      try {
        const name = String(exec?.name ?? '')
        if (TARGET_TOOLS.has(name)) {
          stats.inspected += 1
          await captureFromToolArgs(exec)
        } else if (SHELL_TOOLS.has(name)) {
          await captureFromShell(exec)
        }
      } catch (error) {
        stats.lastSkip = error instanceof Error ? error.message : String(error)
      }
      return next()
    }),
  )

  // 兜底：某些 fs 后端若派发 intent 事件，也照样留底
  ctx.effect(() =>
    ctx.on('fs/write-intent', async (target, _actor, next) => {
      await captureTarget(target, false)
      return next()
    }),
  )
  ctx.effect(() =>
    ctx.on('fs/edit-intent', async (target, _actor, next) => {
      await captureTarget(target, false)
      return next()
    }),
  )

  // 卸载前落盘
  ctx.effect(() => () => {
    if (persistTimer !== null) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    persistNow()
  })

  // ---------- 工具 ----------
  ctx.effect(() =>
    tools.register({
      name: 'checkpoint_list',
      description:
        'List the files whose previous content was captured before this agent wrote, edited or had a shell command modify them. Pair with checkpoint_restore to roll one back.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            total: { type: 'integer' },
            files: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  kind: { type: 'string', enum: ['modified', 'created'] },
                  bytes: { type: 'integer' },
                  capturedAt: { type: 'string' },
                },
                required: ['path', 'kind', 'bytes', 'capturedAt'],
                additionalProperties: false,
              },
            },
            marks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  label: { type: 'string' },
                  at: { type: 'string' },
                  snapshots: { type: 'integer' },
                },
                required: ['id', 'label', 'at', 'snapshots'],
                additionalProperties: false,
              },
            },
          },
          required: ['total', 'files'],
          additionalProperties: false,
        },
        render(_args, value) {
          const files = Array.isArray(value?.files) ? value.files : []
          if (files.length === 0) return [text('还没有任何写前快照（agent 改过的文件会出现在这里）。')]
          const created = files.filter((file) => file.kind === 'created').length
          const shown = files.slice(0, 20)
          const lines = shown.map((file, index) => {
            const tag = file.kind === 'created' ? '[新建→回滚即删]' : `${file.bytes} 字节`
            const time = String(file.capturedAt).slice(11, 19)
            return `${index + 1}. ${file.path}  ${tag}  ${time}`
          })
          const more = files.length > shown.length ? `\n… 还有 ${files.length - shown.length} 个（用 path 指定目标即可操作）` : ''
          const marksShown = Array.isArray(value?.marks) && value.marks.length > 0 ? `\n任务标记：${value.marks.map((m) => `${m.label}(${m.id})@${String(m.at).slice(11, 19)}`).join(' · ')}` : ''
          return [
            text(`共 ${files.length} 个可回滚目标（修改 ${files.length - created} / 新建 ${created}）：\n${lines.join('\n')}${more}${marksShown}`),
          ]
        },
      },
      async execute() {
        const files = [...records.values()]
          .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
          .map((record) => ({
            path: record.path,
            kind: record.created ? 'created' : 'modified',
            bytes: record.bytes,
            capturedAt: record.capturedAt,
          }))
        return { total: files.length, files, marks: marks.slice(-20).reverse() }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'checkpoint_restore',
      description:
        'Restore files captured before this agent modified them, and delete files this agent created. Pass "path" for one target, or "all": true for everything. Targets outside the session workspace / allowRestoreDirs need confirm: true; red-line directories (学习空间 / DSH install dir / .dsh credentials / system dirs) are always refused, even with confirm: true.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Absolute or display path to restore. Exact match or a unique path suffix; an ambiguous suffix is rejected with the candidate list.',
          },
          all: { type: 'boolean', description: 'Restore/delete every captured target. Requires confirm: true.' },
          mark: { type: 'string', description: 'Restore everything captured AFTER this task mark (label or id from checkpoint_mark / checkpoint_list marks). Requires confirm: true. Mutually exclusive with path.' },
          confirm: {
            type: 'boolean',
            description:
              'Required together with "all": true, for targets under config protectDirs, and for single targets outside the session workspace / allowRestoreDirs whitelist. Red-line targets are refused even with confirm: true.',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            restored: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  action: { type: 'string', enum: ['restored', 'deleted'] },
                  bytes: { type: 'integer' },
                },
                required: ['path', 'action', 'bytes'],
                additionalProperties: false,
              },
            },
            failed: {
              type: 'array',
              items: {
                type: 'object',
                properties: { path: { type: 'string' }, reason: { type: 'string' } },
                required: ['path', 'reason'],
                additionalProperties: false,
              },
            },
            mark: { type: 'string' },
          },
          required: ['restored', 'failed'],
          additionalProperties: false,
        },
        render(_args, value) {
          const markLine = typeof value?.mark === 'string' && value.mark !== '' ? [`已回滚到标记 ${value.mark} 之后的改动。`] : []
          const restored = Array.isArray(value?.restored) ? value.restored : []
          const failed = Array.isArray(value?.failed) ? value.failed : []
          const lines = []
          if (restored.length > 0) {
            lines.push(`已处理 ${restored.length} 个目标：`)
            for (const item of restored) {
              lines.push(`  ${item.action === 'deleted' ? '🗑 删除' : '✓ 恢复'} ${item.path}`)
            }
          }
          if (failed.length > 0) {
            lines.push(`失败 ${failed.length} 个：`)
            for (const item of failed) lines.push(`  ✗ ${item.path} — ${item.reason}`)
          }
          return [text(markLine.concat(lines.length > 0 ? lines : ['没有可回滚的快照。']).join('\n'))]
        },
      },
      async execute(args, exec) {
        const all = args?.all === true
        const wanted = typeof args?.path === 'string' && args.path.trim() !== '' ? args.path.trim() : undefined
        const markWanted = typeof args?.mark === 'string' && args.mark.trim() !== '' ? args.mark.trim() : undefined
        if (markWanted !== undefined && (all || wanted !== undefined)) {
          throw failure('CONFLICTING_TARGETS', 'mark 与 path / all 互斥：mark 只负责「回到标记点之后的全部改动」。')
        }
        if (!all && wanted === undefined && markWanted === undefined) {
          throw failure('MISSING_TARGET', 'checkpoint_restore 需要 path（回滚单个目标），all: true + confirm: true（回滚全部），或 mark + confirm: true（回到任务标记点）。')
        }
        const mark = markWanted !== undefined ? marks.find((m) => m.id === markWanted || m.label === markWanted) : undefined
        if (markWanted !== undefined && mark === undefined) {
          throw failure('MARK_NOT_FOUND', `没有标记 ${markWanted}。先用 checkpoint_list 查看已有 marks，或 checkpoint_mark 打一个。`)
        }
        if (markWanted !== undefined && args?.confirm !== true) {
          throw failure('CONFIRM_REQUIRED', `回到标记点 ${mark.label} 会恢复其后捕获的全部快照。确认请显式传 confirm: true。`)
        }
        if (all && args?.confirm !== true) {
          throw failure(
            'CONFIRM_REQUIRED',
            `回滚全部（all: true）会重写/删除当前全部 ${records.size} 个快照目标，其中可能包含正在运行的插件源码。先看影响范围请用 checkpoint_diff 的 all: true；确认要回滚请显式传 confirm: true。只想丢弃快照、不动文件，用 checkpoint_forget。`,
          )
        }

        let targets = [...records.entries()]
        if (mark !== undefined) {
          targets = targets.filter(([, record]) => record.capturedAt > mark.at)
        } else if (!all) {
          // 严格匹配：歧义时 strictTargets 直接抛错并列候选，绝不逐个恢复
          targets = strictTargets(records, wanted)
          if (targets.length === 0) {
            throw failure('NOT_FOUND', `没有匹配到快照：${wanted}。先用 checkpoint_list 查看可回滚的目标。`)
          }
        }

        const policy = resolveRestorePolicy(exec)
        const restored = []
        const failed = []
        const confirmed = args?.confirm === true
        // 2026-11-03 审计 C1/C4：单目标回滚在「工作区 / allowRestoreDirs 白名单」之外也必须 confirm，
        // 与 tidy_undo / updater_rollback 的约定拉齐；红线目标无论 confirm 与否一律拒绝。
        const sessionCwdPath = all ? undefined : await sessionCwd(exec)
        const insideAllowedRestore = (osPath) => {
          const normalized = normalizeGuardPath(osPath)
          if (normalized === '') return false
          const roots = [...(sessionCwdPath ? [sessionCwdPath] : []), ...allowRestoreDirs]
          return roots.some((root) => isInside(root, normalized))
        }
        for (const [key, record] of targets) {
          restoring.add(key)
          try {
            const target = await fs.resolve(record.path)
            const osPath = typeof fs.processPath === 'function' ? fs.processPath(target) : record.path
            // 红线：即使 confirm: true 也拒绝（红线是「根本不该被碰」，不是「多点一次就行」）
            if (isRedline(osPath) || isRedline(record.path)) {
              failed.push({
                path: record.path,
                reason: '目标在红线目录（学习空间 / DSH 安装目录 / .dsh 凭据目录 / 系统目录），拒绝回滚或删除；传 confirm 也不放行。',
              })
              continue
            }
            if (!confirmed) {
              if (isProtected(osPath)) {
                failed.push({
                  path: record.path,
                  reason: '目标在受保护目录（protectDirs）里，回滚/删除需要显式传 confirm: true。',
                })
                continue
              }
              if (!insideAllowedRestore(osPath)) {
                failed.push({
                  path: record.path,
                  reason: '目标不在工作区 / allowRestoreDirs 白名单内，回滚/删除需要显式传 confirm: true。',
                })
                continue
              }
            }
            if (record.created) {
              await deleteFile(target, policy)
              restored.push({ path: record.path, action: 'deleted', bytes: 0 })
            } else {
              await fs.writeText(target, record.content, undefined, undefined, policy)
              restored.push({ path: record.path, action: 'restored', bytes: record.bytes })
            }
            records.delete(key)
            totalBytes -= record.bytes
          } catch (error) {
            failed.push({ path: record.path, reason: error instanceof Error ? error.message : String(error) })
          } finally {
            restoring.delete(key)
          }
        }
        schedulePersist()
        return { restored, failed, mark: mark !== undefined ? mark.label : '' }
      },
    }),
  )

  // ---- checkpoint_mark：任务级检查点（B2 · 2026-11-03） ----
  ctx.effect(() =>
    tools.register({
      name: 'checkpoint_mark',
      description:
        'Mark the current point as a named task checkpoint. Use it before a risky multi-file change: if it goes wrong, checkpoint_restore {mark: "<label>", confirm: true} rolls back exactly the files changed after this mark. The mark itself never touches files.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Short label for the checkpoint, e.g. "before-b2-change".' },
        },
        required: ['label'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            at: { type: 'string' },
            snapshots: { type: 'integer' },
          },
          required: ['id', 'label', 'at', 'snapshots'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [text('已打标记 ' + value.label + '（' + value.id + '）。之后改动的文件可用 checkpoint_restore {mark: "' + value.label + '", confirm: true} 一键回到此点。')]
        },
      },
      async execute(args) {
        const label = typeof args?.label === 'string' ? args.label.trim() : ''
        if (label === '') throw failure('MISSING_LABEL', 'checkpoint_mark 需要 label。')
        if (marks.some((m) => m.id === label || m.label === label)) throw failure('MARK_EXISTS', '标记 ' + label + ' 已存在。换个 label，或先 checkpoint_list 看已有标记。')
        marks.push({ id: 'mk' + (marks.length + 1), label, at: new Date().toISOString(), snapshots: records.size })
        while (marks.length > MAX_MARKS) marks.shift()
        schedulePersist()
        return { id: 'mk' + (marks.length), label, at: marks[marks.length - 1].at, snapshots: records.size }
      },
    }),
  )

  // ---- checkpoint_forget：只丢快照，不动文件 ----
  ctx.effect(() =>
    tools.register({
      name: 'checkpoint_forget',
      description:
        'Discard captured snapshots WITHOUT restoring or deleting anything. Use it to drop stale entries or targets you no longer want to roll back (pass "path" or "all": true).',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute or display path. Exact match or a unique path suffix; an ambiguous suffix is rejected with the candidate list.',
          },
          all: { type: 'boolean', description: 'Discard every captured snapshot.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            forgotten: { type: 'array', items: { type: 'string' } },
            remaining: { type: 'integer' },
          },
          required: ['forgotten', 'remaining'],
          additionalProperties: false,
        },
        render(_args, value) {
          const forgotten = Array.isArray(value?.forgotten) ? value.forgotten : []
          if (forgotten.length === 0) return [text(`没有匹配到快照（剩余 ${value?.remaining ?? 0} 个）。`)]
          const lines = forgotten.map((item) => `  - ${item}`)
          return [text(`已丢弃 ${forgotten.length} 个快照（未改动任何文件），剩余 ${value?.remaining ?? 0} 个：\n${lines.join('\n')}`)]
        },
      },
      async execute(args) {
        const all = args?.all === true
        const wanted = typeof args?.path === 'string' && args.path.trim() !== '' ? args.path.trim() : undefined
        if (!all && wanted === undefined) {
          throw failure('MISSING_TARGET', 'checkpoint_forget 需要 path（丢弃单个目标），或传 all: true（丢弃全部）。')
        }
        const matched = all ? [...records.entries()] : strictTargets(records, wanted)
        const forgotten = []
        for (const [key, record] of matched) {
          records.delete(key)
          totalBytes -= record.bytes
          forgotten.push(record.path)
        }
        if (forgotten.length > 0) schedulePersist()
        return { forgotten, remaining: records.size }
      },
    }),
  )

  // ---- checkpoint_prune：按会话 / 按时间清理快照记录（只丢记录，绝不读写用户文件） ----
  ctx.effect(() =>
    tools.register({
      name: 'checkpoint_prune',
      description:
        'Prune captured snapshots by session id and/or age. Defaults to a dry run that only reports what would be dropped; dropping records requires dryRun: false plus confirm: true. Only snapshot records are removed — user files are never touched. Snapshots under protectDirs are always kept.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description:
              'Only prune snapshots captured under this session id. Old snapshots without a recorded session id count as unknown and are kept.',
          },
          olderThanDays: {
            type: 'number',
            description:
              'Only prune snapshots captured more than this many days ago. Snapshots without a valid timestamp are kept.',
          },
          dryRun: {
            type: 'boolean',
            description:
              'Default true: only report what would be pruned. Pass false together with confirm: true to actually drop the snapshot records.',
          },
          confirm: {
            type: 'boolean',
            description:
              'Required together with dryRun: false. Acknowledges dropping snapshot records; files are never modified or deleted.',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            dryRun: { type: 'boolean' },
            matched: { type: 'integer' },
            forgotten: { type: 'array', items: { type: 'string' } },
            wouldForget: { type: 'array', items: { type: 'string' } },
            protected: { type: 'integer' },
            unknown: { type: 'integer' },
            remaining: { type: 'integer' },
          },
          required: ['dryRun', 'matched', 'forgotten', 'wouldForget', 'protected', 'unknown', 'remaining'],
          additionalProperties: false,
        },
        render(_args, value) {
          const dryRun = value?.dryRun !== false
          const matched = value?.matched ?? 0
          const wouldForget = Array.isArray(value?.wouldForget) ? value.wouldForget : []
          const skipped = []
          if ((value?.protected ?? 0) > 0) skipped.push(`受保护目录跳过 ${value.protected} 个`)
          if ((value?.unknown ?? 0) > 0) skipped.push(`未知会话/时间跳过 ${value.unknown} 个`)
          const skippedText = skipped.length > 0 ? `（${skipped.join('，')}）` : ''
          if (matched === 0) {
            return [text(`没有匹配到可清理的快照${skippedText}，剩余 ${value?.remaining ?? 0} 个。`)]
          }
          const shown = wouldForget.slice(0, 20)
          const more = wouldForget.length > shown.length ? `\n… 还有 ${wouldForget.length - shown.length} 个（不再列出）` : ''
          const head = dryRun
            ? `清理预演（dryRun，尚未删除任何东西）：会丢弃 ${matched} 条快照记录${skippedText}，当前共 ${value?.remaining ?? 0} 个、清理后剩 ${Math.max(0, (value?.remaining ?? 0) - matched)} 个。只动快照记录，不会读写任何用户文件。`
            : `已丢弃 ${matched} 条快照记录${skippedText}（未改动任何用户文件），剩余 ${value?.remaining ?? 0} 个。`
          const lines = shown.map((item) => `  - ${item}`)
          if (dryRun) lines.push('确认要清理请传 dryRun: false + confirm: true；只想丢弃指定目标/全部，用 checkpoint_forget。')
          return [text([head, lines.join('\n') + more].filter(Boolean).join('\n'))]
        },
      },
      async execute(args) {
        const rawSession = typeof args?.sessionId === 'string' ? args.sessionId.trim() : ''
        const sessionId = rawSession !== '' ? rawSession : undefined
        const olderThanDays = args?.olderThanDays
        if (sessionId === undefined && olderThanDays === undefined) {
          throw failure(
            'MISSING_FILTER',
            'checkpoint_prune 至少需要一个过滤条件（sessionId 或 olderThanDays），不会无条件清空全部快照；想丢弃全部请用 checkpoint_forget 的 all: true。',
          )
        }
        if (
          olderThanDays !== undefined &&
          (typeof olderThanDays !== 'number' || !Number.isFinite(olderThanDays) || olderThanDays <= 0)
        ) {
          throw failure('INVALID_ARGUMENT', 'olderThanDays 必须是大于 0 的数字（单位：天）。')
        }
        const dryRun = args?.dryRun !== false
        if (!dryRun && args?.confirm !== true) {
          throw failure(
            'CONFIRM_REQUIRED',
            `真正清理（dryRun: false）会丢弃匹配的快照记录（只删记录、不改动任何用户文件），需要显式传 confirm: true。先看影响面请用默认的 dryRun: true。`,
          )
        }

        const now = Date.now()
        const selected = []
        const protectedPaths = []
        let unknown = 0
        for (const [key, record] of [...records.entries()]) {
          const verdict = pruneVerdict(record, { sessionId, olderThanDays, now })
          if (verdict === 'unknown-session' || verdict === 'unknown-time') {
            unknown += 1
            continue
          }
          if (verdict !== 'match') continue
          // protectDirs 的保护逻辑对清理同样生效：受保护目标的快照永不清理
          if (isProtected(record.path)) {
            protectedPaths.push(record.path)
            continue
          }
          selected.push([key, record])
        }

        const wouldForget = selected.map(([, record]) => record.path)
        if (!dryRun) {
          // 红线：这里只删内存里的快照记录（+ 落盘 snapshots.json），不调用任何 fs 写/删接口
          for (const [key, record] of selected) {
            records.delete(key)
            totalBytes -= record.bytes
          }
          if (selected.length > 0) schedulePersist()
        }
        return {
          dryRun,
          matched: selected.length,
          forgotten: dryRun ? [] : wouldForget.slice(),
          wouldForget,
          protected: protectedPaths.length,
          unknown,
          remaining: records.size,
        }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'checkpoint_diff',
      description:
        'Preview what checkpoint_restore would change: a line diff between the live file and the captured content. Pass "path" for one target or "all": true for every captured target.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute or display path (exact match or a unique suffix; ambiguous suffixes are rejected).',
          },
          all: { type: 'boolean', description: 'Diff every captured target.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            entries: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  status: { type: 'string', enum: ['modified', 'created', 'missing', 'unchanged'] },
                  added: { type: 'integer' },
                  removed: { type: 'integer' },
                  truncated: { type: 'boolean' },
                  hunks: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        oldStart: { type: 'integer' },
                        oldCount: { type: 'integer' },
                        newStart: { type: 'integer' },
                        newCount: { type: 'integer' },
                        lines: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: { op: { type: 'string' }, text: { type: 'string' } },
                            required: ['op', 'text'],
                            additionalProperties: false,
                          },
                        },
                      },
                      required: ['oldStart', 'oldCount', 'newStart', 'newCount', 'lines'],
                      additionalProperties: false,
                    },
                  },
                },
                required: ['path', 'status', 'added', 'removed', 'truncated', 'hunks'],
                additionalProperties: false,
              },
            },
          },
          required: ['entries'],
          additionalProperties: false,
        },
        render(_args, value) {
          const entries = Array.isArray(value?.entries) ? value.entries : []
          if (entries.length === 0) return [text('没有可对比的快照。')]
          const modified = entries.filter((entry) => entry.status === 'modified').length
          const created = entries.filter((entry) => entry.status === 'created').length
          const missing = entries.filter((entry) => entry.status === 'missing').length
          const unchanged = entries.filter((entry) => entry.status === 'unchanged').length
          const summary = [
            `回滚预览（共 ${entries.length} 个目标）`,
            `会恢复内容 ${modified} 个、会删除新建 ${created} 个、会重建已删 ${missing} 个${unchanged > 0 ? `、无变化 ${unchanged} 个` : ''}`,
          ].join('\n')
          const out = [summary, '']
          let rendered = 0
          let clipped = false
          for (const entry of entries) {
            out.push(`■ ${entry.path}`)
            if (entry.status === 'created') {
              out.push('   新建文件 → 回滚会删除它')
              out.push('')
              continue
            }
            if (entry.status === 'unchanged') {
              out.push('   与快照一致 → 回滚不会改变内容')
              out.push('')
              continue
            }
            if (entry.status === 'missing') out.push('   文件已被删除 → 回滚会重建它')
            if (entry.truncated) {
              out.push(`   文件太大，只统计行数：+${entry.added} / -${entry.removed}`)
              out.push('')
              continue
            }
            if (entry.status === 'modified') out.push(`   改动 +${entry.added} / -${entry.removed} 行`)
            for (const hunk of entry.hunks) {
              if (clipped) break
              out.push(`   @@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`)
              for (const line of hunk.lines) {
                if (rendered >= 200) {
                  clipped = true
                  break
                }
                const sign = line.op === 'add' ? '+' : line.op === 'del' ? '-' : ' '
                out.push(`   ${sign}${line.text}`)
                rendered += 1
              }
            }
            out.push('')
          }
          if (clipped) out.push('…（diff 过长，已截断）')
          return [text(out.join('\n').trimEnd())]
        },
      },
      async execute(args) {
        const all = args?.all === true
        const wanted = typeof args?.path === 'string' && args.path.trim() !== '' ? args.path.trim() : undefined
        if (!all && wanted === undefined) {
          throw failure('MISSING_TARGET', 'checkpoint_diff 需要 path（对比单个目标），或传 all: true（对比全部）。')
        }

        let targets = [...records.entries()]
        if (!all) {
          // 与 restore/forget 同一套严格匹配：歧义时抛错并列候选，不预设要对比哪个
          targets = strictTargets(records, wanted)
          if (targets.length === 0) {
            throw failure('NOT_FOUND', `没有匹配到快照：${wanted}。先用 checkpoint_list 查看可对比的目标。`)
          }
        }

        const entries = []
        for (const [, record] of targets) {
          let current = null
          try {
            const target = await fs.resolve(record.path)
            const info = await fs.stat(target)
            if (info && info.type === 'file') current = await fs.readText(target)
          } catch (error) {
            current = null
          }
          if (record.created) {
            entries.push({ path: record.path, status: 'created', added: 0, removed: 0, truncated: false, hunks: [] })
            continue
          }
          const diff = diffTextLines(record.content, current === null ? '' : current)
          const hunks = diff.truncated ? [] : buildHunks(diff.ops)
          const status =
            current === null
              ? 'missing'
              : diff.added === 0 && diff.removed === 0
                ? 'unchanged'
                : 'modified'
          entries.push({
            path: record.path,
            status,
            added: diff.added,
            removed: diff.removed,
            truncated: diff.truncated,
            hunks,
          })
        }
        return { entries }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'checkpoint_status',
      description: 'Diagnostics for the checkpoint plugin: captured targets, persistent store path, and hook counters.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            ready: { type: 'boolean' },
            unavailableReason: { type: 'string' },
            snapshots: { type: 'integer' },
            totalBytes: { type: 'integer' },
            storeFile: { type: 'string' },
            events: {
              type: 'object',
              properties: {
                preExecute: { type: 'integer' },
                inspected: { type: 'integer' },
                shellScanned: { type: 'integer' },
                captured: { type: 'integer' },
                droppedOnLoad: { type: 'integer' },
              },
              required: ['preExecute', 'inspected', 'shellScanned', 'captured', 'droppedOnLoad'],
              additionalProperties: false,
            },
            skipped: {
              type: 'object',
              properties: {
                missing: { type: 'integer' },
                notFile: { type: 'integer' },
                tooLarge: { type: 'integer' },
                unreadable: { type: 'integer' },
                noPath: { type: 'integer' },
                outside: { type: 'integer' },
                excluded: { type: 'integer' },
              },
              required: ['missing', 'notFile', 'tooLarge', 'unreadable', 'noPath', 'outside', 'excluded'],
              additionalProperties: false,
            },
            lastSkip: { type: 'string' },
          },
          required: ['ready', 'snapshots', 'totalBytes', 'storeFile', 'events', 'skipped'],
          additionalProperties: false,
        },
        render(_args, value) {
          const events = value?.events ?? {}
          const skipped = value?.skipped ?? {}
          const lines = [
            `快照 ${value?.snapshots ?? 0} 个，共 ${value?.totalBytes ?? 0} 字节`,
            `存档：${value?.storeFile ?? '?'}`,
            `前置事件 ${events.preExecute ?? 0} 次（write/edit ${events.inspected ?? 0}，shell 扫描 ${events.shellScanned ?? 0}），累计捕获 ${events.captured ?? 0}`,
            `加载时丢弃失效快照 ${events.droppedOnLoad ?? 0} 个（文件与父目录都已不存在的旧路径）`,
            `跳过：missing ${skipped.missing ?? 0} / notFile ${skipped.notFile ?? 0} / tooLarge ${skipped.tooLarge ?? 0} / unreadable ${skipped.unreadable ?? 0} / noPath ${skipped.noPath ?? 0} / outside ${skipped.outside ?? 0} / excluded ${skipped.excluded ?? 0}`,
          ]
          if (value?.ready === false) lines.unshift(`不可用：${value?.unavailableReason || '未知原因'}`)
          return [text(lines.join('\n'))]
        },
      },
      async execute() {
        const writability = probeStoreWritable(storeDir)
        return {
          ready: writability.ready,
          unavailableReason: writability.reason,
          snapshots: records.size,
          totalBytes,
          storeFile,
          events: {
            preExecute: stats.preExecute,
            inspected: stats.inspected,
            shellScanned: stats.shellScanned,
            captured: stats.capturedCount,
            droppedOnLoad: stats.droppedOnLoad,
          },
          skipped: { ...stats.skipped },
          lastSkip: stats.lastSkip ?? '',
        }
      },
    }),
  )
}
