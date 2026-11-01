/**
 * dsh-updater —— 基于 git 的插件更新器 + GitHub 学习台。
 *
 * 解决什么问题：本机有一堆手写插件（`D:\AI\dsh-bundles\*`），它们的上游在 GitHub 或别的
 * git 远端。想让它们"从远端长进"就需要一条可验证、可回退的通道，而不是手工覆盖文件。
 *
 * 两半能力：
 *
 *   A. 版本同步（机械、不烧 token）
 *      `updater_check`  → 用 `git ls-remote` 比对远端提交与本机已应用提交（零 API 配额）
 *      `updater_apply`  → 克隆到暂存 → 校验 → 算差异 → 整目录备份 → 落位
 *      `updater_rollback` → 从备份恢复，且**先把当前状态再备一份**，回滚本身可再回滚
 *
 *   B. GitHub 学习台（给 agent 用，插件自己不调模型）
 *      `updater_study` → `git clone --depth 1` 一个公开仓库到本地，出源码地图 + 关键文件预览
 *      之后 agent 用 read/grep 自己读、自己提炼、自己产 diff。
 *
 * 为什么 B 不在插件里调 LLM：插件一旦自己调模型，就要配 key、要计费、结果不可预期，
 * 而且会把"学习"这个本该由 agent 主导的过程塞进一个黑盒。插件只负责搬运和索引，
 * 推理交回 agent —— 这样每一步都可检查、可复现。
 *
 * 为什么全走 git 而不是 GitHub API：实测未认证 API 只有 60 次/小时，且
 * `raw.githubusercontent.com` 在本机被单独干扰（超时）。git 协议两个问题都没有，
 * `git ls-remote` 实测 1.3 秒。
 *
 * 刻意的取舍：
 *   - **不自己重载插件**：`updater_apply` 只把文件落到本地目录，重载（remove_bundle +
 *     install_bundle）必须由 agent 调 `plugin_manager` 完成。插件内没有、也不该有
 *     plugin_manager 服务，自己改 profile 会绕开它的校验。
 *   - **默认不删本地多余文件**（prune 默认 false）：本机插件常有人工改动，盲目对齐会让
 *     它们消失。要完全对齐得显式传 prune: true。
 *   - **写入受 allowedRoots 闸门限制**：只允许写登记过的、位于白名单根目录下的 localDir，
 *     拒绝 profile / DSH_HOME / 系统目录，防止配置写错时把环境搞坏。
 *   - **备份是整目录的**（除 node_modules）：回滚必须能精确还原，省这点空间不值得。
 *
 * 已知边界：
 *   - 只支持 git 远端（GitHub / 任意 https git / 本地裸仓库）。没有 git 就整体不可用。
 *   - `ref` 支持分支名和 tag；提交 SHA 只能作为 ref 传来自动 fetch，不能直接 `--branch`。
 *   - 不做 merge：本地的人工改动不会与新版合并，apply 是"新版覆盖 + 备份留证"。
 *   - 不跟踪远端版本号：check 比的是提交 SHA，`package.json` 的版本号只在 apply 后可见。
 *   - 私有仓库需要本机 git 凭据；插件不处理认证，失败会把 git 的 stderr 原样带出来。
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-updater'
export const inject = ['tools', 'subprocess']

const STATE_VERSION = 1
const MAX_COLLECT_BYTES = 16 * 1024 * 1024
const MAX_TREE_ENTRIES = 240
const MAX_PREVIEW_CHARS = 3500
const MAX_DIFF_CHARS = 12000
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '.turbo', 'dist-cache'])
// 只拦真正危险的目标。刻意不按 "AppData" 这类宽泛词拦：用户完全可能把插件放在
// 某个临时或用户目录下，白名单 already 是主闸门，这里只加一层防"白名单配错"的保险。
const PROTECTED_SEGMENTS = ['windows', 'program files', 'program files (x86)', 'programdata', '.dsh']

// ---------------------------------------------------------------- 通用小工具

const toPosix = (value) => value.split(path.sep).join('/')

function pad(n) {
  return String(n).padStart(2, '0')
}

/** 目录名用的时间戳：20261027-223501234（毫秒级；同一秒内的备份名字序必须仍然等于创建序） */
function stamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${String(date.getMilliseconds()).padStart(3, '0')}`
}

function shortSha(sha) {
  return typeof sha === 'string' && sha.length >= 8 ? sha.slice(0, 8) : ''
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * child 是否在 parent 之内（含相等）。用 path.relative 判断，跨盘符也安全。
 * Windows 路径大小写不敏感，这里统一小写后再比，避免 `D:\AI` 与 `d:\ai` 被判定为越界。
 */
function isInside(parent, child) {
  const fold = (value) => {
    const resolved = path.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  const relative = path.relative(fold(parent), fold(child))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** 递归列出文件（跳过 node_modules / .git 等）。 */
function walkFiles(root, options = {}) {
  const { limit = 8000, maxDepth = 12, skipDirs = SKIP_DIRS } = options
  const out = []
  const walk = (dir, depth) => {
    if (out.length >= limit || depth > maxDepth) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= limit) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue
        walk(full, depth + 1)
      } else if (entry.isFile()) {
        out.push(full)
      }
    }
  }
  walk(root, 0)
  return out
}

/**
 * 删除目录/文件。
 *
 * Windows 上两个坑叠在一起：
 *   1. `fs.rmSync` 的 `force` 只忽略 ENOENT，遇到 EPERM 照样抛；
 *   2. git 在 Windows 上创建的 `.git/objects/**` 对象文件带**只读位**，可能删不掉。
 * 先正常删；失败就递归摘掉只读位再删一次。克隆暂存目录每次都带 .git，这是热路径。
 */
function forceRm(target) {
  if (!existsSync(target)) return
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 })
    return
  } catch {
    /* 落到下面摘只读重试 */
  }
  const stack = [target]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries = []
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else {
        try {
          chmodSync(full, 0o666)
        } catch {
          /* 摘不掉就跳过 */
        }
      }
    }
  }
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 80 })
}

function dirBytes(root) {
  let total = 0
  for (const file of walkFiles(root, { limit: 20000 })) {
    try {
      total += statSync(file).size
    } catch {
      /* 文件在扫描中被删：忽略 */
    }
  }
  return total
}

function readTextPreview(file, maxChars = MAX_PREVIEW_CHARS) {
  try {
    const stat = statSync(file)
    if (stat.size > 512 * 1024) return { text: '', truncated: true, note: `文件较大（${Math.round(stat.size / 1024)} KB），未内联` }
    const raw = readFileSync(file, 'utf8')
    if (raw.length <= maxChars) return { text: raw, truncated: false, note: '' }
    return { text: `${raw.slice(0, maxChars)}\n…（已截断，共 ${raw.length} 字符）`, truncated: true, note: '' }
  } catch {
    return { text: '', truncated: false, note: '读不了' }
  }
}

/** 仓库 URL → 稳定的目录名。 */
function slugOf(repo) {
  const clean = String(repo)
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
  const parts = clean.split('/').filter(Boolean)
  const tail = parts.length >= 2 ? parts.slice(-2) : parts
  const slug = tail.join('-').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
  return slug || 'repo'
}

/** 归一化远端地址，去掉末尾 .git 便于比较。 */
function normalizeRepo(repo) {
  return String(repo).trim().replace(/\/+$/, '').replace(/\.git$/i, '')
}

// ---------------------------------------------------------------- 校验门

/**
 * 一个目录能不能当作可安装的 DSH 插件 bundle？
 * 只做静态和语法检查，不执行插件代码。
 */
