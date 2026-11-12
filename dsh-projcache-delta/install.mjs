#!/usr/bin/env node
/**
 * install.mjs —— 把增量 checkpoint 覆盖层挂进 desktop profile（零重启、可撤装）。
 *
 * 做法（施工图第 1 步：profile 覆盖机制，不改 app.asar）：
 *   1) 在 profile 的 node_modules/@local 下建 junction 指向本包目录（与其它本地插件同构，
 *      HMR 会把「已链接包的目标」纳入文件比较，改代码在下次重组时生效，无需重启）；
 *   2) 把 cordis.patch.yml 的正文（停用官方三件 + insert 本地三件）拼进
 *      profile 的 cordis.patch.yml，块首尾带标记，--revert 只删这个块。
 *
 * 不做的事：不动 app.asar、不跑 pnpm、不改 profile package.json、不落 .bak 备份
 * （补丁用临时文件 + rename 原子落盘；块可精确移除，所以没有「旧文件」留下）。
 *
 * 用法：
 *   node install.mjs                # dry-run：打印将要做的改动
 *   node install.mjs --apply        # 安装
 *   node install.mjs --revert       # 撤装（安全网；非常态路径）
 *   node install.mjs --apply --profile <profile 目录>
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const value = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const revert = has('--revert')
const apply = has('--apply') || revert // 撤装本身就是要落盘的动作
const write = apply
const profileDir = value('--profile', path.join(os.homedir(), '.dsh', 'profiles', 'desktop'))
const patchFile = path.join(profileDir, 'cordis.patch.yml')
const linkDir = path.join(profileDir, 'node_modules', '@local')
const linkPath = path.join(linkDir, 'dsh-projcache-delta')
const MARK_BEGIN = '# >>> dsh-projcache-delta (install.mjs; --revert removes this block) >>>'
const MARK_END = '# <<< dsh-projcache-delta <<<'

if (!existsSync(patchFile)) {
  console.error('install: profile patch not found: ' + patchFile)
  process.exit(1)
}
const canonical = readFileSync(path.join(HERE, 'cordis.patch.yml'), 'utf8')
const rows = canonical.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n').trim()
if (rows === '') {
  console.error('install: cordis.patch.yml has no rows')
  process.exit(1)
}
const block = [MARK_BEGIN, rows, MARK_END].join('\n') + '\n'
const current = readFileSync(patchFile, 'utf8')
const beginIndex = current.indexOf(MARK_BEGIN)
const endIndex = current.indexOf(MARK_END)

function withoutBlock(text) {
  if (beginIndex < 0) return text
  if (endIndex < 0) throw new Error('install: patch block start marker without end marker; refusing to edit')
  return text.slice(0, beginIndex) + text.slice(endIndex + MARK_END.length + 1)
}

function linkState() {
  if (!existsSync(linkPath)) return { state: 'missing' }
  const stat = lstatSync(linkPath)
  if (!stat.isSymbolicLink()) return { state: 'not-a-link' }
  const target = realpathSync(linkPath)
  const expected = realpathSync(HERE)
  return { state: target === expected ? 'correct' : 'other-target', target }
}

const measured = linkState()
const plan = {
  profileDir,
  patchFile,
  linkPath,
  link: revert ? 'remove (if it points at this package)' : measured.state === 'correct' ? 'keep' : 'create',
  linkState: measured,
  patch: revert ? (beginIndex >= 0 ? 'remove managed block' : 'no managed block (nothing to remove)') : beginIndex >= 0 ? 'replace managed block' : 'append managed block',
}

if (!write) {
  console.log('install (dry-run):')
  console.log(JSON.stringify(plan, null, 2))
  console.log('rows:\n' + rows)
  console.log('\nrerun with --apply to install; --revert to remove.')
  process.exit(0)
}

// --- link ---
if (revert) {
  if (measured.state === 'correct') {
    rmSync(linkPath)
    console.log('link removed: ' + linkPath)
  } else if (measured.state === 'missing') console.log('link already absent: ' + linkPath)
  else console.log('link left untouched (state: ' + measured.state + '): ' + linkPath)
} else if (measured.state !== 'correct') {
  if (measured.state !== 'missing') {
    console.error('install: refusing to replace an existing link/directory at ' + linkPath + ' (state: ' + measured.state + ')')
    process.exit(1)
  }
  mkdirSync(linkDir, { recursive: true })
  symlinkSync(HERE, linkPath, 'junction')
  console.log('link created: ' + linkPath + ' -> ' + HERE)
} else console.log('link already correct: ' + linkPath)

// --- patch block (atomic publish, no .bak left behind) ---
let next
if (revert) {
  next = withoutBlock(current)
  if (!next.endsWith('\n')) next += '\n'
} else {
  const base = withoutBlock(current)
  next = base.endsWith('\n') ? base : base + '\n'
  next += block
}
const temp = patchFile + '.tmp-' + process.pid
writeFileSync(temp, next)
renameSync(temp, patchFile)
console.log('patch written: ' + patchFile + ' (' + (revert ? 'block removed' : 'block installed') + ')')
console.log('next: HMR recomposes this profile automatically (~3s). Verify with:')
console.log('  node ' + path.join(HERE, 'verify.mjs'))
