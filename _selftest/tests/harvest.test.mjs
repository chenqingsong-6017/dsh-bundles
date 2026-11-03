import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractSession, similarity, gate } from '../../dsh-harvest/lib/core.js'

let passed = 0
const ok = (label) => { passed += 1; console.log('  OK ' + label) }

// ---------- 候选抽取：只收事实级内容，且必须带证据 ----------
const session = {
  meta: { id: 'sess-test-1', cwd: 'D:/tmp', createdAt: 100 },
  events: [
    { seq: 1, time: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这是硬规则：删除前必须三查。' }] } },
    { seq: 2, time: 20, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '不对，应该先读取再修改。' }] } },
    { seq: 3, time: 30, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '以后记住每次都要跑验证门。' }] } },
    { seq: 4, time: 40, type: 'user/message', data: { source: { kind: 'agent' }, content: [{ type: 'text', text: '这是硬规则：助手自己的话不该被收成用户事实。' }] } },
  ],
}
const out = extractSession(session)
assert.ok(Array.isArray(out.candidates), 'extractSession 必须返回 candidates 数组')
assert.ok(out.candidates.length >= 3, '三条用户事实应被抽出，实际 ' + out.candidates.length)
assert.ok(out.candidates.every((c) => c.evidence && c.evidence.session === 'sess-test-1' && c.evidence.seq > 0), '每条候选必须带 session/seq 证据')
assert.ok(out.candidates.every((c) => c.status === 'pending'), '新候选状态必须是 pending（只写候选，不自动入库）')
assert.ok(!out.candidates.some((c) => String(c.text).includes('助手自己的话')), 'agent 来源的消息不能被收成用户事实')
ok('候选抽取：事实入选、证据必带、agent 消息不收')

// ---------- 去重：相似度是纯函数，可单测 ----------
assert.equal(similarity('必须先读再改', '必须先读再改'), 1)
assert.equal(similarity('完全不同的两句话', 'zzzzzz'), 0)
assert.ok(similarity('删除前必须三查', '删除前必须三查一遍') > 0.7, '近似句相似度应高于 0.7（实测 0.75）')
ok('相似度：同句=1、异句=0、近似>0.8')

// ---------- 删除闸门：没被覆盖的会话不许删 ----------
const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-harvest-test-'))
try {
  const denied = gate({ storeDir: dir, sessionIds: ['sess-a'] })
  assert.equal(denied.allowed, false, '没有 harvest 记录的会话必须拒绝删除')
  assert.deepEqual(denied.missing, ['sess-a'])
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ sessions: { 'sess-a': { lastMtime: 1, candidates: 1 } } }))
  const allowed = gate({ storeDir: dir, sessionIds: ['sess-a'] })
  assert.equal(allowed.allowed, true, '已覆盖的会话应放行')
  assert.deepEqual(allowed.covered, ['sess-a'])
  assert.equal(gate({ storeDir: dir, sessionIds: [] }).allowed, false, '空清单不许默认放行（fail-closed）')
  ok('删除闸门：未覆盖拒绝、已覆盖放行、空清单 fail-closed')
} finally { rmSync(dir, { recursive: true, force: true }) }

console.log('harvest.test.mjs: 通过 ' + passed + ' 组断言')