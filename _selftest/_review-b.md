# dsh-memory 持久化 / 生命周期 审查报告（memory-reviewer-b）

- 审查对象：`D:\AI\dsh-bundles\dsh-memory\index.js`（2374 行，ESM；git 58f4cad，sha256 前缀 311be5f398ba13dd；审查期间未改动）
- 范围：load/save、每日备份与轮转（BACKUP_KEEP）、损坏保护、aliases.json 旁路、memory_add / memory_update(supersede) / merge / remove / audit / search / review、dedupe、staleAfter、applicableAt / workspaces、normalizeEntry / memoryEntrySchema、参数边界
- 方法：全部在 mkdtemp 临时 storeDir 里跑真实 `apply(ctx, {storeDir})` + `defs.get(name).execute(args)`（套路同 `_selftest/tests/memory.test.mjs` 的 host()）。真实库 `D:\AI\dsh-data\memory` 只读（只看字段并集、nextId、目录文件名，没写没改）。临时目录 `D:\AI\dsh-data\_review-b-tmp`，已清理。
- 环境：Windows / Node 22 / Asia-Shanghai。
- 分布：高 2 · 中 8 · 低 7，共 17 条。全部【已复现】。
- 复现约定：脚本存成 `repro-bNN.mjs` 后 `node repro-bNN.mjs` 即可跑（file URL 直连插件源码，无 npm 依赖，只碰 mkdtemp 临时目录）。

---

## B01 · persist() 写盘失败只 return false，六个写工具全都当成功返回

- 严重度：高
- 状态：【已复现】
- 位置：index.js:1054-1072（persist），调用点 1632 / 1752 / 1800 / 1840 / 1921 / 2366
- repro：
```js
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import os from 'node:os'; import path from 'node:path'
const M = await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js')
const host = (dir) => { const defs = new Map(); M.apply({ tools: { register: (d) => (defs.set(d.name, d), () => {}) }, effect: (f) => f(), on: () => () => {}, get: () => undefined, systemPrompt: { context: () => () => {} } }, { storeDir: dir, maxInjectChars: 1200 }); return defs }
const dir = mkdtempSync(path.join(os.tmpdir(), 'mem-b01-'))
const defs = host(dir)
mkdirSync(path.join(dir, 'memory.json.tmp'))   // 让原子写第一步失败（等价于磁盘满 / 目录只读）
const added = await defs.get('memory_add').execute({ text: '这条永远不会落盘' })
console.log('add 返回:', JSON.stringify({ id: added.entry.id, text: added.entry.text }))
console.log('磁盘上有 memory.json?', existsSync(path.join(dir, 'memory.json')))
const reload = await host(dir).get('memory_list').execute({})
console.log('重载后 total =', reload.total, ' health =', reload.health)
```
- 期望 vs 实际：期望写盘失败报错（或 health=readonly / 返回 warning）。实际 persist 的 catch 只有 `return false`（1070 行），返回值六个 execute 全都不看：add 返回 `{entry:{id:"m1"}}`、remove 返回「已删除」、search 的 usedCount 也当写成功。实测 add 返回成功、磁盘没有 memory.json、重载 total=0、health 仍是 ok。同一路径也吃掉 memory_candidates 的 accept（2366 行）：候选标 accepted 但条目没入库，两边都查不到。
- 建议修法：persist 失败抛错（至少 add / update / remove / merge / candidates-accept 必须抛），并把 storeHealth 置 readonly 让 requireWritable 拦住后续写。

---

## B02 · 多会话/多进程各自 load 后全量覆盖写：后写者静默丢掉前写者新条目，还会抢同一 id

- 严重度：高
- 状态：【已复现】
- 位置：index.js:1054-1072（全量 JSON.stringify(state) 覆盖）、1074-1104（只在 apply 时 load 一次）
- repro：
```js
import { mkdtempSync } from 'node:fs'
import os from 'node:os'; import path from 'node:path'
const M = await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js')
const host = (dir) => { const defs = new Map(); M.apply({ tools: { register: (d) => (defs.set(d.name, d), () => {}) }, effect: (f) => f(), on: () => () => {}, get: () => undefined, systemPrompt: { context: () => () => {} } }, { storeDir: dir, maxInjectChars: 1200 }); return defs }
const dir = mkdtempSync(path.join(os.tmpdir(), 'mem-b02-'))
const a = host(dir), b = host(dir)      // 两个窗口 / 两个进程各自 load 了空库
const ra = await a.get('memory_add').execute({ text: '会话A：用户要求回答用中文' })
const rb = await b.get('memory_add').execute({ text: '会话B：插件都放 D 盘' })
console.log('A id =', ra.entry.id, '；B id =', rb.entry.id, '（同一 id 冲突）')
const reload = await host(dir).get('memory_list').execute({})
console.log('重载后 total =', reload.total, '内容 =', JSON.stringify(reload.entries.map((e) => e.text)))
```
- 期望 vs 实际：应两条都在（或检测 mtime 变化后重读合并 / 报冲突）。实际重载 total=1，只剩会话 B；会话 A 的一次写入完全丢失；A、B 都分到 id=m1，说明 nextId 也是各算各的。记忆是跨会话共享单文件库，多窗口 + 子代理并发时必现。
- 建议修法：写前比对 `statSync(storeFile).mtimeMs` 与启动基线，变了重读 + 按 id 合并再写；或加 memory.json.lock（wx）互斥；nextId 提到 max(id)+1。

