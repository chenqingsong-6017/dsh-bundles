// dsh-memory v4.16 回归：memory_update 允许「只更新元数据」，不必重发正文。
//
// 为什么：工具自己的 aliasHint / missing-alias tip 就在推荐 `memory_update {id, aliases:[...]}`，
// 但 v4.2 的校验只放行 verifiedCount-only，形成「推荐的用法被自己的校验拒绝」。
// 30 天 metrics（tool-error-rate-baseline.json）里这是最高频错误签名（11 次）。
import assert from 'node:assert/strict'
import { makeTmp, sweepStaleDirs } from './_tmp-dirs.mjs'
import { apply } from '../../dsh-memory/index.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log('  ✓ ' + label)
}
const tmp = (tag) => makeTmp('dsh-memory-meta-' + tag)
sweepStaleDirs()

function host(dir) {
  const defs = new Map()
  const layers = []
  const ctx = {
    tools: { register: (definition) => { defs.set(definition.name, definition); return () => {} } },
    effect: (fn) => { fn(); return () => {} },
    on: () => () => {},
    get: () => undefined,
    systemPrompt: { context: (layer) => { layers.push(layer); return () => {} } },
  }
  apply(ctx, {
    storeDir: dir,
    maxInjectChars: 1500,
    maxBytes: 20000,
    captureCandidates: false,
    captureRuleFiles: false,
  })
  return { defs, layers }
}
const priming = (h) => h.layers[0].text({ agent: { session: {} } })

{
  const root = tmp('aliases')
  const h = host(root)
  priming(h)
  const add = await h.defs.get('memory_add').execute({ text: '测试用短事实：服务端口 1234。' })
  const id = add.entry.id
  assert.ok(id, '前置：memory_add 要能写入')

  // 1) 只传 aliases（本次要修的场景）
  const u1 = await h.defs.get('memory_update').execute({ id, aliases: ['端口', 'port'] })
  assert.deepEqual(u1.entry.aliases, ['端口', 'port'], 'aliases 要更新')
  assert.equal(u1.entry.text, '测试用短事实：服务端口 1234。', 'text 不能被清空')
  ok('只传 aliases 能更新，正文保持不变')

  // 2) 只传 pinned
  const u2 = await h.defs.get('memory_update').execute({ id, pinned: true })
  assert.equal(u2.entry.pinned, true, 'pinned 要更新')
  ok('只传 pinned 能更新')

  // 3) 只传 tags
  const u3 = await h.defs.get('memory_update').execute({ id, tags: ['t1', 't2'] })
  assert.deepEqual(u3.entry.tags, ['t1', 't2'], 'tags 要更新')
  ok('只传 tags 能更新')

  // 4) 只传 text（回归：原有路径不能被改坏）
  const u4 = await h.defs.get('memory_update').execute({ id, text: '换了正文：服务端口 5678。' })
  assert.equal(u4.entry.text, '换了正文：服务端口 5678。', 'text 要更新')
  ok('只传 text 仍可更新（回归）')

  // 5) 只传 id、什么都不给：必须仍然拒绝（防「手的滑了」把条目改空）
  await assert.rejects(
    () => h.defs.get('memory_update').execute({ id }),
    (err) => /MEMORY_ARG_MISSING|可更新字段|需要新的 text/.test(String(err?.message ?? err)),
    '只有 id 必须拒绝',
  )
  ok('只有 id 仍然拒绝（防误调用）')
}

console.log(`memory-meta-update: ${passed} 项通过`)
