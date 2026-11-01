import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shouldNotify, describeOutcome, xmlEscape, compact, buildToastScript, buildBalloonScript, dayOf, apply } from '../../dsh-notify/index.js'
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
ok('compact：压空白并按上限截断')

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