---

## B03 · memory_add 的重复命中不区分死活：命中已 superseded 的条目就假成功，文本根本没生效

- 严重度：中
- 状态：【已复现】
- 位置：index.js:1569-1593（duplicate = state.entries.find，未过滤 isActive）
- repro：
```js
import { mkdtempSync } from 'node:fs'
import os from 'node:os'; import path from 'node:path'
const M = await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js')
const host = (dir) => { const defs = new Map(); M.apply({ tools: { register: (d) => (defs.set(d.name, d), () => {}) }, effect: (f) => f(), on: () => () => {}, get: () => undefined, systemPrompt: { context: () => () => {} } }, { storeDir: dir, maxInjectChars: 1200 }); return defs }
const dir = mkdtempSync(path.join(os.tmpdir(), 'mem-b03-'))
const defs = host(dir)
const a = await defs.get('memory_add').execute({ text: '旧事实：预算 8000' })
await defs.get('memory_update').execute({ id: a.entry.id, text: '新事实：预算 12000', supersede: true })
const again = await defs.get('memory_add').execute({ text: '旧事实：预算 8000' })
const l = await defs.get('memory_list').execute({})
console.log('再次 add →', JSON.stringify({ deduped: again.deduped, id: again.entry.id, supersededBy: again.entry.supersededBy, status: again.entry.status }))
console.log('注入块含旧事实?', l.block.includes('预算 8000'), '；active 条数 =', l.entries.filter((e) => !e.supersededBy && e.status !== 'deprecated').length)
```
- 期望 vs 实际：应让旧事实重新生效（复活或新建），或明确报「命中已失效条目，请 supersede 新条目」。实际返回 `{deduped:true, id:"m1", supersededBy:"m2", status:"deprecated"}`，render 输出「已存在相同记忆：m1」，而该条永不注入（block 无它，active 仍 1 条）。模型以为记住了，实际没有——静默丢写入。
- 建议修法：重复查找只在 isActive 条目里找；命中失效条时复活（删 supersededBy / status）或报错提示。

---

## B04 · 重复命中时新参数被整体吞掉（aliases / tags / scope / kind / importance / workspaces）

- 严重度：中
- 状态：【已复现】
- 位置：index.js:1569-1593
- repro：
```js
import { mkdtempSync } from 'node:fs'
import os from 'node:os'; import path from 'node:path'
const M = await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js')
const host = (dir) => { const defs = new Map(); M.apply({ tools: { register: (d) => (defs.set(d.name, d), () => {}) }, effect: (f) => f(), on: () => () => {}, get: () => undefined, systemPrompt: { context: () => () => {} } }, { storeDir: dir, maxInjectChars: 1200 }); return defs }
const dir = mkdtempSync(path.join(os.tmpdir(), 'mem-b04-'))
const defs = host(dir)
await defs.get('memory_add').execute({ text: '同一句话' })
const second = await defs.get('memory_add').execute({ text: '同一句话', aliases: ['别名甲', '别名乙'], tags: ['t1'], scope: 'plugin-dev', importance: 9, workspaces: ['D:\\AI\\proj'], kind: 'rule' })
const e = second.entry
console.log('deduped =', second.deduped, '落库字段 =', JSON.stringify({ aliases: e.aliases, tags: e.tags, scope: e.scope, importance: e.importance, workspaces: e.workspaces, kind: e.kind }))
```
- 期望 vs 实际：应把新给的 aliases / tags / scope / kind / importance / workspaces 合并进已有条目（memory_add 返回的 aliasHint 正是教模型「再 add 一次补别名」的路径）。实际只回写 pinned / status / staleAfter / sources，其余全丢，输出 `落库字段 = {}`。「只在项目A生效」「重要度 9」被静默丢弃。
- 建议修法：dedupe 分支按 update 的字段规则合并（aliases / tags 并集，其余覆盖）再 persist。

---

## B05 · memory_update 的 supersede 新条目丢 importance / status / staleAfter / verifiedAt / usedCount / validFrom

