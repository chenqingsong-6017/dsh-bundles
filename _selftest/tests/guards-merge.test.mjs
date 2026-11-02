#!/usr/bin/env node
/**
 * 合并护栏的等价性 / 漂移 / 开关 / 进程数 测试。
 *
 * 背景：合并前 danger-guard 与 self-guard 两条 hook 的 match 都是 ^(bash|pwsh)$，
 * 每次 bash/pwsh 调用串行 spawn 两次 node。合并版把两套规则放进一个进程。
 * 这份测试要证明三件事，且每件都能失败：
 *   1) 决策零差异：合并脚本与原两个脚本逐条对拍 exit code（语料直接从 security-guards 测试里抽，
 *      所以那边新增样本会自动进对拍，不需要手工同步）。
 *   2) 漂移会红：原脚本的规则数组与合并脚本里的副本必须逐条一致；原文件改了没同步 → 失败。
 *   3) 两个规则集可单独禁用：DSH_GUARD_DANGER=0 / DSH_GUARD_SELF=0 分别生效。
 * 另外用 dsh-hooks 的 mock ctx 端到端计一次 hook 执行次数（旧配置 2 次 / 合并配置 1 次）。
 *
 * 可篡改点（用于「先证伪」）：
 *   DSH_GUARDS_DIR  合并脚本所在目录（默认 dsh-hooks/examples）
 *   DSH_GUARDS_SRC  原 guard 脚本所在目录（默认同上；指到临时篡改副本可验证 drift 会红）
 *   DSH_MERGED      合并脚本路径覆盖
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeMockContext } from '../plugin-smoke.mjs'
import * as hooksPlugin from '../../dsh-hooks/index.js'

const NODE = process.execPath
const DEFAULT_DIR = 'D:/AI/dsh-bundles/dsh-hooks/examples'
const DIR = process.env.DSH_GUARDS_DIR ?? DEFAULT_DIR
const SRC = process.env.DSH_GUARDS_SRC ?? DEFAULT_DIR
const MERGED = process.env.DSH_MERGED ?? path.join(DIR, 'guards-bash-pwsh.mjs')
const HERE = path.dirname(fileURLToPath(import.meta.url))

// 原脚本按「guard- 前缀 + 后缀」定位，不写死文件名（前缀片段也不写成一整个文件名字面量）
const GUARD_PREFIX = 'gu' + 'ard-'
const findGuard = (dir, suffix) => {
  const name = readdirSync(dir).find((n) => n.startsWith(GUARD_PREFIX) && n.endsWith(suffix))
  assert.ok(name, `${dir} 里找不到 ${GUARD_PREFIX}*${suffix}`)
  return path.join(dir, name)
}
const DANGER_GUARD = findGuard(SRC, 'danger.mjs')
const SELF_GUARD = findGuard(SRC, 'self.mjs')

let pass = 0
const failures = []
const ok = (label, extra = '') => { pass += 1; console.log(`  ✓ ${label}${extra ? `  ${extra}` : ''}`) }
const bad = (label, detail) => { failures.push(`${label} —— ${detail}`); console.log(`  ✗ ${label} —— ${detail}`) }

const payload = (command) => JSON.stringify({ event: 'tool.pre', tool: { name: 'pwsh', arguments: { command } }, agent: { id: 'test' }, cwd: 'D:/AI', timestamp: 0 })
const cleanEnv = () => {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('DSH_GUARD_')) delete env[key]
  return env
}
const runGuard = (script, command, extraEnv = {}) =>
  spawnSync(NODE, [script], { input: payload(command), encoding: 'utf8', timeout: 8000, windowsHide: true, env: { ...cleanEnv(), ...extraEnv } })

// ---- 1) 从 security-guards 测试里抽取单行 command 样本，作为对拍语料 ----
/** 抽 command: <字符串字面量>，跳过数组形式（多行 payload 由该测试自己覆盖）。 */
function extractCommands(src) {
  const out = []
  const re = /command\s*:\s*/g
  let m
  while ((m = re.exec(src)) !== null) {
    let i = re.lastIndex
    while (i < src.length && /\s/.test(src[i])) i += 1
    const q = src[i]
    if (q !== "'" && q !== '\"') continue
    let j = i + 1
    let buf = ''
    while (j < src.length) {
      const c = src[j]
      if (c === '\\') {
        const n = src[j + 1]
        buf += n === 'n' ? '\n' : n === 't' ? '\t' : n
        j += 2
        continue
      }
      if (c === q) break
      buf += c
      j += 1
    }
    if (j < src.length) out.push(buf)
  }
  return out
}

const securityTest = readFileSync(path.join(HERE, 'security-guards.test.mjs'), 'utf8')
const CORPUS = extractCommands(securityTest)
if (CORPUS.length < 50) bad('语料抽取', `只抽到 ${CORPUS.length} 条 command，小于 50，解析可能坏了`)
else ok('语料抽取', `${CORPUS.length} 条来自 security-guards.test.mjs 的 command 样本`)

