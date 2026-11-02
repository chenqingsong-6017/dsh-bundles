#!/usr/bin/env node
/**
 * 装配顺序检查：profile.dsh.profile.bundles 的顺序 = Cordis 插件加载/注册顺序
 * = tools/pre-execute waterfall 的调用顺序。
 *
 * 为什么把它做成独立脚本：selfcheck 要能调用，单测要能拿反序 fixture 证明它会红。
 * 顺序语义与早停规则见官方文档：
 *   https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-execution-pipeline.zh.md
 * 本仓说明：D:/AI/dsh-bundles/README.md「pre-execute 拦截链顺序」。
 *
 * 用法：
 *   node _selftest/assembly-order.mjs                     # 默认读 ~/.dsh/profiles/desktop/package.json
 *   node _selftest/assembly-order.mjs --profile <path>    # 指定 profile package.json（测试用）
 *   node _selftest/assembly-order.mjs --json              # 机器可读输出
 */
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const REQUIRED_ORDER = [
  { name: '@local/dsh-checkpoint', role: '留底（先快照后放行）' },
  { name: '@local/dsh-hooks', role: '硬红线（hooks.json 七层，onError=deny）' },
  { name: '@local/dsh-auto-approve', role: '策略代审（可 deny/ask 早停）' },
]

export function defaultProfilePath(env = process.env) {
  const home = env.USERPROFILE || env.HOME || os.homedir()
  return path.join(home, '.dsh', 'profiles', 'desktop', 'package.json')
}

/** 纯函数：传入 profile JSON 对象，返回 { ok, code, order, problems } */
export function checkAssembly(profile, required = REQUIRED_ORDER) {
  const bundles = profile?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) {
    return { ok: false, code: 'NO_BUNDLES', order: [], problems: ['profile 里没有 dsh.profile.bundles 数组，无法判断装配顺序'] }
  }
  const order = required.map((item, i) => ({ ...item, expected: i, index: bundles.indexOf(item.name) }))
  const problems = []
  for (const item of order) {
    if (item.index < 0) problems.push(item.name + '（' + item.role + '）不在 bundles 里：pre-execute 链少一层，等于该层不参与拦截')
  }
  const present = order.filter((item) => item.index >= 0)
  for (let i = 1; i < present.length; i++) {
    const prev = present[i - 1]
    const cur = present[i]
    if (!(prev.index < cur.index)) {
      problems.push(
        prev.name + '（' + prev.role + '，第 ' + (prev.index + 1) + ' 位）必须在 ' +
        cur.name + '（' + cur.role + '，第 ' + (cur.index + 1) + ' 位）之前：' +
        'tools/pre-execute 是 waterfall，先到的层返回结果就早停，后面的层根本拿不到这次调用；' +
        '反序会让安全语义退化（详见 README「pre-execute 拦截链顺序」）',
      )
    }
  }
  return { ok: problems.length === 0, code: problems.length === 0 ? 'OK' : 'ORDER_BROKEN', order, problems }
}

function render(result) {
  if (!result.ok) {
    console.error('✗ 装配顺序不合格（' + result.code + '）：')
    for (const problem of result.problems) console.error('  - ' + problem)
    return
  }
  const chain = result.order.map((item) => item.name + '(#' + (item.index + 1) + ')').join(' → ')
  console.log('装配顺序 OK：' + chain)
}

function main(argv) {
  let profilePath = defaultProfilePath()
  let json = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--profile') { profilePath = argv[++i] }
    else if (argv[i] === '--json') { json = true }
    else { console.error('未知参数：' + argv[i]); process.exit(2) }
  }
  let profile
  try { profile = JSON.parse(readFileSync(profilePath, 'utf8')) } catch (error) {
    if (json) console.log(JSON.stringify({ ok: false, code: 'PROFILE_UNREADABLE', profilePath, problems: [String(error?.message ?? error)] }))
    else console.error('✗ 读不到 profile：' + profilePath + '（' + String(error?.message ?? error) + '）')
    process.exit(1)
  }
  const result = checkAssembly(profile)
  if (json) console.log(JSON.stringify({ ...result, profilePath }))
  else render(result)
  process.exit(result.ok ? 0 : 1)
}

if (import.meta.url === 'file://' + process.argv[1].replace(/\\/g, '/') || process.argv[1]?.endsWith('assembly-order.mjs')) main(process.argv.slice(2))