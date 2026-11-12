# CHANGELOG

本文件从 v3.20 起建立（按「改到谁补谁」的规则补上）。更早的版本记录见 [README.md](README.md) 的版本节。
格式：Keep a Changelog；版本号跟 `package.json`。

## v4.14.0（2026-11-12）

**淘汰机制补上「可观测 + 可审计 + 不说谎」**——取经 Hermes 的 no-op 原因日志与 run report，起因是 2026-11-12 的真实观测：
记忆 11945/12000（99.5%）时 `memory_add` 已经被拒，而 `memory_status.health` 仍报 `ok`，`lastRunAt` 仍为空——
诊断说没事、动作却失败，且分不清「维护没跑」和「跑了没事可做」。

### Added
- `maintenance.json`（旁路小文件，不碰主库 schema / SQLite 迁移）：每次维护运行都落一条统计——
  `lastRunAt / checked / archived / promoted / skipped{pinned,rule,draft,notDue,grace} / note`。
  归档为 0 的那次也写：`note` 说明「不是没跑」，这正是 Hermes no-op 原因日志的作用。
- `archive-manifest.jsonl`：每条归档一行（`ts/by/id/reason/signal/chars`），append-only；超 2MiB 轮转一份 `.1`。
  预算腾挪（makeRoom）与 curator 归档同一格式；**主库落盘成功后才追加**，避免「manifest 说归档了、主库没写成功」的假账。
- `memory_status.budget: {used, max, remaining, state}`：`ok < 95% ≤ degraded`、`used ≥ max` 为 `full`。
- `memory_status.maintenance` 扩为 `{lastRunAt, checked, archived, promoted, skipped, note}`，重启后从旁路文件恢复。

### Changed
- `memory_status.health` 不再只看库完整性：预算 degraded/full 时同步报 degraded/full（`ok` 只在真的能正常写时出现）。
- `memory_status` 渲染行补「检查/归档/巩固/各类跳过原因」与预算告警；写满时直接给出口（memory_remove 精简或调 maxBytes）。
- 代码指纹 → `4.14.0-elimination-observe`。

### 测试
- `memory.test.mjs` 146 项全过（+2）：①构造 90 天前到期条目 → 真机路径归档 1 条、rule 计入 skipped、manifest 1 行、重启后统计仍在；
  ②预算 90%→95%→写满三档：`state`、`health`、`remaining` 与「下一次写入是否被拒」逐档对齐。
## v4.13.0（2026-11-11）

**domain 受控词表**——把 155 个自由 tag 收成 12 个可检索的粗分类，不动历史数据。

### 背景（v4.12 遗留的真瓶颈）
- v4.12 的分类检索机制真机通过（`total == matches`），但端到端聚合覆盖只到 50%。
- 根因不在代码而在数据：**113 条记忆上有 155 个 tag**，同义并存严重——
  `plugin-dev`(10)/`plugin`(2)/`dsh-plugin`(1)、`dsh-memory`(8)/`memory`(3)/`记忆`(3)、
  `硬规则`(9)/`rule`(5)/`workspace-rule`(1)、`HMR`(2)/`hmr`(1)、`验证门`(2)/`verification-gate`(1)/`verify-gate`(1)。

### Added
- `lib/tagdomains.js`：12 个受控 domain（rule / memory / plugin-dev / dsh / ops / research / obsidian /
  machine / eval / workbuddy / security / identity / misc）+ 反向索引 + `expandTagFilter` / `domainsOfEntry`。
- `memory_search` 的 `tags` 参数支持 **domain 名展开**：传 `plugin-dev` 会命中该域下所有原 tag；
  传原 tag 仍精确匹配（向后兼容）。
- `memory_status.facets` 新增 `domains`（域覆盖条目数）与 `unclassified`（无有效 tag 的条目数）——
  后者是数据治理的观测值，不是装饰。

### 数据修正（只补不改）
- 补了 4 条无 tag 条目的标签（m246/m247/m248/m249，都是硬规则类）。
- 补了 9 个遗漏 tag 的映射（env / 命名 / ops / 架构 / 规则收窄 / 整体进化 / 落地 / 乔布斯 / verified）。
- 映射覆盖：155 个 tag 中 146 已映射（94%）；未分类条目从 5 降到 **0**。

### 为什么不批量改历史 tag
- 题集 gold（23 道 benchmark）与既有检索行为都依赖当前 tag 分布，批量改会同时移动基线和行为，
  改完无法判断「变好是因为分类对了，还是因为基线被改了」。
- 两层分类是只读视图：随时可调映射、可回滚，且原 tag 的细粒度检索能力不丢。
## v4.12.1（2026-11-11）

**修分类浏览被两处机制砍条**——真机暴露，两处都只在「带过滤 + SQLite 后端」时出现。

### Fixed
- 第一处：**兜底空分类**。FTS5 候选集只返回词面命中的条目，分类浏览拿它会漏人：
  实测 `tags=[plugin-dev]` 时 `total=10` 却只回 2 条，另外 8 条跟 query 没有共同词。
  修法：带 tag/scope 过滤时**走全量扫描**（`scoreEntries`），不走 `scoreEntriesIndexed`。
- 第二处：**分数门槛**。`score > 0.0001` 会把「query 词面不重合 → 分数 0」的同类条目砍掉。
  修法：分类浏览时不做分数门槛——「列出这一类」的语义不是「找最像的几条」，排序只是锦上添花。
- 指纹：`4.12.0-tagfilter` → `4.12.1-tagfilter-fullscan`（行为改动必须同步指纹，否则无法区分进程里跑的是哪版）。

### 已知限制（v4.13 待办，诚实记录）
- **tag 碎片化是分类检索的真瓶颈**：113 条记忆上有 **155 个 tag**，同义并存严重——
  `plugin-dev`(10)/`plugin`(2)/`dsh-plugin`(1)、`dsh-memory`(8)/`memory`(3)/`记忆`(3)、
  `硬规则`(9)/`rule`(5)/`workspace-rule`(1)、`HMR`(2)/`hmr`(1)、`验证门`(2)/`verification-gate`(1)/`verify-gate`(1)。
  实测：分类检索跑 5 个聚合问题，机制层全部生效（total==matches），但关键点覆盖只从 33% 升到 50%；
  只有「记忆系统升级」这类 tag 恰好整齐的题做到 0/5→5/5。
