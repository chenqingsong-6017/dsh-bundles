/**
 * dsh-updater 真实调用级测试。
 *
 * 不装进 DSH 也测：mock 一个最小的 ctx（tools 收集注册项、subprocess 用真实
 * child_process 驱动真 git），然后直接调用每个工具的 execute。
 *
 * 全链路都跑真的：
 *   - 本地 bare repo 当"远端"，真 commit + 真 push
 *   - 真 git clone / ls-remote / rev-parse
 *   - 真备份目录、真回滚、真文件内容比对
 *
 * 覆盖：登记 → 检查基线 → 试运行 → 拒写（无 confirm）→ 应用 → 再次检查 → 应用
 *      → 回滚 → 校验门拦截语法错误 → 白名单拦截越界路径 → prune 语义 → study 复用
 */
import assert from 'node:assert/strict'
import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let passed = 0
const ok = (label, extra = '') => {
  passed += 1
  console.log(`  ✓ ${label}${extra ? `  ${extra}` : ''}`)
}
const section = (title) => console.log(`\n## ${title}`)

// ------------------------------------------------------------ 环境

const GIT = 'C:\\Program Files\\Git\\cmd\\git.exe'
const tempRoots = []
const tmp = mkdtempSync(path.join(tmpdir(), 'updater-test-'))
tempRoots.push(tmp)

function gitRun(args, cwd) {
  const result = spawnSync(GIT, ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

/** 写一个最小但合法的 DSH 插件目录。 */
function writePlugin(dir, { version, marker, syntaxOk = true, extraFile = null }) {
  mkdirSync(path.join(dir, 'locale'), { recursive: true })
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: '@local/demo',
        version,
        type: 'module',
        exports: { '.': './index.js', './locale/*.json': './locale/*.json', './icon': './icon.svg' },
        files: ['index.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg'],
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
      null,
      2,
    ),
  )
  writeFileSync(
    path.join(dir, 'index.js'),
    syntaxOk
      ? `export const name = 'demo'\nexport const inject = ['tools']\nexport function apply(ctx) {}\n// ${marker}\n`
      : `export function apply( {  // 故意制造语法错误\n`,
  )
  writeFileSync(path.join(dir, 'cordis.patch.yml'), `- insert:\n    - id: demo\n      name: '@local/demo'\n`)
  writeFileSync(path.join(dir, 'locale', 'zh.json'), JSON.stringify({ meta: { title: '演示', description: marker } }))
  writeFileSync(path.join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"></svg>')
  if (extraFile) writeFileSync(path.join(dir, extraFile), 'local-only\n')
}

/** 真 child_process 驱动的 subprocess mock，贴合 DSH 的 handle 契约。 */
function makeSubprocess() {
  return {
    async resolveExecutable(name) {
      const table = { git: GIT, node: process.execPath }
      const hit = table[name]
      if (!hit) throw new Error(`找不到可执行文件 ${name}`)
      return hit
    },
    spawn(options) {
      const { argv, cwd, stdio, signal } = options
      const child = nodeSpawn(argv[0], argv.slice(1), {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: process.env,
      })
      const buffers = { stdout: [], stderr: [] }
      const bytes = { stdout: 0, stderr: 0 }
      const max = { stdout: stdio?.stdout?.maxBytes ?? 1e6, stderr: stdio?.stderr?.maxBytes ?? 1e6 }
      child.stdout.on('data', (chunk) => {
        if (bytes.stdout < max.stdout) {
          buffers.stdout.push(chunk)
          bytes.stdout += chunk.length
        }
      })
      child.stderr.on('data', (chunk) => {
        if (bytes.stderr < max.stderr) {
          buffers.stderr.push(chunk)
          bytes.stderr += chunk.length
        }
      })
      if (signal) signal.addEventListener('abort', () => { try { child.kill() } catch { /* 已退出 */ } })
      const done = new Promise((resolve) => {
        child.on('close', (code, sig) => resolve({ exitCode: code, signal: sig }))
        child.on('error', (error) => resolve({ exitCode: -1, signal: null, error: error.message }))
      })
      const collector = (bucket) => ({
        readFrom(offset = 0) {
          const text = Buffer.concat(buffers[bucket]).toString('utf8')
          return { text: text.slice(offset) }
        },
      })
      return {
        done,
        collected: { stdout: collector('stdout'), stderr: collector('stderr') },
        terminate() {
          try { child.kill('SIGTERM') } catch { /* 已退出 */ }
        },
      }
    },
  }
}

function makeCtx() {
  const registered = new Map()
  const ctx = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
    subprocess: makeSubprocess(),
    effect(fn) { return fn() },
    get() { return undefined },
  }
  return { ctx, registered, tool: (toolName) => registered.get(toolName) }
}

