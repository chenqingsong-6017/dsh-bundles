import assert from 'node:assert/strict'
import { classifyUsage } from '../../dsh-skill-usage/index.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

const DAY = 24 * 60 * 60 * 1000
const now = Date.parse('2026-10-25T12:00:00.000Z')
const ago = (days) => new Date(now - days * DAY).toISOString()
const thresholds = { staleAfterDays: 14, archiveAfterDays: 30 }

assert.equal(classifyUsage({ uses: 1, firstSeenAt: ago(60), lastUsedAt: ago(1) }, now, thresholds).state, 'active')
ok('1 天前用过 = 常用')
assert.equal(classifyUsage({ uses: 1, firstSeenAt: ago(60), lastUsedAt: ago(20) }, now, thresholds).state, 'stale')
ok('20 天没用 = 陈旧')
assert.equal(classifyUsage({ uses: 1, firstSeenAt: ago(90), lastUsedAt: ago(35) }, now, thresholds).state, 'archive-candidate')
ok('35 天没用 = 建议归档')
assert.equal(classifyUsage({ uses: 0, firstSeenAt: ago(2) }, now, thresholds).state, 'new')
ok('登记 2 天且从未用过 = 新')
assert.equal(classifyUsage({ uses: 1, firstSeenAt: ago(90), lastUsedAt: ago(40), reviewedAt: ago(1) }, now, thresholds).state, 'active')
ok('刚复核过的旧技能 = 提醒已续期')
assert.equal(classifyUsage({ uses: 1, firstSeenAt: ago(90), lastUsedAt: ago(40), reviewedAt: ago(20) }, now, thresholds).state, 'stale')
ok('复核过期后回到陈旧')
assert.equal(classifyUsage({ uses: 0 }, now, thresholds).state, 'unknown')
ok('无任何时间锚点 = unknown')

console.log(`skill-usage: ${passed} 项通过`)
