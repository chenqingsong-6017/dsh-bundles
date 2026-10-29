/**
 * 真实 GitHub 联调：拿公开仓库 + 本机真实插件跑一次 dryRun。
 * dryRun 只克隆/校验/算差异，不写任何本地文件，可以安全对着真插件跑。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'

const GIT = 'C:\\Program Files\\Git\\cmd\\git.exe'

function makeSubprocess() {
  return {
    async resolveExecutable(name) {
      const table = { git: GIT, node: process.execPath }
      if (!table[name]) throw new Error(`找不到 ${name}`)
      return table[name]
    },
    spawn({ argv, cwd, stdio, signal }) {
      const child = nodeSpawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      const buffers = { stdout: [], stderr: [] }
      child.stdout.on('data', (chunk) => buffers.stdout.push(chunk))
      child.stderr.on('data', (chunk) => buffers.stderr.push(chunk))
      if (signal) signal.addEventListener('abort', () => { try { child.kill() } catch { /* 已退出 */ } })
      const done = new Promise((resolve) => {
        child.on('close', (code, sig) => resolve({ exitCode: code, signal: sig }))
        child.on('error', (error) => resolve({ exitCode: -1, signal: null, error: error.message }))
      })
      const collector = (bucket) => ({
        readFrom(offset = 0) {
          return { text: Buffer.concat(buffers[bucket]).toString('utf8').slice(offset) }
        },
      })
      return { done, collected: { stdout: collector('stdout'), stderr: collector('stderr') }, terminate() { try { child.kill() } catch { /* 已退出 */ } } }
    },
  }
}

const registered = new Map()
const ctx = {
  tools: { register(def) { registered.set(def.name, def); return () => registered.delete(def.name) } },
  subprocess: makeSubprocess(),
  effect(fn) { return fn() },
}

const store = mkdtempSync(path.join(tmpdir(), 'updater-live-'))
const updater = await import('../dsh-updater/index.js')
updater.apply(ctx, {
  storeDir: store,
  allowedRoots: ['D:\\AI\\dsh-bundles'],
  backupsToKeep: 2,
  gitTimeoutMs: 180000,
})

const tool = (name) => registered.get(name)
const call = async (name, args) => {
  const started = Date.now()
  const value = await tool(name).execute(args, {})
  const rendered = tool(name).output.render ? tool(name).output.render(args, value) : []
  return { value, rendered, ms: Date.now() - started }
}

console.log('=== 1) 登记真实 GitHub 源 ===')
let out = await call('updater_source', {
  action: 'add',
  name: 'eva-theme',
  repo: 'https://github.com/seaison/dsh-plugin-eva-theme.git',
  localDir: 'D:\\AI\\dsh-bundles\\dsh-plugin-eva-theme',
  bundleName: 'dsh-plugin-eva-theme',
})
console.log(out.rendered[0]?.text ?? JSON.stringify(out.value))

console.log('\n=== 2) check 远端（ls-remote，零 API 配额）===')
out = await call('updater_check', {})
console.log(`${out.ms} ms`)
console.log(out.rendered[0]?.text ?? JSON.stringify(out.value))

console.log('\n=== 3) apply dryRun（克隆 + 校验 + 算差异，不写盘）===')
out = await call('updater_apply', { name: 'eva-theme', dryRun: true })
console.log(`${out.ms} ms`)
console.log(`status=${out.value.status} ok=${out.value.ok}`)
console.log(`fromVersion=${out.value.fromVersion} toVersion=${out.value.toVersion}`)
console.log(`files=${JSON.stringify(out.value.files)}`)
console.log(`issues=${JSON.stringify(out.value.issues)}`)
console.log(`diffStat:\n${out.value.diffStat || '(无)'}`)
if (out.value.message) console.log(`message=${out.value.message}`)
console.log('\n--- rendered ---')
console.log(out.rendered[0]?.text ?? '')

console.log('\n=== 4) 确认 dryRun 没动本地文件 ===')
const { readFileSync } = await import('node:fs')
const manifest = JSON.parse(readFileSync('D:\\AI\\dsh-bundles\\dsh-plugin-eva-theme\\package.json', 'utf8'))
console.log(`本地仍是 ${manifest.name}@${manifest.version}`)

console.log('\n=== 5) study 一个真实公开仓库 ===')
out = await call('updater_study', { repo: 'https://github.com/seaison/dsh-plugin-eva-theme.git' })
console.log(`${out.ms} ms`)
console.log(`ok=${out.value.ok} sha=${out.value.sha} files=${out.value.fileCount} reused=${out.value.reused}`)
console.log(`dir=${out.value.dir}`)
console.log(`tree(前12)=${JSON.stringify(out.value.tree.slice(0, 12))}`)
if (out.value.message) console.log(`message=${out.value.message}`)

rmSync(store, { recursive: true, force: true })
console.log('\n完成')
