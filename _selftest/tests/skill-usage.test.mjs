import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
assert.equal(decideCuration({ uses: 1, firstSeenAt: ago(90), lastUsedAt: ago(40), catalogSeenAt: seenNow }, now, thresholds, seenNow).reason, 'stale-30d')
ok('curator：目录内 40 天没用 → 归档（stale-30d，活动衰减非从未用过）')
assert.equal(decideCuration({ uses: 1, firstSeenAt: ago(90), lastUsedAt: ago(40), catalogSeenAt: seenNow }, now, thresholds, seenNow).reason, 'stale-30d')
ok('curator：单次没看见不算「没了」→ 仍按陈旧归档（stale-30d），不误判 not-in-catalog')
assert.equal(decideCuration({ uses: 1, lastUsedAt: ago(40), catalogSeenAt: seenNow, catalogMissCount: 2, lastCatalogMissAt: ago(10) }, now, thresholds, seenNow).reason, 'not-in-catalog')
ok('curator：连续缺席 2 次且最后一次满 7 天 → 才归档（not-in-catalog）')
assert.equal(decideCuration({ uses: 1, lastUsedAt: ago(40), catalogSeenAt: seenNow, catalogMissCount: 2, lastCatalogMissAt: ago(3) }, now, thresholds, seenNow).reason, 'stale-30d')
ok('curator：缺席刚满 2 次但未满 7 天 → 先按陈旧归档，不判「目录里没了」')
assert.equal(decideCuration({ uses: 1, lastUsedAt: ago(40), catalogSeenAt: seenNow, catalogMissCount: 1, lastCatalogMissAt: ago(30) }, now, thresholds, seenNow).reason, 'stale-30d')
ok('curator：只缺席 1 次 → 不判「目录里没了」')
assert.equal(decideCuration({ uses: 1, lastUsedAt: ago(40), catalogSeenAt: seenNow }, now, thresholds, ago(10)).action, 'none')
ok('curator：目录刷新结果超过 7 天 → 本轮不判（catalogUntrusted）')
assert.equal(decideCuration({ uses: 1, lastUsedAt: ago(40) }, now, thresholds, seenNow).action, 'none')
ok('curator：从未在目录里见过的记录（别的 scope）→ 不归档，不知道 ≠ 没有')
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
  assert.equal(alphaArchived.archivedReason, 'stale-30d', '归档原因应写明阈值（活动衰减）')
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


