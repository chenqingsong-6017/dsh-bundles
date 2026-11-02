/**
 * 文件写入护栏（tool.pre · write/edit）—— v3（2026-11-03 修 G1/G2）
 * 拦四类：① 系统目录 ② DSH 凭据 ③ 静态护栏路径 ④ 配置驱动：hooks.json 里每条 run 指向的脚本
 * 第 ④ 条依据：2026-11-03 全局审计发现合并后的 guards-bash-pwsh.mjs 与 _ops/net-guard.mjs
 * 不在旧正则 guard-[a-z]+ 里 → agent 可先改护栏再动手。配置驱动让「改名/搬家」不再产生新洞。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** 配置驱动：目标是否等于 hooks.json 里任意 run 指向的脚本（或 hooks.json 自身）。读不到配置只退回静态规则。 */
function configuredProtectedTarget(t) {
  try {
    const file = process.env.DSH_HOME
      ? path.join(process.env.DSH_HOME, 'hooks.json')
      : path.join(homedir(), '.dsh', 'hooks.json')
    const text = readFileSync(file, 'utf8')
    if (t.endsWith('/hooks.json')) return '护栏配置（hooks.json）'
    for (const m of text.matchAll(/"([^"]+\.(?:mjs|js|cjs))"/g)) {
      const p = m[1].replace(/\\/g, '/').toLowerCase()
      if (p !== '' && t === p) return '护栏脚本（hooks.json 配置驱动）'
    }
  } catch { /* 读不到配置时退回静态规则 */ }
  return null
}

const raw = await new Promise((resolve) => {
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (c) => { buffer += c })
  process.stdin.on('end', () => resolve(buffer))
})
let payload = {}
try { payload = JSON.parse(raw) } catch { process.exit(0) }
const a = payload?.tool?.arguments ?? {}
const target = String(a.file_path ?? a.path ?? '')
if (target.trim() === '') process.exit(0)
const t = target.toLowerCase().replace(/\\/g, '/')

const BLOCK = [
  { re: /^[a-z]:\/windows(\/|$)/, why: 'Windows 系统目录' },
  { re: /^[a-z]:\/program files(\(x86\))?(\/|$)/, why: 'Program Files 目录' },
  { re: /\/system32\//, why: 'System32' },
  { re: /(^|\/)\.credentials\.yaml$/, why: 'DSH 凭据文件' },
  { re: /(^|\/)\.dsh\/hooks\.json$/, why: '护栏配置（改它等于关护栏）' },
  { re: /\/dsh-hooks\/examples\/guard-[a-z]+\.mjs$/, why: '护栏脚本（改它等于关护栏）' },
  // 2026-11-03：合并后的 guards-*.mjs 与 examples 目录下的全部脚本（含 post-reminder）
  { re: /\/dsh-hooks\/examples\/[^/]+\.(mjs|js|cjs)$/, why: '护栏脚本目录（改它等于关护栏）' },
  { re: /\/_ops\/(?:net-guard|install-net-guard|guards?-[a-z-]+|guard-protect-apply)\.mjs$/, why: '护栏脚本（改它等于关护栏）' },
]
for (const { re, why } of BLOCK) {
  if (re.test(t)) {
    console.error('拒绝写入：目标是 ' + why + '（' + target + '）。系统目录、凭据与护栏文件不接受 agent 写入；确需修改请人工操作。')
    process.exit(2)
  }
}
const fromConfig = configuredProtectedTarget(t)
if (fromConfig) {
  console.error('拒绝写入：目标是 ' + fromConfig + '（' + target + '）。护栏只能人工维护——这是防止被注入后先拆防线的必要限制。')
  process.exit(2)
}
process.exit(0)
