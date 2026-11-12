#!/usr/bin/env node
/**
 * verify.mjs --- 真机「生效」观测器：直接读缓存文件判断跑的是哪一版写入路径。
 *
 * 为什么不用日志/版本号推断：写入格式就是行为证据。旧代码只会写「整份 pretty JSON」，
 * 新代码写「单行基线 + 增量行」。文件形态一翻，就证明进程里跑的是 fork。
 *
 *   journal-baseline  单行 {"version":8,"record":...}          -> 新代码写过
 *   journal           基线行 + >=1 增量行                       -> 新代码写过，且发生了增量追加
 *   legacy            多行 pretty JSON（{"version": 8, ...}）   -> 旧代码写过（尚未被新写覆盖）
 *   foreign           其它（parse 失败/版本不认识）             -> 异常，退出码 1
 *
 * 用法：node verify.mjs [--dir <缓存目录>] [--since 180]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const value = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const dir = value('--dir', path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions'))
const since = Number(value('--since', '180'))
const now = Date.now()
const files = []
let foreign = 0
for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort()) {
  const file = path.join(dir, name)
  const stat = statSync(file)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    files.push({ name, format: 'unreadable', error: String(error) })
    foreign += 1
    continue
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  let format = 'foreign'
  let version = null
  let deltaLines = 0
  try {
    const first = JSON.parse(lines[0])
    version = typeof first.version === 'number' ? first.version : null
    if (first.record !== undefined) {
      format = lines.length === 1 ? 'journal-baseline' : 'journal'
      for (const line of lines.slice(1)) if (JSON.parse(line).delta !== undefined) deltaLines += 1
    }
  } catch (error) {
    try {
      const document = JSON.parse(text)
      version = typeof document.version === 'number' ? document.version : null
      if (document.record !== undefined) format = 'legacy'
    } catch (nested) {
      format = 'foreign'
    }
  }
  if (format === 'foreign') foreign += 1
  files.push({
    name,
    format,
    version,
    deltaLines,
    size: stat.size,
    ageSeconds: Math.round((now - stat.mtimeMs) / 1000),
    writtenRecently: now - stat.mtimeMs <= since * 1000,
  })
}
const live = files.filter((file) => file.writtenRecently && (file.format === 'journal' || file.format === 'journal-baseline'))
const summary = {
  dir,
  sinceSeconds: since,
  files: files.length,
  live: live.length,
  journalWithDeltas: files.filter((file) => file.format === 'journal').length,
  journalBaseline: files.filter((file) => file.format === 'journal-baseline').length,
  legacy: files.filter((file) => file.format === 'legacy').length,
  foreign,
  recent: live.sort((left, right) => left.ageSeconds - right.ageSeconds).slice(0, 8),
}
console.log(JSON.stringify(summary, null, 2))
if (foreign > 0) {
  console.error('verify: ' + foreign + ' cache file(s) are in neither the legacy nor the journal form')
  process.exit(1)
}
if (live.length === 0) console.error('verify: no journal-form cache write within the last ' + since + 's --- new code not observed yet (idle session, or the override did not load)')
process.exit(0)
