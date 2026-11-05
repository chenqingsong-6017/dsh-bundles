/**
 * 两个最小的跨模块工具：错误对象构造与文本结果包装。
 */

/** 统一错误契约：所有抛出的错误都带 code（UPPER_SNAKE），调用方据此分支，不必解析中文文案。 */
export function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export const text = (value) => ({ type: 'text', text: value })
