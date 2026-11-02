/**
 * 危险命令 + 护栏自保护（tool.pre · bash/pwsh）—— 合并版 v1（2026-11-02）
 * @guard-revision: 2026-11-02-merged-bash-pwsh
 *
 * 为什么合并：合并前 danger-guard 与 self-guard 两条 match 都是 ^(bash|pwsh)$，
 * 每次 bash/pwsh 调用要串行 spawn 两次 node（实测 113ms + 100ms，见 _ops/hook-bench.mjs）。
 * 合并后同一个 node 进程一次读完 stdin，分别跑两套规则；任一命中即 stderr + exit 2。
 *
 * 语义依据（官方）：@deepseek-ai/dsh-hook-protocol 的 mergeHookOutputs —— 同一扩展点上多个
 * hook 的权限按 deny > ask > allow 折叠，最严格者胜。本脚本把「两条 hook 的最严格折叠」
 * 内联进一个进程，故拦截决策与合并前等价；等价性由 _selftest/tests/guards-merge.test.mjs
 * 逐条对拍（原脚本 vs 合并脚本，比对 exit code）。
 *
 * 两套规则集保持独立，可分别关闭（只影响本进程，等价于把对应 hook 的 enabled 设 false）：
 *   DSH_GUARD_DANGER=0  关危险命令规则集（DANGER_RULES）
 *   DSH_GUARD_SELF=0    关护栏自保护规则集（SELF_*）
 * 取值 0 / false / off 视为关闭，其余（含未设）一律开启 —— fail-safe 默认开着。
 *
 * 规则同源：DANGER_RULES 与 guard-danger.mjs 的 RULES 逐字一致，SELF_* 与 guard-self.mjs 一致。
 * 漂移由 guards-merge.test.mjs 的 drift 用例守护：原文件改了而这里没同步，测试就红。
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

// ---- 两套规则集的独立开关（只影响本进程） ----
const isOff = (v) => { const s = String(v ?? '').trim().toLowerCase(); return s === '0' || s === 'false' || s === 'off' }
const DANGER_ON = !isOff(process.env.DSH_GUARD_DANGER)
const SELF_ON = !isOff(process.env.DSH_GUARD_SELF)

// ---- 规则集 A：危险命令（与 guard-danger.mjs 的 RULES 同源） ----
const DANGER_RULES = [
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

// ---- 拒绝理由（措辞与原脚本一致，从原文件取出，不改写） ----
const MSG_DANGER_PREFIX = "命中危险模式："
const MSG_DANGER_SUFFIX = "。已由 dsh-hooks 拦下（规则集来源：LOLBAS/Sigma/OWASP LLM Top 10 2026，见 _research/security-guardrails.md）。如确需执行，请人工在终端逐条操作；如判断是误报，请把命令加进 D:/AI/dsh-bundles/_selftest/tests/security-guards.test.mjs。"
const MSG_SELF = "拒绝执行：命令在写护栏文件或配置（hooks.json / guard-*.mjs）。护栏只能人工维护——这是防止被注入后先拆防线的必要限制。"

// ---- 规则集 B：护栏自保护（与 guard-self.mjs 同源） ----
const SELF_WRITE_VERB = /(set-content|add-content|out-file|copy-item|move-item|rename-item|new-item|del\s|erase\s|rimraf|tee\b|>{1,2}\s*(?!&))\S*/
const SELF_GUARD_TARGET = /(hooks\.json|guard-[a-z]+\.mjs)/

// ---- 评估：两套规则都跑，任一击中即 stderr + exit 2（等价于 deny > ask > allow 折叠） ----
const HITS = []
if (DANGER_ON) {
  for (const [re, why] of DANGER_RULES) {
    if (re.test(cmd)) {
      HITS.push(MSG_DANGER_PREFIX + why + MSG_DANGER_SUFFIX)
      break
    }
  }
}
if (SELF_ON && SELF_WRITE_VERB.test(cmd) && SELF_GUARD_TARGET.test(cmd)) HITS.push(MSG_SELF)
if (HITS.length === 0) process.exit(0)
for (const hit of HITS) console.error(hit)
process.exit(2)
