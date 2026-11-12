#!/usr/bin/env node
// 错误签名统计的纯函数层：归一化签名 + 「跨天复发」汇总。
// 为什么单独拆出来：仪表脚本是 CLI（顶层就执行），纯函数放这里才能被 _selftest 单测；
// 也让 tool-error-rate.mjs 与 harness-quality.mjs 用同一套口径（一条事实一个权威源）。

/**
 * 归一化错误签名：去路径、去 id、去数字，便于跨会话聚合。
 * 判据：同一天同一句话只应该算一个签名；数字与路径变化不算新问题。
 */
export function signature(text) {
  return String(text)
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    .replace(/\b[0-9a-f]{8,}\b/g, '<id>')
    .replace(/\b\d{3,}\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 110)
}

/**
 * 错误分类学：按「谁该修」分，而不是按报错文本分。
 *
 * 2026-11-12 从 tool-error-rate.mjs 搬到这里：分类逻辑必须能被单测
 * （`_selftest/tests/error-classify.test.mjs`），否则改了分类器没有任何东西能证明它没误分类。
 * 顺序即优先级：越具体的形态越靠前；最后的 `code/other` 是兜底桶，理想情况应为 0。
 */
export function classify(msg) {
  const m = String(msg).toLowerCase()
  // run_code 的失败形态细分：此前这些大多掉进 code/other（曾占基线 55.3%）或 validation，
  // 归因器只能说「习惯」，给不出改法。细分后每一类都能落到具体修法。
  if (/code run failed|program completion|lossless json|toolcallerror/.test(m)) {
    if (/unknown tool/.test(m)) return 'run_code 工具名错'
    if (/timed out|timeout|deadline/.test(m)) return 'run_code 超时'
    if (/invalid-output|lossless json/.test(m)) return 'run_code 输出格式'
    if (/syntaxerror|unexpected character|unexpected token|unterminated|requires parens|invalid time value|expected /.test(m)) return 'run_code 语法错'
    return 'run_code 其他异常'
  }
  // 直接的工具调用报「工具不存在」（不在 run_code 内）：靠报错文本能认出来，应提示可用工具名
  if (/unknown tool/.test(m)) return '工具名错（unknown tool）'
  if (/non-public ip|fetch failed|getaddrinfo|enotfound|econnrefused|econnreset|socket hang up|tls handshake|cross-origin redirect/.test(m)) return 'network 通道'
  // 顺序理由：`old_string was not found` 属 edit 失误（不是路径错），由下面 edit 规则先认；
  // 而 `cannot read X: not found` 是路径错、不是写冲突，必须在 filesystem 之前单独认出来。
  if (/cannot read .*(not found|no such file)|enoent/.test(m)) return 'not-found 路径错'
  if (/cannot modify|cannot read|fs_stale_version|ebusy|eperm|being used by another/.test(m)) return 'filesystem 写冲突/歧义'
  if (/expected a semicolon|expected ','|unexpected character|unterminated|requires parens|invalid time value/.test(m)) return 'code 语法/逻辑'
  if (/matched \d+ times|expected |old_string was not found|must differ|offset \d+ is out of range/.test(m)) return 'edit 用法失误'
  if (/timed out|timeout|deadline/.test(m)) return 'timeout 超时'
  if (/aborted|abort/.test(m)) return 'aborted 被打断'
  if (/session has ended|start_session/.test(m)) return 'session 生命周期'
  if (/not found|no such file|enoent/.test(m)) return 'not-found 路径错'
  // 从 code/other 拆出（2026-11-12 用 --dump-errors 逐条看过原文）
  if (/记忆已占用|单条记忆最多|超预算/.test(m)) return '记忆配额超限'
  if (/protocol is blocked/.test(m)) return '浏览器协议限制'
  if (/is not a function/.test(m)) return '插件渲染错'
  // 已修的旧 bug：留独立类，观察它是否彻底消失（归因 owner=fixed）
  if (/memory_update 需要新的 text/.test(m)) return '已修：memory_update 元数据'
  if (/validation|invalid|schema|arguments/.test(m)) return 'validation 参数错'
  return 'code/other'
}

/**
 * 把「签名 → 按天计数」汇总成复发指标。
 *
 * 稳定性判据（钱学森式「扰动后能否回到平衡」的可测化）：
 *   一个错误签名只出现在 1 天 = 偶发；跨 ≥2 天 = 没修住，属稳定性问题。
 *
 * @param {Map<string, Map<string, number> | Set<string> | {count:number, days:string[]}>} sigDays
 * @returns {{signatures:number, repeatSignatures:number, repeatErrors:number, totalErrors:number,
 *            repeatErrorShare:number, maxDays:number, worst:Array<{sig:string,count:number,days:number}>}}
 */
/**
 * 改前 / 改后对比（判据写死在这里，避免每次换一套说法）：
 *   复发占比变化 ≥ +5pp 或 错误率上升 ≥0.5pp → 恶化
 *   复发占比下降 ≥5pp 或 错误率下降 ≥0.5pp → 改善
 *   其余 → 持平（样本太小不算改善）
 */
export function comparePhase(before, after) {
  const rate = (a) => (a.calls ? a.errors / a.calls : 0)
  const share = (a) => (a.repeat && a.repeat.repeatErrorShare) || 0
  const dEr = +(rate(after) - rate(before)).toFixed(4)
  const dRs = +(share(after) - share(before)).toFixed(4)
  let verdict = '持平'
  if (dRs <= -0.05 || dEr <= -0.005) verdict = '改善'
  if (dRs >= 0.05 || dEr >= 0.005) verdict = '恶化'
  return {
    errorRateBefore: +rate(before).toFixed(4), errorRateAfter: +rate(after).toFixed(4), errorRateDelta: dEr,
    repeatShareBefore: +share(before).toFixed(4), repeatShareAfter: +share(after).toFixed(4), repeatShareDelta: dRs,
    verdict,
  }
}

export function summarizeRepeat(sigDays) {
  const norm = new Map()
  for (const [sig, v] of sigDays || []) {
    if (v instanceof Map) {
      let count = 0
      for (const n of v.values()) count += Number(n) || 0
      norm.set(sig, { count, days: new Set(v.keys()) })
    } else if (v instanceof Set) {
      norm.set(sig, { count: v.size, days: v })
    } else if (v && typeof v === 'object') {
      const days = v.days instanceof Set ? v.days : new Set(v.days || [])
      norm.set(sig, { count: Number(v.count) || days.size, days })
    }
  }
  let signatures = 0
  let repeatSignatures = 0
  let repeatErrors = 0
  let totalErrors = 0
  let maxDays = 0
  const worst = []
  for (const [sig, { count, days }] of norm) {
    signatures += 1
    totalErrors += count
    const d = days.size
    if (d > maxDays) maxDays = d
    if (d >= 2) {
      repeatSignatures += 1
      repeatErrors += count
      worst.push({ sig, count, days: d })
    }
  }
  worst.sort((a, b) => (b.count - a.count) || (b.days - a.days))
  return {
    signatures,
    repeatSignatures,
    repeatErrors,
    totalErrors,
    repeatErrorShare: totalErrors ? Math.round((repeatErrors / totalErrors) * 10000) / 10000 : 0,
    maxDays,
    worst: worst.slice(0, 5),
  }
}
