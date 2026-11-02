#!/usr/bin/env node
/**
 * 把 bash/pwsh 的两条护栏 hook（danger-guard + self-guard）合并成一条（guards-bash-pwsh.mjs）。
 *
 * 为什么必须人工跑：C:/Users/<你>/hooks.json 是护栏配置，agent 的 write/edit（guard-fs）与
 * 命令行（guard-self）两条路都被禁止改它 —— 这是防「被注入后先拆防线」的必要限制。
 * 所以「合并」这个动作只能由人在终端执行；本脚本负责备份 / 校验 / 写入 / 失败自动回滚。
 *
 * 用法：
 *   node _ops/hooks-merge-apply.mjs                 预演（默认，只打印将做的改动，不写）
 *   node _ops/hooks-merge-apply.mjs --apply         真写（要求终端 TTY）
 *   node _ops/hooks-merge-apply.mjs --revert        回滚到最近一次备份（= hooks-merge-revert.mjs）
 *   可选：--file <路径>  --backup-dir <目录>  --backup <备份文件名>
 *
 * 安全设计：
 *   1) 默认 dry-run；写之前必须有备份，写之后重新读一遍校验；任何一步失败 → 自动还原备份。
 *   2) --apply / --revert 要求 stdin+stdout 都是 TTY：agent 起的 pwsh 进程没有 TTY，到不了写入分支。
 *      （只降低误触发概率，不是绝对隔离：已知旁路⑦「先写脚本再执行」本来就绕过命令行文本检查。）
 *   3) 只替换名称为 danger-guard / self-guard 的两条；其余 hook 原样保留（条数 -1 校验）。
 *   4) 两个原脚本文件不删不改：回滚就是把配置换回去，脚本一直在。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const MERGED_SCRIPT = 'D:/AI/dsh-bundles/dsh-hooks/examples/guards-bash-pwsh.mjs'
export const MERGE_NAME = 'bash-pwsh-guards'
export const MATCH = '^(bash|pwsh)$'
export const DROP_NAMES = ['danger-guard', 'self-guard']
export const DEFAULT_FILE = path.join(process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '.', '.dsh'), 'hooks.json')
export const DEFAULT_BACKUP_DIR = 'D:/AI/dsh-data/backup/guards'

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

/** 合并规则：去掉两条、插入一条；两条缺一条就拒绝（避免只合并半边的半吊子状态）。 */
export function mergeHooks(list) {
  const hooks = Array.isArray(list) ? list : []
  const dropped = hooks.filter((h) => DROP_NAMES.includes(h?.name)).map((h) => h.name)
  const missing = DROP_NAMES.filter((n) => !dropped.includes(n))
  if (missing.length > 0) return { changed: false, hooks, dropped, missing }
  const kept = []
  let insertAt = -1
  for (const hook of hooks) {
    if (DROP_NAMES.includes(hook?.name)) {
      if (insertAt === -1) insertAt = kept.length
      continue
    }
    kept.push(hook)
  }
  kept.splice(insertAt === -1 ? kept.length : insertAt, 0, {
    name: MERGE_NAME,
    event: 'tool.pre',
    match: MATCH,
    run: 'node "' + MERGED_SCRIPT + '"',
    timeoutMs: 4000,
    onError: 'deny',
  })
  return { changed: true, hooks: kept, dropped, missing: [] }
}

/** 校验：配置结构 + 合并脚本存在且语法过 + 只剩一条覆盖 bash/pwsh 的 hook。 */
export function validate(config, opts = {}) {
  const issues = []
  const script = opts.mergedScript ?? MERGED_SCRIPT
  const list = Array.isArray(config?.hooks) ? config.hooks : []
  if (!Array.isArray(config?.hooks)) issues.push('顶层没有 hooks 数组')
  for (const name of DROP_NAMES) {
    if (list.some((h) => h?.name === name)) issues.push('仍残留旧 hook：' + name)
  }
  const merged = list.filter((h) => h?.name === MERGE_NAME)
  if (merged.length !== 1) issues.push('合并后应恰好有 1 条 ' + MERGE_NAME + '，实际 ' + merged.length)
  const covering = list.filter((h) => h?.event === 'tool.pre' && h?.match === MATCH)
  if (covering.length !== 1) issues.push('覆盖 bash/pwsh 的 tool.pre hook 应恰好 1 条，实际 ' + covering.length)
  for (const hook of list) {
    if (typeof hook?.event !== 'string' || typeof hook?.run !== 'string') issues.push('有 hook 缺 event 或 run：' + JSON.stringify(hook).slice(0, 80))
  }
  if (!existsSync(script)) {
    issues.push('合并脚本不存在：' + script)
  } else {
    const check = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    if (check.status !== 0) issues.push('合并脚本语法不过：' + String(check.stderr ?? '').trim().slice(0, 200))
  }
  return issues
}

