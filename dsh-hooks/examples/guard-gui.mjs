/**
 * GUI 第二入口护栏（tool.pre · cua_driver_native__launch_app）
 * 问题：cua 能起任意程序，完全绕过 bash/pwsh 的命令审核（见研究文档 §7.1 #6）。
 * 只拦「明显可被当执行器用」的启动：脚本引擎、系统二进制、脚本后缀。
 * 保守起见不拦普通应用，避免正常用 GUI 时误伤。
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
const target = String(a.path ?? a.launch_path ?? a.aumid ?? a.bundle_id ?? a.name ?? '').toLowerCase().replace(/\\/g, '/')
if (target.trim() === '') process.exit(0)

const EXE = /(\/|^)(powershell|pwsh|cmd|wscript|cscript|mshta|rundll32|regsvr32|certutil|bitsadmin|msbuild|installutil|cmstp|msdt|procdump|psexec|reg|sc|schtasks|wmic|vssadmin|wevtutil|ntdsutil)(\.exe)?$/
const SCRIPT = /\.(hta|vbs|js|jse|wsf|bat|cmd|ps1|psm1|scr)$/
const SYS_DIR = /(windows\/system32|program files)/
if (EXE.test(target) || SCRIPT.test(target) || SYS_DIR.test(target)) {
  console.error('拒绝通过 GUI 启动：目标是 ' + target + '（系统二进制/脚本引擎/系统目录）。cua 是第二入口，不能绕过命令审核；需要时请人工在终端执行。')
  process.exit(2)
}
process.exit(0)