- 严重度：中
- 状态：【已复现】
- 位置：index.js:1728-1754（normalizeEntry 只抄 tag / tags / scope / kind / paths / workspaces / pinned / migratedFrom / sources / aliases）
- repro：
```js
import { mkdtempSync } from 'node:fs'
import os from 'node:os'; import path from 'node:path'
const M = await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js')
const host = (dir) => { const defs = new Map(); M.apply({ tools: { register: (d) => (defs.set(d.name, d), () => {}) }, effect: (f) => f(), on: () => () => {}, get: () => undefined, systemPrompt: { context: () => () => {} } }, { storeDir: dir, maxInjectChars: 1200 }); return defs }
const dir = mkdtempSync(path.join(os.tmpdir(), 'mem-b05-'))
const defs = host(dir)
const a = await defs.get('memory_add').execute({ text: '过时：Node 20 支持 X', kind: 'fact', importance: 10, status: 'stable', staleAfter: '2099-01-01' })
await defs.get('memory_update').execute({ id: a.entry.id, text: a.entry.text, verified: true })
const before = (await defs.get('memory_list').execute({})).entries.find((e) => e.id === a.entry.id)
const after = (await defs.get('memory_update').execute({ id: a.entry.id, text: '新：Node 22 支持 X', supersede: true })).entry
const pick = (e) => ({ importance: e.importance, status: e.status, staleAfter: e.staleAfter, verifiedAt: e.verifiedAt, usedCount: e.usedCount })
console.log('旧条目 =', JSON.stringify(pick(before)))
console.log('supersede 新条目 =', JSON.stringify(pick(after)))
console.log('effectiveImportance', M.effectiveImportance(before), '→', M.effectiveImportance(after))
```
- 期望 vs 实际：supersede 应只换 text / id，其余元数据继承。实际新条目是 `{}`：importance 从 10 掉回按 kind 推导的 4（注入排序、审计口径全变），status=stable 丢失，staleAfter（时间有效性承诺）丢失，verifiedAt 丢失（刚复核的条目又变「未复核」）。v2.8 的时间失效线一 supersede 就没了。
- 建议修法：改成 `normalizeEntry({ ...entry, id: 'm' + nextId, text: next, addedAt: now, updatedAt: now })`，并重置 usedCount / lastUsedAt。

---

## B06 · memory_merge 不继承 workspaces / importance / sources：工作区限定规则一合并就变成全局生效

- 严重度：中
- 状态：【已复现】
- 位置：index.js:1902-1914（merged 的 normalizeEntry 只取 aliases / tag / tags / scope / kind / pinned）
- repro：
```js
import { mkdtempSync } from 'node:fs'
import os from 'node:os'; import path from 'node:path'
const M = await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js')
const host = (dir) => { const defs = new Map(); M.apply({ tools: { register: (d) => (defs.set(d.name, d), () => {}) }, effect: (f) => f(), on: () => () => {}, get: () => undefined, systemPrompt: { context: () => () => {} } }, { storeDir: dir, maxInjectChars: 1200 }); return defs }
const dir = mkdtempSync(path.join(os.tmpdir(), 'mem-b06-'))
const defs = host(dir)
const a = await defs.get('memory_add').execute({ text: '只在项目A生效的规则甲', workspaces: ['D:\\AI\\proj'], importance: 9, sources: ['https://x'] })
const b = await defs.get('memory_add').execute({ text: '只在项目A生效的规则乙', workspaces: ['D:\\AI\\proj'] })
const merged = await defs.get('memory_merge').execute({ ids: [a.entry.id, b.entry.id] })
const before = M.renderMemory([a.entry, b.entry], { cwd: 'D:\\AI\\other', maxInjectChars: 1000 })
const after = M.renderMemory([merged.entry], { cwd: 'D:\\AI\\other', maxInjectChars: 1000 })
console.log('其他项目 cwd 下：合并前含正文?', before.includes('只在项目A'), '合并后含正文?', after.includes('只在项目A'))
console.log('merged 字段 =', JSON.stringify({ workspaces: merged.entry.workspaces, importance: merged.entry.importance, sources: merged.entry.sources }))
```
- 期望 vs 实际：合并应是并集（workspaces 求并/取交，importance 取 max，sources 求并；v3.6 已为 aliases 做过同样的修，但只修了这一项）。实际 `merged 字段 = {}`，且其他工作区 cwd 下：合并前注入为空、合并后正文出现——工作区限定被抹掉，项目私有规则推向全局。真实库 82 条里已有带 workspaces 的条目，这是活风险。
- 建议修法：合并时 workspaces 用 `[...new Set(sources.flatMap(e => e.workspaces ?? []))]`，其它字段同样并集 / 取 max，再交给 normalizeEntry。

---

## B07 · 备份轮转按 memory.json.bak- 前缀一刀切：人工 bak-before-* 回滚点会被当第 11 份旧备份删掉

