import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  apply,
  CHANNELS,
  fileFor,
  LEVELS,
  levelRank,
  localDay,
  matchesFilter,
  normalizeEvent,
  parseLine,
  parseWhen,
} from '../../dsh-eventlog/index.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log('  ✓ ' + label)
}

const host = (dir, extra) => {
  const defs = new Map()
  const handlers = []
  const ctx = {
    tools: { register: (definition) => { defs.set(definition.name, definition); return () => {} } },
    effect: (fn) => fn(),
    on: (name, handler) => { handlers.push({ name, handler }); return () => {} },
  }
  apply(ctx, { storeDir: dir, ...(extra ?? {}) })
  return { defs, handlers }
}

// ---- 纯函数 ----
{
  assert.deepEqual(LEVELS, ['info', 'warn', 'error', 'fatal'])
  assert.ok(CHANNELS.includes('plugin'))
  assert.equal(levelRank('warn') > levelRank('info'), true)
  assert.equal(levelRank('nonsense'), 0)
  assert.match(localDay(Date.parse('2026-11-01T12:00:00+08:00')), /^\d{4}-\d{2}-\d{2}$/)

  const event = normalizeEvent({ level: 'WARN', channel: 'Plugin', code: 'x-y', message: '  多行\n消息  ', data: { a: 1 } }, 0)
  assert.equal(event.level, 'warn', '级别小写化')
  assert.equal(event.channel, 'plugin', '频道小写化')
  assert.equal(event.message, '多行 消息', '消息压成单行')
  assert.equal(event.data, '{"a":1}', 'data 序列化成字符串')
  assert.equal(normalizeEvent({ level: 'bogus', channel: 'bogus', message: 'x' }).level, 'info', '非法级别回落 info')
  assert.equal(normalizeEvent({ message: 'x'.repeat(600) }).message.length, 400, '消息截断到 400')
  ok('normalizeEvent：级别/频道归一、单行化、截断')

  const base = normalizeEvent({ level: 'error', channel: 'agent', code: 'TOOL-ERROR', message: 'boom', source: 'web_fetch' }, 1000)
  assert.equal(matchesFilter(base, {}), true)
  assert.equal(matchesFilter(base, { channel: 'agent' }), true)
  assert.equal(matchesFilter(base, { channel: 'memory' }), false)
  assert.equal(matchesFilter(base, { code: 'tool-error' }), true, 'code 不区分大小写')
  assert.equal(matchesFilter(base, { level: 'warn' }), true, 'level 是「≥」语义')
  assert.equal(matchesFilter(base, { level: 'fatal' }), false)
  assert.equal(matchesFilter(base, { keyword: 'WEB_FETCH' }), true, 'keyword 覆盖 source')
  assert.equal(matchesFilter(base, { keyword: '不存在' }), false)
  assert.equal(matchesFilter(base, { since: 2000 }), false, '早于 since 被过滤')
  assert.equal(matchesFilter(base, { until: 500 }), false, '晚于 until 被过滤')
  ok('matchesFilter：频道/级别≥/事件码/关键词/时间窗')

  const now = Date.parse('2026-11-01T00:00:00+08:00')
  assert.equal(parseWhen('7d', now), now - 7 * 86400000)
  assert.equal(parseWhen('12h', now), now - 12 * 3600000)
  assert.equal(parseWhen('2026-10-31', now), Date.parse('2026-10-31T00:00:00'))
  assert.equal(parseWhen('', now), null)
  assert.equal(parseWhen('坏值', now), null)
  ok('parseWhen：相对 / 日期 / 非法')

  assert.equal(parseLine('{"a":1}').a, 1)
  assert.equal(parseLine(''), null)
  assert.equal(parseLine('{坏 json'), null)
  ok('parseLine：坏行不抛')
}