function inspectBundle(root) {
  const issues = []
  const err = (code, message) => issues.push({ level: 'error', code, message })
  const warn = (code, message) => issues.push({ level: 'warn', code, message })

  const pkgFile = path.join(root, 'package.json')
  if (!existsSync(pkgFile)) {
    err('no-package', '缺 package.json')
    return { ok: false, issues, name: '', version: '', patch: '', jsFiles: [] }
  }

  const pkg = readJson(pkgFile)
  if (!pkg || typeof pkg !== 'object') {
    err('bad-package', 'package.json 不是合法 JSON')
    return { ok: false, issues, name: '', version: '', patch: '', jsFiles: [] }
  }

  const patchRel = pkg?.dsh?.bundle?.patch
  if (typeof patchRel !== 'string' || patchRel.trim() === '') {
    err('no-bundle-patch', 'package.json 缺 dsh.bundle.patch')
  } else if (!existsSync(path.join(root, patchRel))) {
    err('missing-patch-file', `dsh.bundle.patch 指向的 ${patchRel} 不存在`)
  }

  const entryRel = typeof pkg.exports?.['.'] === 'string' ? pkg.exports['.'] : './index.js'
  if (!existsSync(path.join(root, entryRel))) err('missing-entry', `入口 ${entryRel} 不存在`)

  const jsFiles = walkFiles(root, { skipDirs: new Set(['node_modules', '.git', 'dist', 'lib']) })
    .filter((file) => file.endsWith('.js') || file.endsWith('.mjs'))
    .filter((file) => {
      const base = path.basename(file)
      return base === 'index.js' || base === 'client.js' || base === 'index.mjs' || path.dirname(file) === root
    })

  const entryFile = path.join(root, entryRel)
  if (existsSync(entryFile)) {
    let source = ''
    try {
      source = readFileSync(entryFile, 'utf8')
    } catch {
      source = ''
    }
    const hasApply = /export\s+(async\s+)?function\s+apply\b/.test(source)
    const hasDefault = /^\s*export\s+default\b/m.test(source)
    if (hasDefault) {
      err('default-export', `${entryRel} 用了 export default：Loader 的 unwrapExports 会丢掉 inject（官方 postmortem 0001），只允许 export function apply`)
    } else if (!hasApply) {
      err('no-export-form', `${entryRel} 没有 export function apply`)
    }
  }

  if (!existsSync(path.join(root, 'icon.svg')) && !existsSync(path.join(root, 'icon.png'))) {
    warn('no-icon', '没有 icon.svg / icon.png，插件列表会显示默认图标')
  }
  const localeDir = path.join(root, 'locale')
  if (!existsSync(localeDir)) warn('no-locale', '没有 locale/ 目录，标题和描述会回落到 package.json')

  return {
    ok: issues.every((issue) => issue.level !== 'error'),
    issues,
    name: typeof pkg.name === 'string' ? pkg.name : '',
    version: typeof pkg.version === 'string' ? pkg.version : '',
    patch: typeof patchRel === 'string' ? patchRel : '',
    jsFiles,
  }
}

// ---------------------------------------------------------------- 插件主体

