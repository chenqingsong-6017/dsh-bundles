import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { dayOf, sessionIdOf, listSessionFiles, parseSessionFile, priceFor, costOf, decompressSessionBuffer, apply } from '../../dsh-usage/index.js'
import { makeMockContext } from '../plugin-smoke.mjs'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ---- dayOf ----
// 2026-10-26T13:25:11.710Z = 北京时间 2026-10-26 21:25
const ts = Date.parse('2026-10-26T13:25:11.710Z')
assert.equal(dayOf(ts, 'Asia/Shanghai'), '2026-10-26')
assert.equal(dayOf(ts, 'UTC'), '2026-10-26')
// 跨时区边界：UTC 23:30 在北京是第二天
assert.equal(dayOf(Date.parse('2026-10-26T23:30:00Z'), 'Asia/Shanghai'), '2026-10-27')
assert.equal(dayOf(Date.parse('2026-10-26T23:30:00Z'), 'UTC'), '2026-10-26')
assert.equal(dayOf(Number.NaN, 'UTC'), '')
ok('dayOf：按指定时区切日期，跨时区边界正确')

// ---- sessionIdOf ----
assert.equal(sessionIdOf('/a/b/session-abc123/session.v4.jsonl.zstd'), 'session-abc123')
assert.equal(sessionIdOf('/x/y/8f0e-11/session.v4.jsonl.zstd'), '8f0e-11')
ok('sessionIdOf：取父目录名作为会话 id')

// ---- priceFor ----
// 2026-11-02（报告 #47）：族匹配只认显式通配键（`model*`），裸键不再当前缀用，避免 deepseek 吞掉 deepseek-flash。
const prices = { 'deepseek-flash': { input: 0.5, output: 8, cacheRead: 0.05, cacheWrite: 0.5 }, 'kimi-*': { input: 4 } }
assert.deepEqual(priceFor(prices, 'deepseek-official', 'deepseek-flash').input, 0.5)
assert.deepEqual(priceFor(prices, 'x', 'kimi-k3').input, 4, '显式通配键才做族匹配（kimi-* → kimi-k3）')
assert.equal(priceFor(prices, 'x', 'unknown-model'), null)
assert.equal(priceFor(null, 'x', 'y'), null)

const familyPrices = {
  deepseek: { input: 9 },
  'deepseek*': { input: 1 },
  'deepseek-flash*': { input: 2 },
  'deepseek-flash': { input: 0.5 },
}
assert.equal(priceFor(familyPrices, 'p', 'deepseek-flash').input, 0.5, '精确命中优先于任何通配键')
assert.equal(priceFor(familyPrices, 'p', 'deepseek-flash-2026').input, 2, '最长通配前缀胜出（deepseek-flash* > deepseek*）')
assert.equal(priceFor(familyPrices, 'p', 'deepseek-pro').input, 1, '只有短前缀匹配时用短前缀')
assert.equal(
  priceFor({ deepseek: { input: 9 } }, 'p', 'deepseek-flash'),
  null,
  '裸键 deepseek 不再吞掉同前缀模型（修复 #47 的核心：不再 model.startsWith(裸键)）',
)
assert.equal(priceFor({ '*': { input: 3 } }, 'p', 'whatever-model').input, 3, '显式 * 是兜底价，允许')
ok('priceFor：精确匹配优先、显式通配键族匹配取最长前缀、裸键不再当前缀')

// ---- costOf ----
const bucket = { provider: 'deepseek-official', model: 'deepseek-flash', input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 0 }
const cost = costOf(bucket, prices)
assert.equal(Math.round(cost * 100) / 100, 8.55, `1M input + 1M output + 1M cacheRead = 0.5+8+0.05 (got ${cost})`)
assert.equal(costOf(bucket, null), null, '没价格表不算钱')
ok('costOf：按每百万单价计算，无价格返回 null')

// ---- listSessionFiles + parseSessionFile（用临时生成的 zstd 日志）----
const root = mkdtempSync(join(tmpdir(), 'dsh-usage-'))
try {
  const ws = join(root, '--workspace--')
  const s1 = join(ws, 'session-aaa')
  const s2 = join(ws, 'session-bbb')
  mkdirSync(s1, { recursive: true })
  mkdirSync(s2, { recursive: true })

  const line = (time, model, input, output, cacheRead) =>
    JSON.stringify({
      type: 'assistant/message',
      seq: 1,
      time,
      data: {
        usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: 0, totalTokens: input + output + cacheRead },
        message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-official', model } },
      },
    })

  const day1 = Date.parse('2026-10-26T02:00:00Z')
  const day2 = Date.parse('2026-10-27T02:00:00Z')
  const body1 = [
    line(day1, 'deepseek-flash', 100, 10, 1000),
    line(day1, 'deepseek-flash', 200, 20, 2000),
    line(day2, 'deepseek-pro', 300, 30, 3000),
    // 2026-11-02（报告 #48）：time 缺失的事件不许用 Date.now() 冒充「今天」，必须跳过并计数
    JSON.stringify({
      type: 'assistant/message',
      seq: 9,
      data: {
        usage: { inputTokens: 999, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1008 },
        message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
      },
    }),
    'not-json-line',
    JSON.stringify({ type: 'turn/start', data: {} }),
  ].join('\n')
  writeFileSync(join(s1, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(body1, 'utf8')))
  writeFileSync(join(s2, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(line(day1, 'deepseek-flash', 50, 5, 500), 'utf8')))
  writeFileSync(join(ws, 'unrelated.txt'), 'ignore me')

  const files = listSessionFiles(root)
  assert.equal(files.length, 2, `should find 2 session logs, got ${files.length}`)
  ok('listSessionFiles：只收 *.jsonl.zstd，忽略其他文件')

  const parsed = await parseSessionFile(files.find((f) => f.includes('session-aaa')), { timeZone: 'Asia/Shanghai' })
  assert.equal(parsed.calls, 3, 'bad lines skipped, 3 usage events kept')
  assert.equal(parsed.buckets.length, 2, 'two (date,model) buckets')
  assert.equal(parsed.skippedNoTime, 1, 'time 缺失的事件必须跳过并计数（不许 Date.now() 冒充日期）')
  const b1 = parsed.buckets.find((b) => b.date === '2026-10-26' && b.model === 'deepseek-flash')
  assert.equal(b1.calls, 2)
  assert.equal(b1.input, 300)
  assert.equal(b1.output, 30)
  assert.equal(b1.cacheRead, 3000)
  assert.equal(b1.total, 3330)
  const b2 = parsed.buckets.find((b) => b.model === 'deepseek-pro')
  assert.equal(b2.date, '2026-10-27')
  ok('parseSessionFile：按 (日期,模型) 聚合，跳过坏行与非 usage 事件')
} finally {
  rmSync(root, { recursive: true, force: true })
}

