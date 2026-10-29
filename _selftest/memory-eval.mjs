#!/usr/bin/env node
// dsh-memory 评测：两块指标，可复跑。
//  A. 召回评测（内置夹具 20 条 + 8 个查询）：relevant recall@3 是否 ≥ 80%
//  B. 真实库卫生检查（存在 D:/AI/dsh-data/memory/memory.json 时）：硬规则是否全在、注入是否超预算、失效条目是否漏注入
// 用法：node _selftest/memory-eval.mjs            # 两块都跑
//       node _selftest/memory-eval.mjs --fixture  # 只跑夹具
import { existsSync, readFileSync } from 'node:fs'
import { applicableAt, renderMemory, scoreEntries } from '../dsh-memory/index.js'

const STORE = 'D:/AI/dsh-data/memory/memory.json'
const BUDGET = 1500
const fixtureOnly = process.argv.includes('--fixture')

const fixture = [
  { id: 'f1', text: '所有数据放 D 盘，不落 C 盘', scope: 'global', kind: 'rule', tags: ['rule'], pinned: true },
  { id: 'f2', text: '回答一律用中文', scope: 'global', kind: 'rule', tags: ['rule'], pinned: true },
  { id: 'f3', text: '记忆超预算时拒绝写入，并提示先删过时条目', scope: 'plugin-dev', kind: 'fact', tags: ['memory'] },
  { id: 'f4', text: '插件源码放在 dsh-bundles 目录，数据放在 dsh-data 目录', scope: 'plugin-dev', kind: 'fact', tags: ['plugin'] },
  { id: 'f5', text: '改完插件要用 remove_bundle 加 install_bundle 重载', scope: 'plugin-dev', kind: 'fact', tags: ['plugin'] },
  { id: 'f6', text: '插件入口必须用 node --check 过语法', scope: 'plugin-dev', kind: 'fact', tags: ['test'] },
  { id: 'f7', text: '测试失败会被 steer 推回来，本轮不允许结束', scope: 'plugin-dev', kind: 'fact', tags: ['test'] },
  { id: 'f8', text: '记忆库路径在 dsh-data 下的 memory 目录', scope: 'data-infra', kind: 'fact', tags: ['memory'] },
  { id: 'f9', text: '审计日志保留 30 天，超期自动清理', scope: 'data-infra', kind: 'fact', tags: ['audit'] },
  { id: 'f10', text: '用量索引按 session 统计 token', scope: 'data-infra', kind: 'fact', tags: ['usage'] },
  { id: 'f11', text: '工作区地图的权威来源是 workspace.json', scope: 'dsh-date', kind: 'fact', tags: ['workspace'] },
  { id: 'f12', text: '快捷方式保持原名，不许改', scope: 'global', kind: 'rule', tags: ['naming'], pinned: true },
  { id: 'f13', text: '文件夹改英文名要意译，禁拼音', scope: 'global', kind: 'rule', tags: ['naming'], pinned: true },
  { id: 'f14', text: '抖音客户端必须用普通权限启动', scope: 'machine', kind: 'fact', tags: ['env'] },
  { id: 'f15', text: 'scope 分五域：global、plugin-dev、data-infra、dsh-date、machine', scope: 'plugin-dev', kind: 'fact', tags: ['memory'] },
  { id: 'f16', text: '虚拟机的归档区不可搬动，否则会报路径找不到', scope: 'machine', kind: 'fact', tags: ['env'] },
  { id: 'f17', text: '评测套件在 dsh-data 的 eval 目录', scope: 'data-infra', kind: 'fact', tags: ['eval'] },
  { id: 'f18', text: '审计工具只给候选，不自动删除记忆', scope: 'data-infra', kind: 'fact', tags: ['audit'] },
  { id: 'f19', text: '会话检索用官方 session-search，不重造', scope: 'plugin-dev', kind: 'fact', tags: ['session'] },
  { id: 'f20', text: '不做向量检索，体量小用 BM25 就够', scope: 'plugin-dev', kind: 'fact', tags: ['memory'] },
]
const cases = [
  { query: '预算超了怎么办', expect: 'f3' },
  { query: '改完插件怎么重载', expect: 'f5' },
  { query: '测试失败被拦怎么处理', expect: 'f7' },
  { query: '数据放哪个盘', expect: 'f1' },
  { query: '快捷方式能不能改名', expect: 'f12' },
  { query: 'scope 有哪几个域', expect: 'f15' },
  { query: '审计会自己删记忆吗', expect: 'f18' },
  { query: '要不要做向量检索', expect: 'f20' },
]

