import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as mod from '../../dsh-skill-usage/index.js'
import { makeMockContext } from '../plugin-smoke.mjs'

const { classifyUsage, normalizeSkillKey, resolveSkillName, decideCuration } = mod

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

// Curator 自动归档判据（纯函数）：只动账本、只在自己看得准的时候动手
const seenNow = ago(0)
assert.equal(decideCuration({ uses: 1, firstSeenAt: ago(90), lastUsedAt: ago(40), catalogSeenAt: seenNow }, now, thresholds, seenNow).reason, 'unused-30d')
ok('curator：目录内 40 天没用 → 归档（unused-30d）')
assert.equal(decideCuration({ uses: 1, firstSeenAt: ago(90), lastUsedAt: ago(40), catalogSeenAt: ago(3) }, now, thresholds, seenNow).reason, 'not-in-catalog')
ok('curator：本次目录里没看见（上次是 3 天前）→ 归档（not-in-catalog）')
assert.equal(decideCuration({ uses: 1, firstSeenAt: ago(90), lastUsedAt: ago(40), catalogSeenAt: seenNow }, now, thresholds, null).action, 'none')
ok('curator：目录名单不可信（catalogAt 缺失）→ 不归档，宁可漏不误伤')
assert.equal(decideCuration({ uses: 1, firstSeenAt: ago(90), lastUsedAt: ago(20), catalogSeenAt: seenNow }, now, thresholds, seenNow).action, 'none')
ok('curator：20 天没用（未到 30）→ 不归档')
assert.equal(decideCuration({ uses: 1, lastUsedAt: ago(40), catalogSeenAt: seenNow, archivedAt: ago(1) }, now, thresholds, seenNow).action, 'none')
ok('curator：已归档条目不再重复处理')
assert.equal(classifyUsage({ uses: 1, firstSeenAt: ago(90), lastUsedAt: ago(40), reviewedAt: ago(20) }, now, thresholds).state, 'stale')
ok('复核过期后回到陈旧')
assert.equal(classifyUsage({ uses: 0 }, now, thresholds).state, 'unknown')
ok('无任何时间锚点 = unknown')

// ── #43：firstSeenAt 不冒充 lastUsed，不参与 stale/archive 阈值 ──
{
  const neverUsedOld = classifyUsage({ uses: 0, firstSeenAt: ago(60) }, now, thresholds)
  assert.equal(neverUsedOld.state, 'new', '登记 60 天但从未用过：仍是 new，不是 archive-candidate')
  assert.equal(neverUsedOld.days, null, '从未用过时 days 必须为 null（不参与阈值排序）')
  assert.equal(neverUsedOld.firstSeenDays, 60, 'firstSeenDays 只作旁注')
  ok('从未用过 + 登记 60 天 = new（firstSeenAt 不再冒充 lastUsed）')

  const usedNoAnchor = classifyUsage({ uses: 3, firstSeenAt: ago(60) }, now, thresholds)
  assert.equal(usedNoAnchor.state, 'unknown', '用过但存档缺 lastUsedAt：不猜时间，也不进 attention')
  ok('用过但缺 lastUsedAt = unknown（不拿登记时间凑数）')

  // 旁注不改变「真用过」的判定：30 天没用仍是 archive-candidate
  assert.equal(classifyUsage({ uses: 1, firstSeenAt: ago(5), lastUsedAt: ago(31) }, now, thresholds).state, 'archive-candidate')
  ok('真用过且 31 天没动 = archive-candidate（旁注不干扰）')
}

