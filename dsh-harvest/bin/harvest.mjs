#!/usr/bin/env node
/**
 * dsh-harvest CLI v0.1.0 — 开发与验收用；与插件共用 lib/core.js。
 *
 * 用法：
 *   node bin/harvest.mjs --status
 *   node bin/harvest.mjs --all
 *   node bin/harvest.mjs --workspace D:\AI-date\dsh-date\dsh-亲爱的管家
 *   node bin/harvest.mjs --session <会话id> --redo
 *   node bin/harvest.mjs --gate <会话id1,会话id2>
 */
import { gate, scan, status } from '../lib/core.js'

const argv = process.argv.slice(2)

function valueOf(flag) {
  const index = argv.indexOf(flag)
  if (index < 0) return ''
  const next = argv[index + 1]
  if (!next || next.startsWith('--')) return ''
  return next
}

const options = {}
const storeDir = valueOf('--store')
const sessionsRoot = valueOf('--root')
if (storeDir !== '') options.storeDir = storeDir
if (sessionsRoot !== '') options.sessionsRoot = sessionsRoot

if (argv.includes('--status')) {
  console.log(JSON.stringify(status(options), null, 2))
  process.exit(0)
}

if (argv.includes('--gate')) {
  const raw = valueOf('--gate')
  const ids = raw.split(',').map((item) => item.trim()).filter((item) => item !== '')
  console.log(JSON.stringify(gate(Object.assign({}, options, { sessionIds: ids })), null, 2))
  process.exit(0)
}

const result = scan(Object.assign({}, options, {
  workspace: valueOf('--workspace'),
  sessionId: valueOf('--session'),
  limit: Number(valueOf('--limit')) || 0,
  redo: argv.includes('--redo'),
}))

console.log(JSON.stringify({
  ok: result.ok,
  scanned: result.scanned,
  skipped: result.skipped,
  candidatesAdded: result.candidatesAdded,
  episodesAdded: result.episodesAdded,
  pendingTotal: result.pendingTotal,
  errors: result.errors,
  samples: result.samples.map((item) => ({
    type: item.type,
    text: item.text,
    session: item.evidence.session,
    seq: item.evidence.seq,
  })),
}, null, 2))
