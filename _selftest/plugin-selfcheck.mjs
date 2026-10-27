/**
 * dsh-butler-tidy 自检：结构 + schema + 行为 + 安装状态
 * - 每个工具的 parameters / output.schema 是否齐全
 * - 每个返回值是否严格匹配自己的 output.schema（字段、类型、多余字段）
 * - render 是否产出非空文本
 * - 安装版本是否与源码一致
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const PKG = 'D:\\AI\\dsh-bundles\\dsh-butler-tidy'
const FIX = 'D:\\AI\\dsh-data\\selfcheck-fixture'
const STORE = 'D:\\AI\\dsh-data\\selfcheck-store'
const PROFILE_PKG = path.join(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop', 'package.json')

let pass = 0
const fails = []
const check = (label, ok, extra = '') => {
  if (ok) {
    pass += 1
  } else {
    fails.push(`${label} ${extra}`)
    console.log(`  ✗ ${label} ${extra}`)
  }
}

const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v)
const typeOk = (want, v) => {
  const t = typeOf(v)
  if (want === 'integer') return Number.isInteger(v)
  if (want === 'number') return typeof v === 'number'
  if (want === 'array') return Array.isArray(v)
  if (want === 'object') return t === 'object'
  return t === want
}

function validateSchema(schema, value, where = '$') {
  const errors = []
  const walk = (s, v, p) => {
    if (!s || typeof s !== 'object') return
    if (s.type && !typeOk(s.type, v)) {
      errors.push(`${p}: 期望 ${s.type}，实际 ${typeOf(v)}`)
      return
    }
    if (s.type === 'array' && s.items) {
      v.forEach((item, index) => walk(s.items, item, `${p}[${index}]`))
    }
    if (s.type === 'object' && v && typeof v === 'object') {
      for (const key of s.required || []) if (!(key in v)) errors.push(`${p}: 缺字段 ${key}`)
      if (s.additionalProperties === false) {
        for (const key of Object.keys(v)) {
          if (!s.properties || !(key in s.properties)) errors.push(`${p}: 多出字段 ${key}`)
        }
      }
      for (const [key, sub] of Object.entries(s.properties || {})) {
        if (key in v) walk(sub, v[key], `${p}.${key}`)
      }
    }
  }
  walk(schema, value, where)
  return errors
}

// ── 准备 ─────────────────────────────────────────────────────
if (existsSync(FIX)) rmSync(FIX, { recursive: true, force: true })
if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true })
mkdirSync(path.join(FIX, 'empty-a', 'empty-b'), { recursive: true })
mkdirSync(path.join(FIX, 'empty-c'), { recursive: true })
writeFileSync(path.join(FIX, 'doc.pdf'), 'pdf')
writeFileSync(path.join(FIX, 'pic.jpg'), 'jpg')
writeFileSync(path.join(FIX, '中文文档.txt'), 'text')
writeFileSync(path.join(FIX, 'dup-1.bin'), Buffer.alloc(8192, 9))
writeFileSync(path.join(FIX, 'dup-2.bin'), Buffer.alloc(8192, 9))

const registered = new Map()
const ctx = {
  tools: { register(def) { registered.set(def.name, def); return () => {} } },
  effect(fn) { fn() },
  get() { return undefined },
  logger() { return { debug() {}, info() {}, warn() {}, error() {} } },
}

const mod = await import('../dsh-butler-tidy/index.js')
mod.apply(ctx, { storeDir: STORE })

// ── 1. 结构检查 ──────────────────────────────────────────────
const EXPECTED = ['tidy_scan', 'tidy_plan', 'tidy_apply', 'tidy_undo', 'tidy_status']
for (const name of EXPECTED) {
  const tool = registered.get(name)
  check(`工具存在：${name}`, Boolean(tool))
  if (!tool) continue
  check(`${name} 有 description`, typeof tool.description === 'string' && tool.description.length > 20)
  check(`${name} 有 parameters`, tool.parameters && tool.parameters.type === 'object')
  check(`${name} 有 output.schema`, Boolean(tool.output && tool.output.schema))
  check(`${name} 有 render`, typeof tool.output?.render === 'function')
  check(`${name} schema 允许闭包`, tool.output?.schema?.additionalProperties === false)
}
check('工具数量 = 5（符合 UX 规范 3–5）', registered.size === 5, `实际 ${registered.size}`)

// ── 2. 行为 + schema 一致性 ─────────────────────────────────
const call = async (name, args) => {
  const tool = registered.get(name)
  const value = await tool.execute(args, {})
  const errors = validateSchema(tool.output.schema, value, name)
  check(`${name} 返回满足 schema`, errors.length === 0, errors.slice(0, 3).join(' | '))
  const rendered = tool.output.render(args, value)
  check(
    `${name} render 输出有效`,
    Array.isArray(rendered) && rendered.length > 0 && rendered.every((item) => item.type === 'text' && item.text.length > 0),
  )
  return value
}

const scanDrive = await call('tidy_scan', { drive: 'd' })
check(
  '盘点返回 D 盘余量',
  scanDrive.drives.length === 1 && scanDrive.drives[0].letter.toUpperCase() === 'D',
  JSON.stringify(scanDrive.drives),
)
check('未指定 path 时 inspect 为空', scanDrive.inspect.path === '')

const scanTarget = await call('tidy_scan', { drive: 'd', path: FIX })
check('探查给出结论', ['safe', 'caution', 'forbidden', 'missing'].includes(scanTarget.inspect.verdict))
check('探查统计到文件', scanTarget.inspect.files >= 5, `实际 ${scanTarget.inspect.files}`)

const scanHealth = await call('tidy_scan', { drive: 'd', health: true })
check('体检：7 天错误数为数字', typeof scanHealth.health.errors7d === 'number')
check('体检：已装软件数 >= 0', scanHealth.health.installedApps >= 0)

const scanResidue = await call('tidy_scan', { drive: 'd', residue: true })
check('残留：四类均为数组', ['deadPath', 'ghostServices', 'deadStartup', 'deadTasks'].every((key) => Array.isArray(scanResidue.residue[key])))

const scanEvents = await call('tidy_scan', { drive: 'd', events: true })
check(
  '事件：系统/应用总量为数字',
  typeof scanEvents.events.systemTotal === 'number' && typeof scanEvents.events.appTotal === 'number',
)
check('事件：Top 分组为数组', Array.isArray(scanEvents.events.systemTop) && Array.isArray(scanEvents.events.appTop))

for (const kind of ['organize', 'clean', 'folders', 'rename', 'empty', 'dupes']) {
  const args = { kind, target: FIX }
  if (kind === 'rename') args.renames = [{ path: path.join(FIX, '中文文档.txt'), name: 'chinese-doc' }]
  const planned = await call('tidy_plan', args)
  check(`plan ${kind} 有 hint`, typeof planned.hint === 'string' && planned.hint.length > 0)
}
check('plan dupes 找到重复组', (await call('tidy_plan', { kind: 'dupes', target: FIX })).dupeGroups.length === 1)

const residuePlan = await call('tidy_plan', { kind: 'residue' })
check('残留方案返回条目数组', Array.isArray(residuePlan.residueItems))
check('残留条目带作用域', residuePlan.residueItems.every((item) => item.scope === 'user' || item.scope === 'admin'))
const residueRefused = await call('tidy_apply', { kind: 'residue', confirm: false })
check('残留处置未确认拒绝', residueRefused.applied === false && residueRefused.moved === 0)

const refused = await call('tidy_apply', { kind: 'organize', target: FIX, confirm: false })
check('未确认拒绝执行', refused.applied === false && refused.moved === 0)

const emptyApplied = await call('tidy_apply', { kind: 'empty', target: FIX, confirm: true })
check('空目录清理生效', emptyApplied.applied === true && emptyApplied.moved >= 2, `实际 ${emptyApplied.moved}`)

const dupesApplied = await call('tidy_apply', { kind: 'dupes', target: FIX, confirm: true })
check('查重隔离生效', dupesApplied.applied === true && dupesApplied.moved >= 1)

const undoRefused = await call('tidy_undo', { confirm: false })
check('撤销未确认拒绝', undoRefused.applied === false)
const undone = await call('tidy_undo', { confirm: true })
check('撤销生效', undone.applied === true && undone.restored >= 1)

const status = await call('tidy_status', {})
check('诊断指向数据目录', status.storeDir === STORE)
check('诊断记录清单数 >= 1', status.manifests >= 1, `实际 ${status.manifests}`)

// ── 3. 安装状态 ─────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(path.join(PKG, 'package.json'), 'utf8'))
check('包名正确', pkg.name === '@local/dsh-butler-tidy')
check('manifest 指向 patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
check('导出 icon/locale', Boolean(pkg.exports['./icon']) && Boolean(pkg.exports['./locale/*.json']))
check('README 存在', existsSync(path.join(PKG, 'README.md')))
check('icon.svg 存在', existsSync(path.join(PKG, 'icon.svg')))
check('locale/zh.json 存在', existsSync(path.join(PKG, 'locale', 'zh.json')))

let installedVersion = '（未读）'
if (existsSync(PROFILE_PKG)) {
  const profile = JSON.parse(readFileSync(PROFILE_PKG, 'utf8'))
  const dep = String(profile.dependencies?.['@local/dsh-butler-tidy'] || '')
  if (dep.startsWith('link:')) {
    const targetPkg = path.join(dep.slice(5), 'package.json')
    installedVersion = existsSync(targetPkg) ? JSON.parse(readFileSync(targetPkg, 'utf8')).version : dep
  } else {
    installedVersion = dep || '（未安装）'
  }
}
check('安装版本与源码一致', String(installedVersion).includes(pkg.version), `源码 ${pkg.version} / profile ${installedVersion}`)

// ── 4. 清理 ─────────────────────────────────────────────────
rmSync(FIX, { recursive: true, force: true })
rmSync(STORE, { recursive: true, force: true })

console.log(`\n结果：${fails.length === 0 ? `全部通过（${pass} 项）` : `${fails.length} 项失败 / 通过 ${pass} 项`}`)
for (const failure of fails) console.log(`  - ${failure}`)
if (fails.length > 0) process.exitCode = 1
