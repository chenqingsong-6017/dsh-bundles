import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  shouldNotify,
  describeOutcome,
  xmlEscape,
  compact,
  buildToastScript,
  buildBalloonScript,
  dayOf,
  apply,
  resolveTurnDuration,
  TRUNCATION_HINT,
} from '../../dsh-notify/index.js'
import { makeMockContext } from '../plugin-smoke.mjs'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

const defaults = {
  minDurationMs: 60000,
  notifyOnComplete: true,
  notifyOnError: true,
  notifyOnInterrupt: false,
}

// ---- shouldNotify：只在该打扰的时候打扰 ----
assert.equal(
  shouldNotify({ reason: { kind: 'completed' }, durationMs: 90000, ...defaults }),
  'complete',
  '长回合完成 → 通知',
)
assert.equal(
  shouldNotify({ reason: { kind: 'completed' }, durationMs: 5000, ...defaults }),
  null,
  '短回合完成 → 静默（不变成噪音）',
)
assert.equal(shouldNotify({ reason: { kind: 'error' }, durationMs: 3000, ...defaults }), 'error', '失败立即通知，不受时长限制')
assert.equal(
  shouldNotify({ reason: { kind: 'error' }, durationMs: 3000, ...defaults, notifyOnError: false }),
  null,
  'notifyOnError=false 时失败也不通知',
)
assert.equal(
  shouldNotify({ reason: { kind: 'interrupted' }, durationMs: 90000, ...defaults }),
  null,
  '中断默认不通知',
)
assert.equal(
  shouldNotify({ reason: { kind: 'interrupted' }, durationMs: 90000, ...defaults, notifyOnInterrupt: true }),
  'interrupt',
  '显式开启后中断才通知',
)
assert.equal(shouldNotify({ reason: { kind: 'max-tokens' }, durationMs: 1000, ...defaults }), 'max-tokens')
assert.equal(
  shouldNotify({ reason: { kind: 'completed' }, durationMs: 90000, ...defaults, notifyOnComplete: false }),
  null,
  'notifyOnComplete=false 时不通知完成',
)
ok('shouldNotify：长任务/失败通知，短问答静默，开关可关')

// ---- 2026-11-02 新增：耗时缺失不许静默漏报（报告 #45）----
// 修复前：`undefined >= 60000` 为 false → 拿不到耗时的完成回合永远不通知（漏报）。
assert.equal(
  shouldNotify({ reason: { kind: 'completed' }, durationMs: undefined, ...defaults }),
  'complete',
  '耗时 undefined 的完成回合 → 保守通知（不许 undefined >= minDurationMs 静默判假）',
)
assert.equal(
  shouldNotify({ reason: { kind: 'completed' }, durationMs: null, ...defaults }),
  'complete',
  '耗时 null 的完成回合 → 同样走「未知耗时」分支',
)
assert.equal(
  shouldNotify({ reason: { kind: 'completed' }, durationMs: null, ...defaults, notifyOnComplete: false }),
  null,
  '未知耗时也不能绕过 notifyOnComplete=false',
)

const unknownDuration = describeOutcome('complete', { durationMs: null, sessionShort: 'abc', title: 'x' })
assert.ok(unknownDuration.body.includes('耗时未知'), `未知耗时必须明说，实际：${unknownDuration.body}`)
assert.ok(!unknownDuration.body.includes('NaN'), '不许出现 NaN 秒')
assert.ok(!unknownDuration.body.includes('0 秒'), '不许把未知耗时说成 0 秒')

// 真实耗时来源：事件自带 durationMs 优先；否则 turn/start.time → turn/end.time；都没有 = unknown
assert.deepEqual(
  resolveTurnDuration({ event: { time: 2000 }, startedAt: 1000 }),
  { durationMs: 1000, source: 'turn/start' },
  'turn/start + turn/end 的时间差就是真实耗时',
)
assert.deepEqual(
  resolveTurnDuration({ event: { time: 9999, data: { durationMs: 1234 } }, startedAt: 1000 }),
  { durationMs: 1234, source: 'event' },
  '事件自带 durationMs 时直接用（不拿 9999-1000 冒充）',
)
assert.deepEqual(
  resolveTurnDuration({ event: { type: 'turn/end' }, startedAt: undefined }),
  { durationMs: null, source: 'unknown' },
  '开始/结束时间都取不到 → 明确 unknown，而不是 0',
)
assert.equal(
  resolveTurnDuration({ event: { time: 500 }, startedAt: 1000 }).source,
  'unknown',
  '时钟倒挂不报负数耗时，按未知处理',
)
ok('耗时缺失：未知分支明说 + 保守通知，不许静默漏报也不许 NaN/0 秒')

// ---- describeOutcome：说人话 ----
const complete = describeOutcome('complete', { durationMs: 185000, sessionShort: 'c3b2eae9', title: 'dsh-创建' })
assert.equal(complete.title, '任务完成')
assert.ok(complete.body.includes('dsh-创建'), '正文带任务名')
assert.ok(complete.body.includes('3 分钟'), `时长要可读（实际 ${complete.body}）`)
assert.ok(complete.body.includes('c3b2eae9'), '正文带会话短 id')