- 严重度：中
- 状态：【已复现】
- 位置：index.js:35（BACKUP_KEEP=10）、978-1002（pruneBackups 只看前缀 + mtime）
- repro：
```js
import { mkdtempSync, writeFileSync, utimesSync, readdirSync } from 'node:fs'
import os from 'node:os'; import path from 'node:path'
const M = await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js')
const host = (dir) => { const defs = new Map(); M.apply({ tools: { register: (d) => (defs.set(d.name, d), () => {}) }, effect: (f) => f(), on: () => () => {}, get: () => undefined, systemPrompt: { context: () => () => {} } }, { storeDir: dir, maxInjectChars: 1200 }); return defs }
const dir = mkdtempSync(path.join(os.tmpdir(), 'mem-b07-'))
writeFileSync(path.join(dir, 'memory.json'), JSON.stringify({ version: 1, nextId: 2, entries: [{ id: 'm1', text: '有内容', addedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }] }))
const base = Date.now() / 1000 - 30 * 86400
const files = Array.from({ length: 10 }, (_, i) => ['memory.json.bak-2026090' + i, base + i * 86400])
files.push(['memory.json.bak-before-merge', base - 86400])    // 人工回滚点，最老
for (const [name, t] of files) { writeFileSync(path.join(dir, name), '{"entries":[]}'); utimesSync(path.join(dir, name), t, t) }
await host(dir).get('memory_add').execute({ text: '触发一次写入' })
const left = readdirSync(dir).filter((n) => n.startsWith('memory.json.bak-'))
console.log('写入后剩余备份数 =', left.length, '；人工回滚点还在吗?', left.includes('memory.json.bak-before-merge'))
```
- 期望 vs 实际：轮转只该清按天自动生成的 memory.json.bak-YYYYMMDD。实际 pruneBackups 用 basename(storeFile)+'.bak-' 前缀全收，按 mtime 只留 10 个，人工那个最老 → unlink。实测剩 10 份、bak-before-merge 消失。真实库当前正好有 3 个人工点：memory.json.bak-before-aliases / .bak-before-merge2 / .bak-before-merge3（另有 bak-20261029），再攒几份就按 mtime 被吃，且完全不提示。
- 建议修法：正则只匹配 `^memory\.json\.bak-\d{8}$` 参与轮转，或轮转备份放独立目录 backups。

---

## B08 · aliases.json 没有损坏保护：解析失败静默从空开始，下一次写盘就把原文件覆盖成空（「防丢副本」不防丢）

- 严重度：中
- 状态：【已复现】
- 位置：index.js:897-912（loadAliases 的 catch 注释就是「从空开始」）、914-937（saveAliases）、950-957（syncAliases 用内存条目重建整个文件）
- repro：
```js
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'; import path from 'node:path'
const M = await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js')
const host = (dir) => { const defs = new Map(); M.apply({ tools: { register: (d) => (defs.set(d.name, d), () => {}) }, effect: (f) => f(), on: () => () => {}, get: () => undefined, systemPrompt: { context: () => () => {} } }, { storeDir: dir, maxInjectChars: 1200 }); return defs }
const dir = mkdtempSync(path.join(os.tmpdir(), 'mem-b08-'))
writeFileSync(path.join(dir, 'memory.json'), JSON.stringify({ version: 1, nextId: 2, entries: [{ id: 'm1', text: '已有条目', addedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }] }))
writeFileSync(path.join(dir, 'aliases.json'), '{ 这不是合法 JSON')     // 手工编辑失败 / 非原子工具写坏
await host(dir).get('memory_update').execute({ id: 'm1', text: '已有条目（改一下）' })
console.log('改完后 aliases.json =', readFileSync(path.join(dir, 'aliases.json'), 'utf8').replace(/\s+/g, ' ').slice(0, 100))
console.log('有没有 aliases 备份?', readdirSync(dir))
// 变体：memory.json 缺失（换 profile / 误删）时，别名旁路下一次写入即被清空
const dir2 = mkdtempSync(path.join(os.tmpdir(), 'mem-b08b-'))
writeFileSync(path.join(dir2, 'aliases.json'), JSON.stringify({ version: 1, aliases: { m1: ['别名甲'], m2: ['别名乙'] } }))
await host(dir2).get('memory_add').execute({ text: '新会话第一条' })
console.log('无 memory.json 时写入后 aliases.json =', readFileSync(path.join(dir2, 'aliases.json'), 'utf8').replace(/\s+/g, ' '))
```
- 期望 vs 实际：aliases.json 应与 memory.json 同一套损坏保护（改名留证 + 拒绝覆盖）。实际坏 JSON 被 catch 成 `aliasesSidecar = {}`，随后一次 update / add 触发 syncAliases 用当前条目重建，坏文件被原子替换成 `{"aliases":{}}`：原内容没了，没有 .corrupt 留证。memory.json 一旦缺失，旁路别名也在下一次写入被清空。注释说它是「防丢副本」，但 syncAliases 是「以条目为唯一真相源的全量投影」：条目不在 = 别名立刻消失，起不到 v3.6 想要的兜底。
- 建议修法：loadAliases 解析失败时改名 aliases.json.corrupt-<ts> 并告警；syncAliases 改成「读旧文件 → 与内存条目并集 → 只增不删」。