- 结论：**机制已修好，数据未治理**。v4.13 要做的不是再加检索参数，而是 tag 体系（归并同义 / 补全漏标 / 考虑两层：领域 + 主题）。
  不能靠批量改历史 tag 了事——题集 gold 与检索行为都依赖现状，需要先设计再动。

### 教训
- 同一功能的两道机制（候选集 / 准入门槛）要一起审：只修一处，另一处照样砍条。
- 「机制修好了」不等于「功能好了」：数据质量（tag 分类）是可以比代码更硬的瓶颈。判据是端到端覆盖率，不是单元测试绿。
- 判据不能只看「返回了几条」，要看 `total`（过滤后语料总量）与 `matches` 是否一致——本文档第 1 条的发现就来自这个对账。
## v4.12.0（2026-11-11）

**分类检索**——补 synthesis 缺口的零模型解法：聚合问题靠「分类」不靠「匹配」。

### 背景（先量再改）
- 用 5 个聚合问题（「记忆系统做过哪几次升级」「陛下立过哪些硬规则」等）测 top10 关键点覆盖：
  **平均 33%**（最低 0/5）——BM25 打分只能「找最像的几条」，无法「把某类全部捞出来」。
- 加多说法查询后升到 53%，仍不够。根因不是查询词，是**检索维度**：聚合是分类问题。
- 权威前沿佐证：Hindsight（arXiv 2512.12818，2025-12）四网络 + retain/recall/**reflect**，
  LongMemEval 39%→83.6%、扩展 backbone 91.4%。synthesis 是独立缺口；但臣先用零模型方案补分类层。

### Added
- `memory_search` 新增 `tags: string[]`（OR 过滤）与 `scope: string` 过滤：先按类目收窄语料，再在类内打分排序。
- `memory_status` 新增 `facets`（tag / scope 分布，tag 报前 20）：agent 看到分类才知道该用哪个标签捞。
- 返回中回显 `filters`（实际生效的 tags/scope）。

### 依据
- 数据：tag 分布 plugin-dev(10) / 硬规则(9) / dsh-memory(8)；scope global(40) / plugin-dev(35) —— 分类维度本来就清晰，缺的只是入口。
- 测试：`_selftest/tests/memory-tagfilter.test.mjs`。
## v4.11.0（2026-11-11）

检索召回提升——**先量再改**：23 题基准 Recall@5 从 0.783 提到 0.870，并把「换说法」做成机制。

### Added
- `memory_search` 新参数 `queries: string[]`（最多 5 个额外说法）：每个说法独立打分、每条记忆取**最高分**（max-pooling），
  覆盖率与门槛按最能对上的那个说法算；不传时行为与 v4.10 完全一致。
  依据：同一问题换说法，三道语义缺口题从**全库第 6/6/8 名升到第 1 名**（4.06→22.95 / 7.49→32.96 / 8.24→58.17）——
  缺的不是算法，是**查询用词**；agent 本身就是 LLM，让它一次给几种说法比插件再调一次模型便宜得多。
- 同义组补 5 组（重启 / 改名 / 交付 / 自研 / 卸载），覆盖「口语提问 vs 书面记忆」最常见的缺口。

### Fixed
- `_ops/memory-bench.mjs` 补 **gold 存在性校验**：原脚本注释声称校验、代码里实际没有，
  3 道 gold 已被清理的题被静默算成「未进前 5」，把真基线 21/25 报成 18/25。现在无效题直接 `exit 3`，不再给假分。
- 基准加诊断：未命中时输出 gold 的**全库名次与分数差**——名次 6 和名次 80 是两种病，只看「未进前 5」分不出来。
- 题集修正：q01 的 gold m179 → m188（等价条目换代）；q18(m148) / q24(m71) 主题已在后续清理中不存在 → 删题（25→23）。

### Changed
- render：命中偏少时提示「用 queries 给几种不同说法再搜」，不再只对低置信度说「换个关键词」。

### 依据
- 度量先行：`node _ops/memory-bench.mjs` 三个数（Recall@5 / 存储预算 / 正文外移率），改前 0.783 → 改后 0.870。
- 测试：新增 `_selftest/tests/memory-multiquery.test.mjs`（8 项，含 max-pooling 必须等于两者最大值而非相加）。
## v4.10.0（2026-11-11）

实体解析（entity resolution）——零 LLM，图仍是派生视图（不建第二权威源）。

- 新增 `lib/entity.js`：称谓前缀规范化（我的同事X / my coworker X → X）、归一 key、别名表、疑似重复候选、健康度统计。
- 写入路径：memory_add / memory_update 的 entities 经 `resolveEntities`（规范化 + 别名归并 + 去重）。
- 检索路径：memory_search 的 entity 用 `expandEntityKeys` 展开别名；`entityCoccur` 改归一比对（修 Alice / alice 漏匹配）。
- 新增 3 个工具：`memory_entity_status`（健康度）/ `memory_entity_resolve`（单实体视图）/ `memory_entity_merge`（合并，confirm 门）。
- 别名表落旁路文件 `entity-aliases.json`（与 aliases.json 同模式，对旧版本不可见，免疫「未知字段被洗掉」）。
- 修：`entityStats` 用归一 key，大小写不同算同一实体（原按 normalizeEntity 计，会虚高）。
- 测试：新增 `_selftest/tests/memory-entity.test.mjs`（10 组断言）；旧 144 项 + oracle 12 项保持通过。
## v4.9.0 — 2026-11-10

标题：「完整 curator」——信任增量（dedup→confidence++）+ 矛盾浮现（surface contradictions）。

### Added
- 信任增量：memory_add 写入几乎一致内容（相似度 ≥0.97）→ 旧条目 verifiedCount++（置信度提升），不新增重复。对齐 core-memory-kit「dedup hit → confidence++」。
- `detectContradictions` 纯函数：同 entity 的条目对、文本非重复（相似度 <0.9）→ 疑似矛盾。只浮现不自动失效（零模型误杀风险，交人/LLM 确认）。
- memory_audit 加 `contradictions` 报告。

### Changed
- 冲突门改进：v4.0「高度相似必拒」→ v4.9「只差标点（相似度 1.0）dedup→confidence++，内容不同才拒绝」。

### 依据
- core-memory-kit（trust delta：dedup→confidence++、downgrade on supersede）、ai-memory-mcp（autonomous curator daemon surface contradictions）、Cognee improve（feedback-weighted consolidation）。

### 测试
- 单测 142 → 144（新增：detectContradictions 纯函数 + 信任增量端到端）。


## v4.8.0 — 2026-11-10

标题：「用户画像」——slot 槽位 + profileView 聚合，memory_search slot 查询。

### Added
- `PROFILE_SLOTS`（identity/preference/habit/environment/taboo/goal/milestone）槽位定义 + 中文标签。
- `slot` 字段：memory_add/update 两侧支持，白名单校验。
- `profileView` 纯函数：按槽位聚合画像，读不碰 LLM。
- memory_search 加 `slot` 参数：按槽位过滤（或 all），返回 `profile`（完整画像）。

### 依据
- Memobase typed taxonomy（8 主题/~40 槽位）的零模型版：画像=结构化槽位，不是笔记袋；读路径纯 SQL/内存、不碰 LLM。

### 测试
- 单测 140 → 142（新增：profileView 纯函数 + slot 写入/过滤/画像端到端）。


## v4.7.0 — 2026-11-10

标题：「实体图视图」——entityIndex + entityCoccur 纯函数，memory_search 加 entity 过滤；图作为派生索引，不另起权威源。

### Added
- `entityIndex`（实体→记忆倒排）、`entityCoccur`（实体共现，按频次）纯函数——从 entries 的 entities 标签派生「图视图」，零模型、零图库。
- memory_search 加 `entity` 参数：按实体过滤检索，返回 `coccurring`（与它共现的实体，按频次）。

### 依据
- graph-taxonomy（arXiv:2602.05665）：图作为「索引/视图」而非「权威存储」；上次 v4.6.0 实体图塞核心导致挂载失败，这次复用已有工具、不新建。

### 测试
- 单测 138 → 140（新增：entityIndex/entityCoccur 纯函数 + entity 过滤端到端）。
- 判据锚：写「用户+Anthropic」「用户+OpenAI」「DSH」，entity=用户 只回前两条，共现=Anthropic/OpenAI。


## v4.6.0 — 2026-11-10

标题：「bi-temporal 时间分层」——补全 validFrom 事件时间起点 + at_time 点时间查询，对齐 Graphiti/memv 双时间戳。

### Added
- `validFrom` 语义补全（此前是 v2.6.1 捡回的「幽灵字段」——只存不用、无工具入口）：memory_add / memory_update 两侧支持；YYYY-MM-DD 或 ISO，非法报 `MEMORY_DATE_INVALID`，空串清除。
- 点时间查询：memory_search 加 `at_time` 参数（YYYY-MM-DD 或 ISO），返回「那一刻为真」的条目（validFrom 已到、invalidAt 未到）。
- 纯函数：`isNotYetValid`（validFrom 未到=尚未生效）、`isTrueAt`（区间 [validFrom, invalidAt) 内为真）、`parseTimestamp`（统一日期/ISO 解析，消除 isInvalidEntry 与新函数的重复）。

### Changed
- 注入（render.js）与检索（memory_search）过滤从「只拦 invalidAt」升级为 `isTrueAt`——validFrom 未到的条目不注入、不检索。
- 检索结果补 validFrom/invalidAt 字段（点时间查询能看到事实区间）。

### 依据
- Graphiti/memv bi-temporal（事件时间 valid_at/invalid_at + 事务时间 created_at/expired_at）；Zep temporal KG（arXiv:2501.13956）；Memobase 靠 event timeline 拿 LoCoMo temporal 85.05%。
- 调研来源：agentic-memory 合集（ANALYSIS-arxiv-2501.13956-zep.md、vendor/memv/docs/concepts/bi-temporal.md）。

### 测试
- 单测 136 → 138（新增：纯函数 isNotYetValid/isTrueAt/parseTimestamp + 点时间查询端到端）。
- 判据锚：写「1月Anthropic（3月失效）」「3月OpenAI」，点时间查 2月只回 Anthropic、3月只回 OpenAI、现在只回 OpenAI，两条留档；validFrom 未到不注入。


## v4.6.0 — 2026-11-09（已回滚）

零模型实体共现图（memory_entities 工具 + lib/entities.js）——因塞进 dsh-memory 导致挂载失败（Cordis schema 验证/新增依赖问题），已回滚，转独立插件 dsh-memory-entities。教训：新维度应独立插件，不塞核心记忆插件（「一切皆插件」）。

## v4.6.0 — 2026-11-09

标题：「零模型实体共现图」——新工具 memory_entities + 实体倒排。

### Added
- `lib/entities.js`：`queryEntity` 纯函数，零模型实体共现图（倒排 + 共现，不做语义关系）。
- 新工具 `memory_entities`：查实体出现在哪些记忆、与谁共现，回答「X 和 Y 通过哪些共享记忆关联」。

### 说明
- 这是 Graphiti 实体图的最小零模型版。实体覆盖率当前只有 14/103（13.6%）、22 个实体、共现稀疏——能力先建、标签后补。

### 测试
- 单测 136 → 137（新增 v4.6 实体共现图）。

## v4.5.2 — 2026-11-09

标题：「作用域治理」——DEFAULT_SCOPE_ROOTS 把 dsh-创建 归入 plugin-dev 域。

### Changed
- DEFAULT_SCOPE_ROOTS 修正：plugin-dev 加 `D:\AI-date\dsh-date\dsh-创建`。此前 dsh-创建（cwd 在 dsh-date 下）被 detectScope 判成 dsh-date，28 条 plugin-dev 条目被当「跨域」压成 14 字 compact；现在正确识别为 plugin-dev，本域条目完整渲染。
- 数据治理：35 条 unscoped 补标 scope/workspaces——6 条 global 价值观、28 条 plugin-dev + workspaces=[dsh-创建]、m239 补 global。

### 测试
- detectScope 断言更新（dsh-创建→plugin-dev），补「亲爱的管家仍 dsh-date」防误伤；单测 136 项全过。

## v4.5.1 — 2026-11-09

标题：「停用词补漏 + bench 口径修正」——修两处实践检验暴露的问题。

### Fixed
- 中文停用字补「少」：此前「多少」不在停用表，负例「今天汇率多少」单命中「多少」（df=1、覆盖率 0.300 越过长查询单单元门槛 0.25）被误注入。补「少」后「多少」成为纯虚词被过滤，负例误注入 4.8% → 0，recall@1/3 仍 0.969。
- bench 口径修正（`_selftest/memory-bench.mjs`）：默认读 SQLite `memory.db`（此前读迁移前的旧 `memory.json`）+ `BUDGET` 1500 → 2500（对齐生产 `maxInjectChars`）。旧口径误报负例误注入 0，修正后才暴露上面这条。

### 测试
- 单测 136 项全过；bench recall@1/3 0.969、负例误注入 0、注入覆盖 0.375。

## v4.5.0 — 2026-11-09

标题：「软期限≠硬失效」——新增 `softDeadline` 字段，对齐 Graphiti「软期限不算 invalid_at」（edges.py:281-284）。

### Added
- `softDeadline` 字段（YYYY-MM-DD，可选）：目标/计划日期。到期**不失效**（仍注入与检索），只转「该复核」（`isStaleEntry` 判 stale、注入带 ⏰、排序降权）。与 `invalidAt`（硬失效，到期隐藏）严格区分。
- 写入（memory_add）与更新（memory_update）两侧都支持 `softDeadline`；非法日期格式报 `MEMORY_DATE_INVALID`，空串清除。
- 卡片导出（`cardMarkdown`）补 `softDeadline` frontmatter。

### 依据
- Graphiti 源码：软期限明确不算 `invalid_at`，代码层 `normalize_future_temporal_bounds` 正则兜底（`temporal_edge_utils.py:15-71`）。此前 `invalidAt` 单字段会把「by March 2026」这类软期限误判为过期。

### 测试
- 单测 131 → **136**（新增 5 项：软期限到期=stale / 未到=不 stale / 软期限过期≠失效 / 只有 invalidAt 才失效 / normalize 保留与非法丢弃）。
- 全部门 `npm run check` 通过（31 通过 · 0 警告 · 0 失败）。

## v4.3.1 — 2026-11-05

标题：「拆完扫尾」——清掉两处拆分后暴露的死代码，无行为变化。

### Removed
- `lib/constants.js` 的 `RELEVANT_CONFIDENCE`：全仓无引用（拆分前就是死常量，匿名覆盖时留下的）。
- `lib/store.js` 的 `schemaUpgraded` 状态与 getter：只写不读（迁移信息实际由 `state.version` 与 `memory_status.schemaVersion` 承载）。

### 测试
- 五套回归仍全过（133 / 12 / 7 / 10 / 6）；`node --check` 全通过；拆分前后导出面 45 个名字逐一对齐（`_reports` 见 CHANGELOG v4.3.0）。

## v4.3.0 — 2026-11-05

标题：「把 apply 拆成组装层」——存储层（状态 + 双后端持久化 + 备份 + 别名旁路 + 候选池 + 归档）搬进 `lib/store.js` 的 `createStore()` 工厂，`apply` 只负责组装与工具注册。工具名/参数/返回结构、检索与写入行为一行未变。承接同日的 v4.2.3（顶层辅助函数拆出 lib 九模块）。

### Changed（结构，无行为变化）
- 新增 `lib/store.js`（约 1900 行）：`createStore({ ctx, config, maxBytes, maxInjectChars, scopeRoots, relevanceFloor })` 返回存储入口——`load/persist/refreshBeforeWrite/newEntryId/makeRoom/persistCandidates/...` 等 30 个函数，加 7 个 getter（`storeHealth/corruptCopy/schemaUpgraded/db/usageDirty/lastUsageFlush/lastKnownCwd`）。可变标量走 getter，避免工具层拿到创建时的快照。
- `state` / `candidates` 改成**稳定对象 + 原地替换**（`replaceState/replaceCandidates`）：原来 `state = {...}` 整体赋值会把工具层握着的引用变成旧对象——这是拆分时唯一必须改语义的地方，专门加了注释与两个替换函数。
- `index.js` 5861 → **2271 行**（v4.2.3 的 4157 再降 1886）；`apply` 只剩配置校验、工厂装配、14 个工具注册、注入层挂载。
- `codeFingerprint` 提到 `4.3.0-store-factory`。

### 测试
- 同一套回归全过：`memory.test` 133、`memory-oracle` 12、`memory-schema` 7、`memory-sqlite` 10（含双进程并发写）、`memory-v42` 6。
- 拆分过程中用「真机指纹 + 全量回归」逐步收敛：先搬数据层（存储/别名/备份），再搬派生视图（isActive/usedChars/renderOnce），每步跑测试；`ctx` 传入工厂后才把 `currentCwdOf` 等依赖修正。
- 真机验收：重组后 `memory_status` 返回 `4.3.0-store-factory`，条目/字符数与拆分前一致。

## v4.2.3 — 2026-11-05

标题：「拆单文件巨无霸」——把 5861 行的 `index.js` 按职责拆成 `lib/` 九个模块，工具名/参数/返回结构一行未变，检索与写入行为零改动。起因：体检 L4「巨无霸」长期 warn（>3000 行评估线），且该文件 45 天内被改 37 次，每次改动都落在一个 4032 行的 `apply` 闭包里。

### Changed（结构，无行为变化）
- 顶层辅助函数整体迁出：`lib/constants.js`（调参与存储常量）、`lib/util.js`（fail/text）、`lib/entry.js`（时效/重要性/作用域）、`lib/text.js`（分词与相似度）、`lib/score.js`（BM25 + 覆盖率 + 门槛）、`lib/render.js`（注入渲染）、`lib/schema.js`（规范化/迁移/卡片）、`lib/candidates.js`（候选抽取）、`lib/store-snapshot.js`（只读快照）。
- `index.js` 只保留 `apply` 组装层，并把原公共导出逐个 re-export，外部导入面（测试/其它插件）保持完全一致。
- `zh-words.txt` 随分词模块迁到 `lib/`，`package.json` 的 `files` 补 `lib/`。
- `codeFingerprint` 提到 `4.2.3-lib-split`（真机验证 HMR 是否已换新代码的观测点）。

### 测试
- 拆分前后同一套回归：`memory.test.mjs` 133、`memory-oracle` 12、`memory-schema` 7、`memory-sqlite` 10、`memory-v42` 6 全过；`npm run check` 三道门通过。
- 真机验收：重组后 `memory_status` 返回新指纹 `4.2.3-lib-split`，`memory_list` 计数与拆分前一致（115 条 / 生效 93 / 11185 字符）。

## v4.2.2 — 2026-11-03

标题：「修全局审计 H2 + B4」——SQLite 多进程并发写不再静默丢条目；`memory_remove` 加 `confirm:true` 门槛。新增错误码 `MEMORY_ID_CONFLICT`；`memory_remove` 新增可选参数 `confirm`、返回值新增预览字段。证据：`_reports/global-audit-memory-2026-11-03.md` §H2/§M5、`_reports/fix-backlog-2026-11-03.md` A1/B4。

### Fixed（高危）
- **H2 SQLite 双进程并发写丢条目**：旧实现 `persistSqlite()` 先 refresh、到写事务里才落盘，而 id 是在 `execute()` 里按 `m${state.nextId}` 发的 → 「读 nextId → 写」TOCTOU；主键冲突走 `ON CONFLICT(id) DO UPDATE` 静默覆盖。现在 ① 新增 `newEntryId()` 在 `BEGIN IMMEDIATE` 内原子发号（读 `meta.next_id` → +1 写回 → COMMIT），所有条目创建点统一走它；② 新条目只 `INSERT`、既有只 `UPDATE`，本进程新发的号撞上库内已有 id 时抛 `MEMORY_ID_CONFLICT`（含 id、提示重试）并回滚，内存态回退到磁盘版本；③ `refreshSqliteState()` 后清空 meta 统计键缓存（原只刷 `next_id/write_seq/data_version`，`sort_doc_count` 等拿旧值写回 → `docCount` 偏小 → idf 变负 → 检索静默 0）；④ 每次写事务末尾按 `entries` 实际行数对账 `sort_doc_count` / `unit_doc_count` / `next_seq`，`next_id` 只增不减；⑤ `memory_search` 前按 `write_seq` 刷新（未变只多一条单行查询）。
- **B4 `memory_remove` 无确认门槛**：原来直接 `filter` + persist，单条物理删比批量 `memory_purge`（必须 `confirm:true`）还宽松。现在不带 `confirm:true` 不删，返回 `{ removed:false, confirmRequired:true, preview:{id,chars,pinned,kind,usedCount,text}, hint }`（提示先 `memory_list` 核对删除三查）；`confirm:true` 才物理删。

### 测试
- `_selftest/tests/memory-sqlite.test.mjs` 新增第 10 组：两个 node 子进程在同一临时库上各 `memory_add` 8 条（真实 `apply()` + 工具调用，带「同时加载 / 每轮同时开写」屏障），断言 16 条全在、16 个 id 互不重复、两进程 `memory_search` 都非 0、`meta.sort_doc_count/unit_doc_count` 与 `entries` 行数一致、`next_id`/`next_seq` 自洽。修复前该用例失败（distinct ids 12/16），修复后通过（连跑 4 次稳定）。
- `_selftest/tests/memory.test.mjs` 新增 B4 用例：无 confirm 只给预览不删（字符数 / pinned / hint 含 memory_list 与 confirm:true）、`confirm:true` 才删、未确认的另一条不被连带删；既有 `memory_remove` 调用点补 `confirm:true`。
- `_ops/memory-diff-search.mjs` 的 memory_remove 差分步骤同步补 `confirm:true`（旧版本副本忽略多余参数，差分口径不变）。

## v4.2.1 — 2026-11-03

标题：「修全局审计 H1 + M1/M2/M3」——JSON 后端不再同步死循环；procedure 复用门槛的三条绕过路径全部堵住。工具名与既有参数集不变（`memory_merge` 只新增可选 `verifiedCount`；新增错误码 `MEMORY_VERIFIEDCOUNT_INVALID`）。证据：`_reports/global-audit-memory-2026-11-03.md` §1 H1、§2 M1–M3。

### Fixed（高危）
- **H1 JSON 后端同步死循环**：`persist()` 原顺序是「先 `acquireLock()` 后 `mkdirSync`」。`storeDir` 不存在/不可写时锁文件 `wx` 写失败 → `statSync` 也失败 → `acquireLock()` 内层 catch `continue`，deadline 检查永远走不到 → 纯自旋堵死整个 DSH 进程（事件循环全停，只能杀进程），而 `storage:'json'` 正是官方给的「回滚开关」。
  现在：`mkdirSync(storeDir,{recursive:true})` 提到取锁之前（新增 `ensureStoreDir()`，失败抛 `MEMORY_STORE_WRITE_FAILED`）；锁目录不存在 → 立刻抛 `MEMORY_STORE_LOCKED`（可读错误，不重试）；`wx` 失败且 errno 不是 `EEXIST` → 立刻抛；内层 catch 不再 `continue`，统一落到 deadline/sleep；陈旧锁只有「真删掉」才 `continue`，否则仍受 deadline 约束。
- **M1 去重分支绕过 procedure 门槛**：`memory_add` 命中完全重复时在 procedure 门槛之前 `return`，且可任意改 `kind`——「先 add fact，再用同一文本 add kind:procedure」即可绕过。现在去重分支对「去重后实际 kind」跑同一道闸：改成 procedure 必须本次显式给 `verifiedCount ≥ 2`，否则 `MEMORY_PROCEDURE_UNVERIFIED`。
- **M2 空条目 supersede**：`memory_update {verifiedCount, supersede:true}` 不带 `text` 会造出 `text:''` 的新条目并把旧条作废。现在 `supersede` 要求 `text` 非空（`MEMORY_ARG_MISSING`）。
- **M3 两步升级 procedure**：`verifiedCount` 原来任意 kind 都能写，「fact 先灌 2 → 再改 kind=procedure」即可过闸。现在：`verifiedCount` 只允许写在 procedure 条目上（`MEMORY_VERIFIEDCOUNT_INVALID`，add/update/merge 三处同口径）；把 kind 改成 procedure 必须**本次显式**给 `verifiedCount ≥ 2`（不沿用存量值）；kind 离开 procedure 时清掉 `verifiedCount/lastVerifiedAt`（堵「降级再升级」）；`memory_merge` 只继承 procedure 来源的证据，并新增可选 `verifiedCount` 参数。

### 测试
- `_selftest/tests/memory.test.mjs`：H1 用 `child_process.spawnSync` + 5s 超时断言「子进程必须退出」，不直接 `await`——① storeDir 不存在 → 快速成功（mkdir 已提前）；② storeDir 是普通文件 → 快速结构化错误；③ 父级是文件（不存在且不可创建）→ 快速结构化错误。
- `_selftest/tests/memory-v42.test.mjs`：M1/M2/M3 三条绕过路径各一条用例，并覆盖「正常路径不误杀」（procedure 累加证据、一次性带证据升级、带 text 的 supersede、merge 显式证据）。

## v4.2.0 — 2026-11-02

标题：「集百家所长，补写入侧四长板」——skip 可推导 / kind=reference / 预算见顶精简建议 / kind=procedure。检索打分一行未动；14 个工具名不变，参数集只增不减。唯一的契约放宽：`memory_update` 的 `text` 在只更新 `verifiedCount` 时可省略（`required` 由 `['id','text']` → `['id']`）；`memory_add` 跳过写入时 `entry` 变可选并新增诊断字段。

### 写入路径过滤（A4）
- `memory_add` 写入前比对规则源（工作区 AGENTS.md、`.dsh/rules/*.md`、全局 AGENTS.md）的每一行：近重复（bigram Jaccard ≥0.86 或原文被包含）→ 不写库，返回 `skipped/deriveSource/deriveReason/deriveSimilarity`；`force:true` 与配置 `deriveGate:'off'` 两条逃生口。
- 新增导出函数 `derivableHit()` / `normalizeRuleLine()`（纯函数，可单测）。

### kind=reference
- 重要度基线 5、复核期 180 天；注入行（含索引行）带 `↗` 前缀。

### 预算见顶主动精简（A2）
- `MEMORY_BUDGET_EXCEEDED` 报错改为：现状 + 合并建议（相似 ≥0.62 的条目对）+ drop 建议（stale / 从未命中且 >7 天未更新）+ 无候选时的诚实说明。

### kind=procedure
- 入库门槛 `verifiedCount ≥ 2`（未达抛 `MEMORY_PROCEDURE_UNVERIFIED`）；落 `verifiedCount/lastVerifiedAt`；`memory_update` 可只传 `verifiedCount` 累加证据（参数 required 从 `['id','text']` 放宽为 `['id']`）；`memory_merge` 合并成 procedure 同样过门槛。
- 重要度基线 7；注入行带 `⚙` 前缀；卡片导出带证据字段。
- 修 `normalizeEntry` 白名单：新增字段若不在白名单会在 load→persist 一轮被洗掉（v3.20 archivedAt 同款坑，本次单测当场抓到）。

### 测试
- 新增 `_selftest/tests/memory-v42.test.mjs`（5 组断言）：可推导命中/不误判/跳过/逃生口；reference 写入·重要度·180 天·检索·注入标记；预算见顶报错含 `m1+m2` 合并建议与 `m3` stale drop 建议；procedure 门槛（0/1 拒、2 收、可累加、不能无证据升级、schema 声明、导出带证据）。
- 旧套件全过：`memory.test.mjs` 131 项、`memory-sqlite.test.mjs` 9 组、`memory-schema.test.mjs` 7 组、`memory-oracle.test.mjs` 12 项。

## v4.1.0 — 2026-11-02

标题：「换底座、不换公式」——存储从 JSON 整库重写换成 SQLite 单文件（P2.1），检索从全量遍历换成 FTS5 候选集 + df 统计（P2.2）；打分公式一行没改、14 工具 schema 逐位不变、两条回滚路。依据 `_reports/memory-storage-bench-2026-11-02.json`：10000 条时 JSON 全量读 65.4ms / 写 32.1ms，先破百的是检索遍历（5000 条 171.3ms、10000 条 319.4ms，瓶颈是每轮重新分词）——所以先换存储是「为增长留余量」，检索热路径才用候选集解决。

### 存储（P2.1）
- 新增 SQLite 后端：`storeDir/memory.db` 单文件（`node:sqlite` 内置模块，零依赖），`journal_mode=WAL` + `busy_timeout=2000` + `synchronous=NORMAL`；`meta` 表存 `data_version` / `next_id` / `schema_version` / `write_seq`，`entries` 表存全字段 `payload` + 写入顺序 `seq` + 检索词表。
- 首次以 `storage: 'sqlite'` 启动自动迁移（无需手工命令）：迁移锁 → JSON 四件套备份到 `backups/pre-sqlite-<ts>/`（manifest 带 sha256）→ 临时库单事务写入 → **回读 canonicalJson 逐字段比对** → 通过才原子改名；失败删临时库并拒绝启动，原 JSON 不动。
- `memory.json` / `archive.json` 在 SQLite 后端下只读保留（迁移源 + 回滚备份），不再被写；`aliases.json` 仍随每次落盘同步（防丢副本，条目里也存一份）；`candidates.json` / `history.jsonl` / `review-latest.md` 位置与行为不变。
- 写路径只提交脏行（payload 变更 + 删除），不再整库 stringify/rename；多进程靠 WAL + `meta.write_seq` 合并（双实例写入不丢条、id 不冲突）。
- 用量计数（`usedCount` / `lastUsedAt`）仍即时进内存，但最多延迟 60s 落盘（旧实现每次 `memory_search` 都整库写，10k 条时是 30–60ms 写放大）；崩溃最多丢最近 60s 的使用计数，不影响正文。
- 加载/刷新顺序与旧后端对齐：生效在前、归档在后，组内按 `seq`。独立差分曾发现「重载后归档条目位置不同」，已修。
- SQLite 后端不再走旧 `persist()` 在 Windows 上被吞的 fsync 路径（只读句柄报 EPERM）；刷盘交给 WAL + `synchronous=NORMAL`，旧 JSON 后端保留原样。
- 每日备份改为 `VACUUM INTO memory.db.bak-YYYYMMDD`（自包含快照，含 WAL 数据），`BACKUP_KEEP=10` 口径不变；DB `quick_check` 失败进入 corrupt 只读保护态，不覆盖/不删除原文件。
- `schemaTooNewError` 扩展到 SQLite：`meta.schema_version` 高于插件支持时抛 `MEMORY_SCHEMA_TOO_NEW` 拒绝启动，旧逻辑绝不覆盖新数据。
- 回滚：`config.storage = 'json'` 切回 v4.0.1 的 JSON 后端（代码完整保留）；配套 `_ops/memory-rollback-sqlite.mjs`（`--dry-run` / `--apply`）把 DB 导出成旧后端可读的 JSON，只读 DB、不删库。

### 检索（P2.2）
- 新增 `retrieval: 'index'`（生产默认）：两张 FTS5 表只做**候选集召回 + df 统计**，打分仍用原 `scoreEntries` 公式（BM25 K1/B + tag×2 + alias×2.5 + 同义扩展 + 过期惩罚）——公式一行未改，排序逐位一致由差分测试把关。
- token/unit 列全部由应用层 `tokenize()` / `contentUnitsOf()` 生成后空格分隔入库；FTS5 分词器只挂 `unicode61 tokenchars '-_.'`，**绝不让默认分词器直接吃中文原文**（连续中文会被当成一个巨大 token）。
- `term_df` / `unit_df` 增量维护；启动自检发现 FTS 行数/统计量与 `entries` 不一致就整表重建（索引是可重建的派生数据）。
- 回退：`retrieval: 'scan'` 回退 v4.0.1 的全量遍历；`storage: 'json'` 时自动走全量遍历。
- 性能（交付报告 §4.2，合成 10k 条真实词表长尾）：单次 `memory_search` 旧 181.1ms → 新 **21ms 中位 / 29ms p95**；最坏情况（低熵重复语料、候选接近全库）50ms。真库 110 条时新路径含工具层约 18ms（旧约 2ms）——小库固定开销，收益在 5000+ 条才显现。
- 接口零变化：14 个工具的参数/返回 schema 逐位一致（`node _ops/memory-tool-schema.mjs --compare _reports/memory-tool-schema-before.json` 通过）；`memory_status.storeFile` 在 SQLite 后端指向 `memory.db`。

### 测试与文档
- 新增 `_selftest/tests/memory-sqlite.test.mjs`（9 组断言 / 源码内 42 条 `assert` 通过）：迁移备份与 manifest sha256、`memory.json` 不动、回读逐字段一致、注入块逐字节一致；14 条查询在 json / sqlite-index / sqlite-scan 三后端 top-k 与 score 逐位一致；11 个工具调用（add/update/remove/restore/merge/audit/history/review/export/candidates/status）全通；重载落盘；FTS/df 清空后自愈；schemaTooNew；`storage: json` 回滚开关；损坏 DB 保护；双实例并发写不丢条。
- 旧套件 `_selftest/tests/memory.test.mjs` 131 项仍全过（JSON 后端仍是代码默认值，向后兼容）；`node --check index.js` 通过。
- **真机（2026-11-02 22:54 本地，零重启）**：重载后首次以 `sqlite` 启动完成迁移（真库 110 条耗时 115ms，`memory.db` 221 KB）；`memory_status` 返回 `ready=true`、`storeFile` 指向 `…\memory.db`、`entries=110`（88 生效 + 22 归档）、`usedChars=7848/12000`、`schemaVersion=2`；生成 `backups/pre-sqlite-20261102145425/`（manifest 带 sha256）与当日 `memory.db.bak-20261102`；迁移后 `memory.json` 的 sha256 与迁移前 manifest 一致。14 工具真机各调一遍通过（临时条目已清干净，终态回到 110/88/7848）。
- **独立差分**（另一执行者独立编写脚本 `_ops/memory-diff-search.mjs`，旧 v4.0.1 冻结副本 vs 新插件，真库只读副本）：225 条查询 ×（limit=5 判据层 + limit=20 全量层）+ 列表 + 注入 + 写路径 + 重载 + live DB 只读补充差分，**1372/1372 项检查逐位一致 / 不一致 0**（脚本对插件 sha256 归因）；真库 4 个 JSON 的 sha256 前后不变。报告 `_reports/memory-diff-search-2026-11-02.json`（交付报告 `_reports/dsh-memory-p2-delivery-2026-11-02.md`）。
- **验证门**：`npm run check` 通过（测试门全量 33 个测试，含新增 `memory-sqlite.test.mjs` 9 组）。
- 文档：README 新增「存储后端（v4.1）」「迁移与回滚」两节，并更新顶部数据位置/版本、工具表（补全 14 个）、机制与配置示例；`memory-OPS.md` 补 SQLite 备份/回滚/健康检查；`package.json` 版本 4.0.1 → 4.1.0、`engines.node` → `>=23.4.0`。

### 备注
- 生效方式：插件是 pnpm link 安装，需重载 bundle（或重启 DSH）后新代码才进进程；本机数据目录的首次迁移发生在重载之后。
- 升级前不用手工备份：自动迁移自带 `backups/pre-sqlite-*`；想多一层保障可先复制 `memory.json`。

## v4.0.0 — 2026-11-01

标题：「考虑以后」——把结构改在**不可逆**的地方，不碰昂贵的结构。依据 2026-11-01 源码级调研（mem0 v3 删掉约 4000 行图存储、Letta 退回 Markdown、LangMem 图模块 159/182 行是注释、arXiv 2608.28978 图记忆 F1 0.417<扁平 0.468）。

### Added
- `invalidAt`：事实失效时刻（YYYY-MM-DD / ISO）。到点后**不注入、不检索，但留档不删**，与 Graphiti 双时间戳里真正有用的那一半对齐。
- `entities[]`：纯字符串实体标签（去重、最多 12 条、每条 40 字），进 BM25 词表。**不建实体表、不抽 LLM、不建边**——它是将来真要做关系层时唯一现成的锚点（mem0 v3 同款思路）。
- `sources[]` 结构化归一：`file:line` / `session:<id>` / URL 三种形态，去重截断；卡片导出同步输出。
- `memory_audit.growth` 触发线指标：条目数、平均字数、注入占比、实体/来源覆盖、失效数、**stage**（flat / hybrid-search / tiered-inject / entity-layer）与 `nextTrigger` 文案；同时输出 `schemaVersion`。
- `migrateState()` + `SCHEMA_VERSION = 2`：加载即迁移、只升不降、内容一律不动，迁移结果随下一次 persist 落盘（读的时候不改文件）。
- `memory_export` 回读校验：导出后回读前 5 张卡确认 `id` 可解析，返回 `verified` —— 导出物是脱离 DSH 也能读的资产，必须可验证。
- `memory_add` **写入冲突硬门**：同 scope + 相似度 ≥ 0.88 + 双方生效时直接拒绝，逼出三条明确出路 `supersede` / `allowDuplicate` / `status: draft`。依据：mem0/Letta/Graphiti 唯一有共识的一条是「冲突必须显式处理」。

### Changed
- `scope` 收敛：只允许 `global` 或小写 slug（`normalizeScope`），路径/中文/大写一律报错——历史上 8 种取值混用、10 条没有 scope，趁 60 条先立格式。
- 显式 `supersede` 不再被「文本完全一致」的去重捷径吞掉：意图是推翻旧条就必须真走推翻路径（旧条回写 `supersededBy` + `invalidAt` + `deprecated`）。
- 卡片导出补全 `entities` / `sources` / `invalidAt` / `workspaces` 四段 frontmatter；YAML 值统一加引号（路径含反斜杠、URL 含冒号，裸写会被解析坏）。
- `memory_search` 与注入渲染口径统一：失效条目不参与，`total` 也只算可检索条目。

### Verification
- 单测：**131 项通过**（新增 v4.0 五组：纯函数 / 冲突四条路径 / invalidAt 不注入不检索 / audit 触发线 / 导出回读）。
- `node --check index.js` 通过；`npm run check` 三道门见验证记录。
- **生效需重启 DSH**（插件 index.js 只在启动时求值）。

## v3.27.0 — 2026-10-31

### Fixed
- **用户消息沉淀的注入污染**：v3.1 只剥 `<memory>` 块，`<path-rules>` / `<available_skills>` / `<system-reminder>` 里的规则文本会被当成「用户偏好」抓进候选池（实测：关掉规则文件沉淀后仍冒出候选 c19，内容就是 `.dsh/rules/core.md` 被注入的那句）。
- 新增导出 `stripHarnessBlocks(text)`：沉淀前先整块剥掉四类注入块；污染门同步补上这些标记作为最后一道防线。

### Verification
- 单测新增：注入块剥离（大小写 / 带属性 / 多块混排）与 `extractCandidates` 不再从注入文本出候选；验证门通过。

## v3.26.0 — 2026-10-31

### Added
- `captureRuleFiles` 配置开关（默认 `true`，向后兼容）：单独控制「规则文件沉淀」（从 `AGENTS.md` / `.dsh/rules` 抽硬规则自动入库），与 `captureCandidates`（用户消息沉淀）解耦。
- 本机 desktop profile 设为 `false`：规则已由 AGENTS/rules 每轮注入，重复入库只占存储预算（实测：清掉的规则在重启后被自动写回）。

### Changed
- `package.json` 版本从 3.21.0 补到 3.26.0（3.22–3.25 的功能此前只进了代码与提交信息，manifest/CHANGELOG 未同步，见下面补记）。

### Verification
- 单测新增 `captureRuleFiles` 集成断言：关掉时规则文件不入库，默认时仍入库；验证门通过。

### 补记 v3.23–v3.25（2026-10-31，按提交信息回填）

- **v3.23** `inject:false`：只参与检索、不占每轮注入预算；前置只留硬规则。
- **v3.24** 参数交叉校验（如 `maxInjectChars` > `maxBytes` 时告警）+ 注入收益度量（学 Google ADK 的成对校验与 `_prompt_chars_saved`）。
- **v3.25** 容量策略：撞墙先归档（≥30 天且未命中，可逆）+ `health` 分级预警（85% / 95%）。
- 修复：`memory_add` 漏接 `inject:false`（schema 声明了但 execute 没映射）。

## v3.21.0 — 2026-10-30

### Added
- `memory_history`：读 append-only 变更日志（add / update / remove，带时间戳与被删正文），支持按 id / event 过滤。
- `memory_purge`：批量物理删除归档条目，必须 `confirm:true`，支持 `ids` / `olderThanDays` 过滤；只碰归档，生效记忆不动。
- `history.jsonl`：persist 成功后按基线 diff 追加事件（2 MB 轮转，写失败 fail-safe）。

### Changed
- **存储预算 8000 → 12000**：代码 `DEFAULT_MAX_BYTES` 与 `cordis.patch.yml` 的 `maxBytes` **两处同时改**——配置覆盖代码默认值，只改一处不生效（真机实测踩到；bundle patch 里原本硬写 8000）。
- 依据：mem0 / memobase 存储无上限，容量只在注入侧卡；注入预算不变。

### Verification
- 单测 121 项通过；三道门通过。
- bench 零回归（recall@1 100% / @3 100% / 负例误注入 9.5%）。

### Notes
- 生效需重启 DSH。

## v3.20.0 — 2026-10-30

### Added
- `memory_restore`：把被预算保护挤掉（deprecated 且未被取代）的条目恢复为生效记忆，恢复前查预算。
- `memory_list` 的 `includeArchived` 参数与 `active` / `includeArchived` 返回字段。
- 导出 `isArchivedEntry(entry)`，归档判定收口到一处。
- `archive.json` 旁路归档文件（冷存），损坏时 fail-safe。

### Changed
- **归档条目不再写入 `memory.json`**：主库只存生效条目，归档落 `archive.json`；加载时合并回内存态，检索/审计行为不变。
- `memory_list` 默认**不返回**归档条目（此前 93 条会全吐出来，37 KB/次）；表头改为「N 条生效 / M 条归档」。

### Fixed
- **v3.19 连带 bug：`memory_list` 整条不可用** —— `memoryEntrySchema` 未声明 `archivedAt` / `archiveReason`，库中存在自动归档条目时工具层校验失败（`additionalProperties: false`）。
- **v3.19 连带 bug：归档元数据被洗掉** —— `normalizeEntry` 的 `OPTIONAL_STRING_FIELDS` 缺这两个字段，load→persist 一轮就丢归档时间与原因。
- 两处均有单测覆盖；单测 117 → **118**。

### Verification
- 单测 118 项通过；三道门通过。
- 重启后真机验收：`archive.json` 生成（1 条 m95），主库只剩 47 条生效，`memory_list` 返回 47 条 / 21.9 KB（改造前 93 条 / 37.4 KB）。
- 真实库副本冒烟：48 条 → 47 生效 + 1 归档，零写入。
- bench 零回归（recall@1 100% / @3 100% / 负例误注入 9.5%）。

### Notes
- 生效需重启 DSH。
- 存量归档懒迁移（首次写库时搬进 `archive.json`）。
