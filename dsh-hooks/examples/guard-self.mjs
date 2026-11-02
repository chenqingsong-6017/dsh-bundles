/**
 * 护栏自保护（tool.pre · bash/pwsh）—— v3（2026-11-03 修 G1/G2）
 * 旧正则只认 guard-[a-z]+\.mjs，合并后的 guards-bash-pwsh.mjs 与 _ops/net-guard.mjs 漏网。
 * 现在：静态正则 + 配置驱动（hooks.json 每条 run 指向的脚本），改名/搬家不再产生新洞。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** 配置驱动：命令行里是否点名了 hooks.json 任意 run 指向的脚本。命令文本已去引号、小写、压空白。 */
function configuredScriptTouched(cmdText) {
  try {
    const file = process.env.DSH_HOME
      ? path.join(process.env.DSH_HOME, 'hooks.json')
      : path.join(homedir(), '.dsh', 'hooks.json')
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/"([^"]+\.(?:mjs|js|cjs))"/g)) {
      const p = m[1].replace(/\\/g, '/').toLowerCase()
      if (p !== '' && cmdText.includes(p)) return true
    }
  } catch { /* 读不到配置就只用静态正则 */ }
  return false
}

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
const GUARD_TARGET = /(hooks\.json|guards?-[a-z-]+\.mjs|net-guard\.mjs|install-net-guard\.mjs|guard-protect-apply\.mjs)/
if (WRITE_VERB.test(cmd) && (GUARD_TARGET.test(cmd) || configuredScriptTouched(cmd))) {
  console.error('拒绝执行：命令在写护栏文件或配置（hooks.json / guard-*.mjs / 配置驱动的护栏脚本）。护栏只能人工维护——这是防止被注入后先拆防线的必要限制。')
  process.exit(2)
}
process.exit(0)