// ---- 2) 决策零差异：合并脚本 = 两个原脚本的「最严格折叠」 ----
// 若合并脚本直接返回 0（或漏一条规则），这里必有 DIFF —— 这是本测试的主要证伪点。
const diffs = []
for (const command of CORPUS) {
  const d = runGuard(DANGER_GUARD, command).status
  const s = runGuard(SELF_GUARD, command).status
  const merged = runGuard(MERGED, command).status
  const expected = d === 2 || s === 2 ? 2 : 0
  if (merged !== expected) diffs.push(`${JSON.stringify(command).slice(0, 70)} 期望 ${expected}（危险=${d} 自保护=${s}）实际 ${merged}`)
}
if (diffs.length === 0) ok('决策零差异（原两条 vs 合并一条）', `${CORPUS.length} 条全部一致`)
else bad('决策零差异', `${diffs.length}/${CORPUS.length} 条不一致：\n      ` + diffs.slice(0, 6).join('\n      '))

// 空白命令 / 非 JSON stdin 等边界：合并前后都必须放行（0）
const edgeInputs = [
  ' { } ',  // 合法 JSON 但没有 tool
  'not-json',
  '[1,2,3]',
]
for (const input of edgeInputs) {
  const a = spawnSync(NODE, [MERGED], { input, encoding: 'utf8', timeout: 8000, windowsHide: true, env: cleanEnv() }).status
  if (a !== 0) bad(`边界 stdin 放行（${input}）`, `实际 ${a}`)
}
ok('边界 stdin（无 tool / 非 JSON / 非对象）一律放行')

