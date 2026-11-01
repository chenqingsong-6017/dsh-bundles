/**
 * 危险命令拦截（tool.pre · bash/pwsh）—— v3（2026-11-01 修误报）
 * @guard-revision: 2026-11-01-falsepositive-fix
 *
 * v3 相对 v2 的改动（根因见 D:/AI/dsh-data/tmp/guard-fix/README.md）：
 *   1) 「删除整个用户目录」：原正则末尾 `\s*(|$)` 里的 `(|$)` 是空分支，永远成立，
 *      于是整条规则退化成「Remove-Item … C:\Users\<任意一段>」就命中——
 *      12:49:57 那条只是删 C:\Users\cqs6017\AppData\Local\Temp\dsh-baselines-stub.mjs，被误判。
 *      改成 `\s*(?:$|[;|&])` 后，只有目标**就是**用户目录本身才命中。
 *   2) 同款 `(|$)` 缺陷在「del /s 递归删除整个盘符」里也有，一并改掉。
 *   3) 为了不丢检出力，新增「删除用户目录全部内容」（C:\Users\x\*）规则——
 *      修 (|$) 会顺带放走 `Remove-Item -Recurse C:\Users\bob\*`，必须单独兜住。
 *
 * v2 原有的归一化（小写 / 去引号与脱字符 / 合并空白）与 37 条规则集保持不变；
 * 上限同 v2：正则只是黑名单，自适应攻击能绕（OWASP LLM01:91），真正的控制在能力与审批层。
 */
const raw = await new Promise((resolve) => {
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (c) => { buffer += c })
  process.stdin.on('end', () => resolve(buffer))
})
let payload = {}
try { payload = JSON.parse(raw) } catch { process.exit(0) }