// ---- 写入 / 查询 / 状态 ----
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-eventlog-'))
  const h = host(dir)
  const wrote = await h.defs.get('log_write').execute({
    message: '插件加载失败：dsh-notify 缺 inject',
    level: 'error',
    channel: 'plugin',
    code: 'PLUGIN-LOAD-FAIL',
    source: 'dsh-notify',
  })
  assert.equal(wrote.ok, true)
  assert.ok(existsSync(wrote.file), '事件文件应存在')
  await h.defs.get('log_write').execute({ message: '一次普通里程碑', channel: 'system', code: 'MILESTONE' })
  const body = readFileSync(wrote.file, 'utf8').trim().split('\n')
  assert.equal(body.length, 3, '启动 1 条 + 手写 2 条')
  assert.equal(parseLine(body[0]).code, 'LOG-START', '启动即写 LOG-START')
  ok('log_write：落盘 + 启动事件')

  const errors = await h.defs.get('log_query').execute({ level: 'error' })
  assert.equal(errors.matched, 1)
  assert.equal(errors.entries[0].code, 'PLUGIN-LOAD-FAIL')
  const byChannel = await h.defs.get('log_query').execute({ channel: 'system' })
  assert.ok(byChannel.entries.every((item) => item.channel === 'system'))
  const byKeyword = await h.defs.get('log_query').execute({ keyword: '缺 inject' })
  assert.equal(byKeyword.matched, 1)
  const byCode = await h.defs.get('log_query').execute({ code: 'milestone' })
  assert.equal(byCode.matched, 1, '事件码不区分大小写')
  const ordered = await h.defs.get('log_query').execute({ limit: 3 })
  assert.equal(ordered.entries[0].code, 'MILESTONE', '倒序：最新在前')
  ok('log_query：级别/频道/关键词/事件码/倒序')

  const status = await h.defs.get('log_status').execute({})
  assert.equal(status.files, 1)
  assert.equal(status.entries, 3)
  assert.equal(status.keepDays, 30)
  assert.equal(status.minLevel, 'info')
  assert.equal(status.captureToolErrors, true)
  assert.equal(status.writtenThisRun, 3)
  assert.equal(status.lastError, '')
  ok('log_status：文件/条数/保留/本次写入/无错误')

  // 自动捕获：tool/result 且 isError → TOOL-ERROR
  const capture = h.handlers.find((item) => item.name === 'session/event')
  assert.ok(capture, '应订阅 session/event')
  capture.handler({ header: { id: 's1' } }, { type: 'tool/result', data: { name: 'web_fetch', isError: true, error: { message: 'boom' } } })
  capture.handler({ header: { id: 's1' } }, { type: 'tool/result', data: { name: 'read', isError: false } })
  const captured = await h.defs.get('log_query').execute({ code: 'TOOL-ERROR' })
  assert.equal(captured.matched, 1, '只记错误，不记成功调用')
  assert.equal(captured.entries[0].source, 'web_fetch')
  ok('自动捕获：tool/result 报错 → TOOL-ERROR（成功调用不记）')

  // 真实事件形状（v0.1.1）：tool/call 记名字，tool/result.message 包装 + toolCallId 回查
  capture.handler({ header: { id: 's1' } }, { type: 'tool/call', data: { callId: 'c1', name: 'vision_crop' } })
  capture.handler({ header: { id: 's1' } }, { type: 'tool/result', data: { message: { isError: true, toolCallId: 'c1', content: [{ type: 'text', text: 'invalid region "-3,-4"' }] } } })
  const realShape = await h.defs.get('log_query').execute({ code: 'TOOL-ERROR', keyword: 'invalid region' })
  assert.equal(realShape.matched, 1, '真实 payload 也要抓到')
  assert.equal(realShape.entries[0].source, 'vision_crop', '按 toolCallId 还原工具名，不能是 unknown')
  assert.ok(realShape.entries[0].message.includes('invalid region'), '错误正文要落进 message')
  assert.ok(!realShape.entries[0].message.includes('[object Object]'), '不能出现 [object Object]')
  capture.handler({ header: { id: 's1' } }, { type: 'tool/result', data: { message: { isError: false, toolCallId: 'c1' } } })
  const stillOne = await h.defs.get('log_query').execute({ code: 'TOOL-ERROR', keyword: 'invalid region' })
  assert.equal(stillOne.matched, 1, '成功结果不记')
  ok('自动捕获：真实 payload（message 包装 + callId 映射 + 无 [object Object]）')

  // v0.1.2：content 有正文、error 只有类名 → message 取正文首行，不是 CodeRunFailedError
  capture.handler({ header: { id: 's1' } }, { type: 'tool/call', data: { callId: 'c2', name: 'run_code' } })
  capture.handler(
    { header: { id: 's1' } },
    {
      type: 'tool/result',
      data: {
        message: {
          isError: true,
          toolCallId: 'c2',
          content: [
            {
              type: 'text',
              text: 'Error: code run failed (exception): ToolCallError: cannot read "x": not found\n    at foo (file:///a.js:1:1)',
            },
          ],
        },
        error: { name: 'CodeRunFailedError', code: 'CODE_RUN_FAILED' },
      },
    },
  )
  const human = await h.defs.get('log_query').execute({ code: 'TOOL-ERROR', keyword: 'cannot read' })
  assert.equal(human.matched, 1, '正文里有 cannot read 就该命中')
  assert.equal(human.entries[0].source, 'run_code')
  assert.ok(human.entries[0].message.includes('not found'), '要落真实原因')
  assert.ok(!human.entries[0].message.includes('CodeRunFailedError'), '不能只落错误类名')
  assert.ok(!human.entries[0].message.includes(' at '), '调用栈不进 message')
  ok('自动捕获：取错误正文首行（不是只落错误类名 / 不带调用栈）')

  // minLevel 过滤
  const quietDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-eventlog-q-'))
  const quiet = host(quietDir, { minLevel: 'error' })
  const low = await quiet.defs.get('log_write').execute({ message: 'info 不该落盘', level: 'info' })
  assert.equal(low.ok, false, '低于 minLevel 不写')
  rmSync(dir, { recursive: true, force: true })
  rmSync(quietDir, { recursive: true, force: true })
  ok('minLevel：低级别不落盘')
}

