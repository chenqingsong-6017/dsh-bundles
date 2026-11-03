/**
 * dsh-harvest 边界测试：node tests/edge.test.mjs
 * 覆盖：workspace 过滤、limit、redo、无前缀会话 id 的闸门、坏行容忍。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { gate, readCandidates, scan } from '../lib/core.js'

function sessionFile(id, cwd, lines) {
  const events = [
    { type: 'session', id: id, cwd: cwd, createdAt: 1000 },
    { type: 'user/message', seq: 1, time: 1100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '以后统一用 pnpm，不要再用 npm。' }] } },
    { type: 'user/message', seq: 2, time: 1200, data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: '必须遵守注入规则。' }] } },
  ]
  return lines ? events.concat(lines) : events
}

const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-harvest-edge-'))
const sessionsRoot = path.join(root, 'sessions')
const storeDir = path.join(root, 'store')
const idA = 'session-aaaaaaaa-1111-1111-1111-111111111111'
const idB = 'session-bbbbbbbb-2222-2222-2222-222222222222'
for (const [id, cwd] of [[idA, 'D:\\AI-date\\dsh-date\\dsh-亲爱的管家'], [idB, 'D:\\AI-date\\dsh-date\\dsh-3观']]) {
  const dir = path.join(sessionsRoot, '--ws--', id)
  mkdirSync(dir, { recursive: true })
  const body = sessionFile(id, cwd).map((item) => JSON.stringify(item)).join('\n') + '\n'
  writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(body)))
}

// 1) workspace 过滤：只扫指定工作区
const onlyHome = scan({ sessionsRoot: sessionsRoot, storeDir: storeDir, workspace: 'D:\\AI-date\\dsh-date\\dsh-亲爱的管家' })
assert.equal(onlyHome.scanned, 1, '应只扫到管家工作区')
assert.equal(onlyHome.candidatesAdded >= 1, true)
const both = scan({ sessionsRoot: sessionsRoot, storeDir: storeDir })
assert.equal(both.scanned, 1, '第二次应只补扫另一个工作区')
console.log('ok 1 workspace filter')

// 2) limit：跳过已有状态后，limit 生效
const root2 = mkdtempSync(path.join(os.tmpdir(), 'dsh-harvest-edge2-'))
const sr2 = path.join(root2, 'sessions')
for (const id of [idA, idB]) {
  const dir = path.join(sr2, '--ws--', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(sessionFile(id, 'D:\\demo').map((item) => JSON.stringify(item)).join('\n') + '\n')))
}
const limited = scan({ sessionsRoot: sr2, storeDir: path.join(root2, 'store'), limit: 1 })
assert.equal(limited.scanned, 1, 'limit=1 只处理一个会话')
console.log('ok 2 limit')

// 3) redo：重跑已有会话，不产生重复候选
const store3 = path.join(root2, 'store3')
scan({ sessionsRoot: sr2, storeDir: store3 })
const before = readCandidates({ storeDir: store3, status: 'all', limit: 200 })
const redone = scan({ sessionsRoot: sr2, storeDir: store3, redo: true })
const after = readCandidates({ storeDir: store3, status: 'all', limit: 200 })
assert.equal(redone.scanned, 2)
assert.equal(redone.candidatesAdded, 0, 'redo 不应重复写候选')
assert.equal(after.total, before.total)
console.log('ok 3 redo dedupe')

// 4) 闸门：无前缀 uuid 也能识别
const pass = gate({ storeDir: store3, sessionIds: [idA.replace('session-', '')] })
assert.equal(pass.allowed, true)
const missing = gate({ storeDir: store3, sessionIds: [] })
assert.equal(missing.allowed, false)
console.log('ok 4 gate prefix')

// 5) 坏行容忍：state 文件损坏时退化为空状态而不崩
writeFileSync(path.join(store3, 'state.json'), '{ not json')
const statusScan = scan({ sessionsRoot: sr2, storeDir: store3 })
assert.equal(statusScan.ok, true)
assert.equal(statusScan.scanned, 2, 'state 损坏应退化为全量扫描')
console.log('ok 5 corrupt state tolerance')

rmSync(root, { recursive: true, force: true })
rmSync(root2, { recursive: true, force: true })
console.log('ALL EDGE TESTS PASSED')