let ok = true
console.log('A. 召回评测（内置夹具 20 条 / 8 个查询 / 预算 ' + BUDGET + '）')
const activeFixture = fixture.filter((entry) => !entry.pinned)
let hits = 0
for (const { query, expect } of cases) {
  const top = scoreEntries(activeFixture, query)
    .filter((item) => item.score > 0.0001)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
  // 期望条目若是 pinned 硬规则，它永远在注入块里，算命中（不参与检索排名）。
  const expectPinned = fixture.some((entry) => entry.id === expect && entry.pinned === true)
  const hit = expectPinned || top.some((item) => item.entry.id === expect)
  if (hit) hits += 1
  console.log(`  ${hit ? '✅' : '❌'} ${query.padEnd(18)} 期望 ${expect}${expectPinned ? '（pinned 必在场）' : ''} | top3 ${top.map((item) => item.entry.id).join(',') || '(空)'}`)
}
const recall = hits / cases.length
const recallOk = recall >= 0.8
if (!recallOk) ok = false
console.log(`  recall@3 = ${hits}/${cases.length} = ${(recall * 100).toFixed(0)}%（阈值 ≥ 80%）${recallOk ? ' ✅' : ' ❌'}`)

if (!fixtureOnly && existsSync(STORE)) {
  console.log('')
  console.log('B. 真实库卫生检查')
  // v3.14b：以前这里不传 cwd，也不按 workspaces 过滤 —— v3.0 的工作区条件注入上线后，
  // 条件不匹配的 pinned 条目本来就不该出现在块里，却被当成「硬规则缺失」（实测误报 m10/m11/m12）。
  // 「失效漏注入」同理：m5→m65 这类合并会让新条目正文包含旧条目全文，按 30 字前缀查会把正常合并误判成泄漏。
  const CWD = process.cwd()
  const entries = JSON.parse(readFileSync(STORE, 'utf8')).entries
  const pinned = entries.filter((entry) => entry.pinned === true && applicableAt(entry, CWD))
  const active = entries.filter((entry) => typeof entry.supersededBy !== 'string')
  const stats = {}
  const block = renderMemory(entries, { maxInjectChars: BUDGET, cwd: CWD, stats })
  const coreMissing = pinned.filter((entry) => !block.includes(entry.text))
  const injectedIds = new Set([...(stats.full ?? []), ...(stats.relevant ?? []), ...(stats.indexed ?? []), ...(stats.compact ?? [])])
  const supersededLeak = entries.filter((entry) => typeof entry.supersededBy === 'string' && injectedIds.has(entry.id))
  const chars = block.length
  const limit = BUDGET + 250
  const coreOk = coreMissing.length === 0
  const leakOk = supersededLeak.length === 0
  const sizeOk = chars <= limit
  if (!coreOk || !leakOk || !sizeOk) ok = false
  console.log(`  生效 ${active.length} / 失效 ${entries.length - active.length} / 本工作区适用的硬规则 ${pinned.length}（cwd: ${CWD}）`)
  console.log(`  ${coreOk ? '✅' : '❌'} 硬规则全部注入（${pinned.length - coreMissing.length}/${pinned.length}）${coreOk ? '' : ' 缺失: ' + coreMissing.map((entry) => entry.id).join(',')}`)
  console.log(`  ${leakOk ? '✅' : '❌'} 失效条目未漏注入`)
  console.log(`  ${sizeOk ? '✅' : '❌'} 注入 ${chars} 字符（上限 ${limit}）`)
}

console.log('')
console.log(ok ? '✅ 评测通过' : '❌ 评测未达标')
process.exit(ok ? 0 : 1)
