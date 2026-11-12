import assert from 'node:assert/strict'
import { curationDecision, eliminationSignal, evictionAnchor, evictionWindowDays, effectiveImportance } from '../../dsh-memory/index.js'

// v4.16（P0-2）淘汰判据单测：入口从「staleAfter」改为「锚点 vs 动态窗口」。
// 背景：2026-11-12 实测 106 条里 67 条没有 staleAfter，旧判据让它们永久 notDue（archived=0）。
// 这些用例钉住：无 staleAfter 的旧条目必须进候选；受保护/高价值/窗口内必须不动。

let passed = 0
const ok = (label) => { passed += 1; console.log(`  ✓ ${label}`) }

const today = '2026-11-12'
const now = Date.parse('2026-11-12T12:00:00')
const daysAgo = (n) => new Date(now - n * 86400000).toISOString()

// ---- 1. 窗口函数：按 kind 决定能不能被时间淘汰 ----
{
  assert.equal(evictionWindowDays({ kind: 'fact' }), 90)
  assert.equal(evictionWindowDays({ kind: 'note' }), 30)
  assert.equal(evictionWindowDays({ kind: 'reference' }), 180)
  assert.equal(evictionWindowDays({ kind: 'rule' }), null, 'rule 永不自动淘汰')
  assert.equal(evictionWindowDays({ kind: 'fact', pinned: true }), null, 'pinned 永不自动淘汰')
  assert.equal(evictionWindowDays({ kind: 'fact', slot: 'identity' }), null, '身份槽永不自动淘汰')
  assert.equal(evictionWindowDays({ kind: 'fact', status: 'draft' }), null, 'draft 走 consolidate 不走淘汰')
  assert.equal(evictionWindowDays({ kind: 'fact', text: '见 vault://30-Build/x.md#1' }), null, 'vault 指针保护（断链要人工）')
  assert.equal(evictionWindowDays({ kind: 'procedure' }), null, 'procedure 不在窗口表 = 不淘汰')
  ok('窗口函数：fact/note/reference 有窗口；rule/pinned/identity/draft/vault 一律 null')
}

// ---- 2. 锚点：lastUsedAt > updatedAt > addedAt，坏时间戳返回 NaN ----
{
  assert.equal(evictionAnchor({ lastUsedAt: daysAgo(3), updatedAt: daysAgo(10) }), Date.parse(daysAgo(3)))
  assert.equal(evictionAnchor({ updatedAt: daysAgo(10), addedAt: daysAgo(20) }), Date.parse(daysAgo(10)))
  assert.ok(Number.isNaN(evictionAnchor({})))
  ok('锚点：优先 lastUsedAt，回退 updatedAt/addedAt；无时间戳 = NaN（不动）')
}

// ---- 3. 核心：无 staleAfter 的旧条目必须进候选（旧判据的漏判） ----
{
  const oldFact = { id: 'f1', kind: 'fact', text: 'x', usedCount: 0, addedAt: daysAgo(100), updatedAt: daysAgo(100) }
  const d = curationDecision(oldFact, today, now)
  assert.equal(d.archive, true, '100 天没动过的 fact 必须进候选——旧代码这里漏判')
  assert.ok(d.reason.includes('age'), '理由必须带 age，能解释为什么归档')

  const youngFact = { id: 'f2', kind: 'fact', text: 'x', usedCount: 0, addedAt: daysAgo(10), updatedAt: daysAgo(10) }
  const d2 = curationDecision(youngFact, today, now)
  assert.equal(d2.archive, false, '10 天的 fact 在 90 天窗口内，不动')
  assert.ok(d2.reason.startsWith('window '), '窗口未到的理由必须可识别（维护循环按它计 window）')

  const oldNote = { id: 'n1', kind: 'note', text: 'x', usedCount: 0, updatedAt: daysAgo(40) }
  assert.equal(curationDecision(oldNote, today, now).archive, true, '40 天的 note 超过 30 天窗口')

  const oldRef = { id: 'r1', kind: 'reference', text: 'x', usedCount: 0, updatedAt: daysAgo(100) }
  assert.equal(curationDecision(oldRef, today, now).archive, false, 'reference 窗口 180 天，100 天不动')
  ok('核心：无 staleAfter 的旧事实进候选；窗口内不动；note/reference 各按自己的窗口')
}

// ---- 4. 护栏：受保护 / 高价值 / 仍在用 / 最近动过，一律不动 ----
{
  const old = daysAgo(200)
  const base = { kind: 'fact', text: 'x', updatedAt: old }
  assert.equal(curationDecision({ ...base, usedCount: 3 }, today, now).archive, false, 'usedCount≥3 保护')
  assert.ok(curationDecision({ ...base, usedCount: 3 }, today, now).reason.includes('usedCount'))
  assert.equal(curationDecision({ ...base, usedCount: 0, importance: 9 }, today, now).archive, false, 'importance≥8 保护')
  assert.ok(curationDecision({ ...base, usedCount: 0, importance: 9 }, today, now).reason.includes('importance'))
  assert.equal(curationDecision({ ...base, usedCount: 0, updatedAt: daysAgo(3) }, today, now).archive, false, '最近 7 天动过保护')
  assert.equal(curationDecision({ kind: 'rule', text: 'x', updatedAt: old }, today, now).archive, false, 'rule 永不淘汰')
  assert.equal(curationDecision({ kind: 'fact', text: 'vault://a.md', updatedAt: old }, today, now).archive, false, 'vault 指针保护')
  assert.equal(curationDecision({ kind: 'fact', text: 'x' }, today, now).archive, false, '无时间戳 = 无法证明年龄，不动')
  ok('护栏：usedCount/importance/最近更新/rule/vault 指针/无时间戳 —— 全部不动且理由可读')
}

// ---- 5. stale 语义不回归（v4.4 行为保持） ----
{
  const staleLong = { id: 's1', kind: 'fact', text: 'x', staleAfter: '2026-01-01', updatedAt: daysAgo(60) }
  assert.equal(curationDecision(staleLong, today, now).archive, true, 'stale 到期 + 60 天未动 → 归档（原行为）')
  const staleRecent = { id: 's2', kind: 'fact', text: 'x', staleAfter: '2026-01-01', lastUsedAt: daysAgo(5) }
  assert.equal(curationDecision(staleRecent, today, now).archive, false, 'stale 到期但 5 天内用过 → 活跃豁免（原行为）')
  assert.equal(eliminationSignal({ id: 'e1', text: 'x', staleAfter: '2026-01-01' }, today).rank, 0, 'stale 仍是 rank 0')
  ok('stale 语义不回归：到期+宽限外归档、宽限内豁免、eliminationSignal 排序不变')
}

// ---- 6. 有效重要度参与护栏（衰减后的高 importance 仍可保护） ----
{
  const decayed = { kind: 'fact', text: 'x', updatedAt: daysAgo(400), importance: 9, usedCount: 0 }
  assert.ok(effectiveImportance(decayed, now) > 0)
  assert.equal(curationDecision(decayed, today, now).archive, false, 'importance 9 即使衰减也高于护栏')
  ok('有效重要度：importance 参与护栏判断（不是只看静态字段）')
}

console.log(`\nmemory-eviction-v416: ${passed} 组断言通过`)