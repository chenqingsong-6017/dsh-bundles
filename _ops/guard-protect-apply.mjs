#!/usr/bin/env node
/**
 * guard-protect-apply.mjs —— 把合并 guard 改成受护栏保护的文件名（人工一次）。
 *
 * 背景（AGENTS.md「已知拦不住 ⑧」）：两个护栏的保护名是 guard-<字母>.mjs，而合并版文件名
 * 多了 s 与连字符 → 不匹配，agent 可写它。本脚本把内容复制成受保护名，并把 hook 配置的 run
 * 路径指过去。
 *
 * 安全约束（同 hooks-merge-apply）：--apply / --revert 只在 TTY 里可跑；agent 的 pwsh 通道
 * 拿不到 TTY，所以这条写入只能由人执行。默认是干跑（只打印计划）。
 *
 * 用法：
 *   node _ops/guard-protect-apply.mjs                 # 干跑：打印计划，不写
 *   node _ops/guard-protect-apply.mjs --apply         # 人工执行：备份→复制→改配置→自验证
 *   node _ops/guard-protect-apply.mjs --revert        # 人工回滚：恢复配置并删新文件
 *   node _ops/guard-protect-apply.mjs --self-test     # 无人值守自测（只在临时目录跑）
 *
 * 边界：旧文件保留不删（测试/对拍仍引用它）；新文件是运行时入口。两者字节由复制保证一致，
 * 以后改规则要同时改两份（drift 测试守护旧文件 vs 原 guard 脚本）。
 */
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const DEFAULT_EXAMPLES = path.join(ROOT, 'dsh-hooks', 'examples')
const SOURCE_NAME = "guards-bash-pwsh.mjs"
const TARGET_NAME = "guard-bashpwsh.mjs"
const HOOK_NAME = 'bash-pwsh-guards'
const CFG_NAME = "hooks.json"

const parseArgs = (argv) => {
  const opts = { mode: 'dry-run', config: path.join(os.homedir(), '.dsh', CFG_NAME), examples: DEFAULT_EXAMPLES, allowNonTty: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') opts.mode = 'apply'
    else if (a === '--revert') opts.mode = 'revert'
    else if (a === '--self-test') { opts.mode = 'self-test'; opts.allowNonTty = true }
    else if (a === '--config') opts.config = argv[++i]
    else if (a === '--examples') opts.examples = argv[++i]
    else { console.error('未知参数：' + a); process.exit(2) }
  }
  return opts
}

const readConfig = (file) => JSON.parse(readFileSync(file, 'utf8'))
const findHook = (config) => (config.hooks || []).find((h) => h && h.name === HOOK_NAME)
const newRun = (run) => String(run).replace(SOURCE_NAME, TARGET_NAME)

function plan(opts) {
  if (!existsSync(opts.config)) throw new Error('配置不存在：' + opts.config)
  const source = path.join(opts.examples, SOURCE_NAME)
  const target = path.join(opts.examples, TARGET_NAME)
  if (!existsSync(source)) throw new Error('合并 guard 不存在：' + source)
  const config = readConfig(opts.config)
  const hook = findHook(config)
  if (!hook) throw new Error('配置里找不到 hook：' + HOOK_NAME)
  if (!String(hook.run).includes(SOURCE_NAME)) throw new Error('该 hook 的 run 不是合并版：' + hook.run)
  return { source, target, hook, config, oldRun: hook.run, newRun: newRun(hook.run) }
}

function verify(examples) {
  const target = path.join(examples, TARGET_NAME)
  const run = (payload) => spawnSync(process.execPath, [target], { input: JSON.stringify(payload), encoding: 'utf8' })
  const daily = run({ tool: { name: 'pwsh', arguments: { command: 'git status --short' } } })
  const denyCmd = 'Set-Content C:\\Users\\x\\.dsh\\' + CFG_NAME + ' x'
  const danger = run({ tool: { name: 'pwsh', arguments: { command: denyCmd } } })
  const ok = daily.status === 0 && danger.status === 2
  return { ok, daily: daily.status, danger: danger.status, dangerErr: (danger.stderr || '').trim().slice(0, 120) }
}