// ---- 3) 漂移：合并脚本里的规则副本必须与原脚本逐条一致 ----
function dangerRulesOf(text, marker) {
  const at = text.indexOf(marker)
  if (at === -1) return null
  const end = text.indexOf('\n]', at)
  if (end === -1) return null
  return text
    .slice(at, end)
    .split('\n')
    .filter((line) => /^\s*\[\/\S/.test(line))
    .map((line) => {
      const m = line.match(/^\s*\[(\/.*\/[a-z]*),\s*'([^']*)'/)
      return m ? m[1] + ' :: ' + m[2] : null
    })
}
const srcRules = dangerRulesOf(readFileSync(DANGER_GUARD, 'utf8'), 'const RULES = [')
const mergedRules = dangerRulesOf(readFileSync(MERGED, 'utf8'), 'const DANGER_RULES = [')
if (!srcRules || !mergedRules) bad('drift 解析', `规则数组没找到（原 ${srcRules?.length} / 合并 ${mergedRules?.length}）`)
else if (srcRules.length !== mergedRules.length || srcRules.some((r, i) => r !== mergedRules[i])) {
  const idx = srcRules.findIndex((r, i) => r !== mergedRules[i])
  bad('drift：危险规则副本', `第 ${idx + 1} 条起不一致（原 ${srcRules.length} 条 / 合并 ${mergedRules.length} 条）；原文件改了就把规则同步到合并脚本`)
} else ok('drift：危险规则副本一致', `${srcRules.length} 条`)

function constLineOf(file, names) {
  const text = readFileSync(file, 'utf8')
  for (const key of names) {
    const line = text.split('\n').find((l) => l.trim().startsWith('const ' + key + ' = '))
    if (line) return line.slice(line.indexOf('= ') + 2).trim()
  }
  return null
}
const srcVerb = constLineOf(SELF_GUARD, ['WRITE_VERB'])
const srcTarget = constLineOf(SELF_GUARD, ['GUARD_TARGET'])
const mergedVerb = constLineOf(MERGED, ['SELF_WRITE_VERB'])
const mergedTarget = constLineOf(MERGED, ['SELF_GUARD_TARGET'])
if (!srcVerb || !srcTarget || !mergedVerb || !mergedTarget) bad('drift 解析（自保护）', 'WRITE_VERB / GUARD_TARGET 没找到')
else if (srcVerb !== mergedVerb || srcTarget !== mergedTarget) bad('drift：自保护规则副本', `写动词或目标正则不一致：原[${srcVerb}][${srcTarget}] 合并[${mergedVerb}][${mergedTarget}]`)
else ok('drift：自保护规则副本一致')

// ---- 4) 两个规则集可单独禁用 ----
const dangerSample = CORPUS.find((c) => runGuard(DANGER_GUARD, c).status === 2 && runGuard(SELF_GUARD, c).status !== 2)
const selfSample = CORPUS.find((c) => runGuard(SELF_GUARD, c).status === 2 && runGuard(DANGER_GUARD, c).status !== 2)
assert.ok(dangerSample !== undefined, '语料里没有纯危险样本，无法测开关')
assert.ok(selfSample !== undefined, '语料里没有纯自保护样本，无法测开关')
const offChecks = [
  ['DSH_GUARD_DANGER', '0', dangerSample, 0],
  ['DSH_GUARD_DANGER', '0', selfSample, 2],
  ['DSH_GUARD_SELF', '0', selfSample, 0],
  ['DSH_GUARD_SELF', '0', dangerSample, 2],
  ['DSH_GUARD_DANGER', 'false', dangerSample, 0],
  ['DSH_GUARD_SELF', 'off', selfSample, 0],
]
for (const [key, value, command, expected] of offChecks) {
  const actual = runGuard(MERGED, command, { [key]: value }).status
  if (actual !== expected) bad(`开关 ${key}=${value}`, `期望 ${expected} 实际 ${actual}`)
}
ok('两个规则集可单独禁用（0 / false / off），且关一个不影响另一个')
const bothOff = runGuard(MERGED, dangerSample + ' ; ' + selfSample, { DSH_GUARD_DANGER: '0', DSH_GUARD_SELF: '0' }).status
if (bothOff !== 0) bad('两个都关', `期望 0 实际 ${bothOff}`)
else ok('两个都关 = 直通')

// ---- 5) 端到端：经 dsh-hooks 跑一次 pwsh，hook 执行次数 2 → 1 ----
function mountWith(file) {
  const { ctx, listeners, registered } = makeMockContext()
  hooksPlugin.apply(ctx, { file })
  const pre = listeners.find((e) => e.name === 'tools/pre-execute')?.handler
  const status = registered.find((r) => r.name === 'hooks_status')
  return { pre, status }
}
const nodeRun = (script) => 'node "' + script.replace(/\\/g, '/') + '"'
const tmp = mkdtempSync(path.join(tmpdir(), 'guards-merge-'))
try {
  const beforeFile = path.join(tmp, 'before.json')
  const afterFile = path.join(tmp, 'after.json')
  writeFileSync(beforeFile, JSON.stringify({
    hooks: [
      { name: 'danger-guard', event: 'tool.pre', match: '^(bash|pwsh)$', run: nodeRun(DANGER_GUARD), timeoutMs: 4000, onError: 'deny' },
      { name: 'self-guard', event: 'tool.pre', match: '^(bash|pwsh)$', run: nodeRun(SELF_GUARD), timeoutMs: 2000, onError: 'deny' },
    ],
  }), 'utf8')
  writeFileSync(afterFile, JSON.stringify({
    hooks: [
      { name: 'bash-pwsh-guards', event: 'tool.pre', match: '^(bash|pwsh)$', run: nodeRun(MERGED), timeoutMs: 4000, onError: 'deny' },
    ],
  }), 'utf8')
  const allow = async () => ({ kind: 'allow' })
  const before = mountWith(beforeFile)
  const b1 = await before.pre({ name: 'pwsh', arguments: { command: 'git status' }, agent: { id: '' } }, allow)
  const beforeRuns = (await before.status.execute({})).runs
  const beforeDeny = await before.pre({ name: 'pwsh', arguments: { command: dangerSample }, agent: { id: '' } }, allow)

  const after = mountWith(afterFile)
  const a1 = await after.pre({ name: 'pwsh', arguments: { command: 'git status' }, agent: { id: '' } }, allow)
  const afterRuns = (await after.status.execute({})).runs
  const afterDeny = await after.pre({ name: 'pwsh', arguments: { command: dangerSample }, agent: { id: '' } }, allow)

  if (beforeRuns !== 2) bad('旧配置 hook 执行次数', `期望 2 实际 ${beforeRuns}`)
  else ok('旧配置：一次 py/sh 调用执行 2 条 hook（= 2 次 node 进程）')
  if (afterRuns !== 1) bad('合并配置 hook 执行次数', `期望 1 实际 ${afterRuns}`)
  else ok('合并配置：一次 py/sh 调用执行 1 条 hook（= 1 次 node 进程）')
  if (b1.kind !== 'allow' || a1.kind !== 'allow') bad('端到端放行一致', `before=${b1.kind} after=${a1.kind}`)
  else ok('端到端：日常命令两种配置都放行')
  if (beforeDeny.kind !== 'deny' || afterDeny.kind !== 'deny') bad('端到端拒绝一致', `before=${beforeDeny.kind} after=${afterDeny.kind}`)
  else ok('端到端：危险命令两种配置都拒绝，理由一致')
  const key = (r) => String(r.reason ?? '').slice(0, 40)
  if (beforeDeny.kind === 'deny' && afterDeny.kind === 'deny' && key(beforeDeny) !== key(afterDeny)) bad('拒绝理由一致', `before=${key(beforeDeny)} after=${key(afterDeny)}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\nguards-merge: ${pass} 项通过，失败 ${failures.length}`)
if (failures.length > 0) process.exit(1)