---

## B09 · load 对「JSON 合法但条目形状不合法」静默丢弃，下一次写入即永久覆盖（损坏保护只兜语法错）

- 严重度：中
- 状态：【已复现】
- 位置：index.js:1086-1093（filter id / text 非字符串后直接 map(normalizeEntry)）、1094-1103（只有 JSON.parse 或整体形状异常才进 corrupt）
- repro：
```js
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'; import path from 'node:path'
const M = await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js')
const host = (dir) => { const defs = new Map(); M.apply({ tools: { register: (d) => (defs.set(d.name, d), () => {}) }, effect: (f) => f(), on: () => () => {}, get: () => undefined, systemPrompt: { context: () => () => {} } }, { storeDir: dir, maxInjectChars: 1200 }); return defs }
const dir = mkdtempSync(path.join(os.tmpdir(), 'mem-b09-'))
writeFileSync(path.join(dir, 'memory.json'), JSON.stringify({ version: 1, nextId: 4, entries: [
  { id: 'm1', text: '好条目', addedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'm2', text: null, addedAt: '2026-01-01T00:00:00.000Z' },
  { id: 42, text: '数字 id 条目', addedAt: '2026-01-01T00:00:00.000Z' },
] }))
const list = await host(dir).get('memory_list').execute({})
console.log('load 后 health =', list.health, ' total =', list.total, '（原文件 3 条）')
const defs = host(dir)
await defs.get('memory_add').execute({ text: '任意一次写入' })
console.log('写完后磁盘 id =', JSON.parse(readFileSync(path.join(dir, 'memory.json'), 'utf8')).entries.map((e) => e.id))
console.log('目录 =', readdirSync(dir))
```
- 期望 vs 实际：应与语法错同等对待（留证 + 保护），或至少 health=degraded 并报「2 条无法解析」。实际静默丢 2 条、health 仍 ok；下一次写入覆盖成只剩 m1 + 新条，磁盘上看不出痕迹。唯一救命绳是 ensureDailyBackup 当天那份 .bak-<今天>（里面是全的），但 10 天后滚掉，且没有任何提示。
- 建议修法：过滤时统计丢弃条数，大于 0 置 storeHealth=degraded 并在 memory_list / 注入块里报「N 条因形状不合法被跳过，原文件已备份到 X」；或直接按 corrupt 处理。

---

## B10 · 损坏保护只在当前进程有效：按提示「重载插件」后 health=ok、库静默变空

- 严重度：中
- 状态：【已复现】
- 位置：index.js:1094-1104（rename 留证后只设置本进程 storeHealth）、967-971（初始 ok）
- repro：
```js
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'; import path from 'node:path'
const M = await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js')
const host = (dir) => { const defs = new Map(); M.apply({ tools: { register: (d) => (defs.set(d.name, d), () => {}) }, effect: (f) => f(), on: () => () => {}, get: () => undefined, systemPrompt: { context: () => () => {} } }, { storeDir: dir, maxInjectChars: 1200 }); return defs }
const dir = mkdtempSync(path.join(os.tmpdir(), 'mem-b10-'))
writeFileSync(path.join(dir, 'memory.json'), '{"entries":[{"id":"m1","text":"我还在"}')   // 半截 JSON
const l1 = await host(dir).get('memory_list').execute({})
console.log('第1个进程：health =', l1.health, ' total =', l1.total, ' 留证 =', readdirSync(dir).filter((n) => n.includes('corrupt')))
const second = host(dir)            // 等价于「重载插件」= 新进程
const l2 = await second.get('memory_list').execute({})
console.log('第2个进程：health =', l2.health, ' total =', l2.total, ' healthNote =', l2.healthNote)
await second.get('memory_add').execute({ text: '重载后新写入' })
console.log('写完后磁盘 =', JSON.parse(readFileSync(path.join(dir, 'memory.json'), 'utf8')).entries.map((e) => e.text))
console.log('目录 =', readdirSync(dir))
```
- 期望 vs 实际：原文件被隔离 = 库处于「待人工修复」态，重载后仍应提示「有 1 份 .corrupt 未处理」。实际第 2 个进程 health=ok、total=0、没有提示，memory_add 直接创建全新空库；用户和模型看到「记忆 0 条」只会以为库本来就空。数据没被删（还在 .corrupt-*），但保护态不跨进程，错误信息里「人工确认修复…并重载插件前拒绝写入」给了错误的安全感。
- 建议修法：load 时若存在 memory.json.corrupt-* 而 memory.json 不存在，同样进入只读保护态，或在 memory_list / 注入块里挂一行「上次损坏：<文件名>」。

