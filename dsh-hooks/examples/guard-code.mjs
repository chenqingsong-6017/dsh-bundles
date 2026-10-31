/**
 * 代码执行护栏（tool.pre · run_code）—— v3
 * 变更：删掉 guard-code:allow 逃生口（研究结论 R33：一行字即可绕过，等于没有）；
 * 保留长字符串字面量（>400 字符）豁免，避免写测试/文档时误伤。
 * 已知上限：best-effort，正则抓不到刻意混淆的代码。
 */
const raw = await new Promise((resolve) => {
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (c) => { buffer += c })
  process.stdin.on('end', () => resolve(buffer))
})
let payload = {}
try { payload = JSON.parse(raw) } catch { process.exit(0) }
const args = payload?.tool?.arguments ?? {}
const code = String(args.code ?? args.program ?? '')
if (code.trim() === '') process.exit(0)

const DESTRUCTIVE = /(rmSync|rmdirSync|unlinkSync|writeFileSync|appendFileSync|createWriteStream|execSync|execFileSync|spawnSync|child_process|Remove-Item|\bdel\s|\brmdir\s|diskpart|bcdedit|cipher\s+\/w|takeown|reg\s+(delete|save)|sc\s+(delete|create)|schtasks|Set-MpPreference|Disable-NetFirewallRule|shutdown)/i
const SYS_TARGET = /(Windows|Program Files|System32|HKLM|HKEY_LOCAL_MACHINE|\.credentials\.yaml|hooks\.json|guard-[a-z]+\.mjs)/gi
const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/gs

const LONG = []
let m
while ((m = LITERAL.exec(code)) !== null) { if (m[0].length > 400) LONG.push([m.index, m.index + m[0].length]) }
const inLong = (pos) => LONG.some((s) => pos >= s[0] && pos <= s[1])

let hit = null
SYS_TARGET.lastIndex = 0
while ((m = SYS_TARGET.exec(code)) !== null) {
  if (inLong(m.index)) continue
  const ctx = code.slice(Math.max(0, m.index - 160), m.index + 160)
  if (!DESTRUCTIVE.test(ctx)) continue
  const lineStart = code.lastIndexOf('\n', m.index) + 1
  const lineEnd = code.indexOf('\n', m.index)
  const line = code.slice(lineStart, lineEnd === -1 ? code.length : lineEnd)
  const readOnly = /^\s*(?:const|let|var)?\s*\w*\s*=\s*(?:await\s+)?(?:fs\.)?(readFileSync|readdirSync|readFile|existsSync|statSync|lstatSync)\b/.test(line)
    && !/rmSync|writeFileSync|unlinkSync|execSync|spawnSync/.test(line)
  if (readOnly) continue
  hit = { where: m[0], line: line.trim().slice(0, 120) }
  break
}
if (hit) {
  console.error('拒绝执行：程序里同时出现「破坏性操作」与「系统目标/凭据/护栏文件」（命中 ' + hit.where + '）。run_code 是任意代码执行，这类组合不可逆或可拆护栏，已拦下。如危险文本只是数据（测试/文档），请放进超过 400 字符的字符串。')
  process.exit(2)
}
process.exit(0)
