/**
 * dsh-harvest 自检 v0.1.0：node tests/harvest.test.mjs
 * 覆盖：抽取规则、相似度去重、scan 幂等、删除闸门。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { extractSession, gate, scan, similarity } from '../lib/core.js'

const SESSION_ID = 'session-11111111-1111-1111-1111-111111111111'

// 1) 抽取：规则/纠正/偏好命中，问句不收，证据齐全
const events = [
  { type: 'session', id: SESSION_ID, cwd: 'D:\\AI-date\\demo', createdAt: 1000 },
  { type: 'session/title', data: { title: '测试会话' }, time: 1050 },
  { type: 'turn/start', time: 1100 },
  { type: 'user/message', seq: 3, time: 1200, data: { content: [{ type: 'text', text: '以后所有 Python 都用 uv 装依赖。这个对吗？' }] } },
  { type: 'user/message', seq: 4, time: 1300, data: { content: [{ type: 'text', text: '不对，别再用 pip 了，必须统一用 uv。' }] } },
  { type: 'deliverables/presented', time: 1400, data: { files: [{ path: 'D:\\AI-date\\demo\\out.md' }] } },
  { type: 'user/message', seq: 5, time: 1500, data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: '必须遵守注入的 AGENTS 规则，不许违反。' }] } },
  { type: 'user/message', seq: 6, time: 1600, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我每次开发dsh有没有生成的垃圾' }] } },
]
const session = { meta: { id: SESSION_ID, cwd: 'D:\\AI-date\\demo', createdAt: 1000 }, events }
const extracted = extractSession(session)
assert.equal(extracted.episode.title, '测试会话')
assert.equal(extracted.episode.turns, 1)
assert.equal(extracted.episode.userMsgs, 3)
assert.equal(extracted.episode.deliverables.length, 1)
assert.equal(extracted.candidates.length >= 2, true, '应抽到至少 2 条候选')
assert.equal(extracted.candidates.some((item) => item.type === 'rule'), true, '应识别出规则')
assert.equal(extracted.candidates.every((item) => item.evidence.session === SESSION_ID), true, '证据必须带会话')
assert.equal(extracted.candidates.some((item) => item.text.includes('这个对吗')), false, '问句不收')
assert.equal(extracted.candidates.some((item) => item.text.includes('注入的 AGENTS')), false, '注入内容不收')
assert.equal(extracted.candidates.some((item) => item.text.includes('有没有生成的垃圾')), false, '无问号问句不收')
console.log('ok 1 extraction')

// 2) 相似度
assert.equal(similarity('以后都用 uv 装依赖', '以后都用 uv 装依赖！') > 0.9, true)
assert.equal(similarity('以后都用 uv', '今天天气不错') < 0.2, true)
console.log('ok 2 similarity')

// 3) scan 幂等 + gate 闸门
const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-harvest-test-'))
const sessionsRoot = path.join(root, 'sessions')
const sessionDir = path.join(sessionsRoot, '--demo--', SESSION_ID)
mkdirSync(sessionDir, { recursive: true })
const body = events.map((item) => JSON.stringify(item)).join('\n') + '\n'
writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(body)))
const storeDir = path.join(root, 'store')
const first = scan({ sessionsRoot: sessionsRoot, storeDir: storeDir })
assert.equal(first.scanned, 1)
assert.equal(first.candidatesAdded >= 2, true)
const second = scan({ sessionsRoot: sessionsRoot, storeDir: storeDir })
assert.equal(second.skipped, 1)
assert.equal(second.candidatesAdded, 0)
const pass = gate({ storeDir: storeDir, sessionIds: [SESSION_ID] })
assert.equal(pass.allowed, true)
const blocked = gate({ storeDir: storeDir, sessionIds: ['session-22222222-2222-2222-2222-222222222222'] })
assert.equal(blocked.allowed, false)
assert.equal(blocked.missing.length, 1)
console.log('ok 3 scan/gate')
rmSync(root, { recursive: true, force: true })
console.log('ALL TESTS PASSED')
