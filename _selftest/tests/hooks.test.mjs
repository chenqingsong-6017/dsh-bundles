/**
 * dsh-hooks 行为测试。
 *
 * 纯函数部分直接断言；事件部分 mock 一个 ctx，把 tools/pre-execute 与
 * tools/post-execute 的回调取出来，喂假事件测真实决策（含真实子进程）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { makeMockContext, runSmoke } from '../plugin-smoke.mjs'
import * as mod from '../../dsh-hooks/index.js'

let passed = 0
const ok = (label, extra = '') => {
  passed += 1
  console.log(`  ✓ ${label}${extra ? `  ${extra}` : ''}`)
}

// 1) 结构合规 + apply 能挂载
await runSmoke('dsh-hooks')
ok('结构合规、apply 可挂载')

// 2) 事件名归一化（兼容 Claude Code 的叫法）
assert.equal(mod.normalizeEvent('tool.pre'), 'tool.pre')
assert.equal(mod.normalizeEvent('PreToolUse'), 'tool.pre')
assert.equal(mod.normalizeEvent('stop'), 'turn.stop')
assert.equal(mod.normalizeEvent(' nonsense '), '')
ok('事件别名归一化（PreToolUse → tool.pre，stop → turn.stop）')

// 3) 解析：合法配置
{
  const { hooks, errors } = mod.parseHooksConfig(
    JSON.stringify({
      hooks: [
        { event: 'tool.pre', match: '^(bash|pwsh)$', run: 'node check.mjs', name: 'guard-bash' },
        { event: 'postToolUse', run: 'echo hi', enabled: false, timeoutMs: 999999 },
      ],
    }),
  )
  assert.equal(errors.length, 0)
  assert.equal(hooks.length, 2)
  assert.equal(hooks[0].name, 'guard-bash')
  assert.equal(hooks[0].event, 'tool.pre')
  assert.equal(hooks[1].event, 'tool.post', 'postToolUse 应归一化')
  assert.equal(hooks[1].enabled, false)
  assert.equal(hooks[1].timeoutMs, 60000, 'timeoutMs 应被夹到上限')
  ok('解析合法配置（别名 / enabled / timeout 夹取）')
}

// 4) 解析：坏条目只丢自己，不整体失败
{
  const { hooks, errors } = mod.parseHooksConfig(
    JSON.stringify([
      { event: 'tool.pre', run: 'ok' },
      { event: 'not-an-event', run: 'x' },
      { event: 'tool.pre' },
      { event: 'tool.pre', run: 'x', match: '([' },
      'garbage',
    ]),
  )
  assert.equal(hooks.length, 1)
  assert.equal(errors.length, 4)
  assert.match(errors.join('\n'), /event 认不出/)
  assert.match(errors.join('\n'), /缺 run/)
  assert.match(errors.join('\n'), /不是合法正则/)
  ok('坏条目逐条报错、好条目仍生效', `(${errors.length} 处问题)`)
}

// 5) 解析：非 JSON
{
  const { hooks, errors } = mod.parseHooksConfig('{ not json')
  assert.equal(hooks.length, 0)
  assert.match(errors[0], /不是合法 JSON/)
  ok('非 JSON 不抛错，只报错')
}

// 6) 匹配
{
  const guard = { event: 'tool.pre', match: '^(bash|pwsh)$', enabled: true }
  const off = { event: 'tool.pre', match: '^(bash|pwsh)$', enabled: false }
  assert.equal(mod.matchHook(guard, 'tool.pre', 'pwsh'), true)
  assert.equal(mod.matchHook(guard, 'tool.pre', 'read'), false)
  assert.equal(mod.matchHook(guard, 'tool.post', 'pwsh'), false)
  assert.equal(mod.matchHook(off, 'tool.pre', 'pwsh'), false)
  assert.equal(mod.matchHook({ event: 'turn.stop', match: '' }, 'turn.stop', ''), true)
  ok('匹配规则（正则 / 事件 / 禁用）')
}

// 7) 决策翻译
{
  const okRun = (stdout, extra = {}) => mod.interpretHookResult({ code: 0, stdout, stderr: '', ...extra }, 'tool.pre', 'allow')
  assert.equal(okRun('').decision, 'allow')
  assert.equal(okRun('just text').message, 'just text')
  assert.equal(okRun('{"decision":"deny","reason":"不行"}').decision, 'deny')
  assert.equal(okRun('{"decision":"deny","reason":"不行"}').reason, '不行')
  assert.equal(okRun('{"decision":"ask","reason":"确认下"}').decision, 'ask')

  const exit2 = mod.interpretHookResult({ code: 2, stdout: '', stderr: '危险命令' }, 'tool.pre', 'allow')
  assert.equal(exit2.decision, 'deny')
  assert.match(exit2.reason, /危险命令/)

  const crash = mod.interpretHookResult({ code: 1, stdout: '', stderr: 'boom' }, 'tool.pre', 'allow')
  assert.equal(crash.decision, 'allow', 'onError=allow 时崩溃应放行')
  assert.equal(crash.ok, false)
  const crashDeny = mod.interpretHookResult({ code: 1, stdout: '', stderr: 'boom' }, 'tool.pre', 'deny')
  assert.equal(crashDeny.decision, 'deny', 'onError=deny 时崩溃应拒绝')

  const timeout = mod.interpretHookResult({ code: -1, timedOut: true }, 'tool.pre', 'deny')
  assert.equal(timeout.decision, 'deny')
  assert.match(timeout.reason, /超时/)
  ok('决策翻译（exit 0/2/1、超时、onError）')
}

// 8) 配置来源优先级
{
  const explicit = mod.candidateFiles('C:/work', 'C:/custom/hooks.json')
  assert.deepEqual(explicit, [path.resolve('C:/custom/hooks.json')], '显式指定后不应再读别的')

  const implicit = mod.candidateFiles('C:/work', '')
  assert.equal(implicit[0], path.join(path.resolve('C:/work'), '.dsh', 'hooks.json'), '工作区级应排第一')
  ok('配置来源优先级（显式 > 工作区 > 全局 > profile）')
}

// 8.5) 输出解码：UTF-8 直通，GBK 回退（Windows cmd 的真实坑）
{
  assert.equal(mod.decodeOutput(Buffer.from('hello', 'utf8')), 'hello')
  assert.equal(mod.decodeOutput(Buffer.from('中文', 'utf8')), '中文')
  // "中文" 的 GBK 编码：D6 D0 CE C4
  assert.equal(mod.decodeOutput(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])), '中文', 'GBK 字节应能回退解码')
  assert.equal(mod.decodeOutput(Buffer.alloc(0)), '')
  ok('输出解码（UTF-8 直通 / GBK 回退）')
}

// 9) 端到端：真实子进程 + 事件回调
function mountWith(file) {
  const { ctx, listeners } = makeMockContext()
  mod.apply(ctx, { file })
  const pre = listeners.find((entry) => entry.name === 'tools/pre-execute')?.handler
  const post = listeners.find((entry) => entry.name === 'tools/post-execute')?.handler
  return { pre, post }
}

{
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-hooks-test-'))
  try {
    const file = path.join(dir, 'hooks.json')
    writeFileSync(
      file,
      JSON.stringify({
        hooks: [
          { event: 'tool.pre', match: '^danger$', run: 'exit 2', name: 'deny-danger' },
          { event: 'tool.post', match: '^afterme$', run: 'echo hello-from-hook', name: 'note-after' },
        ],
      }),
      'utf8',
    )
    const { pre, post } = mountWith(file)

    const allow = async () => ({ kind: 'allow' })
    // 命中的危险工具 → deny，且理由可操作
    const denied = await pre({ name: 'danger', arguments: {}, agent: { id: '' } }, allow)
    assert.equal(denied.kind, 'deny')
    assert.match(denied.reason, /dsh-hooks 拦截/)
    assert.match(denied.reason, /enabled/, '拒绝理由要给下一步动作')

    // 未命中的工具 → 走 next()
    const passedThrough = await pre({ name: 'read', arguments: {}, agent: { id: '' } }, allow)
    assert.equal(passedThrough.kind, 'allow')

    // 后置钩子的 stdout 回灌为提示
    const noted = await post({ name: 'afterme', arguments: {}, agent: { id: '' } }, { content: [] }, async () => ({
      kind: 'accept',
      content: [],
    }))
    assert.equal(noted.kind, 'accept')
    assert.match(JSON.stringify(noted.content), /hello-from-hook/)
    ok('端到端：真实子进程 deny / 放行 / 后置回灌')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`\ndsh-hooks: ${passed} 项通过`)
