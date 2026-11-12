// 错误分类器单测（2026-11-12 立）：分类口径错了，归因就全错。
// 为什么要有它：classify 从 tool-error-rate.mjs 搬到 error-stats.mjs 之前**没有任何测试**，
// 改了 12 类却无法证明没误分类；兜底桶 code/other 曾吃掉 55.3% 的错误，归因只能说「习惯」。
//
// 判据：每条断言都来自**真实报错原文**（--dump-errors 从当天会话日志逐条捞的），不是编的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../metrics/error-stats.mjs';

const cases = [
  // run_code 的五种形态（原先全掉进 code/other 或 validation）
  ['code run failed (exception): ToolCallError: unknown tool "memory_status"', 'run_code 工具名错'],
  ['code run failed (exception): tool call timed out after 30000ms', 'run_code 超时'],
  ['code run failed (invalid-output): program completion must be lossless JSON', 'run_code 输出格式'],
  ['code run failed (exception): SyntaxError: Unexpected token }', 'run_code 语法错'],
  ['code run failed (exception): boom', 'run_code 其他异常'],
  // 直接调不存在的工具（不在 run_code 内）
  ['unknown tool "memory_update"', '工具名错（unknown tool）'],
  // 网络 / 文件 / 编辑 / 语法
  ['web fetch failed: TypeError: fetch failed', 'network 通道'],
  ['cannot modify "C:\\x\\y.md": EPERM', 'filesystem 写冲突/歧义'],
  ['old_string was not found in "C:\\x\\y.md"', 'edit 用法失误'],
  ['Expected a semicolon', 'code 语法/逻辑'],
  // 路径错：`cannot read X: not found` 不能再被 filesystem 吃掉
  ['cannot read "C:\\x\\y.md": not found', 'not-found 路径错'],
  ['no such file or directory: z.js', 'not-found 路径错'],
  // 从 code/other 拆出来的四类
  ['tool call timed out after 30000ms', 'timeout 超时'],
  ['vision tool execution aborted', 'aborted 被打断'],
  ['this session has ended; call start_session explicitly to reuse its label', 'session 生命周期'],
  ['记忆已占用 11983 / 12000 字符，本次需 154 字符', '记忆配额超限'],
  ['单条记忆最多 600 字符，当前 601', '记忆配额超限'],
  ['Access to "file:" protocol is blocked', '浏览器协议限制'],
  ['content.some is not a function', '插件渲染错'],
  // 已修的旧 bug：留独立类观察是否归零
  ['memory_update 需要新的 text；要删除请用 memory_remove {id, confirm:true}', '已修：memory_update 元数据'],
  ['invalid arguments: missing required property "description"', 'validation 参数错'],
];

test('每条真实错误原文都落到具体类（不允许再掉进 code/other）', () => {
  const misses = cases
    .map(([text, want]) => ({ text, want, got: classify(text) }))
    .filter((c) => c.got !== c.want);
  assert.deepEqual(misses, []);
});

test('兜底桶仍然存在，但只接真正没见过的文本', () => {
  assert.equal(classify('something totally unheard of happened'), 'code/other');
});

test('大小写不敏感（原始报错有 Expected / expected 两种写法）', () => {
  assert.equal(classify('EXPECTED A SEMICOLON'), 'code 语法/逻辑');
  assert.equal(classify('CODE RUN FAILED (EXCEPTION): BOOM'), 'run_code 其他异常');
});

test('非字符串输入不抛异常（会话日志里 data.message 可能是对象）', () => {
  assert.doesNotThrow(() => classify(undefined));
  assert.doesNotThrow(() => classify(null));
  assert.equal(classify(undefined), 'code/other');
});
