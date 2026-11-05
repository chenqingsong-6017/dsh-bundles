// 格式化工具 + 尺寸常量（从 index.js 机械提取，逻辑零变化）
export const text = (value) => ({ type: 'text', text: value })

export const MB = 1024 * 1024
export const GB = 1024 * MB
// ───────────────────────────── 格式化 ─────────────────────────────

export function fmtSize(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value >= GB) return `${(value / GB).toFixed(1)} GB`
  if (value >= MB) return `${(value / MB).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`
  return `${value} B`
}

export function fmtCount(n) {
  return Number(n).toLocaleString('zh-CN')
}

export function pad2(n) {
  return String(n).padStart(2, '0')
}

export function stampOf(date = new Date()) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(
    date.getMinutes(),
  )}${pad2(date.getSeconds())}-${String(date.getMilliseconds()).padStart(3, '0')}`
}

export function hhmmss(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