// ── #44：名字归一化（trim + 大小写折叠）──
{
  assert.equal(normalizeSkillKey('  DSH-Memory '), 'dsh-memory')
  assert.equal(resolveSkillName('  Alpha ', ['alpha', 'Beta']), 'alpha', '折叠后仍要返回账本里的规范名')
  assert.equal(resolveSkillName('ALPHA', ['alpha']), 'alpha')
  assert.equal(resolveSkillName('Beta', ['alpha', 'Beta']), 'Beta', '精确匹配优先，保留原大小写')
  assert.equal(resolveSkillName('missing', ['alpha']), '')
  assert.equal(resolveSkillName('   ', ['alpha']), '')
  ok('resolveSkillName：先精确、再大小写/空白折叠，找不到返回空串')

  // 端到端：账本里已有历史技能（Alpha 40 天前用过；Gamma 60 天前首扫、从未用过）+ 名字带空白/大小写差异
  const storeDir = mkdtempSync(path.join(os.tmpdir(), 'skill-usage-test-'))
  writeFileSync(
    path.join(storeDir, 'usage.json'),
    JSON.stringify({
      version: 1,
      skills: {
        Alpha: { uses: 2, firstSeenAt: new Date(Date.now() - 90 * DAY).toISOString(), lastUsedAt: new Date(Date.now() - 40 * DAY).toISOString() },
        Gamma: { uses: 0, firstSeenAt: new Date(Date.now() - 60 * DAY).toISOString() },
      },
    }),
    'utf8',
  )
  const { ctx, registered } = makeMockContext()
  ctx.skills = { list: async () => [{ name: 'Alpha' }, { name: 'Beta' }, { name: 'Gamma' }] }
  mod.apply(ctx, { storeDir })
  const toolOf = (name) => registered.find((tool) => tool.name === name)
  const usageTool = toolOf('skill_usage')
  const markTool = toolOf('skill_usage_mark')
  const restoreTool = toolOf('skill_usage_restore')
  assert.ok(usageTool && markTool && restoreTool, '应注册 skill_usage / skill_usage_mark / skill_usage_restore')

  const before = await usageTool.execute({})
  // 新语义（2026-11-05 Curator）：Alpha 40 天没用且仍在目录里 → 自动归档，默认列表不再显示；
  // Gamma 从未用过（new）不参与归档。
  assert.equal(before.counts.archived, 1, '目录内 40 天没用的 Alpha 应被 curator 自动归档')
  assert.equal(before.rows.find((row) => row.name === 'Alpha'), undefined, '默认列表不显示已归档条目')
  const gammaBefore = before.rows.find((row) => row.name === 'Gamma')
  assert.equal(gammaBefore.state, 'new', 'Gamma 登记 60 天、从未用过：仍报 new，不报 archive-candidate')
  assert.equal(gammaBefore.firstSeenDays, 60)
  assert.equal(before.counts.archiveCandidates, 0, '已归档的不再计入 attention')
  ok('curator 自动归档：目录内 40 天未用 → archived，默认列表隐藏')

  const archivedView = await usageTool.execute({ filter: 'archived' })
  const alphaArchived = archivedView.rows.find((row) => row.name === 'Alpha')
  assert.ok(alphaArchived, 'filter=archived 应能看到已归档条目')
  assert.equal(alphaArchived.archivedReason, 'unused-30d', '归档原因应写明阈值')
  ok('skill_usage filter=archived：归档条目可查，带归档原因')

  const restored = await restoreTool.execute({ name: '  alpha ' })
  assert.equal(restored.restored, true, 'restore 应命中并恢复 Alpha')
  ok('skill_usage_restore：归档条目可恢复（并刷新复核时间，避免立刻再归档）')

  const marked = await markTool.execute({ name: '  alpha ' })
  assert.equal(marked.name, 'Alpha', '带空白/小写输入应命中原名 Alpha')
  ok('skill_usage_mark 端到端：trim + 大小写折叠后标记成功')

  const after = await usageTool.execute({})
  assert.equal(after.rows.find((row) => row.name === 'Alpha').state, 'active', '复核后 Alpha 从 attention 摘掉')
  assert.equal(after.rows.find((row) => row.name === 'Gamma').state, 'new')
  await new Promise((resolve) => setTimeout(resolve, 250))
  rmSync(storeDir, { recursive: true, force: true })
}

console.log(`skill-usage: ${passed} 项通过`)