const atomicWrite = (file, text) => {
  const tmp = file + '.tmp-' + process.pid
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

/** 预演或真写。返回结构化报告（dryRun 时 wrote=false）。 */
export function applyMerge(opts = {}) {
  const file = opts.file ?? DEFAULT_FILE
  const backupDir = opts.backupDir ?? DEFAULT_BACKUP_DIR
  const dryRun = opts.dryRun !== false
  const mergedScript = opts.mergedScript ?? MERGED_SCRIPT
  const report = { file, backupDir, dryRun, wrote: false, backup: '', beforeCount: 0, afterCount: 0, dropped: [], issues: [], rolledBack: false }
  if (!existsSync(file)) {
    report.issues.push('配置文件不存在：' + file)
    return report
  }
  let original
  try {
    original = readJson(file)
  } catch (error) {
    report.issues.push('配置文件不是合法 JSON：' + String(error.message ?? error).slice(0, 160))
    return report
  }
  report.beforeCount = Array.isArray(original?.hooks) ? original.hooks.length : 0
  const merged = mergeHooks(original?.hooks)
  report.dropped = merged.dropped
  if (merged.missing.length > 0) {
    report.issues.push('找不到要合并的 hook：' + merged.missing.join(' / ') + '（已是合并态，或配置被手工改过）')
    return report
  }
  if (!merged.changed) {
    report.issues.push('没有需要合并的 hook')
    return report
  }
  const next = { ...original, hooks: merged.hooks }
  report.afterCount = merged.hooks.length
  const issues = validate(next, { mergedScript })
  if (issues.length > 0) {
    report.issues.push(...issues)
    return report
  }
  if (dryRun) return report

  mkdirSync(backupDir, { recursive: true })
  const backupName = path.basename(file) + '.bak-' + stamp()
  const backup = path.join(backupDir, backupName)
  copyFileSync(file, backup)
  report.backup = backup
  const originalText = readFileSync(file, 'utf8')
  try {
    atomicWrite(file, JSON.stringify(next, null, 2) + '\n')
    const issuesAfter = validate(readJson(file), { mergedScript })
    if (issuesAfter.length > 0) throw new Error('写入后校验失败：' + issuesAfter.join('；'))
    report.wrote = true
  } catch (error) {
    writeFileSync(file, originalText, 'utf8')
    report.rolledBack = true
    report.issues.push('写入/校验失败，已回滚：' + String(error.message ?? error).slice(0, 200))
  }
  return report
}

/** 回滚：恢复最近一次（或指定）备份；恢复前先给当前文件存一份 '.pre-revert-' 快照。 */
export function revertMerge(opts = {}) {
  const file = opts.file ?? DEFAULT_FILE
  const backupDir = opts.backupDir ?? DEFAULT_BACKUP_DIR
  const report = { file, backupDir, wrote: false, backup: '', preRevert: '', issues: [] }
  if (!existsSync(backupDir)) {
    report.issues.push('备份目录不存在：' + backupDir)
    return report
  }
  const prefix = path.basename(file) + '.bak-'
  const candidates = readdirSync(backupDir).filter((n) => n.startsWith(prefix)).sort()
  const name = opts.backup ?? candidates[candidates.length - 1]
  if (!name) {
    report.issues.push('找不到备份文件（' + backupDir + ' 里没有 ' + prefix + '*）')
    return report
  }
  const backup = path.join(backupDir, name)
  report.backup = backup
  let restored
  try {
    restored = readJson(backup)
  } catch (error) {
    report.issues.push('备份文件不是合法 JSON：' + String(error.message ?? error).slice(0, 160))
    return report
  }
  if (!Array.isArray(restored?.hooks)) {
    report.issues.push('备份里没有 hooks 数组，拒绝回滚')
    return report
  }
  const preRevert = file + '.pre-revert-' + stamp()
  if (existsSync(file)) copyFileSync(file, preRevert)
  report.preRevert = existsSync(preRevert) ? preRevert : ''
  atomicWrite(file, JSON.stringify(restored, null, 2) + '\n')
  report.wrote = true
  return report
}

const describe = (report, title) => {
  const out = [title]
  if (report.file) out.push('  配置：' + report.file)
  if (report.dropped?.length) out.push('  移除：' + report.dropped.join(' + '))
  if (report.beforeCount) out.push('  hook 条数：' + report.beforeCount + ' → ' + report.afterCount)
  if (report.backup) out.push('  备份：' + report.backup)
  if (report.preRevert) out.push('  回滚前快照：' + report.preRevert)
  if (report.rolledBack) out.push('  已自动回滚（写入后校验失败）')
  for (const issue of report.issues ?? []) out.push('  ✗ ' + issue)
  return out.join('\n')
}

export function cli(argv = process.argv.slice(2)) {
  const has = (name) => argv.includes(name)
  const value = (name) => { const at = argv.indexOf(name); return at === -1 ? undefined : argv[at + 1] }
  const file = value('--file') ?? DEFAULT_FILE
  const backupDir = value('--backup-dir') ?? DEFAULT_BACKUP_DIR
  const backup = value('--backup')
  const wantsWrite = has('--apply') || has('--revert')
  if (wantsWrite && !(process.stdin.isTTY && process.stdout.isTTY)) {
    console.error('拒绝执行：--apply / --revert 只允许人工在终端里跑（当前标准输入/输出不是 TTY）。这是护栏配置的写入门 —— agent 不能改它。')
    return 2
  }
  if (has('--revert')) {
    const report = revertMerge({ file, backupDir, backup })
    console.log(describe(report, report.wrote ? '已回滚到备份：' : '回滚未完成：'))
    return report.wrote ? 0 : 1
  }
  const report = applyMerge({ file, backupDir, dryRun: !has('--apply') })
  const failed = report.issues.length > 0
  console.log(describe(report, report.wrote ? '已合并并写入（备份可回滚）：' : failed ? '未写入（有阻塞问题）：' : '预演（dry-run，未写任何文件）：如果要落盘请加 --apply'))
  if (!failed && !report.wrote) console.log('\n确认无误后，请人工在终端执行：node _ops/hooks-merge-apply.mjs --apply')
  return failed ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = cli()
}