// ------------------------------------------------------------ 搭场景

section('准备远端仓库与本地插件')

const remote = path.join(tmp, 'remote.git')
gitRun(['init', '--bare', '--quiet', remote])
const work = path.join(tmp, 'work')
mkdirSync(work, { recursive: true })
gitRun(['init', '--quiet', '-b', 'main', work])

writePlugin(work, { version: '1.0.0', marker: 'v1' })
gitRun(['add', '-A'], work)
gitRun(['commit', '--quiet', '-m', 'v1'], work)
gitRun(['remote', 'add', 'origin', remote], work)
gitRun(['push', '--quiet', 'origin', 'HEAD:main'], work)
gitRun(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote)
ok('远端裸仓库就绪（v1.0.0，main）')

const pluginsRoot = path.join(tmp, 'plugins')
const localPlugin = path.join(pluginsRoot, 'demo')
writePlugin(localPlugin, { version: '0.9.0', marker: 'v0', extraFile: 'local-notes.md' })
ok('本地插件就绪（v0.9.0，带一个本地独有文件）')

const store = path.join(tmp, 'store')
const { ctx, tool } = makeCtx()
const updater = await import('../../dsh-updater/index.js')
updater.apply(ctx, {
  storeDir: store,
  allowedRoots: [pluginsRoot],
  backupsToKeep: 3,
  gitTimeoutMs: 60000,
})

for (const toolName of ['updater_status', 'updater_source', 'updater_check', 'updater_apply', 'updater_rollback', 'updater_study']) {
  assert.ok(tool(toolName), `缺工具 ${toolName}`)
}
ok('6 个工具全部注册', 'status/source/check/apply/rollback/study')

// ------------------------------------------------------------ 登记

section('登记更新源')

let result = await tool('updater_status').execute({}, {})
assert.equal(result.sources.length, 0)
ok('初始没有源')
assert.equal(result.git.available, true)
ok('git 可用被正确探到', result.git.path)

result = await tool('updater_source').execute({ action: 'add', name: 'demo', repo: remote, localDir: localPlugin, bundleName: '@local/demo' })
assert.equal(result.ok, true, result.message)
assert.equal(result.total, 1)
ok('登记源成功')

result = await tool('updater_status').execute({}, {})
assert.equal(result.sources.length, 1)
assert.equal(result.sources[0].localVersion, '0.9.0')
assert.equal(result.sources[0].insideAllowedRoot, true)
ok('status 报告本地版本与白名单状态', `localVersion=${result.sources[0].localVersion}`)

// ------------------------------------------------------------ 检查

section('检查远端')

result = await tool('updater_check').execute({}, {})
assert.equal(result.results[0].status, 'baseline-missing', JSON.stringify(result.results[0]))
assert.equal(result.behind, 0)
ok('首次检查标记 baseline-missing（不谎报"落后"）')

// ------------------------------------------------------------ 越界与未确认

section('安全闸门')

result = await tool('updater_apply').execute({ name: 'demo', confirm: true, dryRun: true }).catch((error) => ({ thrown: error.message }))
assert.equal(result.status, 'validated', JSON.stringify(result).slice(0, 300))
ok('dryRun 通过校验（未写盘）')

result = await tool('updater_apply').execute({ name: 'demo' })
assert.equal(result.status, 'refused')
assert.match(result.message, /confirm/)
ok('没有 confirm 时拒绝写入')

const outsideDir = path.join(tmp, 'outside', 'evil')
mkdirSync(outsideDir, { recursive: true })
result = await tool('updater_source').execute({ action: 'add', name: 'evil', repo: remote, localDir: outsideDir })
assert.equal(result.ok, false)
assert.match(result.message, /白名单/)
ok('白名单外的 localDir 被拒绝登记')

// ------------------------------------------------------------ 应用 v1

section('应用更新')