// ---- 保留策略：超 keepDays 的文件自动清 ----
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-eventlog-prune-'))
  writeFileSync(fileFor(dir, '2020-01-01'), JSON.stringify(normalizeEvent({ message: 'old' })) + '\n', 'utf8')
  host(dir, { keepDays: 30 })
  assert.equal(existsSync(fileFor(dir, '2020-01-01')), false, '超期文件应被清理')
  rmSync(dir, { recursive: true, force: true })
  ok('保留策略：超 keepDays 自动清理')
}

// ---- fail-safe：写不进去也不能抛 ----
{
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-eventlog-fail-'))
  const blocker = path.join(root, 'blocker')
  writeFileSync(blocker, 'not a dir', 'utf8')
  const h = host(path.join(blocker, 'nested'))
  const wrote = await h.defs.get('log_write').execute({ message: '写不进也不该抛' })
  assert.equal(wrote.ok, false)
  const status = await h.defs.get('log_status').execute({})
  assert.ok(status.lastError !== '', '失败要记进 lastError，而不是吞掉')
  rmSync(root, { recursive: true, force: true })
  ok('fail-safe：目录不可写时返回 ok:false 并记 lastError，不抛')
}

// ---- v0.1.3：轮转按候选文件大小续写（别一条一个文件） ----
{
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-eventlog-roll-"))
  const day = localDay(Date.now())
  const base = fileFor(dir, day)
  const line = JSON.stringify(normalizeEvent({ message: 'x'.repeat(300) })) + '\n'
  writeFileSync(base, line.repeat(30000), 'utf8')
  assert.ok(readFileSync(base).length > 8 * 1024 * 1024, "构造一个超过 8MB 的当天基文件")
  const h = host(dir)
  await h.defs.get('log_write').execute({ message: 'after-roll-1' })
  await h.defs.get('log_write').execute({ message: 'after-roll-2' })
  const names = readdirSync(dir)
  assert.equal(names.filter((n) => n.endsWith(".2.jsonl")).length, 0, "第二块没满就不该再建 .2")
  const rolled = names.find((n) => n.endsWith(".1.jsonl"))
  assert.ok(rolled, "基文件满后应滚到 .1")
  const lines = readFileSync(path.join(dir, rolled), 'utf8').trim().split('\n')
  assert.ok(lines.length >= 3, "LOG-START + 2 条应续写在同一块里，而不是一条一个文件")
  rmSync(dir, { recursive: true, force: true })
  ok("轮转：按候选文件大小续写，不碎成一条一文件（块内 " + lines.length + " 行）")
}

// ---- v0.1.3：空 message 拒绝 ----
{
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-eventlog-empty-"))
  const h = host(dir)
  const empty = await h.defs.get('log_write').execute({ message: '   ' })
  assert.equal(empty.ok, false, "空事件必须拒绝")
  const st = await h.defs.get('log_status').execute({})
  assert.notEqual(st.lastError, "", "拒绝原因要进 lastError")
  rmSync(dir, { recursive: true, force: true })
  ok("log_write：空 message 拒绝，且 lastError 有原因")
}

// ---- v0.1.3：显式成功不误报 ----
{
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-eventlog-ok-"))
  const h = host(dir)
  const capture = h.handlers.find((item) => item.name === "session/event")
  capture.handler({ header: { id: 's' } }, { type: 'tool/call', data: { callId: 'c9', name: 'read' } })
  capture.handler(
    { header: { id: 's' } },
    { type: 'tool/result', data: { message: { isError: false, toolCallId: 'c9' }, error: { name: 'NotFatal' } } },
  )
  const errs = await h.defs.get('log_query').execute({ code: 'TOOL-ERROR' })
  assert.equal(errs.matched, 0, "isError:false 时不得记 TOOL-ERROR")
  rmSync(dir, { recursive: true, force: true })
  ok("自动捕获：显式 isError:false 且带 error 字段时不误报")
}

console.log(`eventlog: ${passed} 项通过`)
