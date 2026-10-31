/**
 * 凭据读取护栏（tool.pre · read/grep/glob）
 * 依据：OWASP LLM01 2026 的「致命三要素」——B 腿（访问敏感数据）。
 * 只拦凭据/密钥文件，不拦 .dsh 目录本身（配置排查要用）。
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
const target = String(a.file_path ?? a.path ?? a.pattern ?? a.glob ?? a.include ?? '')
if (target.trim() === '') process.exit(0)
const t = target.toLowerCase().replace(/\\/g, '/')

const BLOCK = [
  { re: /(^|\/)\.credentials\.yaml$/, why: 'DSH 凭据文件' },
  { re: /(^|\/)\.ssh(\/|$)/, why: 'SSH 私钥目录' },
  { re: /(^|\/)\.aws(\/|$)/, why: 'AWS 凭据目录' },
  { re: /(^|\/)id_rsa(\.[a-z]+)?$/, why: 'SSH 私钥' },
  { re: /(^|\/)\.git-credentials$/, why: 'git 明文凭据' },
  { re: /(^|\/)\.npmrc$/, why: 'npm token 配置' },
  { re: /(^|\/)credentials(\.json)?$/, why: '凭据文件' },
  { re: /(^|\/)cookies?(\.(sqlite|txt|json))?$/, why: '浏览器 cookie' },
]
for (const { re, why } of BLOCK) {
  if (re.test(t)) {
    console.error('拒绝读取：目标是 ' + why + '（' + target + '）。凭据类文件不由 agent 读取，需要时请人工处理。')
    process.exit(2)
  }
}
process.exit(0)