---

## B11 · nextId 缺失时用 entries.length+1 兜底：有 id 空洞就生成重复 id，memory_remove 一次删两条

- 严重度：低
- 状态：【已复现】
- 位置：index.js:1088（nextId 兜底）、1605 / 1732 / 1904 / 2355（新 id 生成）、1838（filter 删同 id 全部）
- repro：
```js
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import os from 'node:os'; import path from 'node:path'
const M = await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js')
const host = (dir) => { const defs = new Map(); M.apply({ tools: { register: (d) => (defs.set(d.name, d), () => {}) }, effect: (f) => f(), on: () => () => {}, get: () => undefined, systemPrompt: { context: () => () => {} } }, { storeDir: dir, maxInjectChars: 1200 }); return defs }
const dir = mkdtempSync(path.join(os.tmpdir(), 'mem-b11-'))
writeFileSync(path.join(dir, 'memory.json'), JSON.stringify({ version: 1, entries: [     // 旧版 / 手工导入：没有 nextId
  { id: 'm1', text: '甲', addedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'm3', text: '丙', addedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
] }))
const defs = host(dir)
const added = await defs.get('memory_add').execute({ text: '新写入' })
console.log('新条目 id =', added.entry.id, '；磁盘 id =', JSON.parse(readFileSync(path.join(dir, 'memory.json'), 'utf8')).entries.map((e) => e.id))
const rm = await defs.get('memory_remove').execute({ id: 'm3' })
console.log('remove m3 后 total =', rm.total)
```
- 期望 vs 实际：应取 nextId = max(现有 m 后数字) + 1 = 4。实际用 entries.length+1 = 3，新条目 id=m3，磁盘出现 `["m1","m3","m3"]`；remove({id:'m3'}) 返回 removed=true 但一次删掉两条（total 3 → 1）。
- 建议修法：兜底改为按 id 里 m 后数字取 max + 1；remove 用 findIndex + splice 只删第一条，命中多条时在返回里报出来。

---

## B12 · deriveStaleAfter 混用本地时刻与 UTC 日期：本地 0:00–8:00 写入的 fact 过期日早一天

- 严重度：低
- 状态：【已复现】
- 位置：index.js:111-115（base 是本地时刻，结果用 toISOString 取 UTC 日期）、324-330（trustMark 又用 UTC today 比较）
- repro：
```js
const M = await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js')
console.log('TZ =', Intl.DateTimeFormat().resolvedOptions().timeZone)
console.log('本地 2026-10-29 00:30 写 fact → staleAfter =', M.deriveStaleAfter('fact', new Date('2026-10-29T00:30:00+08:00')))
console.log('本地 2026-10-29 09:00 写 fact → staleAfter =', M.deriveStaleAfter('fact', new Date('2026-10-29T09:00:00+08:00')))
```
- 期望 vs 实际：期望「90 天后」在本地日历上是 2027-01-27，与几点写无关。实际凌晨 0:30 写得到 2027-01-26（本地口径少一天），上午 9:00 写得到 2027-01-27：同一条事实的过期日取决于当天几点写。判定侧也都用 UTC 日期，所以不会漏标/多标超过一天，但本地 0:00–8:00 条目会提前约 8 小时进入「待重验」，报的日期也与用户日历差一天。
- 建议修法：统一用本地日期（toLocaleDateString('sv-SE') 或手工 getFullYear/getMonth/getDate 拼），today 也取本地日期。

---

## B13 · memory_update verified:true 不解除 ⏰待重验，而 audit / review 的提示说「verified:true 清除标记」

- 严重度：低
- 状态：【已复现】
- 位置：index.js:1792-1798（verified 只写 verifiedBy / verifiedAt）、2023（提示「复核后用 memory_update verified:true 清除标记」）、2148-2153（review 同一提示）
- repro：
```js
import { mkdtempSync } from 'node:fs'
import os from 'node:os'; import path from 'node:path'
const M = await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js')
const host = (dir) => { const defs = new Map(); M.apply({ tools: { register: (d) => (defs.set(d.name, d), () => {}) }, effect: (f) => f(), on: () => () => {}, get: () => undefined, systemPrompt: { context: () => () => {} } }, { storeDir: dir, maxInjectChars: 1200 }); return defs }
const dir = mkdtempSync(path.join(os.tmpdir(), 'mem-b13-'))
const defs = host(dir)
const a = await defs.get('memory_add').execute({ text: '依赖版本的事实', kind: 'fact', staleAfter: '2020-01-01' })
await defs.get('memory_update').execute({ id: a.entry.id, text: a.entry.text, verified: true })
const e = (await defs.get('memory_list').execute({})).entries.find((x) => x.id === a.entry.id)
console.log('verified 后 =', JSON.stringify({ verifiedAt: e.verifiedAt, staleAfter: e.staleAfter }), ' trustMark =', JSON.stringify(M.trustMark(e)))
```
- 期望 vs 实际：按提示复核后 ⏰ 应消失（或自动把 staleAfter 往后推）。实际 staleAfter 原封不动，trustMark 变成 `"⏰待重验 ✓已验证 "`：既说过期又说已验证，两个标记挂同一条；memory_audit 的 recheck 也继续把它算过期。按文档操作的模型会反复「复核」却清不掉。
- 建议修法：verified === true 时同步 entry.staleAfter = deriveStaleAfter(entry.kind)（无推导就 delete），或把提示文案改成「verified:true 只加 ✓」。

