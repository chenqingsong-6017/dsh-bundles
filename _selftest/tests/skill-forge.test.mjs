import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  similarity,
  pickSignals,
  classifyTheme,
  clusterSignals,
  draftSkill,
  renderSkillMd,
  admitSkill,
  verifyCandidate,
  run,
  status,
} from '../../dsh-skill-forge/lib/core.js'

let passed = 0
const ok = (label) => { passed += 1; console.log('  OK ' + label) }

// ---------- 1. 相似度是纯函数：可单测 ----------
assert.equal(similarity('先验证再交付', '先验证再交付'), 1)
assert.equal(similarity('完全不同的两句话', 'zzzzzz'), 0)
assert.ok(similarity('先验证再交付', '先验证再交付一遍') > 0.7)
ok('相似度：同句=1、异句=0、近似>0.7')

// ---------- 2. 信号筛选：只收纠错/规则，偏好与空文本不收 ----------
const raw = [
  { type: 'correction', text: '不对，先验证再交付', evidence: { session: 's1', seq: 1 } },
  { type: 'rule', text: '硬规则：删除前必须三查', evidence: { session: 's1', seq: 2 } },
  { type: 'preference', text: '我喜欢深色模式', evidence: { session: 's1', seq: 3 } },
  { type: 'correction', text: '   ', evidence: { session: 's1', seq: 4 } },
]
const signals = pickSignals(raw)
assert.equal(signals.length, 2, '只收 correction/rule 且非空文本')
ok('信号筛选：只收纠错与规则，偏好与空文本不收')

// ---------- 3. 主题分类：命中与兜底 ----------
assert.equal(classifyTheme('先验证再交付，要有观测值').key, 'verification')
assert.equal(classifyTheme('不许偷懒，不要最小改动').key, 'minimal-change')
assert.equal(classifyTheme('这是随便一句无关的话').key, 'lesson')
ok('主题分类：验证/最小改动命中，无关句兜底 lesson')

// ---------- 4. 聚类：相似句同组、异句分组 ----------
const clusters = clusterSignals([
  { type: 'correction', text: '先验证再交付', cwd: 'W1', evidence: { session: 's1', seq: 1 } },
  { type: 'correction', text: '先验证再交付', cwd: 'W1', evidence: { session: 's2', seq: 2 } },
  { type: 'correction', text: '完全不相干的内容 ABCDEF', cwd: 'W1', evidence: { session: 's3', seq: 3 } },
], 0.62)
assert.ok(clusters.length >= 2, '同项目内应聚出至少两组')
assert.ok(clusters.some((c) => c.items.length >= 2), '相似句应聚成一组')
ok('聚类：相似句同组、异句分组')

