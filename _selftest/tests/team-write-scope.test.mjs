#!/usr/bin/env node
/**
 * team write_scopes 回归 —— 复现 2026-11-02 10:18:24 的 5 次 TEAM_INVALID_WRITE_SCOPE，
 * 并机器检查「本仓文档里不许出现绝对路径 write_scopes 的示例」。
 *
 * 报错来自官方 @deepseek-ai/dsh-experimental-agent-team（lib/types/validation.js 的 writeScope()）：
 * 先把 \ 归一成 /，再拒绝「以 / 开头 / 以盘符开头（/^[a-z]:/i）/ 含空段或 . 或 .. / 空串」，
 * 抛 TeamError(code = TEAM_INVALID_WRITE_SCOPE)。
 *
 * 为什么要把官方模块抽出来跑，而不是在测试里复述这条规则：
 *   1. 本检查的命题是「官方实现真的会拒绝 D:\…」——只有跑官方原函数才算证据；
 *   2. asar 里的模块不能直接 import，所以用 _ops/asar.mjs cat 抽到临时目录再动态 import；
 *   3. validation.js 只 import ./error.js，而 error.js 又 import @deepseek-ai/dsh-llm
 *      （该包只存在于 app.asar 内，磁盘上没有），所以 error.js 换成同接口的本地 shim：
 *      shim 只继承 Error 并保留 code 字段，被测的判断逻辑仍是官方 validation.js 原文。
 *
 * 可证伪开关（故意留的，用来证明断言不是永远绿）：
 *   TEAM_VALIDATION_DIR  指向含 validation.js + error.js 的目录，替代 asar 抽取。
 *                        把 validation.js 里的盘符判断删掉再跑，用例 1 必须红。
 *   TEAM_DOC_SCAN_ROOT   覆盖文档 lint 的扫描根；指向放了绝对路径示例的临时目录必须红。
 *   DSH_ASAR             覆盖 app.asar 路径（DSH 换安装位置时用）。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SELFTEST = path.resolve(HERE, '..')
const BUNDLES = path.resolve(SELFTEST, '..')
const WORKSPACE = process.env.TEAM_DOC_SCAN_ROOT ?? 'D:\\AI-date\\dsh-date\\dsh-创建'
const ASAR = process.env.DSH_ASAR ?? 'D:\\AI\\deepsek harness\\resources\\app.asar'
const PKG = 'dsh/node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/types'

// error.js 的替身：官方 error.js 依赖 @deepseek-ai/dsh-llm，只存在于 app.asar 内。
// 这里保持 HarnessError/TeamError 的形状（message + code），让官方 validation.js 原样可跑。
const ERROR_SHIM = [
  'export class HarnessError extends Error {',
  '  constructor(message, code) { super(message); this.name = "HarnessError"; this.code = code }',
  '}',
  'export class TeamError extends HarnessError {',
  '  constructor(message, code) { super(message); this.name = "TeamError"; this.code = code }',
  '}',
  '',
].join('\n')

let passed = 0
const ok = (label) => { passed += 1; console.log('  \u2713 ' + label) }

function materializeOfficial() {
  if (process.env.TEAM_VALIDATION_DIR) return process.env.TEAM_VALIDATION_DIR
  if (!existsSync(ASAR)) {
    throw new Error('找不到 app.asar：' + ASAR + '（用 DSH_ASAR 指定；这条回归的判据是官方实现，不能跳过）')
  }
  const cli = path.join(BUNDLES, '_ops', 'asar.mjs')
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-team-write-scope-'))
  const r = spawnSync(process.execPath, [cli, 'cat', PKG + '/validation.js'], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error('asar 抽取 validation.js 失败：' + (r.stderr || r.stdout))
  writeFileSync(path.join(dir, 'validation.js'), r.stdout)
  writeFileSync(path.join(dir, 'error.js'), ERROR_SHIM)
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  return dir
}

// ---------- 1. 官方实现：绝对路径必须被拒（复现日志里的原错误） ----------
const dir = materializeOfficial()
const { writeScope } = await import(pathToFileURL(path.join(dir, 'validation.js')).href)

const rejects = (label, value) => {
  let error = null
  try { writeScope(value) } catch (caught) { error = caught }
  assert.ok(error, label + '：应被拒绝，但被接受了（输入 ' + JSON.stringify(value) + '）')
  assert.equal(error.code, 'TEAM_INVALID_WRITE_SCOPE', label + '：错误码不对')
  assert.match(error.message, /invalid workspace-relative write scope/, label + '：错误文案与日志不一致')
  ok(label + ' → ' + error.code)
}

// 日志原文（events-2026-11-02.jsonl:8-12）里的值就是这种反斜杠绝对路径。
rejects('反斜杠绝对路径（日志原样）', 'D:\\AI\\dsh-bundles\\dsh-memory\\')
rejects('正斜杠绝对路径', 'D:/AI/dsh-bundles/dsh-memory')
rejects('以 / 开头', '/abs/path')
rejects('UNC 路径', '\\\\server\\share\\x')
rejects('.. 越界', '../outside')
rejects('空串', '')

assert.equal(writeScope('./_selftest/tests/'), '_selftest/tests', '相对路径应通过并去掉 ./ 与结尾 /')
assert.equal(writeScope('dsh-memory\\index.js'), 'dsh-memory/index.js', '相对路径应把 \ 归一成 /')
ok('相对路径通过并归一化（./_selftest/tests/ → _selftest/tests）')

// ---------- 2. 文档 lint：示例值不许是绝对路径 ----------
const DOC_EXT = new Set(['.md', '.mdx', '.json', '.yml', '.yaml', '.txt'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.pnpm', 'dist', 'build', 'out', 'coverage'])
const MENTION = /write[_-]?scopes?/gi
const QUOTED = /["'\u0060]([^"'\u0060\n]+)["'\u0060]/g
const isAbsolute = (value) => /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || /^\/[^/]/.test(value)

function* walkDocs(root) {
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walkDocs(full)
    } else if (DOC_EXT.has(path.extname(entry.name).toLowerCase())) {
      yield full
    }
  }
}

/** 只认真当值是数组/字符串的地方，正文里提到路径不算违规。 */
export function lintWriteScopeExamples(text) {
  const violations = []
  let match
  MENTION.lastIndex = 0
  while ((match = MENTION.exec(text)) !== null) {
    const seg = text.slice(match.index, match.index + 400)
    const line = text.slice(0, match.index).split('\n').length
    let body = null
    const bracket = seg.indexOf('[')
    const colon = seg.search(/[:=]/)
    if (bracket >= 0 && colon >= 0 && colon < bracket) {
      const close = seg.indexOf(']', bracket)
      body = seg.slice(bracket, close < 0 ? seg.length : close + 1)
    } else {
      const single = /^[\s=:]*["'\u0060]([^"'\u0060\n]+)["'\u0060]/.exec(seg.slice(match[0].length))
      if (single) body = single[1]
    }
    if (!body) continue
    for (const quoted of body.matchAll(QUOTED)) {
      if (isAbsolute(quoted[1])) violations.push({ line, value: quoted[1] })
    }
  }
  return violations
}

// 先证明 lint 自己会红：这一段是「检查必须能失败」的证据，不是摆设。
const CANARY = '示例：write_scopes: ["D:\\\\AI\\\\dsh-bundles\\\\dsh-memory\\\\"]\n'
assert.equal(lintWriteScopeExamples(CANARY).length, 1, '文档 lint 必须能抓出绝对路径示例（否则它是装饰）')
assert.equal(lintWriteScopeExamples('write_scopes 只收相对路径，仓外目标不写这个字段\n').length, 0)
ok('文档 lint 自检：绝对路径示例报 1 处，正文提及不误报')

const files = [...walkDocs(WORKSPACE)].filter((file) => {
  try { return statSync(file).size < 1_500_000 } catch { return false }
})
const found = []
for (const file of files) {
  for (const violation of lintWriteScopeExamples(readFileSync(file, 'utf8'))) {
    found.push(file + ':' + violation.line + ' → ' + violation.value)
  }
}
assert.deepEqual(found, [], '本仓文档里出现了绝对路径 write_scopes 示例：\n' + found.join('\n'))
ok('文档 lint：扫 ' + files.length + ' 个文档，0 处绝对路径 write_scopes 示例')

console.log('\nteam-write-scope: ' + passed + ' 项通过')
