#!/usr/bin/env node
/**
 * 工具错误率仪表 —— 「可靠性工程」的第一个可复现基线。
 *
 * 为什么需要它：DSH 的 audit 只记副作用白名单，读类工具不计，不能当错误率用；
 * 全量调用与报错只存在于会话事件日志（<DSH_HOME>/sessions/**​/session.v4.jsonl.zstd）。
 *
 * 指标定义（唯一口径，写死在这里，别在别处另算一套）：
 *   errorRate = isError 的 tool/result 数 / tool/call 数
 *   成功 = 工具返回 isError:false 且没抛异常；用户 steer、回合中止不计入错误率（另有统计）。
 *
 * 用法：
 *   node tool-error-rate.mjs                 # 最近 7 天
 *   node tool-error-rate.mjs --days 30 --json
 *   node tool-error-rate.mjs --fail-over 0.02  # CI/收工用：超过阈值退出 1
 *
 * 输出：分类型 / 分工具 / 分天，以及错误签名 Top N（归一化后按次数）。
 * 基线文件：$DSH_METRICS_DIR/tool-error-rate-baseline.json + history.jsonl
 */
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { signature, summarizeRepeat, comparePhase, classify } from './error-stats.mjs'

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const flag = (name) => argv.includes('--' + name)

const HOME = process.env.DSH_HOME || process.env.USERPROFILE + '\\.dsh'
const SESSIONS = path.join(HOME, 'sessions')
const METRICS_DIR = process.env.DSH_METRICS_DIR || 'D:\\AI\\dsh-data\\metrics'
const DAYS = Number(arg('days', 7))
const TOP = Number(arg('top', 12))
const FAIL_OVER = arg('fail-over', null)
const SINCE_AT = arg('since', null)
const SINCE = SINCE_AT ? Date.parse(SINCE_AT) : Date.now() - DAYS * 86400000
/** 窗口标签：改规则后用 --since 只统计「规则生效之后」，避免 7 天滚动窗口把旧数据混进来稀释效果。 */
const WINDOW = SINCE_AT ? ('自 ' + new Date(SINCE).toISOString().slice(0, 16).replace('T', ' ')) : (DAYS + ' 天')
if (SINCE_AT && Number.isNaN(SINCE)) { console.error('--since 不是合法时间：' + SINCE_AT); process.exit(2) }
const JSON_OUT = flag('json')
// --no-write：只做对比/预览，不覆盖权威基线（改前改后的分析不应该改写数据源）。
// --by-session（2026-11-12）：按会话切分输出，用来回答「摩擦在长会话还是在单任务」——口径与总错误率完全一致，
// 只是多一个维度；不带该参数时行为不变。带该参数时自动不写基线。
const NO_WRITE = flag('no-write') || flag('by-session')
const BY_SESSION = flag('by-session')
// --dump-errors（2026-11-12）：按分类打印每条错误原文，用于拆「code/other」这类兜底桶。
// 只读，打印完直接退出（不写基线、不打断正常统计）。
const DUMP = flag('dump-errors')
const dumpRows = []
// --split <ISO>：按时间切「改前 / 改后」两段，用同一套口径算复发对比（改规则后证明改对没有）。
const SPLIT_AT = arg('split', null) ? Date.parse(arg('split', null)) : null
if (SPLIT_AT !== null && Number.isNaN(SPLIT_AT)) { console.error('--split 不是合法时间'); process.exit(2) }
const makeAgg = () => ({ calls: 0, errors: 0, sigCount: new Map(), sigDays: new Map() })
const phases = { before: makeAgg(), after: makeAgg() }
const phaseOf = (t) => (t >= SPLIT_AT ? phases.after : phases.before)
const aggSummary = (ag) => ({ calls: ag.calls, errors: ag.errors, errorRate: +(ag.calls ? ag.errors / ag.calls : 0).toFixed(4), signatures: ag.sigCount.size, repeat: summarizeRepeat(ag.sigDays) })

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
/** 会话日志是「多帧 zstd 拼接」：单个 frame 只有头一行，必须按魔数切帧逐帧解压。 */
function decodeSession(file) {
  const buf = readFileSync(file)
  const offs = []
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offs.push(i)
  }
  let out = ''
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length
    try { out += zlib.zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8') } catch { /* 截断帧忽略 */ }
  }
  return out
}

