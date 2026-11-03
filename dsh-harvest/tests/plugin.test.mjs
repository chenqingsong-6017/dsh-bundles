/**
 * dsh-harvest 插件层集成测试：node tests/plugin.test.mjs
 * 用 mock ctx 注册工具，再真执行四个工具，验证插件层（不是只测 core）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { apply } from '../index.js'

const SESSION_ID = 'session-33333333-3333-3333-3333-333333333333'
const EVENTS = [
  { type: 'session', id: SESSION_ID, cwd: 'D:\\AI-date\\demo', createdAt: 1000 },
  { type: 'session/title', data: { title: '插件层测试' }, time: 1050 },
  { type: 'turn/start', time: 1100 },
  { type: 'user/message', seq: 2, time: 1200, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '以后统一用 pnpm，不要再用 npm。' }] } },
  { type: 'user/message', seq: 3, time: 1300, data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: '必须遵守注入规则。' }] } },
  { type: 'user/message', seq: 4, time: 1400, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这不对，必须改成 pnpm。' }] } },
]

const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-harvest-plugin-'))
const sessionsRoot = path.join(root, 'sessions')
const sessionDir = path.join(sessionsRoot, '--demo--', SESSION_ID)
mkdirSync(sessionDir, { recursive: true })
writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(EVENTS.map((item) => JSON.stringify(item)).join('\n') + '\n')))
const storeDir = path.join(root, 'store')

const tools = new Map()
const fakeCtx = {
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return { dispose() {} }
    },
  },
  effect(fn) {
    const value = fn()
    return typeof value === 'function' ? value : () => {}
  },
}

apply(fakeCtx, { storeDir: storeDir, sessionsRoot: sessionsRoot })

// 1) 四个工具都注册了，描述与 schema 齐全
const names = [...tools.keys()].sort()
assert.deepEqual(names, ['harvest_candidates', 'harvest_gate', 'harvest_run', 'harvest_status'])
for (const name of names) {
  const tool = tools.get(name)
  assert.equal(typeof tool.description, 'string')
  assert.equal(tool.description.length > 10, true, name + ' 缺少有效描述')
  assert.equal(typeof tool.parameters, 'object')
  assert.equal(typeof tool.output.schema, 'object')
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output.render, 'function')
}
console.log('ok 1 tools registered')

// 2) status 就绪
const statusResult = await tools.get('harvest_status').execute({})
assert.equal(statusResult.ready, true)
assert.equal(statusResult.sessionFiles, 1)
console.log('ok 2 status ready')

// 3) run 抽到候选；注入消息不收
const runResult = await tools.get('harvest_run').execute({})
assert.equal(runResult.ok, true)
assert.equal(runResult.scanned, 1)
assert.equal(runResult.candidatesAdded >= 2, true)
assert.equal(runResult.samples.some((item) => item.text.includes('注入规则')), false)
console.log('ok 3 run harvested')

// 4) candidates 带证据
const candidateResult = await tools.get('harvest_candidates').execute({ status: 'all', limit: 50 })
assert.equal(candidateResult.matched >= 2, true)
assert.equal(candidateResult.items.every((item) => item.session === SESSION_ID), true)
assert.equal(candidateResult.items.every((item) => typeof item.seq === 'number' && item.seq > 0), true)
console.log('ok 4 candidates with evidence')

// 5) gate：覆盖放行、未覆盖拒绝
const pass = await tools.get('harvest_gate').execute({ sessions: [SESSION_ID] })
assert.equal(pass.allowed, true)
const blocked = await tools.get('harvest_gate').execute({ sessions: ['session-44444444-4444-4444-4444-444444444444'] })
assert.equal(blocked.allowed, false)
assert.equal(blocked.missing.length, 1)
console.log('ok 5 gate')

// 6) 幂等
const again = await tools.get('harvest_run').execute({})
assert.equal(again.skipped, 1)
assert.equal(again.candidatesAdded, 0)
console.log('ok 6 idempotent')

// 7) render 不炸
for (const name of names) {
  const tool = tools.get(name)
  const result = name === 'harvest_status' ? statusResult : name === 'harvest_run' ? runResult : name === 'harvest_candidates' ? candidateResult : pass
  assert.equal(Array.isArray(tool.output.render({}, result)), true)
}
console.log('ok 7 render')

rmSync(root, { recursive: true, force: true })
console.log('ALL PLUGIN TESTS PASSED')