// ── v1.1.0：可预演（dryRun 只读）/ 可观测（lastCuration + 跳过原因）/ 可审计（archive-manifest.jsonl） ──
{
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const daysAgo = (days) => new Date(Date.now() - days * DAY).toISOString()
  /** 造一份账本：key 是技能名，值直接按 usage.json 的 skills 形状写（不经过插件，等价于历史存档）。 */
  const makeStore = (skills) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'skill-usage-v11-'))
    writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ version: 1, skills }), 'utf8')
    return dir
  }

  // —— A. dry-run 只读 + lastCuration 观测 + manifest 审计（一条链路跑通） ——
  {
    const storeDir = makeStore({
      Stale40: { uses: 2, firstSeenAt: daysAgo(90), lastUsedAt: daysAgo(40), catalogSeenAt: daysAgo(40) },
      Stale35: { uses: 0, firstSeenAt: daysAgo(90), lastUsedAt: daysAgo(35), catalogSeenAt: daysAgo(40) },
      NeverUsed: { uses: 0, firstSeenAt: daysAgo(60), catalogSeenAt: daysAgo(40) },
      ArchivedOld: { uses: 1, firstSeenAt: daysAgo(90), lastUsedAt: daysAgo(60), catalogSeenAt: daysAgo(40), archivedAt: daysAgo(5), archivedReason: 'stale-30d' },
    })
    const { ctx, registered } = makeMockContext()
    let catalogCalls = 0
    // 第一次目录刷新失败 = 真实的「目录名单不可信」：挂载时 curator 必须如实跳过，不许瞎归档。
    ctx.skills = {
      list: async () => {
        catalogCalls += 1
        if (catalogCalls === 1) throw new Error('catalog down')
        return [{ name: 'Stale40' }, { name: 'Stale35' }, { name: 'NeverUsed' }, { name: 'ArchivedOld' }]
      },
    }
    mod.apply(ctx, { storeDir })
    const toolOf = (name) => registered.find((tool) => tool.name === name)
    const usageTool = toolOf('skill_usage')
    const markTool = toolOf('skill_usage_mark')
    const statusTool = toolOf('skill_usage_status')
    const usageFile = path.join(storeDir, 'usage.json')
    const manifestFile = path.join(storeDir, 'archive-manifest.jsonl')
    await sleep(250) // 等挂载时那次 refreshCatalog + runCurator 落定

    const mountStatus = await statusTool.execute({})
    assert.deepEqual(
      mountStatus.lastCuration.skipped,
      { alreadyArchived: 1, catalogUntrusted: 2, notDue: 0, neverUsed: 1 },
      '跳过原因必须按 decideCuration/classifyUsage 的真实判定分桶（2 个目录不可信、1 个从未用过、1 个已归档）',
    )
    assert.equal(mountStatus.lastCuration.archived, 0, '目录不可信时一个都不许归档')
    assert.deepEqual(mountStatus.lastCuration.archivedNames, [])
    assert.equal(typeof mountStatus.lastCuration.at, 'string')
    ok('lastCuration：归档 0 + skipped 按真实判据分桶（catalogUntrusted=2 / neverUsed=1 / alreadyArchived=1）')

    // mark 会刷目录（catalogAt 变可信）但**不**跑 curator —— 正好造出「现在能预演」的状态。
    await markTool.execute({ name: 'NeverUsed' })
    await sleep(250) // 等 mark 触发的落盘写完，再拿基线
    const beforeBuf = readFileSync(usageFile)
    const beforeMtime = statSync(usageFile).mtimeMs
    const beforeCuration = (await statusTool.execute({})).lastCuration

    const dry = await usageTool.execute({ dryRun: true })
    assert.equal(dry.dryRun, true)
    assert.equal(dry.dryRunReason, undefined, '目录名单可信时不该报 reason')
    assert.deepEqual(dry.wouldArchive.map((item) => item.name).sort(), ['Stale35', 'Stale40'], '只报真正会被归档的；已归档/从未用过/刚复核都不列')
    assert.deepEqual(dry.wouldArchive.find((item) => item.name === 'Stale40'), { name: 'Stale40', reason: 'stale-30d', days: 40, uses: 2 })
    ok('dry-run：返回 dryRun:true 与 wouldArchive[{name,reason,days,uses}]')

    await sleep(300) // 给任何「偷偷落盘」的定时器一个机会
    assert.ok(readFileSync(usageFile).equals(beforeBuf), 'dry-run 不许改 usage.json：必须逐字节相同')
    assert.equal(statSync(usageFile).mtimeMs, beforeMtime, 'dry-run 连 usage.json 的 mtime 都不许动')
    assert.deepEqual((await statusTool.execute({})).lastCuration, beforeCuration, 'dry-run 不许跑 curator（lastCuration 不变）')
    assert.equal(existsSync(manifestFile), false, 'dry-run 不许写审计文件')
    ok('dry-run 只读：前后 usage.json 逐字节不变、mtime 不变、lastCuration 不变、无 manifest')

    const real = await usageTool.execute({})
    assert.equal(real.dryRun, undefined, '默认调用不带 dryRun 字段（行为不变）')
    assert.equal(real.wouldArchive, undefined)
    const manifestLines = readFileSync(manifestFile, 'utf8').trim().split('\n')
    assert.equal(manifestLines.length, 2, '真归档两个 → manifest 恰好两行（每行一条）')
    const entries = manifestLines.map((line) => JSON.parse(line))
    assert.deepEqual(entries.map((entry) => entry.name).sort(), ['Stale35', 'Stale40'])
    for (const entry of entries) {
      assert.deepEqual(Object.keys(entry).sort(), ['by', 'days', 'name', 'reason', 'ts', 'uses'], '字段固定：ts/by/name/reason/days/uses')
      assert.equal(entry.by, 'curator')
      assert.equal(entry.reason, 'stale-30d')
      assert.equal(entry.ts, new Date(entry.ts).toISOString(), 'ts 必须是 ISO 时间')
    }
    const entry40 = entries.find((entry) => entry.name === 'Stale40')
    assert.equal(entry40.days, 40)
    assert.equal(entry40.uses, 2)
    ok('archive-manifest：真归档每行一条 JSON，字段与内容正确')

    await sleep(250) // 等 curator 触发的 150ms 防抖落盘真正写完，再验账本
    const saved = JSON.parse(readFileSync(usageFile, 'utf8'))
    assert.equal(saved.skills.Stale40.archivedReason, 'stale-30d')
    assert.equal(typeof saved.skills.Stale40.archivedAt, 'string')
    const afterStatus = await statusTool.execute({})
    assert.equal(afterStatus.lastCuration.archived, 2)
    assert.deepEqual(afterStatus.lastCuration.archivedNames.slice().sort(), ['Stale35', 'Stale40'])
    // NeverUsed 从没被 skill 工具加载过，复核后 classifyUsage 仍报 new —— 所以它记在 neverUsed 而不是 notDue。
    assert.deepEqual(afterStatus.lastCuration.skipped, { alreadyArchived: 1, catalogUntrusted: 0, notDue: 0, neverUsed: 1 })
    ok('lastCuration：归档数/名字/跳过原因与真跑的账本一致')

    await sleep(250)
    rmSync(storeDir, { recursive: true, force: true })
  }

  // —— B. 目录名单不可信：dry-run 诚实报空 + reason，绝不瞎判 ——
  {
    const storeDir = makeStore({
      Stale40: { uses: 2, firstSeenAt: daysAgo(90), lastUsedAt: daysAgo(40), catalogSeenAt: daysAgo(40) },
    })
    const { ctx, registered } = makeMockContext()
    ctx.skills = { list: async () => { throw new Error('catalog down') } }
    mod.apply(ctx, { storeDir })
    const toolOf = (name) => registered.find((tool) => tool.name === name)
    const usageTool = toolOf('skill_usage')
    const statusTool = toolOf('skill_usage_status')
    const usageFile = path.join(storeDir, 'usage.json')
    await sleep(250)
    const beforeBuf = readFileSync(usageFile)

    const dry = await usageTool.execute({ dryRun: true })
    assert.equal(dry.dryRun, true)
    assert.deepEqual(dry.wouldArchive, [], 'wouldArchive 空不是「没有可归档的」，是「目录不可信、不敢判」')
    assert.equal(dry.dryRunReason, 'catalog-untrusted')
    const mountStatus = await statusTool.execute({})
    assert.equal(mountStatus.lastCuration.archived, 0)
    assert.equal(mountStatus.lastCuration.skipped.catalogUntrusted, 1)

    await sleep(300)
    assert.ok(readFileSync(usageFile).equals(beforeBuf), '目录不可信的 dry-run 同样不许落盘')
    assert.equal(existsSync(path.join(storeDir, 'archive-manifest.jsonl')), false)
    ok('目录名单不可信：dry-run 报 wouldArchive:[] + dryRunReason=catalog-untrusted，且不落盘不归档')

    await sleep(250)
    rmSync(storeDir, { recursive: true, force: true })
  }

  // —— C. manifest 超过 2MiB：先轮转成 .1（只留一份历史），再写新文件 ——
  {
    const storeDir = makeStore({
      A40: { uses: 1, firstSeenAt: daysAgo(90), lastUsedAt: daysAgo(40), catalogSeenAt: daysAgo(40) },
      B40: { uses: 3, firstSeenAt: daysAgo(90), lastUsedAt: daysAgo(40), catalogSeenAt: daysAgo(40) },
    })
    const manifestFile = path.join(storeDir, 'archive-manifest.jsonl')
    // 每行 8 字节，凑到刚好超过 2*1024*1024 字节（JSONL 口径：按文件字节算，不按行数）
    const bigHistory = '{"x":1}\n'.repeat(Math.ceil((2 * 1024 * 1024) / 8) + 100)
    writeFileSync(manifestFile, bigHistory, 'utf8')
    writeFileSync(manifestFile + '.1', 'STALE-HISTORY\n', 'utf8')
    const { ctx, registered } = makeMockContext()
    ctx.skills = { list: async () => [{ name: 'A40' }, { name: 'B40' }] }
    mod.apply(ctx, { storeDir })
    await sleep(300)

    assert.equal(readFileSync(manifestFile + '.1', 'utf8'), bigHistory, '轮转：旧审计整份进 .1，字节不变')
    const fresh = readFileSync(manifestFile, 'utf8').trim().split('\n')
    assert.equal(fresh.length, 2, '轮转后新文件只装新归档')
    assert.deepEqual(fresh.map((line) => JSON.parse(line).name).sort(), ['A40', 'B40'])
    ok('archive-manifest 超 2MiB 先轮转成 .1（旧历史被替换，只留一份），新文件从零开始')

    await sleep(250)
    rmSync(storeDir, { recursive: true, force: true })
  }

  // —— D. manifest 写失败：只记 stats.lastError，绝不影响归档主流程 ——
  {
    const storeDir = makeStore({
      C40: { uses: 1, firstSeenAt: daysAgo(90), lastUsedAt: daysAgo(40), catalogSeenAt: daysAgo(40) },
    })
    // 把 manifest 路径占成目录：appendFileSync 必然失败（EISDIR/EPERM）
    mkdirSync(path.join(storeDir, 'archive-manifest.jsonl'))
    const { ctx, registered } = makeMockContext()
    ctx.skills = { list: async () => [{ name: 'C40' }] }
    mod.apply(ctx, { storeDir })
    const statusTool = registered.find((tool) => tool.name === 'skill_usage_status')
    await sleep(300)

    const saved = JSON.parse(readFileSync(path.join(storeDir, 'usage.json'), 'utf8'))
    assert.equal(saved.skills.C40.archivedReason, 'stale-30d', '审计写失败不许影响归档')
    const status = await statusTool.execute({})
    assert.equal(status.lastCuration.archived, 1)
    assert.match(status.lastError, /^manifest: /, '审计失败必须留痕（stats.lastError）')
    ok('manifest 写失败只记 lastError：归档照常完成')

    await sleep(250)
    rmSync(storeDir, { recursive: true, force: true })
  }
}

