/**
 * dsh-staleness-watch 行为测试。
 *
 * 它没有导出内部函数，但 apply 会把自己的两个挂载点交给 ctx，所以可以
 * mock 一个 ctx 拿到 guard 与 post-execute 回调，直接喂事件测真实拦截逻辑。
 */
import assert from 'node:assert/strict'
import { makeMockContext, runSmoke } from '../plugin-smoke.mjs'

let passed = 0
const ok = (label, extra = '') => {
  passed += 1
  console.log(`  ✓ ${label}${extra ? `  ${extra}` : ''}`)
}

// 1) 结构合规 + apply 能挂载
await runSmoke('dsh-staleness-watch')
ok('结构合规、apply 可挂载')

const mod = await import('../../dsh-staleness-watch/index.js')

/** 装一个 mode=block、阈值 3 的实例，返回 { guard, post }。 */
function mount(limit = 3) {
  const { ctx, guards, listeners } = makeMockContext()
  mod.apply(ctx, { mode: 'block', maxBlindActions: limit })
  const guard = guards[0]
  const postEntry = listeners.find((entry) => entry.name === 'tools/post-execute')
  return { guard, post: postEntry?.handler }
}

const click = (pid, windowId = 1) => ({ name: 'click', arguments: { pid, window_id: windowId } })
const snapshot = (pid, windowId = 1) => ({ name: 'get_window_state', arguments: { pid, window_id: windowId } })
const accept = async () => ({ kind: 'accept' })

// 2) 阈值内不拦
{
  const { guard, post } = mount(3)
  assert.ok(typeof post === 'function', '应注册 tools/post-execute')
  for (let i = 0; i < 3; i += 1) await post(click(100), {}, accept)
  ok('连续 3 次输入后仍放行（阈值 3）')
}

// 3) 超过阈值即拦截
{
  const { guard, post } = mount(3)
  for (let i = 0; i < 4; i += 1) await post(click(100), {}, accept)
  const blocked = guard(click(100))
  assert.equal(typeof blocked, 'string', '超过阈值后 guard 应返回拦截文案')
  assert.match(blocked, /拦截/)
  assert.match(blocked, /get_window_state/, '拦截文案应给出下一步动作')
  ok('连续 4 次输入后被拦截', '且提示先取快照')
}

// 4) 重新观察后计数归零
{
  const { guard, post } = mount(3)
  for (let i = 0; i < 4; i += 1) await post(click(100), {}, accept)
  await post(snapshot(100), {}, accept) // 重新观察
  assert.equal(guard(click(100)), undefined, '取过快照后应恢复放行')
  ok('重新观察后计数归零')
}

// 5) 不同目标独立计数
{
  const { guard, post } = mount(3)
  for (let i = 0; i < 4; i += 1) await post(click(100), {}, accept)
  assert.equal(guard(click(200)), undefined, '另一个 pid 不应被牵连')
  ok('不同 pid 独立计数')
}

// 6) mode=warn 时永不拦截
{
  const { ctx, guards } = makeMockContext()
  mod.apply(ctx, { mode: 'warn' })
  const warnGuard = guards[0]
  // warn 模式下 guard 直接返回 undefined
  assert.equal(warnGuard(click(300)), undefined)
  ok('mode=warn 时不拦截')
}

console.log(`\nstaleness-watch: ${passed} 项通过`)