function listSessionFiles(root) {
  const files = []
  if (!existsSync(root)) return files
  for (const ws of readdirSync(root)) {
    const wsd = path.join(root, ws)
    let st; try { st = statSync(wsd) } catch { continue }
    if (!st.isDirectory()) continue
    for (const s of readdirSync(wsd)) {
      const sd = path.join(wsd, s)
      let st2; try { st2 = statSync(sd) } catch { continue }
      if (!st2.isDirectory()) continue
      for (const f of readdirSync(sd)) {
        const fp = path.join(sd, f)
        let st3; try { st3 = statSync(fp) } catch { continue }
        if (st3.isFile() && st3.size > 1024) files.push(fp)
      }
    }
  }
  return files
}

// 错误分类学 classify() 已搬到 error-stats.mjs（纯函数才能单测，测试见 _selftest/tests/error-classify.test.mjs）。


// 归一化签名与「跨天复发」统计在 error-stats.mjs（纯函数，可单测；口径只有一份）。

const DENIED = /dsh-hooks 拦截/
// write gate 拦截（batch_write 要求先 dry-run）：这是**机制正确拦下了一次误写**，与护栏 deny 同类，
// 属预期结果，单列不拉高错误率（2026-11-12 从 code/other 里识别出来）。
const GATE_BLOCKED = /write gate.*dry-run/
// 策略拒绝（auto-approve 规则命中 / 用户手动拒）：也是机制正常工作，不是工具坏了（2026-11-12 从 code/other 里识别）。
const REJECTED = /dsh-auto-approve 拒绝了这次调用|the user rejected tool/
let gateBlocked = 0
let rejected = 0
let denials = 0
const calls = new Map()
const kindCount = new Map()
const toolErr = new Map()
const toolCalls = new Map()
const sigCount = new Map()
/** 每个签名按天计数：Map<sig, Map<day, count>>，用于算「同一错误复发几天」。 */
const sigDays = new Map()
const perDay = new Map()
let totalCalls = 0
let totalErrors = 0
let steers = 0
let abortedTurns = 0
let fileCount = 0

const perSession = []
for (const file of listSessionFiles(SESSIONS)) {
  let txt
  try { txt = decodeSession(file) } catch { continue }
  fileCount++
  const localCalls = new Map()
  // 每个会话一个统计器（--by-session 用；单位与总口径相同：tool/call 与 isError 的 tool/result）
  const sStat = {
    session: path.basename(path.dirname(file)),
    workspace: path.basename(path.dirname(path.dirname(file))),
    calls: 0,
    errors: 0,
    turns: 0,
    sigs: new Map(),
  }
  for (const line of txt.split('\n')) {
    if (line.length < 16) continue
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    const t = typeof ev.time === 'number' ? ev.time : null
    if (t === null || t < SINCE) continue
    const d = ev.data || {}
    if (ev.type === 'tool/call') {
      localCalls.set(d.callId, d.name)
      totalCalls++
      sStat.calls++
      toolCalls.set(d.name, (toolCalls.get(d.name) || 0) + 1)
      const day = new Date(t).toISOString().slice(0, 10)
      const cur = perDay.get(day) || { calls: 0, errors: 0 }
      cur.calls++
      perDay.set(day, cur)
      if (SPLIT_AT !== null) phaseOf(t).calls++
    } else if (ev.type === 'tool/result') {
      const msg = d.message || {}
      if (!msg.isError) continue
      const tool = localCalls.get(msg.toolCallId) || '<unknown>'
      const text = (msg.content && msg.content[0] && msg.content[0].text) || String(msg.error || '')
      // 护栏拦截是「预期结果」，不是缺陷：单列，不拉高错误率
      if (DENIED.test(text)) { denials++; continue }
      if (GATE_BLOCKED.test(text)) { gateBlocked++; continue }
      if (REJECTED.test(text)) { rejected++; continue }
      const kind = classify(text)
      if (DUMP) dumpRows.push({ kind, tool, text: text.replace(/\s+/g, ' ').slice(0, 200) })
      totalErrors++
      sStat.errors++
      kindCount.set(kind, (kindCount.get(kind) || 0) + 1)
      toolErr.set(tool, (toolErr.get(tool) || 0) + 1)
      const sig = signature(text)
      sigCount.set(sig, (sigCount.get(sig) || 0) + 1)
      sStat.sigs.set(sig, (sStat.sigs.get(sig) || 0) + 1)
      const day = new Date(t).toISOString().slice(0, 10)
      const sd = sigDays.get(sig) || new Map()
      sd.set(day, (sd.get(day) || 0) + 1)
      sigDays.set(sig, sd)
      const cur = perDay.get(day) || { calls: 0, errors: 0 }
      cur.errors++
      perDay.set(day, cur)
      if (SPLIT_AT !== null) {
        const ag = phaseOf(t)
        ag.errors++
        ag.sigCount.set(sig, (ag.sigCount.get(sig) || 0) + 1)
        const ad = ag.sigDays.get(sig) || new Map()
        ad.set(day, (ad.get(day) || 0) + 1)
        ag.sigDays.set(sig, ad)
      }
    } else if (ev.type === 'agent/inbox/spliced') {
      if (Array.isArray(d.inserted) && d.inserted.length && d.target === 'next-step') steers++
    } else if (ev.type === 'turn/end') {
      const kind = (d.reason && d.reason.kind) || 'completed'
      sStat.turns++
      if (kind !== 'completed') abortedTurns++
    }
  }
  perSession.push(sStat)
}