// ── v1.2.1 回归：分 scope 的目录视图只回部分技能时，不许把没看见的技能误判 not-in-catalog ──
// 事故（2026-11-12）：一次只回 2 个技能的视图把 catalogAt 推到当下，10 个仍在目录里的技能被归档。
{
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const daysAgo = (days) => new Date(Date.now() - days * DAY).toISOString()
  const storeDir = mkdtempSync(path.join(os.tmpdir(), 'skill-usage-v121-'))
  writeFileSync(
    path.join(storeDir, 'usage.json'),
    JSON.stringify({
      version: 1,
      skills: {
        P: { uses: 2, firstSeenAt: daysAgo(30), lastUsedAt: daysAgo(1) },
        Q: { uses: 1, firstSeenAt: daysAgo(30), lastUsedAt: daysAgo(2) },
      },
    }),
    'utf8',
  )
  const { ctx, registered } = makeMockContext()
  let phase = 'full'
  ctx.skills = { list: async () => (phase === 'full' ? [{ name: 'P' }, { name: 'Q' }] : [{ name: 'P' }]) }
  mod.apply(ctx, { storeDir })
  await sleep(350) // 挂载：完整目录视图
  phase = 'partial'
  const usageTool = registered.find((tool) => tool.name === 'skill_usage')
  const statusTool = registered.find((tool) => tool.name === 'skill_usage_status')
  await usageTool.execute({}) // 触发一次「只看见 P」的刷新
  await sleep(300)
  const afterPartial = JSON.parse(readFileSync(path.join(storeDir, 'usage.json'), 'utf8'))
  assert.equal(afterPartial.skills.Q.archivedAt, undefined, '仍在用、只是在这次视图里没出现的技能，绝不能被归档')
  assert.equal(afterPartial.skills.Q.catalogMissCount, 1, '缺席要计数，供「连续缺席」判据用')
  assert.equal((await statusTool.execute({})).lastCuration.archived, 0)
  // 再来一次 partial：缺席 2 次但未满 7 天 → 仍不许归档（陈旧由 stale 阈值管，不由缺席管）
  await usageTool.execute({})
  await sleep(300)
  const afterSecond = JSON.parse(readFileSync(path.join(storeDir, 'usage.json'), 'utf8'))
  assert.equal(afterSecond.skills.Q.archivedAt, undefined, '连续缺席 2 次但未满 7 天：不判 not-in-catalog')
  assert.equal(afterSecond.skills.Q.catalogMissCount, 2)
  await sleep(250)
  rmSync(storeDir, { recursive: true, force: true })
  ok('分 scope 视图缺人不误归档：缺席只计数，不因单次/两次未见就 not-in-catalog')
}