// ---- 多帧 zstd 回归（真实会话日志是多帧的！）----
// 背景：DSH 自带 node 24.21 的 zstdDecompressSync / createZstdDecompress **只解第一帧**，
// 曾导致整个插件读到 0 行。这里用两段独立压缩再拼接来复现真实形态。
{
  const one = Buffer.from(
    JSON.stringify({
      type: 'assistant/message',
      time: Date.parse('2026-10-26T02:00:00Z'),
      data: {
        usage: { inputTokens: 11, outputTokens: 1, cacheReadTokens: 111 },
        message: { source: { provider: 'p', model: 'm1' } },
      },
    }) + '\n',
    'utf8',
  )
  const two = Buffer.from(
    JSON.stringify({
      type: 'assistant/message',
      time: Date.parse('2026-10-27T02:00:00Z'),
      data: {
        usage: { inputTokens: 22, outputTokens: 2, cacheReadTokens: 222 },
        message: { source: { provider: 'p', model: 'm2' } },
      },
    }) + '\n',
    'utf8',
  )
  const multiFrame = Buffer.concat([zstdCompressSync(one), zstdCompressSync(two)])
  const out = decompressSessionBuffer(multiFrame).toString('utf8')
  assert.ok(out.includes('"m1"'), '第一帧内容')
  assert.ok(out.includes('"m2"'), '第二帧内容（回归：不能只解第一帧）')
  assert.equal(out.split('\n').filter(Boolean).length, 2)
  ok('decompressSessionBuffer：多帧拼接能完整解出（Node 24 只解第一帧的回归）')

  // 把多帧文件写盘，验证 parseSessionFile 端到端不丢帧
  const dir = mkdtempSync(join(tmpdir(), 'dsh-usage-multi-'))
  try {
    const s = join(dir, 'session-multi')
    mkdirSync(s, { recursive: true })
    writeFileSync(join(s, 'session.v4.jsonl.zstd'), multiFrame)
    const parsed = await parseSessionFile(join(s, 'session.v4.jsonl.zstd'), { timeZone: 'Asia/Shanghai' })
    assert.equal(parsed.calls, 2, `多帧文件应解析出 2 条调用，实际 ${parsed.calls}`)
    assert.equal(parsed.buckets.length, 2)
    ok('parseSessionFile：多帧文件端到端解析（跨日期两个桶）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---- 契约（统一规格 2026-11-01）：status 报 ready，探针错误给稳定 code ----
// 只验 schema + render，不跑 execute（execute 会真扫会话日志，测试不该依赖本机盘面）。
{
  const storeDir = mkdtempSync(join(tmpdir(), 'dsh-usage-store-'))
  const { ctx, registered } = makeMockContext()
  apply(ctx, { storeDir })
  const status = registered.find((definition) => definition.name === 'usage_status')
  assert.ok(status, 'usage_status 必须注册')
  assert.ok(status.output.schema.required.includes('ready'), 'status schema 必须含 ready')
  assert.ok(status.output.schema.required.includes('unavailableReason'), 'status schema 必须含 unavailableReason')
  assert.ok(status.output.schema.properties.probe.required.includes('code'), '探针错误必须有稳定 code')
  assert.ok(
    status.output.schema.required.includes('skippedNoTime'),
    'status 必须报「time 缺失被跳过的事件数」（跳过就要看得见，不能静默）',
  )

  const sample = {
    ready: false,
    unavailableReason: '未配置价格表（只能报 token，不报成本）',
    sessionsRoot: '/x',
    storeFile: '/y',
    models: [],
    diagnostics: { node: '24', electron: '44', zstd: 'sync-available' },
    probe: { file: 's1', lines: 0, calls: 0, code: 'USAGE_PARSE_FAILED', error: 'boom' },
  }
  const blocks = status.output.render({}, sample)
  assert.ok(blocks[0].text.includes('不可用：未配置价格表'), `render 要显示「不可用：<reason>」，实际：${blocks[0].text}`)
  rmSync(storeDir, { recursive: true, force: true })
  ok('契约：usage_status 带 ready/unavailableReason，探针错误带 code')
}

console.log(`usage: ${passed} 项通过`)