// fail-safe：会话目录解析失败/为空时，宁可退出也不写 0 基线——空基线会把所有仪表归零，
// 让「错误率 0.00%」看起来像好转（2026-11-01 实测撞到：run_code 环境缺 USERPROFILE 时）。
if (fileCount === 0) {
  console.error('没有找到可解析的会话日志：DSH_HOME=' + HOME + '（会话目录 ' + SESSIONS + '）')
  console.error('拒绝写空基线。若确实要空跑，请先确认 DSH_HOME/USERPROFILE 并显式设置 DSH_METRICS_DIR 到临时目录。')
  process.exit(2)
}

const rate = totalCalls ? totalErrors / totalCalls : 0
const pct = (x) => (100 * x).toFixed(2) + '%'
const sorted = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])

const report = {
  generatedAt: new Date().toISOString(),
  window: WINDOW,
  since: SINCE_AT ? new Date(SINCE).toISOString() : null,
  windowDays: DAYS,
  sessions: fileCount,
  totalCalls,
  totalErrors,
  errorRate: +rate.toFixed(4),
  steers,
  abortedTurns,
  guardDenials: denials,
  gateBlocked,
  rejected,
  byKind: sorted(kindCount).map(([k, v]) => ({ kind: k, count: v, share: +(v / (totalErrors || 1)).toFixed(4) })),
  byTool: sorted(toolErr).slice(0, TOP).map(([tool, errs]) => ({ tool, errs, calls: toolCalls.get(tool) || 0, rate: +((toolCalls.get(tool) || 1) ? errs / (toolCalls.get(tool) || 1) : 0).toFixed(4) })),
  perDay: [...perDay.entries()].sort().map(([day, v]) => ({ day, calls: v.calls, errors: v.errors, rate: +(v.errors / (v.calls || 1)).toFixed(4) })),
  topSignatures: sorted(sigCount).slice(0, TOP).map(([sig, count]) => {
    const days = [...(sigDays.get(sig) || new Map()).keys()].sort()
    return { count, sig, days: days.length, firstDay: days[0] || null, lastDay: days[days.length - 1] || null }
  }),
  /** --by-session：按会话切分（同一口径，只按 file 分组；用来判断摩擦是否随会话变长而上升）。 */
  bySession: perSession
    .slice()
    .sort((a, b) => b.calls - a.calls)
    .map((s) => ({
      session: s.session,
      workspace: s.workspace,
      calls: s.calls,
      errors: s.errors,
      rate: +(s.errors / (s.calls || 1)).toFixed(4),
      turns: s.turns,
      topSig: [...s.sigs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    })),
  /** 稳定性：同一签名跨几天复发（判据登记在 _contracts/metrics.json 的 repeatErrorShare）。 */
  repeat: summarizeRepeat(sigDays),
  ...(SPLIT_AT !== null ? (() => {
    const before = aggSummary(phases.before)
    const after = aggSummary(phases.after)
    return { split: { at: new Date(SPLIT_AT).toISOString(), before, after, compare: comparePhase(before, after) } }
  })() : {}),
}

if (DUMP) {
  const sortedDump = dumpRows.slice().sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
  for (const r of sortedDump) console.log('[' + r.kind + '] ' + r.tool + ' | ' + r.text)
  console.log('\n共 ' + dumpRows.length + ' 条（--dump-errors 只读，不写基线）')
  process.exit(0)
}

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('工具错误率仪表  ' + report.window + ' · ' + report.sessions + ' 个会话')
  console.log('--------------------------------------------------')
  console.log('调用 ' + totalCalls + ' · 报错 ' + totalErrors + ' · 错误率 ' + pct(rate))
  console.log('中途 steer ' + steers + ' · 未完成回合 ' + abortedTurns + ' · 护栏拦截（不计入错误率）' + denials + ' · write gate 拦截（不计入）' + gateBlocked + ' · 策略拒绝（不计入）' + rejected)
  console.log('')
  console.log('[分类型]')
  for (const k of report.byKind) console.log('  ' + (100 * k.share).toFixed(1).padStart(5) + '%  ' + String(k.count).padStart(4) + '  ' + k.kind)
  console.log('')
  console.log('[分工具 · 错误数]')
  for (const t of report.byTool) console.log('  ' + String(t.errs).padStart(4) + '/' + String(t.calls).padStart(5) + '  ' + (100 * t.rate).toFixed(1).padStart(5) + '%  ' + t.tool)
  console.log('')
  console.log('[分天]')
  for (const d of report.perDay) console.log('  ' + d.day + '  ' + d.errors + '/' + d.calls + '  ' + pct(d.rate))
  console.log('')
  console.log('[错误签名 Top]')
  for (const s of report.topSignatures) console.log('  ' + String(s.count).padStart(3) + '  ' + s.sig + (s.days > 1 ? '  (跨 ' + s.days + ' 天)' : ''))
  const rep = report.repeat
  console.log('')
  console.log('[复发] 签名 ' + rep.signatures + ' 个 · 跨天复发 ' + rep.repeatSignatures + ' 个 · 复发错误占 ' + pct(rep.repeatErrorShare) + ' · 最长 ' + rep.maxDays + ' 天')
  for (const w of rep.worst) console.log('  ' + String(w.count).padStart(3) + ' 次 / ' + w.days + ' 天  ' + w.sig)
  if (BY_SESSION) {
    console.log('')
    console.log('[分会话 · 按调用数降序]')
    for (const s of report.bySession) {
      const pctCell = s.calls ? pct(s.rate) : '  —  '
      console.log(
        '  ' + String(s.calls).padStart(5) + ' 调用 / ' + String(s.errors).padStart(3) + ' 错 / ' + pctCell +
          ' · 回合 ' + String(s.turns).padStart(3) + ' · ' + s.session.slice(0, 16) + (s.topSig ? ' · ' + s.topSig.slice(0, 44) : ''),
      )
    }
    console.log('')
    console.log('[按会话长度分组]')
    const groups = [
      ['短（<50 调用）', (s) => s.calls < 50],
      ['中（50–199）', (s) => s.calls >= 50 && s.calls < 200],
      ['长（>=200）', (s) => s.calls >= 200],
    ]
    for (const [name, pred] of groups) {
      const g = report.bySession.filter(pred)
      const c = g.reduce((a, s) => a + s.calls, 0)
      const e = g.reduce((a, s) => a + s.errors, 0)
      console.log('  ' + name + '：' + g.length + ' 会话 · 调用 ' + c + ' · 报错 ' + e + ' · 错误率 ' + (c ? pct(e / c) : '—'))
    }
  }
  if (report.split) {
    const sp = report.split
    console.log('')
    console.log('[改前/改后] 切点 ' + sp.at)
    for (const [name, x] of [['改前', sp.before], ['改后', sp.after]]) {
      console.log('  ' + name + '：调用 ' + x.calls + ' · 报错 ' + x.errors + ' · 错误率 ' + pct(x.errorRate) + ' · 复发占比 ' + pct(x.repeat.repeatErrorShare) + ' · 签名 ' + x.signatures)
    }
    const c = sp.compare
    console.log('  结论：' + c.verdict + '（错误率 ' + (c.errorRateDelta >= 0 ? '+' : '') + (c.errorRateDelta * 100).toFixed(2) + 'pp，复发 ' + (c.repeatShareDelta >= 0 ? '+' : '') + (c.repeatShareDelta * 100).toFixed(1) + 'pp）')
  }
}

if (!NO_WRITE) try {
  mkdirSync(METRICS_DIR, { recursive: true })
  writeFileSync(path.join(METRICS_DIR, 'tool-error-rate-baseline.json'), JSON.stringify(report, null, 2))
  appendFileSync(path.join(METRICS_DIR, 'tool-error-rate-history.jsonl'), JSON.stringify({ at: report.generatedAt, days: DAYS, calls: totalCalls, errors: totalErrors, rate: report.errorRate, repeatSignatures: report.repeat.repeatSignatures, repeatErrorShare: report.repeat.repeatErrorShare, maxDays: report.repeat.maxDays }) + '\n')
} catch (e) {
  console.error('基线落盘失败：' + e.message)
}

if (FAIL_OVER !== null && rate > Number(FAIL_OVER)) {
  console.error('\n✗ 错误率 ' + pct(rate) + ' 超过阈值 ' + FAIL_OVER)
  process.exit(1)
}
