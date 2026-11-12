// 只保留本插件实际用到的格式化函数（与 dsh-butler-tidy/lib/format.js 同风格，零依赖）
export const text = (value) => ({ type: 'text', text: value })

export const MB = 1024 * 1024
export const GB = 1024 * MB

export function fmtSize(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value >= GB) return (value / GB).toFixed(1) + ' GB'
  if (value >= MB) return (value / MB).toFixed(1) + ' MB'
  if (value >= 1024) return (value / 1024).toFixed(0) + ' KB'
  return value + ' B'
}

export function fmtCount(n) {
  return Number(n).toLocaleString('zh-CN')
}
