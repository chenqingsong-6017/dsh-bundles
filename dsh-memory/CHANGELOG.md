
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
# CHANGELOG

本文件从 v3.20 起建立（按「改到谁补谁」的规则补上）。更早的版本记录见 [README.md](README.md) 的版本节。
格式：Keep a Changelog；版本号跟 `package.json`。

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