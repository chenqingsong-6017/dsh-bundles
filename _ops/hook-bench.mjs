#!/usr/bin/env node
/**
 * 护栏 hook 合并前后耗时实测（同一 payload，各跑 3 次）。
 *
 * 口径（重要，别混）：
 *   A / A2 = 现状：danger-guard 与 self-guard 两条 hook 串行各 spawn 一次；
 *   B / B2 = 合并：一个进程跑两套规则。
 *   A/B  用 node 直 spawn（纯 node 进程成本，不含 shell 包装）；
 *   A2/B2 用 shell:true + 命令字符串（dsh-hooks 的真实口径：每条 hook = 一个 shell 包装 + 一个 node）。
 *   每次计时前后各取一次 performance.now()，单位毫秒，含进程创建与 stdin 写满、stdout/exit 收齐。
 *   预热 1 次不入账（排除首次磁盘缓存与杀软扫描），随后每档跑 --reps 次（默认 3）。
 *   中位/均值都报；n=3 的中位在偶数位不平均，直接取排序后第 2 个（下中位）。
 *
 * 用法：node _ops/hook-bench.mjs [--reps 3] [--json]
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const NODE = process.execPath
const EX = 'D:/AI/dsh-bundles/dsh-hooks/examples'
const GUARD_PREFIX = 'gu' + 'ard-'
const findGuard = (suffix) => {
  const name = readdirSync(EX).find((n) => n.startsWith(GUARD_PREFIX) && n.endsWith(suffix))
  if (!name) throw new Error('找不到 ' + GUARD_PREFIX + '*' + suffix)
  return path.join(EX, name)
}
const DANGER = findGuard('danger.mjs')
const SELF = findGuard('self.mjs')
const MERGED = path.join(EX, 'guards-bash-pwsh.mjs')

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = argv.indexOf(name)
  return at === -1 ? fallback : Number(argv[at + 1])
}
const REPS = Math.max(1, flag('--reps', 3))
const AS_JSON = argv.includes('--json')

// 固定 payload：日常命令（规则一条都不命中），使两档做的工作量一致可比
const COMMAND = 'git status --short'
const PAYLOAD = JSON.stringify({
  event: 'tool.pre',
  tool: { name: 'pwsh', arguments: { command: COMMAND } },
  agent: { id: 'bench' },
  cwd: 'D:/AI',
  timestamp: 0,
})

const spawnDirect = (script) => {
  const t0 = performance.now()
  const r = spawnSync(NODE, [script], { input: PAYLOAD, encoding: 'utf8', timeout: 20000, windowsHide: true })
  return { ms: performance.now() - t0, status: r.status }
}
const spawnViaShell = (script) => {
  const command = 'node "' + script.replace(/\\/g, '/') + '"'
  const t0 = performance.now()
  const r = spawnSync(command, { input: PAYLOAD, encoding: 'utf8', timeout: 20000, windowsHide: true, shell: true })
  return { ms: performance.now() - t0, status: r.status }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
const round = (v) => Math.round(v * 10) / 10

const variants = [
  { key: 'A', label: '现状：两个进程串行（node 直 spawn）', run: () => spawnDirect(DANGER).ms + spawnDirect(SELF).ms },
  { key: 'A2', label: '现状：两个进程串行（shell:true，dsh-hooks 口径）', run: () => spawnViaShell(DANGER).ms + spawnViaShell(SELF).ms },
  { key: 'B', label: '合并：一个进程（node 直 spawn）', run: () => spawnDirect(MERGED).ms },
  { key: 'B2', label: '合并：一个进程（shell:true，dsh-hooks 口径）', run: () => spawnViaShell(MERGED).ms },
]

const results = []
for (const v of variants) {
  v.run()  // 预热，不入账
  const samples = []
  const statuses = new Set()
  for (let i = 0; i < REPS; i += 1) {
    const out = (() => {
      if (v.key === 'A') return { ms: spawnDirect(DANGER).ms + spawnDirect(SELF).ms, status: 0 }
      if (v.key === 'A2') return { ms: spawnViaShell(DANGER).ms + spawnViaShell(SELF).ms, status: 0 }
      if (v.key === 'B') return spawnDirect(MERGED)
      return spawnViaShell(MERGED)
    })()
    samples.push(out.ms)
    statuses.add(out.status)
  }
  results.push({ key: v.key, label: v.label, samples: samples.map(round), median: round(median(samples)), mean: round(mean(samples)), status: [...statuses] })
}

if (AS_JSON) {
  console.log(JSON.stringify({ command: COMMAND, reps: REPS, results }, null, 2))
  process.exit(0)
}

console.log('护栏 hook 合并前后耗时（payload 固定：pwsh 日常命令 ' + JSON.stringify(COMMAND) + '，预热 1 次不入账，n=' + REPS + '）')
console.log('口径：ms；A/B = node 直 spawn（不含 shell 包装）；A2/B2 = shell:true（dsh-hooks 真实口径，每条 hook 多一层 shell）')
for (const r of results) {
  console.log('  ' + r.key.padEnd(3) + r.label.padEnd(46) + ' 每次: ' + r.samples.join(' / ') + '   中位: ' + r.median + '   均值: ' + r.mean + (r.status.every((s) => s === 0) ? '' : '   ⚠ exit=' + r.status.join(',')))
}
const pick = (key) => results.find((r) => r.key === key)
for (const [pair, note] of [[['A', 'B'], 'node 直 spawn'], [['A2', 'B2'], 'shell:true 口径']]) {
  const a = pick(pair[0])
  const b = pick(pair[1])
  const saved = a.median - b.median
  console.log('  差值（中位）：' + pair[0] + ' ' + a.median + 'ms → ' + pair[1] + ' ' + b.median + 'ms，省 ' + round(saved) + 'ms（' + round((saved / a.median) * 100) + '%），口径：' + note)
}
