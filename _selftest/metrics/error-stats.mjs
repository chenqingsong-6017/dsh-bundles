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
 * 把「签名 → 按天计数」汇总成复发指标。
 *
 * 稳定性判据（钱学森式「扰动后能否回到平衡」的可测化）：
 *   一个错误签名只出现在 1 天 = 偶发；跨 ≥2 天 = 没修住，属稳定性问题。
 *
 * @param {Map<string, Map<string, number> | Set<string> | {count:number, days:string[]}>} sigDays
 * @returns {{signatures:number, repeatSignatures:number, repeatErrors:number, totalErrors:number,
 *            repeatErrorShare:number, maxDays:number, worst:Array<{sig:string,count:number,days:number}>}}
 */
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