// ── v1.2.0：合并建议（只读中间档）——纯函数判据 + 工具零副作用 ──
{
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const { planConsolidation, skillTokens, CONSOLIDATION_DEFAULT_THRESHOLD } = mod

  const tokens = skillTokens('cordis-plugin-development')
  assert.ok(tokens.has('cordis') && tokens.has('plugin') && tokens.has('development'), '连字符要拆成词')
  assert.ok(!tokens.has('cordis-plugin'), '不该把连字符整串当一个词')
  ok('skillTokens：连字符拆词、停用词剔除')

  const entries = [
    { name: 'cordis-plugin-development', description: 'Cordis plugin development guide', uses: 5, state: 'stale', lastUsedAt: ago(14) },
    { name: 'cordis-composition-reference', description: 'Cordis composition reference', uses: 0, state: 'new' },
    { name: 'editing-cordis-compositions', description: 'Editing cordis compositions', uses: 2, state: 'active' },
    { name: 'nvidia-driver-upgrade', description: 'Upgrade NVIDIA driver on Windows', uses: 1, state: 'active' },
    { name: 'archived-cordis-old', description: 'Cordis plugin development old', archivedAt: ago(5) },
  ]
  const plan = planConsolidation(entries)
  assert.equal(plan.threshold, CONSOLIDATION_DEFAULT_THRESHOLD)
  assert.equal(plan.scanned, 4, '已归档条目不参与聚类')
  assert.equal(plan.clusters.length, 1, '只该聚出 cordis 一组')
  const cluster = plan.clusters[0]
  assert.deepEqual(
    cluster.members.map((member) => member.name).sort(),
    ['cordis-composition-reference', 'cordis-plugin-development', 'editing-cordis-compositions'],
  )
  assert.equal(cluster.umbrellaHint, 'cordis', '伞名取组内高频共同词')
  assert.ok(cluster.sharedTokens.includes('cordis'))
  assert.ok(cluster.similarity > 0 && cluster.similarity <= 1)
  ok('planConsolidation：cordis 三件套聚成一组、无关技能不入组、伞名=cordis、已归档排除')

  assert.equal(planConsolidation(entries, { threshold: 0.9 }).clusters.length, 0, '阈值必须真的起作用')
  ok('planConsolidation：阈值生效（0.9 时同组也散开）')

  // 回归（2026-11-12 真机假组）：名字毫无关系、只是描述里撞了几个通用词 → 不许成组。
  {
    const unrelated = planConsolidation([
      { name: 'official-plugins', description: 'Asks the user before loading app plugins' },
      { name: 'personalized-pages', description: 'Asks the user before creating an app page' },
    ])
    assert.equal(unrelated.clusters.length, 0, '共享描述词但名字无共同主题词：不能聚成一组')
  }
  ok('planConsolidation：名字无共同词时，描述撞词也不成组（真机假组回归）')

  // 工具端到端：只读——调用后 usage.json 逐字节不变，且不写 manifest
  const storeDir = mkdtempSync(path.join(os.tmpdir(), 'skill-usage-v12-'))
  writeFileSync(
    path.join(storeDir, 'usage.json'),
    JSON.stringify({
      version: 1,
      skills: {
        'cordis-plugin-development': { uses: 5, firstSeenAt: ago(30), lastUsedAt: ago(1), catalogSeenAt: ago(0) },
        'cordis-composition-reference': { uses: 0, firstSeenAt: ago(20), catalogSeenAt: ago(0) },
        'editing-cordis-compositions': { uses: 2, firstSeenAt: ago(30), lastUsedAt: ago(2), catalogSeenAt: ago(0) },
        'nvidia-driver-upgrade': { uses: 1, firstSeenAt: ago(30), lastUsedAt: ago(3), catalogSeenAt: ago(0) },
      },
    }),
    'utf8',
  )
  const { ctx, registered } = makeMockContext()
  ctx.skills = {
    list: async () => [
      { name: 'cordis-plugin-development', description: 'Cordis plugin development' },
      { name: 'cordis-composition-reference', description: 'Cordis composition reference' },
      { name: 'editing-cordis-compositions', description: 'Editing cordis compositions' },
      { name: 'nvidia-driver-upgrade', description: 'Upgrade NVIDIA driver' },
    ],
  }
  mod.apply(ctx, { storeDir })
  const planTool = registered.find((tool) => tool.name === 'skill_consolidation_plan')
  assert.ok(planTool, '必须注册 skill_consolidation_plan')
  await sleep(250)
  const usageFile = path.join(storeDir, 'usage.json')
  const beforeBuf = readFileSync(usageFile)
  const beforeMtime = statSync(usageFile).mtimeMs
  const result = await planTool.execute({})
  assert.equal(result.directory, 4, '目录并集大小应等于登记数')
  assert.equal(result.scanned, 4)
  assert.equal(result.clusters.length, 1)
  assert.deepEqual(
    result.clusters[0].members.map((member) => member.name).sort(),
    ['cordis-composition-reference', 'cordis-plugin-development', 'editing-cordis-compositions'],
  )
  assert.match(result.note, /只读/)
  await sleep(300)
  assert.ok(readFileSync(usageFile).equals(beforeBuf), '合并建议只读：usage.json 必须逐字节不变')
  assert.equal(statSync(usageFile).mtimeMs, beforeMtime, '连 mtime 都不许动')
  assert.equal(existsSync(path.join(storeDir, 'archive-manifest.jsonl')), false, '不许写审计文件')
  await sleep(250)
  rmSync(storeDir, { recursive: true, force: true })
  ok('skill_consolidation_plan：真机路径返回分组，且零副作用（usage.json/mtime/manifest 全不变）')

  // 现读视图因 scope 只回部分技能时，必须用账本目录快照补齐，不能少报。
  {
    const storeDir2 = mkdtempSync(path.join(os.tmpdir(), 'skill-usage-v12-union-'))
    const skills = {
      'cordis-plugin-development': { uses: 3, firstSeenAt: ago(20), lastUsedAt: ago(1), catalogSeenAt: ago(0) },
      'cordis-composition-reference': { uses: 0, firstSeenAt: ago(20), catalogSeenAt: ago(0) },
      'editing-cordis-compositions': { uses: 1, firstSeenAt: ago(20), lastUsedAt: ago(2), catalogSeenAt: ago(0) },
      'nvidia-driver-upgrade': { uses: 1, firstSeenAt: ago(20), lastUsedAt: ago(3), catalogSeenAt: ago(0) },
    }
    writeFileSync(path.join(storeDir2, 'usage.json'), JSON.stringify({ version: 1, skills }), 'utf8')
    const full = [
      { name: 'cordis-plugin-development', description: 'Cordis plugin development' },
      { name: 'cordis-composition-reference', description: 'Cordis composition reference' },
      { name: 'editing-cordis-compositions', description: 'Editing cordis compositions' },
      { name: 'nvidia-driver-upgrade', description: 'Upgrade NVIDIA driver' },
    ]
    let calls = 0
    const { ctx: ctxU, registered: regU } = makeMockContext()
    ctxU.skills = {
      list: async () => {
        calls += 1
        return calls === 1 ? full : full.slice(0, 2)
      },
    }
    mod.apply(ctxU, { storeDir: storeDir2 })
    await sleep(300) // 等挂载时那次 refreshCatalog 把 4 个技能写进快照
    const tool = regU.find((item) => item.name === 'skill_consolidation_plan')
    const union = await tool.execute({})
    assert.equal(union.directory, 4, '现读只回 2 个时，账本快照要补齐到 4——少报等于漏掉该合并的技能')
    assert.equal(union.clusters.length, 1, '补齐后 cordis 三件套仍应成组')
    await sleep(250)
    rmSync(storeDir2, { recursive: true, force: true })
    ok('skill_consolidation_plan：现读视图不全时用账本快照取并集（不谎报「没有同主题组」）')
  }
}

console.log(`skill-usage: ${passed} 项通过`)
