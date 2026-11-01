/**
 * 代码执行护栏（tool.pre · run_code）—— v4（2026-11-01 修误报）
 * @guard-revision: 2026-11-01-falsepositive-fix
 *
 * v4 相对 v3 的四处改动（根因与证据见 D:/AI/dsh-data/tmp/guard-fix/README.md）：
 *   1) 系统目标加词边界：\bWindows\b 不再命中 windowsHide（Node spawnSync 的普通选项名）。
 *      这是 12:40:30 / 12:43:49 / 12:45:52 三次误报的唯一原因。
 *   2) 「破坏性」集合拆开：execSync / execFileSync / spawnSync / child_process 是「执行子进程」，
 *      本身不破坏任何东西，不该算破坏性操作；它们只有在「同一段上下文里还有 shell 解释器」时才判危险。
 *      这是 12:54:04「C:\Program Files\nodejs\node.exe」误报的原因。
 *      被拆走的检出力由新增的壳删除动词（rd /s、del /f、format x:）补回，净检出量不降。
 *   3) 注释先掩成空格（等长，索引不变）再匹配——注释不可能被执行，里面提到 Windows/hooks.json
 *      不构成风险。12:46:24 那次 agent 为了绕误报把 windowsHide 拆成 "wind"+"owsHide" 写文件，
 *      加了注释掩码后这类 workaround 不再需要（已收进回归用例 fp-124624）。
 *   4) 字符串字面量**不掩**：execSync('reg delete HKLM/...') 里的命令文本是要被执行的，掩了就漏检。
 *
 * 保留 v3 的 >400 字符字面量豁免（写测试/文档时，危险文本只是数据）。
 * 已知上限：best-effort，正则抓不到刻意混淆的代码；「危险文本当数据写进短字符串」仍可能误报（见 README 残余风险）。
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

const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/gs
const LONG = []
let m
while ((m = LITERAL.exec(code)) !== null) { if (m[0].length > 400) LONG.push([m.index, m.index + m[0].length]) }
const inLong = (pos) => LONG.some((s) => pos >= s[0] && pos <= s[1])

/** 把注释替换成等长空格（字符串里的 // 不算注释）。返回同长度字符串，索引与原文一一对应。 */
function maskComments(src) {
  const chars = src.split('')
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      i += 1
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === c) { i += 1; break }
        i += 1
      }
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { chars[i] = ' '; i += 1 }
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      chars[i] = ' '; chars[i + 1] = ' '; i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { chars[i] = ' '; i += 1 }
      if (i < src.length) { chars[i] = ' '; chars[i + 1] = ' '; i += 2 }
      continue
    }
    i += 1
  }
  return chars.join('')
}
const scan = maskComments(code)

// 破坏性动词：真正的删除 / 覆盖 / 系统写操作（含壳里的 rd /s、del /f、format x:）。
// 刻意不含 execSync / spawnSync —— 执行子进程本身不具破坏性。
const DESTRUCTIVE = /(rmSync|rmdirSync|unlinkSync|writeFileSync|appendFileSync|createWriteStream|Remove-Item|\bdel\s+\/|\bdel\s+[a-z]:|\brmdir\s|\brd\s+\/s|\bformat\s+[a-z]:|diskpart|bcdedit|cipher\s+\/w|takeown|reg\s+(delete|save)|sc\s+(delete|create)|schtasks|Set-MpPreference|Disable-NetFirewallRule|shutdown)/i
// 执行子进程原语：只有与 shell 解释器同现时才升级为危险。
const EXEC_PRIM = /(execSync|execFileSync|spawnSync|child_process)/i
const SHELL_BIN = /\b(cmd|powershell|pwsh|wscript|cscript|mshta|rundll32|regsvr32|certutil|bitsadmin|installutil|regasm|msbuild|wmic|schtasks|vssadmin|wevtutil)\b/i
// 系统目标 / 凭据 / 护栏文件。加词边界，避免 windowsHide、WindowsPaths 这类标识符误判。
const SYS_TARGET = /\b(Windows|Program Files|System32|HKLM|HKEY_LOCAL_MACHINE)\b|\.credentials\.yaml|hooks\.json|guard-[a-z]+\.mjs/gi

let hit = null
SYS_TARGET.lastIndex = 0
while ((m = SYS_TARGET.exec(scan)) !== null) {
  if (inLong(m.index)) continue
  const ctx = scan.slice(Math.max(0, m.index - 160), m.index + 160)
  const destructive = DESTRUCTIVE.test(ctx) || (EXEC_PRIM.test(ctx) && SHELL_BIN.test(ctx))
  if (!destructive) continue
  const lineStart = scan.lastIndexOf('\n', m.index) + 1
  const lineEnd = scan.indexOf('\n', m.index)
  const line = scan.slice(lineStart, lineEnd === -1 ? scan.length : lineEnd)
  const readOnly = /^\s*(?:const|let|var)?\s*\w*\s*=\s*(?:await\s+)?(?:fs\.)?(readFileSync|readdirSync|readFile|existsSync|statSync|lstatSync)\b/.test(line)
    && !DESTRUCTIVE.test(line)
  if (readOnly) continue
  hit = { where: m[0], line: line.trim().slice(0, 120) }
  break
}
if (hit) {
  console.error('拒绝执行：程序里同时出现「破坏性操作」与「系统目标/凭据/护栏文件」（命中 ' + hit.where + '）。run_code 是任意代码执行，这类组合不可逆或可拆护栏，已拦下。如危险文本只是数据（测试/文档/注释），请放进注释或超过 400 字符的字符串；如命中 windowsHide 之类的普通标识符，请反馈到 _selftest/tests/security-guards.test.mjs。')
  process.exit(2)
}
process.exit(0)
