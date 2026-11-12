import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { makeTmp, sweepStaleDirs } from './_tmp-dirs.mjs'
import { apply } from '../../dsh-memory/index.js'

// v4.16（P0-2）集成测试：20 条受控数据 → 跑真实维护链路 → 只归低价值、保护 0 误伤、单轮 ≤5、可恢复。
// 这不是纯函数测试：走 apply(ctx) → memory.json → runMaintenance → archive + manifest 全链路。
sweepStaleDirs()
let passed = 0
const ok = (label) => { passed += 1; console.log(`  ✓ ${label}`) }

const host = (dir, extra) => {
  const defs = new Map()
  const layers = []
  const ctx = {
    tools: { register: (definition) => { defs.set(definition.name, definition); return () => {} } },
    effect: (fn) => fn(),
    on: () => () => {},
    get: () => undefined,
    systemPrompt: { context: (layer) => { layers.push(layer); return () => {} } },
  }
  apply(ctx, { storeDir: dir, maxInjectChars: 1500, ...(extra ?? {}) })
  return { defs, layers }
}

const tmp = makeTmp('dsh-memory-eviction-int')
const seed = host(tmp)
const lowValue = []
// 文本必须彼此不同：memory_add 对高相似文本会去重（相似合并），10 条同模板只会建 1 条。
const topics = ['数据库迁移','网络排查','磁盘清理','日志轮转','备份恢复','接口鉴权','缓存失效','队列积压','证书更新','时钟同步']
for (let i = 0; i < 10; i += 1) {
  const r = await seed.defs.get('memory_add').execute({ text: `${topics[i]} 的旧观察记录，单次任务结论`, kind: 'fact' })
  lowValue.push(r.entry.id)
}
const pinnedR = await seed.defs.get('memory_add').execute({ text: '钉住的硬规则不该动', kind: 'fact', pinned: true })
const ruleR = await seed.defs.get('memory_add').execute({ text: '长期约定不该自动归档', kind: 'rule' })
const vaultR = await seed.defs.get('memory_add').execute({ text: '知识入口见 vault://30-Build/x.md#1', kind: 'fact' })
const usedR = await seed.defs.get('memory_add').execute({ text: '被检索过很多次的旧事实', kind: 'fact' })

// 伪造年龄（memory_add 不能写回 100 天前）：直接改 memory.json，再重新加载走真实读路径。
const file = path.join(tmp, 'memory.json')
const data = JSON.parse(readFileSync(file, 'utf8'))
const oldStamp = new Date(Date.now() - 100 * 86400000).toISOString()
for (const entry of data.entries) {
  if (lowValue.includes(entry.id) || entry.id === vaultR.entry.id || entry.id === usedR.entry.id) {
    entry.addedAt = oldStamp
    entry.updatedAt = oldStamp
  }
  if (entry.id === usedR.entry.id) entry.usedCount = 5
}
writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')

const h = host(tmp)
h.layers[0].text({}) // 触发 runMaintenance（读路径顺带跑）
const status = await h.defs.get('memory_status').execute({})
const summary = status.maintenance.lastSummary
assert.equal(summary.state, 'executed', '有候选时必须报 executed，实际 ' + JSON.stringify(summary));
assert.ok(status.maintenance.archived >= 1, '10 条 100 天低价值事实应至少归档 1 条');
assert.ok(status.maintenance.archived <= 5, '单轮归档不得超过 EVICTION_MAX_PER_RUN=5，实际 ' + status.maintenance.archived);
assert.ok(Array.isArray(summary.ids) && summary.ids.length === status.maintenance.archived, 'lastSummary.ids 与 archived 数一致');
assert.ok(summary.freedChars > 0, 'freedChars 必须为正（可解释腾出多少字符）');
ok('集成：低价值旧事实被归档、单轮 ≤5、summary 带 ids/freedChars')

const archivedSet = new Set(summary.ids);
for (const id of summary.ids) assert.ok(lowValue.includes(id), '只能归档低价值条目，误伤了 ' + id);
for (const protectedId of [pinnedR.entry.id, ruleR.entry.id, vaultR.entry.id, usedR.entry.id]) {
  assert.ok(!archivedSet.has(protectedId), '受保护条目被误归档：' + protectedId);
}
ok('集成：pinned / rule / vault 指针 / usedCount≥3 全部未误伤')

const restored = await h.defs.get('memory_restore').execute({ id: summary.ids[0] })
assert.equal(restored.restored, true, '归档条目必须可 memory_restore 恢复');
const afterRestore = await h.defs.get('memory_status').execute({})
assert.equal(afterRestore.archived, status.archived - 1, '恢复后归档总数应减 1（maintenance.archived 是上次运行的统计快照，不随 restore 变）');
ok('集成：memory_restore 恢复归档条目，归档数回落')

const audit = await h.defs.get('memory_audit').execute({ limit: 20 })
assert.ok(Array.isArray(audit.evictionCandidates) && audit.evictionCandidates.length > 0, 'memory_audit 必须带只读候选清单');
assert.ok(audit.evictionCandidates.some((row) => row.candidate === true), '归档后仍应剩候选（单轮上限留下的）');
ok('集成：memory_audit.evictionCandidates 可读（candidate=true 才是会归档的）')

rmSync(tmp, { recursive: true, force: true })
console.log(`\nmemory-eviction-integration: ${passed} 组断言通过`)