// ---------- 5. 候选生成：证据链 + 置信度 ----------
const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-skill-forge-test-'))
try {
  const storeDir = path.join(dir, 'store')
  const harvestDir = path.join(dir, 'harvest')
  const skillsRoot = path.join(dir, 'skills')
  const options = () => ({ storeDir, harvestDir, skillsRoot })

  const draft = draftSkill(
    {
      cwd: 'W1',
      items: [
        { type: 'correction', text: '不对，先验证再交付', cwd: 'W1', evidence: { session: 's1', seq: 10, time: 100 } },
        { type: 'correction', text: '不对，先验证再交付', cwd: 'W1', evidence: { session: 's2', seq: 20, time: 200 } },
      ],
    },
    { storeDir, harvestDir, skillsRoot }
  )
  assert.ok(draft && draft.id.startsWith('sf-'), '应生成 sf- 前缀候选')
  assert.equal(draft.evidence.length, 2, '两条证据都要带上')
  assert.ok(draft.evidence.every((e) => e.session && e.quote), '每条证据必须带 session 与 quote')
  assert.equal(draft.confidence, 'high', '两条跨会话证据应为 high')
  assert.equal(draft.status, 'pending', '新候选必须是 pending（不自动入库）')
  ok('候选生成：证据链完整、跨会话 high、状态 pending')

  // 单条证据 -> medium
  const draftOne = draftSkill(
    { cwd: 'W2', items: [{ type: 'correction', text: '不要糊弄，查不到就说查不到', cwd: 'W2', evidence: { session: 's9', seq: 1 } }] },
    { storeDir, harvestDir, skillsRoot }
  )
  assert.equal(draftOne.confidence, 'medium', '单条证据应为 medium')
  ok('置信度分级：单条 medium、跨会话两条 high')

  // ---------- 6. SKILL.md 渲染：frontmatter 必填字段 ----------
  const md = renderSkillMd(draft)
  assert.ok(md.includes('name: ' + draft.name), 'frontmatter 必须带 name')
  assert.ok(md.includes('description:'), 'frontmatter 必须带 description')
  assert.ok(md.includes('status: draft'), '入库必须标 draft')
  assert.ok(md.includes('## 5. 证据'), '正文必须带证据节')
  ok('SKILL.md 渲染：name/description/status=draft/证据节齐全')

  // ---------- 7. held-out 检查 ----------
  assert.equal(verifyCandidate(draft).ok, true, '完整候选应通过')
  const noEvidence = verifyCandidate({ name: 'x', evidence: [], whenToUse: 'a', steps: ['s'] })
  assert.equal(noEvidence.ok, false)
  assert.ok(noEvidence.problems.includes('SFE_NO_EVIDENCE'))
  const noSteps = verifyCandidate({ name: 'x', evidence: [{ session: 'a', quote: 'b' }], whenToUse: 'a', steps: [] })
  assert.ok(noSteps.problems.includes('SFE_NO_STEPS'))
  ok('held-out：缺证据/缺步骤被拒')

  // ---------- 8. 入库：写文件、同名不覆盖、force 覆盖 ----------
  const admitted = admitSkill(draft, { skillsRoot })
  assert.equal(admitted.ok, true)
  assert.ok(existsSync(admitted.path), 'SKILL.md 必须真的写出来')
  const fileText = readFileSync(admitted.path, 'utf8')
  assert.ok(fileText.includes('status: draft'))
  const again = admitSkill(draft, { skillsRoot })
  assert.equal(again.ok, false, '同名已存在默认不覆盖')
  assert.ok(String(again.reason).includes('SFE_EXISTS'))
  const forced = admitSkill(draft, { skillsRoot, force: true })
  assert.equal(forced.ok, true, 'force:true 允许覆盖')
  ok('入库：写文件成功、默认不覆盖、force 可覆盖')

  // 无证据候选不许入库
  const denied = admitSkill({ name: 'bad-one', evidence: [] }, { skillsRoot })
  assert.equal(denied.ok, false)
  assert.ok(String(denied.reason).includes('SFE_NO_EVIDENCE'))
  ok('入库闸门：无证据候选拒绝写入')

  // ---------- 9. 主流程 + 幂等 ----------
  const harvestRecords = [
    { type: 'correction', text: '不对，先验证再交付', cwd: 'W1', evidence: { session: 's1', seq: 10, time: 100 }, status: 'pending', createdAt: 1 },
    { type: 'correction', text: '不对，先验证再交付', cwd: 'W1', evidence: { session: 's2', seq: 20, time: 200 }, status: 'pending', createdAt: 1 },
    { type: 'preference', text: '我喜欢深色模式', cwd: 'W1', evidence: { session: 's1', seq: 30 }, status: 'pending', createdAt: 1 },
    { type: 'rule', text: '硬规则：删除前必须三查', cwd: 'W2', evidence: { session: 's3', seq: 40, time: 300 }, status: 'pending', createdAt: 1 },
  ]
  const { mkdirSync } = await import('node:fs')
  mkdirSync(harvestDir, { recursive: true })
  writeFileSync(path.join(harvestDir, 'candidates.jsonl'), harvestRecords.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

  const first = run(options())
  assert.equal(first.scanned, 4, '应扫到 4 条 harvest 候选')
  assert.equal(first.signals, 3, '偏好不算信号，剩 3 条')
  assert.ok(first.created >= 1, '至少产出一个候选')
  const second = run(options())
  assert.equal(second.created, 0, '幂等：重复跑不得新增候选')
  ok('主流程：扫描/筛选/产出正确，重复跑幂等')

  // ---------- 10. status 统计 ----------
  const st = status(options())
  assert.equal(st.harvestCandidates, 4)
  assert.ok(st.candidates >= first.created)
  assert.ok(st.pending >= 1)
  ok('status：harvest 候选 4 条、skill 候选与待审计数一致')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('skill-forge.test.mjs: 通过 ' + passed + ' 组断言')