const command = String(payload?.tool?.arguments?.command ?? '')
if (command.trim() === '') process.exit(0)
const cmd = command.toLowerCase().replace(/["'`]/g, '').replace(/\^/g, '').replace(/\s+/g, ' ').trim()

const RULES = [
  // 一、不可逆删除 / 备份 / 分区
  [/\bvssadmin(\.exe)?\s+delete\s+shadows/, '删除卷影副本（勒索第一步）'],
  [/\bwmic(\.exe)?\s+shadowcopy\s+delete/, '删除卷影副本'],
  [/\b(diskshadow|wbadmin)(\.exe)?\b.*(delete\s+(catalog|systemstatebackup)|start\s+(backup|recovery)|\/s\b)/, '删除备份 / 磁盘快照操作'],
  [/\bwevtutil(\.exe)?\s+cl\b|\bclear-eventlog\b/, '清空事件日志（掩盖痕迹）'],
  [/\bbcdedit(\.exe)?\b.*(recoveryenabled|safeboot|bootstatuspolicy|ignoreallfailures)/, '改启动/恢复配置（不可逆）'],
  [/\bbootrec\b/, '引导修复（不可逆）'],
  [/\bdiskpart\b|\bmkfs\b/, '分区 / 建文件系统'],
  [/\bformat\s+[a-z]:/, '格式化磁盘'],
  [/\bcipher\s+\/w\b/, '擦除磁盘空闲空间（不可恢复）'],
  [/\breg(\.exe)?\s+save\s+hklm/, '导出 SAM/SECURITY 注册表'],
  [/\bntdsutil\b.*\bifm\b/, '提取域控数据库'],
  [/\b(procdump(64)?|createdump)(\.exe)?\b.*(lsass|lsm|minidump|-ma\b)/, '凭据倾倒（转储 lsass）'],
  [/\brundll32(\.exe)?\b.*(javascript:|comsvcs|minidump|url\.dll|advpack|dfshim|\.sct\b|http)/, 'rundll32 代理执行 / 凭据转储'],
  [/\bmshta(\.exe)?\b.*(https?:\/\/|vbscript:|javascript:|\.sct\b|\.hta\b)/, 'mshta 执行远程/内联脚本'],
  [/\bregsvr32(\.exe)?\b.*(\/i:|https?:\/\/)/, 'regsvr32 scriptlet 代理执行'],
  [/\bcertutil(\.exe)?\b.*\s-(urlcache|verifyctl|url|decode|decodehex)\b/, 'certutil 下载落盘 / 解码 payload'],
  [/\bbitsadmin\b.*\/(transfer|addfile|setnotifycmdline)/, 'BITS 下载/执行/持久化'],
  [/\b(installutil|regasm|regsvcs|msbuild)(\.exe)?\b.*(https?:\/\/|temp)/, '.NET 工具代理执行'],
  [/\bcmstp(\.exe)?\b.*(\/ni\b|https?:\/\/)/, 'INF 代理执行'],
  [/\bmsdt(\.exe)?\b.*(\/id\s+pcwdiagnostic|\/param)/, '诊断工具参数注入（Follina 类）'],
  [/\besentutl(\.exe)?\b.*\/y\b.*\/d\b/, '用数据库工具复制文件到 ADS'],
  // 二、持久化 / 防御削弱
  [/\bnew-service\b|\bregister-scheduledtask\b|\bschtasks\b.*\/(create|change)\b/, '创建服务/计划任务（持久化）'],
  [/\bsc(\.exe)?\s+(create|config)\b.*binpath/, '改服务可执行路径（持久化）'],
  [/\bsc(\.exe)?\s+delete\b/, '删除系统服务'],
  [/\bnetsh(\.exe)?\b.*advfirewall.*(set\s+state\s+off|opmode\s+disable|firewall\s+(add|delete)\s+rule)/, '关闭/修改防火墙'],
  [/\b(disable-netfirewallrule|add-mppreference|set-mppreference)\b/, '关闭 Defender 或加白名单'],
  [/\bnet\s+(user|localgroup)\s+\S+.*\/(add|delete)\b/, '新增/删除本地账户'],
  [/\btakeown\b.*\/f\b.*(c:\\windows|program files)/, '夺取系统目录所有权'],
  // 三、远程执行 / 凭据外泄
  [/\bpowershell(\.exe)?\b.*-(e|ec|enc|encodedcommand)\s+[a-z0-9+\/]{20,}/, '编码命令（注入常用）'],
  [/frombase64string.*(iex|invoke-expression|downloadstring|assembly::load)/, '解码即执行'],
  [/\b(nc|ncat|netcat)\b.*\s-e\s|\/dev\/tcp\//, '反弹 shell'],
  [/\b(curl|wget|iwr|invoke-webrequest|invoke-restmethod)\b.*(-d\s+@|--data(-binary|-raw)?\s+@|\s-f\s+[^\s]*@|-infile).*(\.ssh|\.aws|\.dsh|\.credentials|id_rsa|\.git-credentials)/, '上传敏感文件（外泄）'],
  [/(\.ssh[\\\/]|\.aws[\\\/]|\.credentials\.yaml|id_rsa|\.git-credentials).*(curl|iwr|invoke-webrequest|invoke-restmethod|wget|webclient|https?:\/\/)/, '读取凭据后外发'],
  [/(get-content|type\s|cat\s).*(\.ssh[\\\/]|\.aws[\\\/]|\.credentials\.yaml|id_rsa).*(\|\||;|&).*(curl|iwr|invoke-webrequest|invoke-restmethod|nc\s)/, '读凭据管道外发'],
  // 四、不可逆删除（Windows）
  [/\bremove-item\b.*-recurse.*[a-z]:[\\\/]?\s*$/, '递归删除整个盘符'],
  [/\bremove-item\b.*[a-z]:[\\\/]+(windows|program files)\b/, '删除系统目录'],
  // ↓ v3 修：末尾 `(|$)` 原本是空分支（永远成立），改成「命令到此结束或接分隔符」才算目标就是用户目录
  [/\bremove-item\b.*?[a-z]:[\\\/]+users[\\\/]+[^\\\/\s]+[\\\/]?\s*(?:$|[;|&])/, '删除整个用户目录'],
  // ↓ v3 新增：修 (|$) 后会放走「删用户目录全部内容」，单独兜住（12:49:57 那类只删子文件的不受影响）
  [/\bremove-item\b.*[a-z]:[\\\/]+users[\\\/]+[^\\\/\s]+[\\\/]+\*/, '删除用户目录全部内容'],
  // v3 修：原式 `\/[a-z]*s[a-z]*\s+` 只吃一个开关，`del /s /q C:\`（真·递归删盘符）反而漏检；
  // 改成「任意多个 /开关」+ 末尾 (?:$|[;|&])，既修误报又补上这个洞。
  [/\bdel\s+(?:\/[a-z]+\s+)*[a-z]:[\\\/]?\s*(?:$|[;|&])/, '递归删除整个盘符'],
  [/\brm\s+(-[a-z]+\s+)*-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\*|[a-z]:[\\\/])(\s|$)/, '递归删除根目录/盘符'],
  [/\bshutdown\s+\/[sr]\b|\brestart-computer\b|\bstop-computer\b/, '关机/重启'],
  [/\bdd\b.*\bof=\/dev\//, '直接写裸块设备'],
]

for (const [re, why] of RULES) {
  if (re.test(cmd)) {
    console.error('命中危险模式：' + why + '。已由 dsh-hooks 拦下（规则集来源：LOLBAS/Sigma/OWASP LLM Top 10 2026，见 _research/security-guardrails.md）。如确需执行，请人工在终端逐条操作；如判断是误报，请把命令加进 D:/AI/dsh-bundles/_selftest/tests/security-guards.test.mjs。')
    process.exit(2)
  }
}
process.exit(0)