---

## B14 · memory_list 的 block / injectedChars 不传当前 cwd：带 workspaces 的条目永远被算作「没注入」

- 严重度：低
- 状态：【已复现】
- 位置：index.js:1261-1263（listOutput 调 renderOnce('')）、1135-1143（renderOnce 只在 cwd 非空时传 cwd）
- repro：
```js
import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'; import path from 'node:path'
const M = await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js')
const host = (dir) => { const defs = new Map(); M.apply({ tools: { register: (d) => (defs.set(d.name, d), () => {}) }, effect: (f) => f(), on: () => () => {}, get: () => undefined, systemPrompt: { context: () => () => {} } }, { storeDir: dir, maxInjectChars: 1200 }); return defs }
const dir = mkdtempSync(path.join(os.tmpdir(), 'mem-b14-'))
const defs = host(dir)
await defs.get('memory_add').execute({ text: '全局条目', pinned: true })
await defs.get('memory_add').execute({ text: '只属于项目A', pinned: true, workspaces: ['D:\\AI\\proj'] })
const l = await defs.get('memory_list').execute({})
console.log('memory_list.block 含项目A条目?', l.block.includes('只属于项目A'), ' injectedChars =', l.injectedChars)
const entries = JSON.parse(readFileSync(path.join(dir, 'memory.json'), 'utf8')).entries
console.log('真实注入（cwd=D:\\AI\\proj）含项目A条目?', M.renderMemory(entries, { cwd: 'D:\\AI\\proj', maxInjectChars: 1200 }).includes('只属于项目A'))
```
- 期望 vs 实际：memory_list 报的 block / injectedChars / injectedOverBudget 应就是当前会话真实注入的内容。实际 renderOnce('') 的 cwd=''，applicableAt 对任何带 workspaces 的条目返回 false，于是 list 里这些条目永远显示「没进块」、injectedChars 偏小；真正装配系统提示时 cwd 有值，它们会被注入。memory_audit 的 budget.injectedChars、memory_review 的「本轮注入」同样偏低。另外全部条目都被 workspaces 过滤掉时，renderMemory 仍吐一个只有头部的空 <memory> 块，白占预算。
- 建议修法：listOutput / review 也走 currentCwdOf(context)（或接受可选 cwd 参数）；renderMemory 过滤后为空时返回空串。

---

## B15 · aliases 不参与 maxBytes、不去重、无长度 / 条数上限

- 严重度：低
- 状态：【已复现】
- 位置：index.js:293-296（normalizeEntry 只滤空串，不 trim 后去重）、1133（usedChars 只累加 text.length）、1594（只按 text 判预算）
- repro：
```js
import { mkdtempSync, statSync } from 'node:fs'
import os from 'node:os'; import path from 'node:path'
const M = await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js')
const host = (dir) => { const defs = new Map(); M.apply({ tools: { register: (d) => (defs.set(d.name, d), () => {}) }, effect: (f) => f(), on: () => () => {}, get: () => undefined, systemPrompt: { context: () => () => {} } }, { storeDir: dir, maxInjectChars: 1200 }); return defs }
const dir = mkdtempSync(path.join(os.tmpdir(), 'mem-b15-'))
const defs = host(dir)
const r = await defs.get('memory_add').execute({ text: '短文本', aliases: ['', '  ', '甲', '甲'] })
console.log('aliases =', JSON.stringify(r.entry.aliases))
await defs.get('memory_add').execute({ text: '再来一条', aliases: Array.from({ length: 400 }, (_, i) => '别名' + i + '-'.repeat(20)) })
const l = await defs.get('memory_list').execute({})
console.log('400 个别名后 memory.json =', statSync(path.join(dir, 'memory.json')).size, '字节；usedChars =', l.usedChars, '/', l.maxBytes)
```
- 期望 vs 实际：aliases 应去重并计入存储预算，否则 maxBytes=8000 的「超预算拒绝写入」可被绕开。实际重复项保留（`['甲','甲']` 不去重），400 个别名把 memory.json 撑到 16.7 KB 而 usedChars 仍报 15/8000，工具返回「已记住」。
- 建议修法：normalizeEntry 里 aliases 先 trim 再去重，加单条长度上限（如 60 字符），并把 aliases 总字符数并入 maxBytes。

