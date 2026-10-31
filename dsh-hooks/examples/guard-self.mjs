/**
 * 护栏自保护（tool.pre · bash/pwsh）
 * 问题：fs-guard 只拦 write/edit 工具，pwsh 仍可改写 hooks.json / guard-*.mjs ——
 * 等于被注入后可以先用 shell 拆护栏。这条补上（R28 的命令行入口）。
 */
const raw = await new Promise((resolve) => {
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (c) => { buffer += c })
  process.stdin.on('end', () => resolve(buffer))
})
let payload = {}
try { payload = JSON.parse(raw) } catch { process.exit(0) }
const cmd = String(payload?.tool?.arguments?.command ?? '').toLowerCase().replace(/["'`]/g, '').replace(/\^/g, '').replace(/\s+/g, ' ').trim()
if (cmd === '') process.exit(0)

const WRITE_VERB = /(set-content|add-content|out-file|copy-item|move-item|rename-item|new-item|del\s|erase\s|rimraf|tee\b|>{1,2}\s*(?!&))\S*/
const GUARD_TARGET = /(hooks\.json|guard-[a-z]+\.mjs)/
if (WRITE_VERB.test(cmd) && GUARD_TARGET.test(cmd)) {
  console.error('拒绝执行：命令在写护栏文件或配置（hooks.json / guard-*.mjs）。护栏只能人工维护——这是防止被注入后先拆防线的必要限制。')
  process.exit(2)
}
process.exit(0)
