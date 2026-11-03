/**
 * dsh-harvest 工作区审计测试：node tests/workspace.test.mjs
 * 覆盖：账本 vs 磁盘（引用缺失/未登记会话）、harvest 覆盖、归档计数、账本缺失。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { workspaceStatus } from '../lib/workspace.js'

const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-harvest-ws-'))
const sessionsRoot = path.join(root, 'sessions')
const storeDir = path.join(root, 'store')
const idA = 'session-aaaaaaaa-1111-1111-1111-111111111111'
const idB = 'session-bbbbbbbb-2222-2222-2222-222222222222'
const idC = 'session-cccccccc-3333-3333-3333-333333333333'
const idMissing = 'session-dddddddd-4444-4444-4444-444444444444'
const idOrphan = 'session-eeeeeeee-5555-5555-5555-555555555555'

for (const id of [idA, idB, idC, idOrphan]) {
  const dir = path.join(sessionsRoot, '--ws--', id)
  mkdirSync(dir, { recursive: true })
  const body = [
    { type: 'session', id: id, cwd: 'D:\\AI-date\\demo', createdAt: 1000 },
    { type: 'user/message', seq: 1, time: 1100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '以后都用 pnpm。' }] } },
  ].map((item) => JSON.stringify(item)).join('\n') + '\n'
  writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(body)))
}
mkdirSync(storeDir, { recursive: true })
writeFileSync(path.join(storeDir, 'state.json'), JSON.stringify({ version: 1, sessions: { [idA]: { mtime: 1 }, [idC]: { mtime: 1 } } }))
const workspaceFile = path.join(root, 'workspace.json')
writeFileSync(workspaceFile, JSON.stringify({
  global: { archivedSessionIds: [idC] },
  tables: {
    workspaces: {
      'w-1': { path: 'D:\\AI-date\\demo', title: 'demo', sessionIds: [idA, idB, idMissing] },
      'w-2': { path: 'D:\\AI-date\\other', title: 'other', sessionIds: [idC] },
    },
  },
}))

const result = workspaceStatus({ workspaceFile: workspaceFile, storeDir: storeDir, sessionsRoot: sessionsRoot })
assert.equal(result.ready, true)
assert.equal(result.totals.workspaces, 2)
assert.equal(result.totals.onDisk, 4)
assert.equal(result.totals.missing, 1)
assert.equal(result.totals.orphans, 1)
assert.equal(result.totals.archived, 1)
const demo = result.workspaces.find((item) => item.title === 'demo')
assert.equal(demo.sessions, 3)
assert.equal(demo.present, 2)
assert.equal(demo.missing, 1)
assert.equal(demo.harvested, 1)
assert.equal(result.drift.missingByWorkspace.demo.length, 1)
assert.equal(result.drift.orphanSessions.includes(idOrphan), true)
assert.equal(result.drift.orphanSessions.includes(idA), false)
console.log('ok 1 workspace drift')

// 账本缺失：fail-safe，不抛
const missing = workspaceStatus({ workspaceFile: path.join(root, 'nope.json'), storeDir: storeDir, sessionsRoot: sessionsRoot })
assert.equal(missing.ready, false)
assert.equal(missing.workspaces.length, 0)
console.log('ok 2 missing ledger')

rmSync(root, { recursive: true, force: true })
console.log('ALL WORKSPACE TESTS PASSED')
