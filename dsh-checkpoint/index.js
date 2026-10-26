/**
 * dsh-checkpoint —— agent 文件改动的「写前快照 + 一键回滚」（v1.3）。
 *
 * 抓取原则：**只记用户/工作区文件，不记系统与插件自身目录**（excludeDirs = protectDirs + 数据目录）。
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

import { promises as fsp, writeFileSync, readFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-checkpoint'
export const inject = ['tools', 'fs']

const DEFAULT_MAX_BYTES = 1024 * 1024 // 单文件上限 1 MiB
const MAX_SNAPSHOTS = 200
const TOTAL_BUDGET = 64 * 1024 * 1024 // 快照总量上限 64 MiB
const TARGET_TOOLS = new Set(['write', 'edit'])
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'sh', 'shell', 'terminal'])
const DESTRUCTIVE =
  /\b(?:Remove-Item|del|erase|rmdir|rm|Move-Item|mv|ren|Rename-Item|Clear-Content|Set-Content|Add-Content|Out-File|truncate)\b|(?:^|[\s;&|])sed\s+(?:-\w+\s+)*-i\b|>>?\s*\S/i

const text = (value) => ({ type: 'text', text: value })

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

/** 目标匹配：全等 / 唯一后缀 / 目录前缀 / 文件名片段（`path` 传目录或文件名的一部分都能命中） */
function pathMatches(recordPath, needle) {
  const r = normalizePath(recordPath)
  const n = normalizePath(needle)
  if (r === n || r.endsWith(`/${n}`) || n.endsWith(`/${r}`) || r.includes(`/${n}/`)) return true
  // 文件名片段：用户手打 "hermes-lessons" 也能命中 "hermes-lessons-for-dsh.md"
  if (n.includes('/')) return false
  const base = r.slice(r.lastIndexOf('/') + 1)
  return base.includes(n)
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
  const protectDirs = Array.isArray(config?.protectDirs)
    ? config.protectDirs.filter((dir) => typeof dir === 'string' && dir.trim() !== '').map((dir) => path.resolve(dir.trim()))
    : []

  /** 目标是否落在受保护目录里（回滚/删除需要 confirm） */
  function isProtected(osPath) {
    if (typeof osPath !== 'string' || osPath === '') return false
    return protectDirs.some((dir) => isInside(dir, osPath))
  }

  // 采集排除（UX 优先）：受保护目录 + 本插件自己的数据目录都不进账本。
  // 理由：用户不该因为"改插件源码"或"插件自己写数据"而看到一堆内部快照。
  const excludeDirs = [...protectDirs, path.resolve(storeDir)]

  function isExcluded(osPath) {
    if (typeof osPath !== 'string' || osPath === '') return false
    return excludeDirs.some((dir) => isInside(dir, osPath))
  }

  /** key(normalized path) -> { path, content: string | null, bytes, capturedAt, created } */
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

  // ---------- 持久化 ----------
  function serialize() {
    return JSON.stringify({
      version: 2,
      savedAt: new Date().toISOString(),
      records: [...records.values()],
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
  async function captureTarget(target, allowCreated) {
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
    await captureTarget(target, true)
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
      await captureTarget(target, false)
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
      throw new Error('当前沙箱策略是 read-only，拒绝删除文件。')
    }
    if (policy && policy.mode === 'workspace-write' && !isInside(policy.workspaceRoot, osPath)) {
      throw new Error(`目标不在工作区内，拒绝删除：${osPath}`)
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
          return [
            text(`共 ${files.length} 个可回滚目标（修改 ${files.length - created} / 新建 ${created}）：\n${lines.join('\n')}${more}`),
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
        return { total: files.length, files }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'checkpoint_restore',
      description:
        'Restore files captured before this agent modified them, and delete files this agent created. Pass "path" for one target, or "all": true for everything.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute or display path to restore. A unique path suffix is accepted too.',
          },
          all: { type: 'boolean', description: 'Restore/delete every captured target. Requires confirm: true.' },
          confirm: {
            type: 'boolean',
            description:
              'Required together with "all": true. Acknowledges that the rollback rewrites/deletes every captured target, which can include live plugin sources.',
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
          },
          required: ['restored', 'failed'],
          additionalProperties: false,
        },
        render(_args, value) {
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
          return [text(lines.length > 0 ? lines.join('\n') : '没有可回滚的快照。')]
        },
      },
      async execute(args, exec) {
        const all = args?.all === true
        const wanted = typeof args?.path === 'string' && args.path.trim() !== '' ? args.path.trim() : undefined
        if (!all && wanted === undefined) {
          throw new Error('checkpoint_restore 需要 path（回滚单个目标），或传 all: true + confirm: true（回滚全部）。')
        }
        if (all && args?.confirm !== true) {
          throw new Error(
            `回滚全部（all: true）会重写/删除当前全部 ${records.size} 个快照目标，其中可能包含正在运行的插件源码。先看影响范围请用 checkpoint_diff 的 all: true；确认要回滚请显式传 confirm: true。只想丢弃快照、不动文件，用 checkpoint_forget。`,
          )
        }

        let targets = [...records.entries()]
        if (!all) {
          targets = targets.filter(([, record]) => pathMatches(record.path, wanted))
          if (targets.length === 0) {
            throw new Error(`没有匹配到快照：${wanted}。先用 checkpoint_list 查看可回滚的目标。`)
          }
        }

        const policy = resolveRestorePolicy(exec)
        const restored = []
        const failed = []
        const confirmed = args?.confirm === true
        for (const [key, record] of targets) {
          restoring.add(key)
          try {
            const target = await fs.resolve(record.path)
            const osPath = typeof fs.processPath === 'function' ? fs.processPath(target) : record.path
            if (!confirmed && isProtected(osPath)) {
              failed.push({
                path: record.path,
                reason: '目标在受保护目录（protectDirs）里，回滚/删除需要显式传 confirm: true。',
              })
              continue
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
        return { restored, failed }
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
          path: { type: 'string', description: 'Absolute or display path (unique suffix accepted, directory prefix matches too).' },
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
          throw new Error('checkpoint_forget 需要 path（丢弃单个目标），或传 all: true（丢弃全部）。')
        }
        const forgotten = []
        for (const [key, record] of [...records.entries()]) {
          if (all || pathMatches(record.path, wanted)) {
            records.delete(key)
            totalBytes -= record.bytes
            forgotten.push(record.path)
          }
        }
        if (forgotten.length > 0) schedulePersist()
        return { forgotten, remaining: records.size }
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
          path: { type: 'string', description: 'Absolute or display path (a unique suffix is accepted).' },
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
          throw new Error('checkpoint_diff 需要 path（对比单个目标），或传 all: true（对比全部）。')
        }

        let targets = [...records.entries()]
        if (!all) {
          targets = targets.filter(([, record]) => pathMatches(record.path, wanted))
          if (targets.length === 0) {
            throw new Error(`没有匹配到快照：${wanted}。先用 checkpoint_list 查看可对比的目标。`)
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
          required: ['snapshots', 'totalBytes', 'storeFile', 'events', 'skipped'],
          additionalProperties: false,
        },
        render(_args, value) {
          const events = value?.events ?? {}
          const skipped = value?.skipped ?? {}
          return [
            text(
              [
                `快照 ${value?.snapshots ?? 0} 个，共 ${value?.totalBytes ?? 0} 字节`,
                `存档：${value?.storeFile ?? '?'}`,
                `前置事件 ${events.preExecute ?? 0} 次（write/edit ${events.inspected ?? 0}，shell 扫描 ${events.shellScanned ?? 0}），累计捕获 ${events.captured ?? 0}`,
                `加载时丢弃失效快照 ${events.droppedOnLoad ?? 0} 个（文件与父目录都已不存在的旧路径）`,
                `跳过：missing ${skipped.missing ?? 0} / notFile ${skipped.notFile ?? 0} / tooLarge ${skipped.tooLarge ?? 0} / unreadable ${skipped.unreadable ?? 0} / noPath ${skipped.noPath ?? 0} / outside ${skipped.outside ?? 0} / excluded ${skipped.excluded ?? 0}`,
              ].join('\n'),
            ),
          ]
        },
      },
      async execute() {
        return {
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