---

## B16 · memory_merge 接受重复 id（「至少两个」只数了数组长度），把同一条合并两次

- 严重度：低
- 状态：【已复现】
- 位置：index.js:1884-1888（ids.filter 后只判 length，sources 未去重）
- repro：
```js
import { mkdtempSync } from 'node:fs'
import os from 'node:os'; import path from 'node:path'
const M = await import('file:///D:/AI/dsh-bundles/dsh-memory/index.js')
const host = (dir) => { const defs = new Map(); M.apply({ tools: { register: (d) => (defs.set(d.name, d), () => {}) }, effect: (f) => f(), on: () => () => {}, get: () => undefined, systemPrompt: { context: () => () => {} } }, { storeDir: dir, maxInjectChars: 1200 }); return defs }
const dir = mkdtempSync(path.join(os.tmpdir(), 'mem-b16-'))
const defs = host(dir)
const a = await defs.get('memory_add').execute({ text: '唯一一条记忆' })
const merged = await defs.get('memory_merge').execute({ ids: [a.entry.id, a.entry.id] })
console.log('ids=[m1,m1] 被接受 → merged =', JSON.stringify(merged.merged), ' text =', merged.entry.text)
```
- 期望 vs 实际：应报「需要两个不同的 id」。实际通过校验，合并文本变成 `"唯一一条记忆；唯一一条记忆"`：唯一来源被标 superseded，又生成一条自我重复的新条目（active 数不变但正文翻倍，memory_audit 会列为重复候选）。
- 建议修法：`const ids = [...new Set(filtered)]` 之后再判 length >= 2。

---

## B17 · persist 兜底分支（rename 失败后直接覆盖写）不是原子写，崩溃会留下半截 memory.json

- 严重度：低
- 状态：【疑似】（本机无法稳定制造 rename 失败，未跑出半截文件；代码路径确定存在）
- 位置：index.js:1060-1066（writeFileSync(temp) → renameSync(temp, storeFile)，失败则 writeFileSync(storeFile, body)），同写法见 926-932（aliases）、1041-1047（candidates）
- repro：
```js
// 让 renameSync 失败（Windows 上目标被独占 / 被 AV 占用、跨卷、目标为目录），
// 兜底就会 writeFileSync(storeFile) 直接覆盖 —— 先截断再写，进程写到一半被杀即为半截 JSON。
// 1060-1066：
//   try { renameSync(temp, storeFile) } catch { writeFileSync(storeFile, body) }
// 半截文件的下场：load() JSON.parse 抛错 → 改名 .corrupt-* → state 清空 → B10（静默空库）。
```
- 期望 vs 实际：兜底应走「重试 rename / 二次临时文件」，失败就 return false 让上层报错。实际直接覆盖目标文件，非原子；崩溃后按 B10 的路径被隔离成空库（原始内容只剩 .corrupt-* / .bak-*）。
- 建议修法：删掉直接覆盖的兜底，rename 失败重试 2–3 次，仍失败就让 persist 返回 false 并由工具报错（与 B01 一起修）。

---

# 附：检查过但没有发现问题的点（避免重复劳动）

1. memoryEntrySchema 与 normalizeEntry 当前一致，未触发 invalid output：真实库 82 条条目的字段并集（id / text / scope / kind / migratedFrom / usedCount / importance / tags / aliases / pinned / lastUsedAt / addedAt / updatedAt / supersededBy / status / workspaces / staleAfter）全部在 schema properties 里，normalizeEntry 也只产白名单字段；list / search / add / update / merge / audit / review 的返回结构实测都过 schema。
2. 参数边界（实测拦住）：memory_add 空 text 报错、超 600 字符报错；memory_update 空 id / 空 text / 不存在的 id 报错；memory_merge 不存在的 id 报错（B16 的重复 id 除外）；memory_search 空 query 报错；importance 越界钳到 1–10；status 非法枚举报错；staleAfter 非 YYYY-MM-DD 报错；aliases 空串被过滤。
3. memory_audit 的重复 / 过期 / scope / 预算统计与 active 口径一致（deprecated 与 superseded 都已排除），stale 用 updatedAt 且过滤 usedCount=0，未见口径错误。
4. memory_remove 不回收 nextId（不复用旧 id）是正确设计；只要 B11 的兜底不触发就不会撞号。
5. ensureDailyBackup 时序正确：先拷当前文件再写，每天只备份一次。
6. corrupt 留证文件名（replace(/[-:T]/g,'').slice(0,14)）实测生成 memory.json.corrupt-20261029073112，格式正确。
