/**
 * 文件写入护栏（tool.pre · write/edit）—— v2
 * 拦三类：① 系统目录 ② DSH 凭据 ③ 护栏自身（hooks.json、guard-*.mjs）
 * 第 ③ 条依据：被注入的 agent 若能改护栏，等于可先拆防线（见 _research/security-guardrails.md R28/R30）。
 * 代价：以后护栏脚本只由人工维护；agent 改不了它。
 */
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
]
for (const { re, why } of BLOCK) {
  if (re.test(t)) {
    console.error('拒绝写入：目标是 ' + why + '（' + target + '）。系统目录、凭据与护栏文件不接受 agent 写入；确需修改请人工操作。')
    process.exit(2)
  }
}
process.exit(0)