function apply(opts) {
  const p = plan(opts)
  const backup = opts.config + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-')
  copyFileSync(opts.config, backup)
  try {
    copyFileSync(p.source, p.target)
    if (statSync(p.source).size !== statSync(p.target).size) throw new Error('复制后大小不一致')
    p.hook.run = p.newRun
    const tmp = opts.config + '.tmp-' + process.pid
    writeFileSync(tmp, JSON.stringify(p.config, null, 2) + '\n', 'utf8')
    renameSync(tmp, opts.config)
    const check = verify(opts.examples)
    if (!check.ok) throw new Error('自验证失败：daily=' + check.daily + ' danger=' + check.danger + ' ' + check.dangerErr)
    return { backup, target: p.target, oldRun: p.oldRun, newRun: p.newRun, check }
  } catch (error) {
    copyFileSync(backup, opts.config)
    try { unlinkSync(p.target) } catch (ignored) { }
    throw error
  }
}

function revert(opts) {
  const config = readConfig(opts.config)
  const hook = findHook(config)
  if (!hook) throw new Error('配置里找不到 hook：' + HOOK_NAME)
  if (!String(hook.run).includes(TARGET_NAME)) throw new Error('当前 run 不是受保护名，无需回滚：' + hook.run)
  const target = path.join(opts.examples, TARGET_NAME)
  hook.run = String(hook.run).replace(TARGET_NAME, SOURCE_NAME)
  const backup = opts.config + '.pre-revert-' + new Date().toISOString().replace(/[:.]/g, '-')
  copyFileSync(opts.config, backup)
  const tmp = opts.config + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8')
  renameSync(tmp, opts.config)
  if (existsSync(target)) unlinkSync(target)
  return { backup, restoredRun: hook.run, removed: !existsSync(target) }
}

function selfTest() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'guard-protect-'))
  try {
    const examples = path.join(dir, 'examples')
    mkdirSync(examples, { recursive: true })
    copyFileSync(path.join(DEFAULT_EXAMPLES, SOURCE_NAME), path.join(examples, SOURCE_NAME))
    const configPath = path.join(dir, CFG_NAME)
    const runPath = path.join(examples, SOURCE_NAME).replace(/\\/g, '/')
    writeFileSync(configPath, JSON.stringify({ version: 1, hooks: [{ name: HOOK_NAME, event: 'tool.pre', match: '^(bash|pwsh)$', run: 'node "' + runPath + '"', timeoutMs: 4000, onError: 'deny' }] }, null, 2))
    const base = { config: configPath, examples, allowNonTty: true }
    const p = plan(base)
    if (!p.newRun.includes(TARGET_NAME)) throw new Error('计划里的 newRun 不对：' + p.newRun)
    const res = apply(base)
    if (!res.check.ok) throw new Error('apply 后自验证未过')
    const after = readConfig(configPath)
    if (!String(findHook(after).run).includes(TARGET_NAME)) throw new Error('配置未改成受保护名')
    const rev = revert(base)
    if (!rev.restoredRun.includes(SOURCE_NAME)) throw new Error('回滚后 run 不对')
    if (existsSync(path.join(examples, TARGET_NAME))) throw new Error('回滚未删新文件')
    console.log('self-test OK：计划 / apply 复制+改配置+自验证 / revert 还原，全部通过')
    return 0
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const opts = parseArgs(process.argv.slice(2))
if (opts.mode === 'self-test') process.exit(selfTest())
if ((opts.mode === 'apply' || opts.mode === 'revert') && !process.stdout.isTTY && !opts.allowNonTty) {
  console.error('拒绝执行：--apply / --revert 只允许人工在终端里跑（当前不是 TTY）。护栏文件与配置的写入门，agent 不能改它。')
  process.exit(2)
}
try {
  if (opts.mode === 'dry-run') {
    const p = plan(opts)
    console.log('干跑（未写任何文件）：')
    console.log('  配置：' + opts.config)
    console.log('  复制：' + p.source + ' -> ' + p.target)
    console.log('  run ：' + p.oldRun + ' -> ' + p.newRun)
    console.log('确认后请人工执行：node _ops/guard-protect-apply.mjs --apply')
    process.exit(0)
  }
  if (opts.mode === 'apply') {
    const r = apply(opts)
    console.log('已应用：guard 文件名受保护 ' + TARGET_NAME + '，配置 run 已切换')
    console.log('  备份：' + r.backup)
    console.log('  自验证：daily exit=' + r.check.daily + '（应 0）/ danger exit=' + r.check.danger + '（应 2）')
    console.log('回滚：node _ops/guard-protect-apply.mjs --revert')
    process.exit(0)
  }
  const r = revert(opts)
  console.log('已回滚：run=' + r.restoredRun + '，新文件已删=' + r.removed + '，备份=' + r.backup)
  process.exit(0)
} catch (error) {
  console.error('失败：' + (error && error.message ? error.message : String(error)))
  process.exit(1)
}