const failed = describeOutcome('error', { durationMs: 12000, sessionShort: 'abc', title: '' })
assert.equal(failed.title, '任务出错')
assert.ok(failed.body.includes('12 秒'))
assert.ok(failed.body.includes('未命名会话'), '没有任务名时用兜底文案')
ok('describeOutcome：标题/正文人话化，时长按分秒呈现')

// ---- xmlEscape ----
assert.equal(xmlEscape('a & b < c > d "e" \'f\''), 'a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;')
ok('xmlEscape：五个 XML 特殊字符全部转义（Toast 不会崩）')

// ---- compact ----
assert.equal(compact('  a\n\n b   c  '), 'a b c', '压成单行')
assert.equal(compact('x'.repeat(300)).length, 201, '超长截断为 200 + …')
// 2026-11-02 新增（报告 #46）：截断要带可操作提示，人知道去哪看全文
const longBody = compact('y'.repeat(300), 200, TRUNCATION_HINT)
assert.ok(longBody.startsWith('y'.repeat(200)), '仍保留 200 字符正文')
assert.ok(longBody.endsWith(TRUNCATION_HINT), `截断末尾要有提示，实际：…${longBody.slice(-40)}`)
assert.ok(longBody.includes('已截断，详见会话'), '提示要可操作（告诉人去会话里看全文）')
assert.ok(
  buildToastScript('标题', 'z'.repeat(300)).includes('已截断，详见会话'),
  'Toast 正文走同一条截断路径，提示不能只出现在单测里',
)
ok('compact：压空白并按上限截断；正文截断末尾带「已截断，详见会话」')

// ---- buildToastScript（5.1 + WinRT LoadXml 路线）----
const script = buildToastScript('标题 & <tag>', '正文 "引号"')
assert.ok(script.includes('template="ToastText02"'), '用双行模板')
assert.ok(script.includes('标题 &amp; &lt;tag&gt;'), '标题被 XML 转义后写进 toast XML')
assert.ok(script.includes('LoadXml'), '用 LoadXml 构造（5.1 的 InnerText 不可写）')
assert.ok(script.includes('ContentType = WindowsRuntime'), '显式加载 WinRT 类型（pwsh7 加载不到）')
assert.ok(script.includes("CreateToastNotifier('DeepSeek Harness')"), '有 AppUserModelID')
assert.ok(!script.includes('<audio'), '默认不静音')
assert.ok(buildToastScript('t', 'b', true).includes('<audio silent="true"/>'), 'silent=true 时嵌 audio 静音')
assert.ok(script.includes('exit 2'), '失败用非 0 退出码，让上层能区分真假成功')
ok('buildToastScript：LoadXml + XML 转义 + 静音开关 + 失败退出码')

// ---- buildBalloonScript（WinForms 兜底）----
const balloon = buildBalloonScript("it's a test", 'body')
assert.ok(balloon.includes('System.Windows.Forms'), '用 WinForms 托盘气泡')
assert.ok(balloon.includes('ShowBalloonTip'), '调用 ShowBalloonTip')
assert.ok(balloon.includes("it''s a test"), "单引号被转义（PowerShell 字符串安全）")
assert.ok(balloon.includes('exit 2'), '失败同样返回非 0')
ok('buildBalloonScript：WinForms 兜底脚本，含引号转义')

// ---- dayOf ----
assert.equal(dayOf(Date.parse('2026-10-26T13:25:11Z'), 'Asia/Shanghai'), '2026-10-26')
assert.equal(dayOf(Date.parse('2026-10-26T23:30:00Z'), 'Asia/Shanghai'), '2026-10-27')
assert.equal(dayOf(Number.NaN, 'UTC'), '')
ok('dayOf：按指定时区切日，跨边界正确')

// ---- 契约（统一规格 2026-11-01）：status 报 ready，notify 失败给稳定 code ----
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-notify-'))
  try {
    const { ctx, registered } = makeMockContext()
    apply(ctx, { storeDir: dir, timeZone: 'Asia/Shanghai' })
    const status = registered.find((definition) => definition.name === 'notify_status')
    assert.ok(status, 'notify_status 必须注册')
    assert.ok(status.output.schema.required.includes('ready'), 'status schema 必须含 ready')
    assert.ok(status.output.schema.required.includes('unavailableReason'), 'status schema 必须含 unavailableReason')
    assert.ok(
      status.output.schema.required.includes('unknownDurationTurns'),
      'status schema 必须报「耗时未知的完成回合」计数（看不到就无法判断是否在漏报）',
    )

    // 不可用分支的 render：必须出现「不可用：<reason>」
    const sample = { ready: false, unavailableReason: '测试原因', transport: 'log', toastAvailable: false, lastSentAt: '', lastError: '' }
    const blocks = status.output.render({}, sample)
    assert.ok(blocks[0].text.includes('不可用：测试原因'), `render 要显示「不可用：<reason>」，实际：${blocks[0].text}`)

    const notify = registered.find((definition) => definition.name === 'notify')
    assert.ok(notify.output.schema.required.includes('code'), 'notify 的失败返回必须有 code（脚本要能按码命中）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
ok('契约：notify_status 带 ready/unavailableReason，notify 失败带 code')