result = await tool('updater_apply').execute({ name: 'demo', confirm: true })
assert.equal(result.status, 'applied', JSON.stringify(result).slice(0, 400))
assert.equal(result.fromVersion, '0.9.0')
assert.equal(result.toVersion, '1.0.0')
assert.ok(result.backupDir && existsSync(result.backupDir), '备份目录应存在')
ok('应用成功', `${result.fromVersion} → ${result.toVersion}，${result.files.total} 个文件`)

const appliedManifest = JSON.parse(readFileSync(path.join(localPlugin, 'package.json'), 'utf8'))
assert.equal(appliedManifest.version, '1.0.0')
ok('本地 package.json 真的变成 1.0.0')

assert.ok(existsSync(path.join(localPlugin, 'local-notes.md')), '默认不清除本地独有文件')
ok('默认保留本地独有文件（prune=false）')

result = await tool('updater_check').execute({}, {})
assert.equal(result.results[0].status, 'up-to-date', JSON.stringify(result.results[0]))
ok('应用后检查显示 up-to-date')

// ------------------------------------------------------------ 远端前进到 v2

section('远端前进后再次更新')

writePlugin(work, { version: '2.0.0', marker: 'v2' })
gitRun(['add', '-A'], work)
gitRun(['commit', '--quiet', '-m', 'v2'], work)
gitRun(['push', '--quiet', 'origin', 'HEAD:main'], work)
ok('远端已推到 v2.0.0')

result = await tool('updater_check').execute({}, {})
assert.equal(result.results[0].status, 'behind', JSON.stringify(result.results[0]))
assert.equal(result.behind, 1)
ok('检查正确识别 behind')

result = await tool('updater_apply').execute({ name: 'demo', confirm: true, prune: true })
assert.equal(result.status, 'applied')
assert.equal(result.toVersion, '2.0.0')
assert.equal(existsSync(path.join(localPlugin, 'local-notes.md')), false)
ok('prune=true 时清掉本地独有文件', `删除 ${result.files.removed} 个`)

// ------------------------------------------------------------ 回滚

section('回滚')

// 回归（2026-10-31 实测抓到）：两次备份若落在同一秒，旧实现按目录名字排序，
// 而名字里的 shortSha / 'baseline' 后缀可能让“名字序”与“创建序”相反 →
// 回滚会还原更旧的一份（真机现场：本该回 1.0.0，实际回了 0.9.0）。
// 这里把两份备份改名成名字序与创建序相反，回滚必须仍按创建时间选最新。
const backupRoot = path.join(store, 'backups', 'demo')
const backupNames = readdirSync(backupRoot).filter((name) => !name.startsWith('safety-'))
const versionOf = (name) => JSON.parse(readFileSync(path.join(backupRoot, name, 'tree', 'package.json'), 'utf8')).version
const olderName = backupNames.find((name) => versionOf(name) === '0.9.0')
const newerName = backupNames.find((name) => versionOf(name) === '1.0.0')
assert.ok(olderName && newerName, `备份应含 0.9.0 与 1.0.0 各一份：${backupNames.join(', ')}`)
renameSync(path.join(backupRoot, olderName), path.join(backupRoot, '99999999-000000000-zzz'))
await new Promise((resolve) => setTimeout(resolve, 60))
renameSync(path.join(backupRoot, newerName), path.join(backupRoot, '00000000-000000000-aaa'))
ok('把两份备份改成「名字序与创建序相反」', '用于验证回滚选最新')

result = await tool('updater_rollback').execute({ name: 'demo', confirm: true })
assert.equal(result.status, 'restored', JSON.stringify(result).slice(0, 400))
assert.ok(result.safetyBackup && existsSync(result.safetyBackup), '回滚前应有安全备份')
ok('回滚成功', `还原 ${result.files} 个文件`)

const rolledManifest = JSON.parse(readFileSync(path.join(localPlugin, 'package.json'), 'utf8'))
assert.equal(rolledManifest.version, '1.0.0')
ok('回滚后版本回到 1.0.0')
ok('回滚按创建时间选最新备份（名字序反转也不受影响）')

// ------------------------------------------------------------ 回滚参数穿越
// 回归（2026-11-03 全局审计 U1）：backup 原样进 path.join 会让 `..\..\..\evil`
// 穿越到备份根目录之外，再配合 restoreDir 的「树外即删」变成任意目录覆盖。
// 三种越界写法都必须 UPDATER_ARG_INVALID，且不执行任何回滚动作。
section('回滚参数穿越必须拒绝')

