#!/usr/bin/env node
/**
 * cua-tool-filter —— 只注册 cua-driver-native 里真正用得到的工具。
 *
 * 背景：官方包 Config = Schema.object({})，没有过滤开关，56 个工具全量注册
 * （实测声明合计 101,948 字符 ≈ 32k tokens；5 天只用到 15 个）。
 * 本脚本在官方包 lib/index.js 的注册循环前加一行 allowlist 判断，默认保留 20 个日常工具。
 *
 * 用法：
 *   node _ops/cua-tool-filter.mjs --status
 *   node _ops/cua-tool-filter.mjs --apply
 *   node _ops/cua-tool-filter.mjs --allow "click,get_window_state,type_text"
 *   node _ops/cua-tool-filter.mjs --revert
 *
 * 注意：DSH 只在启动时加载插件 JS，改完必须重启 DSH；dsh 升级/重装会覆盖补丁，重跑 --apply。
 *
 * 删除三查（2026-11-02 复核，结论=保留，不删）：
 *   ① 过时？没有——DSH 升级/重装会覆盖官方包，重跑 --apply 仍是「升级后必做」第 2 步（AGENTS.md）。
 *   ② 以后有用？有——每次升级、cua 工具数不对、或要临时放开某工具（--allow / --revert）都用它。
 *   ③ 有价值？有——allowlist 把 56 个工具收窄到 20 个（声明省约 43k 字符，见 AGENTS.md）；
 *      而且 restart-dsh.ps1:30 的预检直接调它 --status，删了预检会空转（并非「零代码引用」）。
 *   什么时候用：DSH 升级或重装后、cua 工具数/声明异常时、临时放开/收回某个工具时；其余时间别动它。
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs'
import path from 'node:path'

const PROFILE = process.env.DSH_PROFILE_DIR || 'C:\\Users\\cqs6017\\.dsh\\profiles\\desktop'
const TARGET = path.join(PROFILE, 'node_modules', '@deepseek-ai', 'dsh-experimental-computer-use-cua-driver-native', 'lib', 'index.js')
const BACKUP = TARGET + '.bak-cua-lite'
const MARK = 'LITE_ALLOW'
const ANCHOR_APPLY = 'async function apply(ctx) {'
const ANCHOR_LOOP = 'for (const tool of catalog.tools) {'

const DEFAULT_ALLOW = [
  'click', 'get_window_state', 'type_text', 'hotkey', 'press_key', 'scroll',
  'launch_app', 'double_click', 'right_click', 'drag', 'set_value',
  'list_apps', 'list_windows', 'get_desktop_state', 'start_session', 'end_session',
  'get_screen_size', 'clipboard_read', 'clipboard_write', 'kill_app',
]

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null }
const line = (allow) => `const LITE_ALLOW = new Set([${allow.map((n) => JSON.stringify(n)).join(', ')}])`
const read = () => readFileSync(TARGET, 'utf8')

function currentAllow(src) {
  const m = src.match(/const LITE_ALLOW = new Set\(\[([^\]]*)\]\)/)
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : []
}

function writePatched(allow) {
  let s = read()
  if (!s.includes(MARK)) {
    if (!existsSync(BACKUP)) { copyFileSync(TARGET, BACKUP); console.log('已备份 → ' + BACKUP) }
    if (!s.includes(ANCHOR_APPLY) || !s.includes(ANCHOR_LOOP)) { console.error('找不到锚点，官方包可能已改版，停止'); process.exit(1) }
    s = s.replace(ANCHOR_APPLY, `${line(allow)}\n${ANCHOR_APPLY}`)
    s = s.replace(ANCHOR_LOOP, `${ANCHOR_LOOP}\n\t\t\tif (!LITE_ALLOW.has(tool.name)) continue;`)
  } else {
    s = s.replace(/const LITE_ALLOW = new Set\(\[[^\]]*\]\)/, line(allow))
  }
  writeFileSync(TARGET, s)
  console.log('已写入 allowlist（' + allow.length + ' 个工具）。重启 DSH 生效。')
}

if (flag('--status')) {
  if (!existsSync(TARGET)) { console.error('目标不存在：' + TARGET); process.exit(1) }
  const s = read()
  const allow = currentAllow(s)
  console.log('目标：' + TARGET)
  console.log('状态：' + (s.includes(MARK) ? '已打补丁' : '官方原文件') + ' · 备份：' + (existsSync(BACKUP) ? '有' : '无') + ' · ' + statSync(TARGET).size + ' 字节')
  if (allow.length) console.log('allowlist（' + allow.length + '）：' + allow.join(', '))
  process.exit(0)
}

if (flag('--revert')) {
  if (!existsSync(BACKUP)) { console.error('没有备份，无法还原'); process.exit(1) }
  copyFileSync(BACKUP, TARGET)
  console.log('已还原官方原文件（' + statSync(TARGET).size + ' 字节）。重启 DSH 生效。')
  process.exit(0)
}

const allowArg = opt('--allow')
if (flag('--apply') || allowArg) {
  writePatched(allowArg ? allowArg.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_ALLOW)
  process.exit(0)
}

console.log('用法：--status | --apply | --allow "a,b" | --revert')
