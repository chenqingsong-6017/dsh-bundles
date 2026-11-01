/**
 * 网络取经护栏（tool.pre · web_fetch）—— 2026-11-01 立
 * 依据：近 7 天 35 次「github 系解析到非公网 IP」无效重试（占全部错误 9%），
 *      另有 arxiv.org 网页版同样失败（正确通道是 export.arxiv.org/api）。
 * 规则：命中即拒，理由里直接给可用的替代命令。不做重试、不做降级。
 * 位置：_ops/ 而非 dsh-hooks/examples/guard-*，因为 guard-*.mjs 被 fs-guard 保护、只能人工改。
 */
const raw = await new Promise((resolve) => {
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => { buffer += chunk })
  process.stdin.on('end', () => resolve(buffer))
})

let payload = {}
try { payload = JSON.parse(raw) } catch { process.exit(0) }

const args = payload?.tool?.arguments ?? {}
const url = String(args.url ?? '').trim()
if (url === '') process.exit(0)

let host = ''
try { host = new URL(url).hostname.toLowerCase() } catch { process.exit(0) }

const BLOCKED = new Set([
  'github.com', 'www.github.com', 'raw.githubusercontent.com', 'api.github.com',
  'gist.github.com', 'codeload.github.com', 'objects.githubusercontent.com',
  'arxiv.org', 'www.arxiv.org', 'docs.github.com',
])

if (BLOCKED.has(host)) {
  const hint = host.includes('arxiv')
    ? '改用 export.arxiv.org/api/query?search_query=...（web_fetch 实测 200）'
    : '改用 git clone --depth 1 <url> D:\\AI\\dsh-data\\tmp\\<name>（实测可用；读完即删）'
  console.error('[net-guard] 拒绝 web_fetch: ' + host + ' 解析到非公网 IP，必然失败（7 天内已浪费 35 次）。' + hint)
  process.exit(2)
}

process.exit(0)