const safetyDirCount = () => readdirSync(backupRoot).filter((name) => name.startsWith('safety-')).length
const badBackupCases = [
  ['../../', '纯 .. 穿越'],
  ['..\\..\\evil', 'Windows 风格 .. 穿越'],
  ['C:\\AI\\dsh-bundles\\evil', '绝对路径'],
  ['\\\\localhost\\D$\\AI\\evil', 'UNC 路径'],
  ['sub/child', '带路径分隔符'],
  ['not-a-backup', '合法单段名但不在备份清单'],
]
for (const [badBackup, label] of badBackupCases) {
  const safetyBefore = safetyDirCount()
  const versionBefore = JSON.parse(readFileSync(path.join(localPlugin, 'package.json'), 'utf8')).version
  result = await tool('updater_rollback').execute({ name: 'demo', confirm: true, backup: badBackup })
  assert.equal(result.ok, false, `${label} 必须被拒：${JSON.stringify(result)}`)
  assert.equal(result.code, 'UPDATER_ARG_INVALID', `${label} 应回 UPDATER_ARG_INVALID，实际 ${result.code}: ${result.message}`)
  assert.equal(JSON.parse(readFileSync(path.join(localPlugin, 'package.json'), 'utf8')).version, versionBefore, `${label} 不得改动本地文件`)
  assert.equal(safetyDirCount(), safetyBefore, `${label} 不得创建安全备份（证明没有真回滚）`)
}
ok('backup 越界（../../、..\\..、盘符绝对路径、UNC、带分隔符、未知名）全部 UPDATER_ARG_INVALID，未执行回滚')

// 反向保险：合法显式备份名仍可用；同时验证「树外即删」只删白名单内文件
const userFile = path.join(localPlugin, 'user-notes.md')
writeFileSync(userFile, '这不是插件产物，回滚不许删\n')
const validBackupName = listBackupNames().find((name) => !name.startsWith('safety-'))
assert.ok(validBackupName, '应有一份正常备份可选')
result = await tool('updater_rollback').execute({ name: 'demo', confirm: true, backup: validBackupName })
assert.equal(result.status, 'restored', JSON.stringify(result).slice(0, 400))
assert.ok(existsSync(userFile), '白名单外的用户文件必须保留（原实现会当「多余文件」删掉）')
assert.match(result.message, /白名单外 \d+ 个文件保留未删/)
ok('合法备份名仍可回滚；白名单外的 user-notes.md 保留未删')

function listBackupNames() {
  return readdirSync(backupRoot).filter((name) => name !== '')
}

// ------------------------------------------------------------ 校验门

section('校验门拦截坏提交')

writePlugin(work, { version: '3.0.0', marker: 'broken', syntaxOk: false })
gitRun(['add', '-A'], work)
gitRun(['commit', '--quiet', '-m', 'broken'], work)
gitRun(['push', '--quiet', 'origin', 'HEAD:main'], work)

const beforeBroken = readFileSync(path.join(localPlugin, 'package.json'), 'utf8')
result = await tool('updater_apply').execute({ name: 'demo', confirm: true })
assert.equal(result.status, 'rejected', JSON.stringify(result).slice(0, 400))
assert.ok(result.issues.some((issue) => issue.code === 'syntax'), 'should report syntax issue')
assert.equal(readFileSync(path.join(localPlugin, 'package.json'), 'utf8'), beforeBroken)
ok('语法错误的新版被拒绝，本地文件原封不动')

// ------------------------------------------------------------ 学习台

section('学习台克隆')

result = await tool('updater_study').execute({ repo: remote })
assert.equal(result.ok, true, result.message)
assert.ok(result.dir && existsSync(result.dir), '克隆目录应存在')
assert.ok(result.fileCount > 0)
assert.ok(result.tree.includes('package.json'))
assert.ok(result.packageJson.includes('@local/demo'))
ok('study 克隆成功并给出源码地图', `${result.fileCount} 个文件，sha=${result.sha}`)

const firstDir = result.dir
result = await tool('updater_study').execute({ repo: remote })
assert.equal(result.reused, true)
assert.equal(result.dir, firstDir)
ok('再次 study 复用已有副本（不重复克隆）')

// ------------------------------------------------------------ 收尾

section('清理')
for (const dir of tempRoots) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* Windows 上偶尔有句柄未释放，忽略 */
  }
}

console.log(`\nupdater: ${passed} 项通过`)