export function apply(ctx, config) {
  const storeDir = (() => {
    const fromConfig = typeof config?.storeDir === 'string' ? config.storeDir.trim() : ''
    if (fromConfig !== '') return path.resolve(fromConfig)
    const profileDir = process.env.DSH_PROFILE_DIR
    if (profileDir) return path.join(profileDir, 'dsh-updater')
    return path.join(os.homedir(), '.dsh', 'dsh-updater')
  })()

  const allowedRoots = (() => {
    const list = Array.isArray(config?.allowedRoots) ? config.allowedRoots : []
    const cleaned = list.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => path.resolve(item.trim()))
    return cleaned.length > 0 ? cleaned : [path.resolve('D:\\AI\\dsh-bundles')]
  })()

  const backupsToKeep = Number.isInteger(config?.backupsToKeep) && config.backupsToKeep > 0 ? Math.min(config.backupsToKeep, 50) : 5
  const gitTimeoutMs =
    Number.isInteger(config?.gitTimeoutMs) && config.gitTimeoutMs > 0 ? Math.min(config.gitTimeoutMs, 600000) : 120000

  const stateFile = path.join(storeDir, 'sources.json')
  const backupsDir = path.join(storeDir, 'backups')
  const stagingDir = path.join(storeDir, 'staging')
  const learnDir = path.join(storeDir, 'learn')

  const tools = ctx.tools
  const subprocess = ctx.subprocess

  let state = { version: STATE_VERSION, sources: {}, studies: {} }

  function load() {
    const parsed = readJson(stateFile)
    if (parsed?.version === STATE_VERSION && parsed?.sources && typeof parsed.sources === 'object') {
      state = {
        version: STATE_VERSION,
        sources: parsed.sources,
        studies: parsed.studies && typeof parsed.studies === 'object' ? parsed.studies : {},
      }
    }
  }

  function persist() {
    try {
      mkdirSync(storeDir, { recursive: true })
      const body = JSON.stringify(state, null, 2)
      const temp = `${stateFile}.tmp`
      writeFileSync(temp, body, 'utf8')
      try {
        renameSync(temp, stateFile)
      } catch {
        // rename 在个别文件系统上不能覆盖已有文件：退化成直接写
        writeFileSync(stateFile, body, 'utf8')
        rmSync(temp, { force: true })
      }
      return true
    } catch {
      return false
    }
  }

  load()

  // ------------------------------------------------------------ git 执行层

  let gitPathCache = null

  async function gitExecutable() {
    if (gitPathCache) return gitPathCache
    const resolved = await subprocess.resolveExecutable('git')
    if (!resolved) throw new Error('本机找不到 git，插件更新器不可用')
    gitPathCache = resolved
    return resolved
  }

  /**
   * 跑一条 git 命令。清空 credential helper 与 askPass，避免在无终端的 Host 进程里
   * 卡在一个等密码的提示上；私有仓库会直接失败并把 stderr 原样带回。
   *
   * `core.autocrlf=false` 是必须的：本机全局配置若开着 autocrlf，新克隆下来的文本文件
   * 会变成 CRLF，而本地插件是 LF，apply 就会把所有文件行尾改掉 —— 实测在 eva-theme 上
   * 表现为 57 个文件"全部改动"。强制关闭后两边都按仓库里的原样字节比较。
   */
  async function git(args, options = {}) {
    // cwd 必须给一个真实目录：DSH 的 subprocess.spawn 拿到 undefined 的 cwd 会在内部
    // 解引用时崩掉（报 "Cannot read properties of undefined (reading 'includes')"），
    // 而这个错误会被下面的 catch 伪装成 git 失败。Host 进程的 cwd 是 profile 目录，
    // 作为一条 git 命令的工作目录无副作用（clone 的目标是绝对路径）。
    const { cwd = process.cwd(), signal, timeoutMs = gitTimeoutMs } = options
    const exe = await gitExecutable()
    const argv = [
      exe,
      '-c', 'credential.helper=',
      '-c', 'core.askPass=',
      '-c', 'core.autocrlf=false',
      '-c', 'core.eol=lf',
      '-c', 'http.lowSpeedLimit=1000',
      '-c', 'http.lowSpeedTime=30',
      ...args,
    ]
    let handle
    try {
      handle = subprocess.spawn({
        argv,
        cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: MAX_COLLECT_BYTES }, stderr: { maxBytes: 1024 * 1024 } },
        graceMs: 2000,
        signal,
      })
    } catch (error) {
      return { code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error), timedOut: false }
    }

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        handle.terminate()
      } catch {
        /* 已退出 */
      }
    }, timeoutMs)

    let outcome = { exitCode: null, signal: null }
    try {
      outcome = await handle.done
    } catch {
      /* 提供方失败：按错误处理 */
    } finally {
      clearTimeout(timer)
    }

    return {
      code: typeof outcome?.exitCode === 'number' ? outcome.exitCode : -1,
      stdout: handle.collected?.stdout?.readFrom(0).text ?? '',
      stderr: handle.collected?.stderr?.readFrom(0).text ?? '',
      timedOut,
    }
  }

  /** 对一组 js 文件做语法检查（node --check），不执行代码。 */
  async function syntaxCheck(files, signal) {
    const problems = []
    let nodeExe = null
    try {
      nodeExe = await subprocess.resolveExecutable('node')
    } catch {
      nodeExe = null
    }
    if (!nodeExe) {
      return [{ level: 'warn', code: 'no-node', message: '找不到 node，跳过语法检查' }]
    }
    for (const file of files.slice(0, 20)) {
      let handle
      try {
        handle = subprocess.spawn({
          argv: [nodeExe, '--check', file],
          cwd: path.dirname(file),
          stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
          graceMs: 1000,
          signal,
        })
      } catch (error) {
        problems.push({ level: 'warn', code: 'syntax-spawn', message: `${path.basename(file)} 语法检查启动失败` })
        continue
      }
      let outcome = { exitCode: null }
      try {
        outcome = await handle.done
      } catch {
        /* 忽略 */
      }
      if (outcome?.exitCode !== 0) {
        const stderr = handle.collected?.stderr?.readFrom(0).text ?? ''
        const firstLine = stderr.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '未知语法错误'
        problems.push({ level: 'error', code: 'syntax', message: `${path.basename(file)}: ${firstLine}` })
      }
    }
    return problems
  }

  // ------------------------------------------------------------ 源登记

  function findSource(sourceName) {
    const key = typeof sourceName === 'string' ? sourceName.trim() : ''
    if (key === '') return { error: '缺少 name' }
    const source = state.sources[key]
    if (!source) {
      const known = Object.keys(state.sources)
      return {
        error: `未登记名为 ${key} 的源${known.length > 0 ? `；已登记：${known.join(', ')}` : '；还没有任何源，先用 updater_source 登记'}`,
      }
    }
    return { name: key, source }
  }

  /** 写入前的硬闸门：localDir 必须在 allowedRoots 内，且不能指向系统/配置目录。 */
  function checkWritable(localDir) {
    const resolved = path.resolve(localDir)
    const segments = toPosix(resolved).toLowerCase().split('/').filter(Boolean)

    for (const guarded of PROTECTED_SEGMENTS) {
      if (segments.includes(guarded)) {
        return { ok: false, reason: `拒绝写入受保护路径 ${resolved}（命中规则 ${guarded}）` }
      }
    }

    // DSH 自己的 profile / home 目录单独判：它们的路径可能被自定义到任何地方，
    // 光靠 .dsh 路径段覆盖不到。
    for (const envName of ['DSH_PROFILE_DIR', 'DSH_HOME']) {
      const dir = process.env[envName]
      if (typeof dir === 'string' && dir.trim() !== '' && isInside(dir.trim(), resolved)) {
        return { ok: false, reason: `拒绝写入 ${envName} 目录 ${resolved}` }
      }
    }

    const ok = allowedRoots.some((root) => isInside(root, resolved))
    if (!ok) {
      return {
        ok: false,
        reason: `目标 ${resolved} 不在 allowedRoots 白名单内（当前允许：${allowedRoots.join(', ')}）`,
      }
    }
    return { ok: true, resolved }
  }

  // ------------------------------------------------------------ 目录操作

  /** 复制 srcRoot 的全部内容到 dstRoot（覆盖同名），返回受影响的相对路径。 */
  function copyOver(srcRoot, dstRoot, relPaths) {
    const touched = []
    for (const relPath of relPaths) {
      const src = path.join(srcRoot, relPath)
      const dst = path.join(dstRoot, relPath)
      mkdirSync(path.dirname(dst), { recursive: true })
      copyFileSync(src, dst)
      touched.push(relPath)
    }
    return touched
  }

  /**
   * 整目录备份到一个新目录。
   *
   * 刻意**不备份 .git / node_modules**：apply 只覆盖和新增文件，从不改动 .git，
   * 所以 .git 不需要进备份；而 .git 可能是几十 MB，备份它纯粹浪费空间。
   * 还原时同理不会删 .git —— 它在 SKIP_DIRS 里，删除逻辑会跳过。
   */
  function backupDir(sourceDir, destination) {
    const files = walkFiles(sourceDir)
    const root = path.join(destination, 'tree')
    for (const file of files) {
      const relPath = toPosix(path.relative(sourceDir, file))
      const target = path.join(root, relPath)
      mkdirSync(path.dirname(target), { recursive: true })
      copyFileSync(file, target)
    }
    return { dir: destination, files: files.length }
  }

  /** 用备份目录替换目标目录的内容（保留 .git、node_modules 这类跳过项）。 */
  function restoreDir(backupTree, targetDir) {
    const files = walkFiles(backupTree)
    const wanted = new Set(files.map((file) => toPosix(path.relative(backupTree, file))))
    let removed = 0
    for (const file of walkFiles(targetDir)) {
      const relPath = toPosix(path.relative(targetDir, file))
      if (!wanted.has(relPath) && !relPath.split('/').some((part) => SKIP_DIRS.has(part))) {
        try {
          rmSync(file, { force: true })
          removed += 1
        } catch {
          /* 删不掉就留着，不阻塞还原 */
        }
      }
    }
    const restored = []
    for (const file of files) {
      const relPath = toPosix(path.relative(backupTree, file))
      const dst = path.join(targetDir, relPath)
      mkdirSync(path.dirname(dst), { recursive: true })
      copyFileSync(file, dst)
      restored.push(relPath)
    }
    return { restored: restored.length, removed }
  }

  /** 备份目录的创建时间（毫秒）。名字可能同秒或被人工重命名，排序只能看文件系统时间。 */
  function backupCreatedMs(root, name) {
    try {
      const st = statSync(path.join(root, name))
      return Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs
    } catch {
      return 0
    }
  }

  /** 按创建时间升序排序（同时间用名字兜底，保证确定性）。 */
  function sortByCreatedAt(root, names) {
    return names.sort((a, b) => {
      const diff = backupCreatedMs(root, a) - backupCreatedMs(root, b)
      if (diff !== 0) return diff
      return a < b ? -1 : a > b ? 1 : 0
    })
  }

  function pruneBackups(sourceName) {
    const root = path.join(backupsDir, sourceName)
    if (!existsSync(root)) return 0
    let deleted = 0
    const pruneGroup = (prefixFilter, keep) => {
      let entries = []
      try {
        entries = readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && prefixFilter(entry.name))
          .map((entry) => entry.name)
        entries = sortByCreatedAt(root, entries)
      } catch {
        return
      }
      while (entries.length > keep) {
        const victim = entries.shift()
        try {
          forceRm(path.join(root, victim))
          deleted += 1
        } catch {
          /* 忽略 */
        }
      }
    }
    // 正常备份按 backupsToKeep 限流；回滚时留的安全备份单独限流，避免无限增长
    pruneGroup((name) => !name.startsWith('safety-'), backupsToKeep)
    pruneGroup((name) => name.startsWith('safety-'), 3)
    return deleted
  }

  function listBackups(sourceName) {
    const root = path.join(backupsDir, sourceName)
    if (!existsSync(root)) return []
    try {
      const names = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('safety-'))
        .map((entry) => entry.name)
      return sortByCreatedAt(root, names)
    } catch {
      return []
    }
  }

  // ------------------------------------------------------------ 克隆

  /**
   * 把仓库克隆到暂存目录，返回插件根目录和提交。
   * 只取一条提交（--depth 1），学习场景不需要历史。
   */
  async function cloneTo(repo, ref, destination, signal) {
    // 顺序要紧：先把父目录建出来，再删旧目标。反过来的话，在 Windows 上删一个
    // 「父链都不存在」的路径会报 EPERM（实测），而不是安静地什么都不做。
    mkdirSync(path.dirname(destination), { recursive: true })
    forceRm(destination)

    const isSha = /^[0-9a-f]{7,40}$/i.test(ref ?? '')
    const cloneArgs = ['clone', '--depth', '1', '--quiet', '--no-tags']
    if (ref && ref !== 'HEAD' && !isSha) cloneArgs.push('--branch', ref)
    cloneArgs.push(repo, destination)

    const cloned = await git(cloneArgs, { signal })
    if (cloned.code !== 0) {
      return {
        ok: false,
        error: cloned.timedOut ? 'git clone 超时' : `git clone 失败：${(cloned.stderr || cloned.stdout).trim().slice(0, 600)}`,
      }
    }

    if (isSha) {
      const fetched = await git(['fetch', '--depth', '1', '--quiet', 'origin', ref], { cwd: destination, signal })
      if (fetched.code !== 0) {
        return { ok: false, error: `git fetch ${ref} 失败：${(fetched.stderr || fetched.stdout).trim().slice(0, 400)}` }
      }
      const checked = await git(['checkout', '--quiet', 'FETCH_HEAD'], { cwd: destination, signal })
      if (checked.code !== 0) {
        return { ok: false, error: `git checkout ${ref} 失败：${(checked.stderr || checked.stdout).trim().slice(0, 400)}` }
      }
    }

    const head = await git(['rev-parse', 'HEAD'], { cwd: destination, signal })
    return { ok: true, dir: destination, sha: head.code === 0 ? head.stdout.trim() : '' }
  }

  /**
   * 两个文件的关系：same 内容相同 / eol 只有行尾（CRLF↔LF）不同 / differ 真不同。
   *
   * 分出 eol 这一档是因为本机的插件目录里真的存在不一致：实测 `dsh-verify/package.json`
   * 是 CRLF 而其余 6 个文件是 LF。这类差异 apply 会顺手规范化成仓库里的 LF，是好事，
   * 但把它混进"内容改动"里报出来，diff 会显示整个文件重写 —— 纯噪音。
   */
  function fileDiffKind(a, b) {
    try {
      const BIG = 4 * 1024 * 1024
      const sizeA = statSync(a)
      const sizeB = statSync(b)
      if (sizeA.size === sizeB.size) {
        // 同大小的大文件（音频/图片/压缩包）不逐字节读，直接视为相同，避免把内存吃满
        if (sizeA.size > BIG) return 'same'
        if (readFileSync(a).equals(readFileSync(b))) return 'same'
      } else if (sizeB.size > BIG) {
        return 'differ'
      }
      const normalize = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
      return normalize(a) === normalize(b) ? 'eol' : 'differ'
    } catch {
      return 'differ'
    }
  }

  /**
   * 比较本地目录与新版目录的**工作区文件**。
   *
   * 刻意不用 `git diff --no-index <dirA> <dirB>`：它会把 `.git/` 里的 index、pack、logs
   * 全当成差异报出来（实测在 eva-theme 上产出 57 条纯噪音，还泄漏了绝对路径），而这些
   * 文件 apply 根本不碰。这里按 walkFiles 的干净视图自己比，统计准确；unified diff 只对
   * 前 12 个改动文件生成，避免一次 spawn 几十个 git 进程拖慢工具调用。
   */
  async function diffDirs(oldDir, newDir, signal) {
    const oldFiles = walkFiles(oldDir).map((file) => toPosix(path.relative(oldDir, file)))
    const newFiles = walkFiles(newDir).map((file) => toPosix(path.relative(newDir, file)))
    const oldSet = new Set(oldFiles)
    const newSet = new Set(newFiles)

    const added = newFiles.filter((relPath) => !oldSet.has(relPath)).sort()
    const removed = oldFiles.filter((relPath) => !newSet.has(relPath)).sort()
    const changed = []
    const eolOnly = []
    for (const relPath of newFiles) {
      if (!oldSet.has(relPath)) continue
      const kind = fileDiffKind(path.join(oldDir, relPath), path.join(newDir, relPath))
      if (kind === 'differ') changed.push(relPath)
      else if (kind === 'eol') eolOnly.push(relPath)
    }
    changed.sort()
    eolOnly.sort()

    const summary = [
      `新增 ${added.length} · 改动 ${changed.length} · 删除 ${removed.length}`,
      ...added.slice(0, 40).map((relPath) => `  + ${relPath}`),
      ...changed.slice(0, 40).map((relPath) => `  ~ ${relPath}`),
      ...removed.slice(0, 40).map((relPath) => `  - ${relPath}`),
    ]
    if (added.length > 40 || changed.length > 40 || removed.length > 40) summary.push('  …（文件清单已截断）')
    if (eolOnly.length > 0) {
      summary.push(
        `仅行尾不同 ${eolOnly.length} 个（内容一致，apply 会统一成仓库里的 LF）：${eolOnly.slice(0, 8).join(', ')}${eolOnly.length > 8 ? ' …' : ''}`,
      )
    }

    const chunks = []
    for (const relPath of changed.slice(0, 12)) {
      const result = await git(
        ['diff', '--no-index', '--no-color', '--unified=2', '--', path.join(oldDir, relPath), path.join(newDir, relPath)],
        { signal, timeoutMs: 30000 },
      )
      let text = (result.stdout || '').replace(/\r\n/g, '\n')
      if (text.trim() === '') continue
      text = text.split(oldDir).join('<本地>').split(newDir).join('<新版>')
      chunks.push(text)
    }
    if (changed.length > 12) chunks.push(`…（还有 ${changed.length - 12} 个改动文件未展开）`)

    let diff = chunks.join('\n').trim()
    if (diff.length > MAX_DIFF_CHARS) diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n…（diff 已截断）`

    return {
      stat: summary.join('\n'),
      diff,
      hasChanges: added.length + changed.length + removed.length + eolOnly.length > 0,
      added,
      changed,
      eolOnly,
      removed,
    }
  }

  // ------------------------------------------------------------ 工具注册

  ctx.effect(() =>
    tools.register({
      name: 'updater_status',
      description:
        'Diagnostics for the plugin updater: where its store lives, whether git/node are resolvable, every registered update source with its local directory, installed version, last applied commit and backup footprint, plus previously cloned study repos. Call this before check/apply to confirm the gate paths and what is registered.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            ready: { type: 'boolean' },
            unavailableReason: { type: 'string' },
            storeDir: { type: 'string' },
            stateFile: { type: 'string' },
            git: { type: 'object', properties: { available: { type: 'boolean' }, path: { type: 'string' }, error: { type: 'string' } }, required: ['available', 'path', 'error'], additionalProperties: false },
            node: { type: 'object', properties: { available: { type: 'boolean' }, version: { type: 'string' } }, required: ['available', 'version'], additionalProperties: false },
            allowedRoots: { type: 'array', items: { type: 'string' } },
            backupsToKeep: { type: 'integer' },
            sources: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  repo: { type: 'string' },
                  ref: { type: 'string' },
                  subdir: { type: 'string' },
                  localDir: { type: 'string' },
                  localExists: { type: 'boolean' },
                  localVersion: { type: 'string' },
                  lastAppliedSha: { type: 'string' },
                  lastSeenSha: { type: 'string' },
                  lastCheckedAt: { type: 'string' },
                  lastAppliedAt: { type: 'string' },
                  backups: { type: 'integer' },
                  backupsBytes: { type: 'integer' },
                  insideAllowedRoot: { type: 'boolean' },
                },
                required: ['name', 'repo', 'ref', 'subdir', 'localDir', 'localExists', 'localVersion', 'lastAppliedSha', 'lastSeenSha', 'lastCheckedAt', 'lastAppliedAt', 'backups', 'backupsBytes', 'insideAllowedRoot'],
                additionalProperties: false,
              },
            },
            studies: {
              type: 'array',
              items: {
                type: 'object',
                properties: { slug: { type: 'string' }, repo: { type: 'string' }, dir: { type: 'string' }, sha: { type: 'string' }, clonedAt: { type: 'string' } },
                required: ['slug', 'repo', 'dir', 'sha', 'clonedAt'],
                additionalProperties: false,
              },
            },
          },
          required: ['ready', 'storeDir', 'stateFile', 'git', 'node', 'allowedRoots', 'backupsToKeep', 'sources', 'studies'],
          additionalProperties: false,
        },
        render(_args, value) {
          const lines = [
            `存储目录：${value?.storeDir ?? '?'}`,
            `git：${value?.git?.available ? value.git.path : `不可用（${value?.git?.error ?? '未知'}）`}`,
            `node：${value?.node?.available ? value.node.version : '不可用'}`,
            `写入白名单：${(value?.allowedRoots ?? []).join(', ')}`,
            `备份保留：${value?.backupsToKeep ?? 0} 份/源`,
            `更新源：${value?.sources?.length ?? 0} 个`,
          ]
          for (const source of value?.sources ?? []) {
            const bits = [
              `  ${source.name}`,
              `→ ${source.repo}${source.ref && source.ref !== 'HEAD' ? `@${source.ref}` : ''}`,
              `本地 ${source.localExists ? `${source.localVersion || '版本未知'}` : '缺失'}`,
              source.lastAppliedSha ? `已应用 ${source.lastAppliedSha}` : '尚未应用过',
              source.backups > 0 ? `备份 ${source.backups} 份/${Math.round(source.backupsBytes / 1024)}KB` : '无备份',
            ]
            if (!source.insideAllowedRoot) bits.push('⚠ 本地目录不在白名单内，不可写')
            lines.push(bits.join(' · '))
          }
          if ((value?.sources ?? []).length === 0) lines.push('  （还没有登记任何源；用 updater_source 登记）')
          if ((value?.studies ?? []).length > 0) {
            lines.push(`学习样本：${value.studies.length} 个`)
            for (const study of value.studies) lines.push(`  ${study.slug} ← ${study.repo}@${study.sha ? study.sha.slice(0, 8) : '?'}`)
          }
          if (value?.ready === false) lines.unshift(`不可用：${value?.unavailableReason || '未知原因'}`)
          return [text(lines.join('\n'))]
        },
      },
      async execute(args, exec) {
        let gitInfo = { available: false, path: '', error: '' }
        try {
          gitInfo = { available: true, path: await gitExecutable(), error: '' }
        } catch (error) {
          gitInfo = { available: false, path: '', error: error instanceof Error ? error.message : String(error) }
        }

        let nodeInfo = { available: false, version: '' }
        try {
          const nodeExe = await subprocess.resolveExecutable('node')
          nodeInfo = { available: Boolean(nodeExe), version: process.versions.node ?? '' }
        } catch {
          nodeInfo = { available: false, version: '' }
        }

        const sources = Object.entries(state.sources).map(([sourceName, source]) => {
          const localDir = typeof source?.localDir === 'string' ? source.localDir : ''
          const localExists = localDir !== '' && existsSync(localDir)
          const manifest = localExists ? readJson(path.join(localDir, 'package.json')) : null
          const backups = localDir === '' ? [] : listBackups(sourceName)
          let backupsBytes = 0
          for (const entry of backups) {
            const dir = path.join(backupsDir, sourceName, entry, 'tree')
            if (existsSync(dir)) backupsBytes += dirBytes(dir)
          }
          return {
            name: sourceName,
            repo: typeof source?.repo === 'string' ? source.repo : '',
            ref: typeof source?.ref === 'string' ? source.ref : 'HEAD',
            subdir: typeof source?.subdir === 'string' ? source.subdir : '',
            localDir,
            localExists,
            localVersion: typeof manifest?.version === 'string' ? manifest.version : '',
            lastAppliedSha: shortSha(source?.lastAppliedSha),
            lastSeenSha: shortSha(source?.lastSeenSha),
            lastCheckedAt: typeof source?.lastCheckedAt === 'string' ? source.lastCheckedAt : '',
            lastAppliedAt: typeof source?.lastAppliedAt === 'string' ? source.lastAppliedAt : '',
            backups: backups.length,
            backupsBytes: Math.round(backupsBytes),
            insideAllowedRoot: localDir !== '' && allowedRoots.some((root) => isInside(root, localDir)),
          }
        })

        const studies = Object.entries(state.studies).map(([slug, study]) => ({
          slug,
          repo: typeof study?.repo === 'string' ? study.repo : '',
          dir: typeof study?.dir === 'string' ? study.dir : '',
          sha: shortSha(study?.sha),
          clonedAt: typeof study?.clonedAt === 'string' ? study.clonedAt : '',
        }))

        // ready 判据：git 与 node 都解析得到才谈得上比对/校验/更新
        const missing = []
        if (!gitInfo.available) missing.push(`git 不可用（${gitInfo.error || '未知原因'}）`)
        if (!nodeInfo.available) missing.push('node 不可解析')
        const ready = missing.length === 0
        const unavailableReason = ready ? '' : missing.join('；')

        return {
          ready,
          unavailableReason,
          storeDir,
          stateFile,
          git: gitInfo,
          node: nodeInfo,
          allowedRoots,
          backupsToKeep,
          sources,
          studies,
        }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'updater_source',
      description:
        'Register, update, or remove an update source for a local plugin: which git remote it tracks (repo/ref/subdir), which local directory it lives in, and which bundle name it installs as. Registering is not required before updater_study (study takes any public repo directly), but updater_check and updater_apply only operate on registered sources so a misconfigured path can never be written.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'remove'], description: 'add registers or overwrites a source; remove forgets it (never touches files).' },
          name: { type: 'string', description: 'Short stable key for this plugin, e.g. "dsh-memory".' },
          repo: { type: 'string', description: 'Git remote URL or local bare repo path, e.g. https://github.com/me/dsh-memory.git' },
          ref: { type: 'string', description: 'Branch, tag, or commit SHA. Defaults to HEAD (the remote default branch).' },
          subdir: { type: 'string', description: 'Plugin subdirectory inside the repo when the bundle is not at the repo root. Defaults to the root.' },
          localDir: { type: 'string', description: 'Absolute local directory of the plugin, must sit inside allowedRoots.' },
          bundleName: { type: 'string', description: 'Package name as installed, e.g. @local/dsh-memory. Used only for reporting.' },
        },
        required: ['action', 'name'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            code: { type: 'string' },
            action: { type: 'string' },
            name: { type: 'string' },
            message: { type: 'string' },
            total: { type: 'integer' },
          },
          required: ['ok', 'action', 'name', 'message', 'total'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [text(`${value?.ok ? '✓' : '✗'} ${value?.message ?? ''}（当前共 ${value?.total ?? 0} 个源）`)]
        },
      },
      async execute(args) {
        const action = args?.action
        const key = typeof args?.name === 'string' ? args.name.trim() : ''
        if (key === '') return { ok: false, code: 'EMPTY_NAME', action: action ?? '', name: '', message: 'name 不能为空', total: Object.keys(state.sources).length }

        if (action === 'remove') {
          if (!state.sources[key]) return { ok: false, code: 'SOURCE_NOT_FOUND', action, name: key, message: `没有名为 ${key} 的源`, total: Object.keys(state.sources).length }
          delete state.sources[key]
          persist()
          return { ok: true, action, name: key, message: `已移除源 ${key}（本地文件未动）`, total: Object.keys(state.sources).length }
        }

        if (action !== 'add') {
          return { ok: false, code: 'INVALID_ACTION', action: action ?? '', name: key, message: 'action 只能是 add 或 remove', total: Object.keys(state.sources).length }
        }

        const repo = typeof args?.repo === 'string' ? args.repo.trim() : state.sources[key]?.repo ?? ''
        const localDir = typeof args?.localDir === 'string' ? args.localDir.trim() : state.sources[key]?.localDir ?? ''
        if (repo === '') return { ok: false, code: 'EMPTY_REPO', action, name: key, message: 'repo 不能为空', total: Object.keys(state.sources).length }
        if (localDir === '') return { ok: false, code: 'EMPTY_LOCAL_DIR', action, name: key, message: 'localDir 不能为空', total: Object.keys(state.sources).length }

        const gate = checkWritable(localDir)
        if (!gate.ok) return { ok: false, code: 'LOCAL_DIR_NOT_ALLOWED', action, name: key, message: gate.reason, total: Object.keys(state.sources).length }

        const previous = state.sources[key] ?? {}
        state.sources[key] = {
          repo,
          ref: typeof args?.ref === 'string' && args.ref.trim() !== '' ? args.ref.trim() : previous.ref ?? 'HEAD',
          subdir: typeof args?.subdir === 'string' ? args.subdir.trim().replace(/^[/\\]+|[/\\]+$/g, '') : previous.subdir ?? '',
          localDir: path.resolve(localDir),
          bundleName: typeof args?.bundleName === 'string' && args.bundleName.trim() !== '' ? args.bundleName.trim() : previous.bundleName ?? '',
          lastSeenSha: previous.lastSeenSha ?? '',
          lastAppliedSha: previous.lastAppliedSha ?? '',
          lastCheckedAt: previous.lastCheckedAt ?? '',
          lastAppliedAt: previous.lastAppliedAt ?? '',
        }
        persist()
        return {
          ok: true,
          action,
          name: key,
          message: `已登记 ${key} → ${repo}（本地 ${path.resolve(localDir)}）`,
          total: Object.keys(state.sources).length,
        }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'updater_check',
      description:
        'Compare every registered source (or one named source) against its git remote using ls-remote and report which local plugins have new upstream commits. Costs no GitHub API quota and writes nothing. Returns per-source status: up-to-date, behind, baseline-missing (never applied yet), no-local (target directory absent), or error.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Only check this registered source. Omit to check all.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            checkedAt: { type: 'string' },
            checked: { type: 'integer' },
            behind: { type: 'integer' },
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  repo: { type: 'string' },
                  ref: { type: 'string' },
                  status: { type: 'string' },
                  remoteSha: { type: 'string' },
                  localSha: { type: 'string' },
                  localVersion: { type: 'string' },
                  note: { type: 'string' },
                  code: { type: 'string' },
                },
                required: ['name', 'repo', 'ref', 'status', 'remoteSha', 'localSha', 'localVersion', 'note'],
                additionalProperties: false,
              },
            },
          },
          required: ['checkedAt', 'checked', 'behind', 'results'],
          additionalProperties: false,
        },
        render(_args, value) {
          const lines = [`检查了 ${value?.checked ?? 0} 个源，${value?.behind ?? 0} 个有新提交`]
          for (const result of value?.results ?? []) {
            const icon = result.status === 'behind' ? '↑' : result.status === 'up-to-date' ? '=' : result.status === 'error' ? '✗' : '·'
            const label =
              result.status === 'behind'
                ? '有新提交'
                : result.status === 'up-to-date'
                  ? '已是最新'
                  : result.status === 'baseline-missing'
                    ? '未建立基线（首次 apply 后即可比对）'
                    : result.status === 'no-local'
                      ? '本地目录不存在'
                      : `错误：${result.note}`
            lines.push(`  ${icon} ${result.name}  ${label}${result.remoteSha ? `  远端 ${result.remoteSha}` : ''}`)
          }
          return [text(lines.join('\n'))]
        },
      },
      async execute(args, exec) {
        const only = typeof args?.name === 'string' && args.name.trim() !== '' ? args.name.trim() : null
        const entries = Object.entries(state.sources).filter(([sourceName]) => (only ? sourceName === only : true))
        if (entries.length === 0) {
          return {
            checkedAt: new Date().toISOString(),
            checked: 0,
            behind: 0,
            results: only
              ? [{ name: only, repo: '', ref: '', status: 'error', code: 'SOURCE_NOT_FOUND', remoteSha: '', localSha: '', localVersion: '', note: `没有登记名为 ${only} 的源` }]
              : [],
          }
        }

        const results = await Promise.all(
          entries.map(async ([sourceName, source]) => {
            const repo = typeof source?.repo === 'string' ? source.repo : ''
            const ref = typeof source?.ref === 'string' && source.ref !== '' ? source.ref : 'HEAD'
            const localDir = typeof source?.localDir === 'string' ? source.localDir : ''
            const manifest = existsSync(localDir) ? readJson(path.join(localDir, 'package.json')) : null
            const localVersion = typeof manifest?.version === 'string' ? manifest.version : ''
            const localSha = shortSha(source?.lastAppliedSha)

            const base = { name: sourceName, repo, ref, remoteSha: '', localSha, localVersion, note: '' }

            if (!existsSync(localDir)) {
              return { ...base, status: 'no-local', code: 'LOCAL_DIR_MISSING', note: `本地目录 ${localDir} 不存在` }
            }

            const remote = await git(['ls-remote', repo, ref === 'HEAD' ? 'HEAD' : ref], { signal: exec?.signal })
            if (remote.code !== 0) {
              return {
                ...base,
                status: 'error',
                code: 'GIT_LS_REMOTE_FAILED',
                note: (remote.timedOut ? 'ls-remote 超时' : (remote.stderr || remote.stdout).trim().split('\n')[0] || 'ls-remote 失败').slice(0, 300),
              }
            }
            const firstLine = remote.stdout.trim().split('\n')[0] ?? ''
            const remoteSha = (firstLine.split(/\s+/)[0] ?? '').trim()
            if (!/^[0-9a-f]{7,40}$/i.test(remoteSha)) {
              return { ...base, status: 'error', code: 'INVALID_REMOTE_SHA', note: `远端没返回可识别的提交（ref=${ref}）` }
            }

            const previousSeen = source?.lastSeenSha ?? ''
            state.sources[sourceName] = { ...source, lastSeenSha: remoteSha, lastCheckedAt: new Date().toISOString() }

            if (!source?.lastAppliedSha) {
              return { ...base, status: 'baseline-missing', remoteSha: shortSha(remoteSha), note: '首次比对：还没应用过更新' }
            }
            if (shortSha(source.lastAppliedSha) === shortSha(remoteSha)) {
              return { ...base, status: 'up-to-date', remoteSha: shortSha(remoteSha), note: '' }
            }
            const changedNote = previousSeen && shortSha(previousSeen) !== shortSha(remoteSha) ? '远端在上次检查后又有新提交' : '远端有新提交，先 updater_apply 再重载'
            return { ...base, status: 'behind', remoteSha: shortSha(remoteSha), note: changedNote }
          }),
        )

        persist()
        const behind = results.filter((result) => result.status === 'behind').length
        return { checkedAt: new Date().toISOString(), checked: results.length, behind, results }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'updater_apply',
      description:
        'Stages an upstream update for one registered source: shallow-clones the remote, resolves the plugin subdir, validates the bundle statically (package.json, dsh.bundle.patch, entry export form, node --check syntax), diffs it against the local directory, backs the local directory up, then copies the new files in. Pass dryRun to only clone, validate and diff with nothing written. This does NOT reload the plugin and does NOT remove local-only files unless prune is true; reload with plugin_manager remove_bundle + install_bundle afterwards. Provide name before confirm in the arguments.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Registered source key to apply.' },
          confirm: { type: 'boolean', description: 'Must be true to write anything. dryRun ignores it.' },
          dryRun: { type: 'boolean', description: 'Clone, validate and diff only; write nothing.' },
          prune: { type: 'boolean', description: 'Also delete files that exist locally but not in the new version. Defaults to false because local plugins often carry hand edits.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            ok: { type: 'boolean' },
            status: { type: 'string', enum: ['applied', 'validated', 'rejected', 'refused', 'error'] },
            code: { type: 'string' },
            stagedSha: { type: 'string' },
            previousSha: { type: 'string' },
            fromVersion: { type: 'string' },
            toVersion: { type: 'string' },
            issues: {
              type: 'array',
              items: {
                type: 'object',
                properties: { level: { type: 'string' }, code: { type: 'string' }, message: { type: 'string' } },
                required: ['level', 'code', 'message'],
                additionalProperties: false,
              },
            },
            files: { type: 'object', properties: { added: { type: 'integer' }, changed: { type: 'integer' }, removed: { type: 'integer' }, total: { type: 'integer' } }, required: ['added', 'changed', 'removed', 'total'], additionalProperties: false },
            backupDir: { type: 'string' },
            diff: { type: 'string' },
            diffStat: { type: 'string' },
            message: { type: 'string' },
            reloadHint: { type: 'string' },
          },
          required: ['name', 'ok', 'status', 'stagedSha', 'previousSha', 'fromVersion', 'toVersion', 'issues', 'files', 'backupDir', 'diff', 'diffStat', 'message', 'reloadHint'],
          additionalProperties: false,
        },
        render(_args, value) {
          const lines = [`${value?.ok ? '✓' : '✗'} ${value?.name ?? '?'} → ${value?.status ?? '?'}`]
          if (value?.fromVersion || value?.toVersion) lines.push(`  版本：${value?.fromVersion || '?'} → ${value?.toVersion || '?'}`)
          if (value?.stagedSha) lines.push(`  提交：${value?.previousSha || '（无基线）'} → ${value.stagedSha}`)
          const files = value?.files ?? {}
          if (files.total > 0) lines.push(`  文件：新增 ${files.added ?? 0} / 改动 ${files.changed ?? 0} / 删除 ${files.removed ?? 0}`)
          for (const issue of value?.issues ?? []) lines.push(`  ${issue.level === 'error' ? '✗' : '⚠'} [${issue.code}] ${issue.message}`)
          if (value?.diffStat) lines.push(`  --- diffstat ---\n${value.diffStat}`)
          if (value?.diff) lines.push(`  --- diff（前段） ---\n${value.diff.split('\n').slice(0, 40).join('\n')}`)
          if (value?.backupDir) lines.push(`  备份：${value.backupDir}`)
          if (value?.message) lines.push(`  ${value.message}`)
          if (value?.reloadHint) lines.push(`  ${value.reloadHint}`)
          return [text(lines.join('\n'))]
        },
      },
      async execute(args, exec) {
        const emptyFiles = { added: 0, changed: 0, removed: 0, total: 0 }
        const found = findSource(args?.name)
        if (found.error) {
          return {
            name: typeof args?.name === 'string' ? args.name : '',
            ok: false,
            status: 'refused',
            code: 'UNKNOWN_SOURCE',
            stagedSha: '',
            previousSha: '',
            fromVersion: '',
            toVersion: '',
            issues: [{ level: 'error', code: 'unknown-source', message: found.error }],
            files: emptyFiles,
            backupDir: '',
            diff: '',
            diffStat: '',
            message: found.error,
            reloadHint: '',
          }
        }

        const { name: sourceName, source } = found
        const repo = typeof source?.repo === 'string' ? source.repo : ''
        const ref = typeof source?.ref === 'string' && source.ref !== '' ? source.ref : 'HEAD'
        const subdir = typeof source?.subdir === 'string' ? source.subdir : ''
        const localDir = typeof source?.localDir === 'string' ? source.localDir : ''
        const dryRun = args?.dryRun === true
        const confirmed = args?.confirm === true

        const base = {
          name: sourceName,
          ok: false,
          status: 'error',
          stagedSha: '',
          previousSha: shortSha(source?.lastAppliedSha),
          fromVersion: '',
          toVersion: '',
          issues: [],
          files: emptyFiles,
          backupDir: '',
          diff: '',
          diffStat: '',
          message: '',
          reloadHint: '',
        }

        if (!dryRun && !confirmed) {
          return { ...base, status: 'refused', code: 'CONFIRM_REQUIRED', message: '这是会改本地文件的动作，需要 confirm: true。想先看差异就传 dryRun: true。' }
        }

        const gate = checkWritable(localDir)
        if (!gate.ok) return { ...base, status: 'refused', code: 'LOCAL_DIR_NOT_ALLOWED', message: gate.reason }
        if (!existsSync(localDir)) return { ...base, status: 'error', code: 'LOCAL_DIR_MISSING', message: `本地目录 ${localDir} 不存在；请先确认插件装在哪。` }
        if (repo === '') return { ...base, status: 'error', code: 'REPO_MISSING', message: '该源没有 repo 地址' }

        const localManifest = readJson(path.join(localDir, 'package.json'))
        const fromVersion = typeof localManifest?.version === 'string' ? localManifest.version : ''

        const target = path.join(stagingDir, `${sourceName}-${stamp()}`)
        const cloned = await cloneTo(repo, ref, target, exec?.signal)
        if (!cloned.ok) {
          return { ...base, fromVersion, status: 'error', code: 'CLONE_FAILED', message: cloned.error }
        }

        const pluginRoot = subdir !== '' ? path.join(cloned.dir, subdir) : cloned.dir
        if (!existsSync(pluginRoot)) {
          forceRm(target)
          return { ...base, fromVersion, stagedSha: shortSha(cloned.sha), status: 'rejected', code: 'NO_SUBDIR', message: `仓库里没有子目录 ${subdir}`, issues: [{ level: 'error', code: 'no-subdir', message: `缺少 ${subdir}` }] }
        }

        const inspected = inspectBundle(pluginRoot)
        const syntaxIssues = await syntaxCheck(inspected.jsFiles, exec?.signal)
        const issues = [...inspected.issues, ...syntaxIssues]
        const toVersion = inspected.version

        const compared = await diffDirs(localDir, pluginRoot, exec?.signal)

        if (!inspected.ok || issues.some((issue) => issue.level === 'error')) {
          forceRm(target)
          return {
            ...base,
            fromVersion,
            toVersion,
            stagedSha: shortSha(cloned.sha),
            status: 'rejected',
            code: 'VALIDATION_FAILED',
            issues,
            diff: compared.diff,
            diffStat: compared.stat,
            message: '新版没通过校验，已放弃（本地未改动）。',
          }
        }

        const newFiles = walkFiles(pluginRoot).map((file) => toPosix(path.relative(pluginRoot, file)))
        const added = compared.added
        const removedAll = compared.removed
        const files = { added: added.length, changed: compared.changed.length, removed: removedAll.length, total: newFiles.length }

        if (dryRun) {
          forceRm(target)
          return {
            ...base,
            ok: true,
            status: 'validated',
            fromVersion,
            toVersion,
            stagedSha: shortSha(cloned.sha),
            issues,
            files,
            diff: compared.diff,
            diffStat: compared.stat,
            message: compared.hasChanges
              ? '试运行通过：差异见上。确认无误后用 confirm: true 真正应用。'
              : '试运行通过：本地与新版内容没有差异。',
          }
        }

        // ---- 真正写入：先备份，再落位 ----
        const backupName = `${stamp()}-${sourceName === '' ? 'prev' : shortSha(source?.lastAppliedSha) || 'baseline'}`
        const backupPath = path.join(backupsDir, sourceName, backupName)
        let backupInfo
        try {
          backupInfo = backupDir(localDir, backupPath)
        } catch (error) {
          forceRm(target)
          return { ...base, fromVersion, toVersion, status: 'error', code: 'BACKUP_FAILED', message: `备份失败，已放弃写入：${error instanceof Error ? error.message : String(error)}` }
        }

        let removedCount = 0
        try {
          copyOver(pluginRoot, localDir, newFiles)
          if (args?.prune === true) {
            for (const relPath of removedAll) {
              try {
                rmSync(path.join(localDir, relPath), { force: true })
                removedCount += 1
              } catch {
                /* 单个删不掉不影响整体 */
              }
            }
          }
        } catch (error) {
          // 落位中途失败：立刻用刚做的备份还原，避免留下半套文件
          try {
            restoreDir(path.join(backupPath, 'tree'), localDir)
          } catch {
            /* 还原也失败：消息里点明备份位置 */
          }
          forceRm(target)
          return {
            ...base,
            fromVersion,
            toVersion,
            status: 'error',
            code: 'WRITE_FAILED',
            issues,
            files,
            backupDir: backupPath,
            diff: compared.diff,
            diffStat: compared.stat,
            message: `写入中途失败（${error instanceof Error ? error.message : String(error)}），已尝试从备份还原；备份完整保留在 ${backupPath}`,
          }
        }

        forceRm(target)

        state.sources[sourceName] = {
          ...source,
          lastAppliedSha: cloned.sha,
          lastSeenSha: cloned.sha,
          lastCheckedAt: new Date().toISOString(),
          lastAppliedAt: new Date().toISOString(),
        }
        persist()
        const prunedBackups = pruneBackups(sourceName)

        const notes = []
        if (args?.prune === true) notes.push(`按 prune 删除本地多余文件 ${removedCount} 个`)
        else if (removedAll.length > 0) notes.push(`有 ${removedAll.length} 个本地文件在新版中不存在，已保留（需要对齐就传 prune: true）`)
        if (prunedBackups > 0) notes.push(`清理了 ${prunedBackups} 份旧备份`)

        return {
          ...base,
          ok: true,
          status: 'applied',
          fromVersion,
          toVersion,
          stagedSha: shortSha(cloned.sha),
          issues,
          files: { added: added.length, changed: compared.changed.length, removed: removedCount, total: newFiles.length },
          backupDir: backupPath,
          diff: compared.diff,
          diffStat: compared.stat,
          message: [`已应用 ${backupInfo.files} 个文件到 ${localDir}`, ...notes].join('；'),
          reloadHint: '文件已就位但还没生效：用 plugin_manager 依次 remove_bundle 再 install_bundle 重载（热替换不换 JS 模块代际，必须走重装）。',
        }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'updater_rollback',
      description:
        'Restore one registered source from its most recent (or a named) apply backup. It first snapshots the current directory as a safety backup, so a rollback is itself reversible. Requires confirm: true. Like updater_apply it does not reload the plugin afterwards.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Registered source key to roll back.' },
          confirm: { type: 'boolean', description: 'Must be true to write anything.' },
          backup: { type: 'string', description: 'Backup entry name to restore. Omit for the most recent one.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            ok: { type: 'boolean' },
            status: { type: 'string', enum: ['restored', 'refused', 'error'] },
            code: { type: 'string' },
            restoredFrom: { type: 'string' },
            safetyBackup: { type: 'string' },
            files: { type: 'integer' },
            message: { type: 'string' },
            reloadHint: { type: 'string' },
          },
          required: ['name', 'ok', 'status', 'restoredFrom', 'safetyBackup', 'files', 'message', 'reloadHint'],
          additionalProperties: false,
        },
        render(_args, value) {
          const lines = [`${value?.ok ? '✓' : '✗'} ${value?.name ?? '?'} → ${value?.status ?? '?'}`]
          if (value?.restoredFrom) lines.push(`  还原自：${value.restoredFrom}`)
          if (value?.safetyBackup) lines.push(`  当前状态另存：${value.safetyBackup}`)
          if (value?.files) lines.push(`  还原文件：${value.files} 个`)
          if (value?.message) lines.push(`  ${value.message}`)
          if (value?.reloadHint) lines.push(`  ${value.reloadHint}`)
          return [text(lines.join('\n'))]
        },
      },
      async execute(args) {
        const found = findSource(args?.name)
        if (found.error) {
          return { name: typeof args?.name === 'string' ? args.name : '', ok: false, status: 'refused', code: 'UNKNOWN_SOURCE', restoredFrom: '', safetyBackup: '', files: 0, message: found.error, reloadHint: '' }
        }
        const { name: sourceName, source } = found
        const localDir = typeof source?.localDir === 'string' ? source.localDir : ''

        if (args?.confirm !== true) {
          return { name: sourceName, ok: false, status: 'refused', code: 'CONFIRM_REQUIRED', restoredFrom: '', safetyBackup: '', files: 0, message: '回滚会改本地文件，需要 confirm: true。', reloadHint: '' }
        }

        const gate = checkWritable(localDir)
        if (!gate.ok) return { name: sourceName, ok: false, status: 'refused', code: 'LOCAL_DIR_NOT_ALLOWED', restoredFrom: '', safetyBackup: '', files: 0, message: gate.reason, reloadHint: '' }

        const entries = listBackups(sourceName)
        if (entries.length === 0) {
          return { name: sourceName, ok: false, status: 'error', code: 'NO_BACKUP', restoredFrom: '', safetyBackup: '', files: 0, message: '这个源还没有任何备份，无法回滚（只应用过一次且没备份过？）', reloadHint: '' }
        }

        const wanted = typeof args?.backup === 'string' && args.backup.trim() !== '' ? args.backup.trim() : entries[entries.length - 1]
        const backupPath = path.join(backupsDir, sourceName, wanted)
        const backupTree = path.join(backupPath, 'tree')
        if (!existsSync(backupTree)) {
          return { name: sourceName, ok: false, status: 'error', code: 'BACKUP_INCOMPLETE', restoredFrom: wanted, safetyBackup: '', files: 0, message: `备份 ${wanted} 不完整（缺 tree 目录）；可选：${entries.join(', ')}`, reloadHint: '' }
        }

        // 回滚前先把当前状态另存一份，保证「回滚的回滚」也可用
        const safetyPath = path.join(backupsDir, sourceName, `safety-${stamp()}`)
        try {
          backupDir(localDir, safetyPath)
        } catch (error) {
          return { name: sourceName, ok: false, status: 'error', code: 'BACKUP_FAILED', restoredFrom: wanted, safetyBackup: '', files: 0, message: `回滚前的安全备份失败，已放弃：${error instanceof Error ? error.message : String(error)}`, reloadHint: '' }
        }

        let outcome
        try {
          outcome = restoreDir(backupTree, localDir)
        } catch (error) {
          return { name: sourceName, ok: false, status: 'error', code: 'RESTORE_FAILED', restoredFrom: wanted, safetyBackup: safetyPath, files: 0, message: `还原失败：${error instanceof Error ? error.message : String(error)}；安全备份在 ${safetyPath}`, reloadHint: '' }
        }

        // 从备份名里还原当时的提交（形如 20261027-223501-abc12345 或 -baseline）
        const marker = wanted.split('-').pop() ?? ''
        const restoredSha = /^[0-9a-f]{7,40}$/i.test(marker) ? marker : ''
        state.sources[sourceName] = {
          ...source,
          lastAppliedSha: restoredSha,
          lastAppliedAt: new Date().toISOString(),
        }
        persist()

        return {
          name: sourceName,
          ok: true,
          status: 'restored',
          restoredFrom: wanted,
          safetyBackup: safetyPath,
          files: outcome.restored,
          message: `已还原（删除 ${outcome.removed} 个多余文件/${outcome.restored} 个文件写回）。回滚前的状态保存在 ${safetyPath}。`,
          reloadHint: '需要重载才生效：plugin_manager remove_bundle + install_bundle。',
        }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'updater_study',
      description:
        'Clone a public git repo (typically on GitHub) into the updater study directory so the agent can read its source locally with normal file tools, and return a source map: file tree, package.json, README head, and entry-point previews. Use this to learn from other plugins or implementations before writing or changing code. Reuses an existing clone unless fresh is true. This tool does not call any model and does not modify any plugin.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Public repo URL or local bare repo path to study.' },
          ref: { type: 'string', description: 'Branch, tag, or commit SHA. Defaults to the remote default branch.' },
          subdir: { type: 'string', description: 'Focus on this subdirectory inside the repo instead of the root.' },
          fresh: { type: 'boolean', description: 'Re-clone even if a local copy already exists.' },
        },
        required: ['repo'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            code: { type: 'string' },
            slug: { type: 'string' },
            dir: { type: 'string' },
            focusDir: { type: 'string' },
            sha: { type: 'string' },
            reused: { type: 'boolean' },
            fileCount: { type: 'integer' },
            totalBytes: { type: 'integer' },
            tree: { type: 'array', items: { type: 'string' } },
            treeTruncated: { type: 'boolean' },
            packageJson: { type: 'string' },
            readme: { type: 'string' },
            entrypoints: {
              type: 'array',
              items: {
                type: 'object',
                properties: { path: { type: 'string' }, preview: { type: 'string' } },
                required: ['path', 'preview'],
                additionalProperties: false,
              },
            },
            message: { type: 'string' },
          },
          required: ['ok', 'slug', 'dir', 'focusDir', 'sha', 'reused', 'fileCount', 'totalBytes', 'tree', 'treeTruncated', 'packageJson', 'readme', 'entrypoints', 'message'],
          additionalProperties: false,
        },
        render(args, value) {
          if (!value?.ok) return [text(`✗ 克隆失败：${value?.message ?? '未知错误'}`)]
          const lines = [
            `✓ ${args?.repo ?? value?.slug ?? ''}${value.sha ? ` @ ${value.sha}` : ''}${value.reused ? '（复用已有副本）' : ''}`,
            `  目录：${value.focusDir || value.dir}`,
            `  文件：${value.fileCount} 个 / ${Math.round((value.totalBytes ?? 0) / 1024)} KB`,
            `  接下来用 read / grep 直接读这个目录。`,
          ]
          if (value.tree?.length > 0) lines.push(`  结构（前 ${Math.min(value.tree.length, 40)} 项）：\n${value.tree.slice(0, 40).map((item) => `    ${item}`).join('\n')}`)
          if (value.message) lines.push(`  ${value.message}`)
          return [text(lines.join('\n'))]
        },
      },
      async execute(args, exec) {
        const repo = typeof args?.repo === 'string' ? args.repo.trim() : ''
        const empty = {
          ok: false,
          slug: '',
          dir: '',
          focusDir: '',
          sha: '',
          reused: false,
          fileCount: 0,
          totalBytes: 0,
          tree: [],
          treeTruncated: false,
          packageJson: '',
          readme: '',
          entrypoints: [],
          message: '',
        }
        if (repo === '') return { ...empty, code: 'EMPTY_REPO', message: 'repo 不能为空' }

        const slug = slugOf(repo)
        const ref = typeof args?.ref === 'string' && args.ref.trim() !== '' ? args.ref.trim() : 'HEAD'
        const subdir = typeof args?.subdir === 'string' ? args.subdir.trim().replace(/^[/\\]+|[/\\]+$/g, '') : ''
        const dir = path.join(learnDir, slug)
        const fresh = args?.fresh === true

        let reused = false
        let sha = ''

        if (!fresh && existsSync(path.join(dir, '.git'))) {
          const head = await git(['rev-parse', 'HEAD'], { cwd: dir, signal: exec?.signal })
          if (head.code === 0) {
            reused = true
            sha = head.stdout.trim()
          }
        }

        if (!reused) {
          const cloned = await cloneTo(repo, ref, dir, exec?.signal)
          if (!cloned.ok) return { ...empty, code: 'CLONE_FAILED', slug, dir, message: cloned.error }
          sha = cloned.sha
        }

        const focusDir = subdir !== '' ? path.join(dir, subdir) : dir
        if (!existsSync(focusDir)) {
          return { ...empty, ok: false, code: 'NO_SUBDIR', slug, dir, sha: shortSha(sha), reused, message: `仓库里没有子目录 ${subdir}` }
        }

        const allFiles = walkFiles(focusDir, { skipDirs: new Set(['node_modules', '.git']) })
        const totalBytes = allFiles.reduce((sum, file) => {
          try {
            return sum + statSync(file).size
          } catch {
            return sum
          }
        }, 0)

        const relative = allFiles.map((file) => toPosix(path.relative(focusDir, file))).sort()
        const tree = relative.slice(0, MAX_TREE_ENTRIES)

        const pkgPreview = readTextPreview(path.join(focusDir, 'package.json'), 2000)
        const readmeFile = ['README.md', 'readme.md', 'README.MD', 'README', 'README.rst']
          .map((candidate) => path.join(focusDir, candidate))
          .find((candidate) => existsSync(candidate))
        const readmePreview = readmeFile ? readTextPreview(readmeFile, MAX_PREVIEW_CHARS) : { text: '', truncated: false, note: '没有 README' }

        const entryNames = ['index.js', 'index.mjs', 'client.js', 'main.js', 'package.json']
        const entrypoints = entryNames
          .map((entry) => path.join(focusDir, entry))
          .filter((entry) => existsSync(entry))
          .slice(0, 3)
          .map((entry) => {
            const preview = readTextPreview(entry, 2200)
            return { path: toPosix(path.relative(focusDir, entry)), preview: preview.text || preview.note }
          })

        state.studies[slug] = { repo, dir, sha, clonedAt: new Date().toISOString() }
        persist()

        const notes = []
        if (readmePreview.note) notes.push(readmePreview.note)
        if (relative.length > MAX_TREE_ENTRIES) notes.push(`文件树只列了前 ${MAX_TREE_ENTRIES} 项（共 ${relative.length}）`)

        return {
          ok: true,
          slug,
          dir,
          focusDir,
          sha: shortSha(sha),
          reused,
          fileCount: allFiles.length,
          totalBytes: Math.round(totalBytes),
          tree,
          treeTruncated: relative.length > MAX_TREE_ENTRIES,
          packageJson: pkgPreview.text || pkgPreview.note,
          readme: readmePreview.text,
          entrypoints,
          message: notes.join('；'),
        }
      },
    }),
  )

}

const text = (value) => ({ type: 'text', text: value })
