# CHANGELOG — dsh-skill-usage

本文件于 2026-10-31 按「改到谁补谁」的规则建立；当前版本为存量版本，本节为补记。

## v1.2.0（2026-11-12）

**合并建议：淘汰机制的「中间档」**——照 Hermes 的 umbrella consolidation 抄判据，按 DSH 能力边界降级成只读报告。

### Added
- 工具 `skill_consolidation_plan`：按名称/描述词面重合（重叠系数，默认阈值 0.3）+ 泛词剔除，
  把技能聚成同主题组并给伞名建议；返回 `scanned / threshold / clusters / note`，明确写「只读」。
- 纯函数 `skillTokens` / `planConsolidation`（导出，单测直接验判据，不跑插件）。

### 为什么不做执行合并
- DSH 技能目录是只读视图（插件没有技能所有权），改文件不是我们的权限；能抄的是判据不是动作。
- Hermes 的合并是 LLM 驱动的（需要 `into` + `reason` + 证据）；我们零 LLM，只把「证据」摆出来供人/模型决策。

### 为什么阈值是 0.3（标定，不是拍脑袋）
- 用 Jaccard 时 cordis 三件套两两只有 0.17（被词数差压死）；换重叠系数后为 0.33，无关技能为 0。
- 0.3 卡在两者之间；阈值 0.9 的对照组在单测里必须散开（证明阈值真的在起作用）。

### 验证
- 单测 32 项通过（+4）；工具零副作用：`usage.json` 逐字节不变、mtime 不变、无 manifest。
- 真机（12:45，HMR 后）：`skill_consolidation_plan` → `directory=12, scanned=2, clusters=[]`；调用前后 `usage.json` sha256+mtime 一致。
  12 个目录技能里 10 个已被 curator 归档（不参与合并建议），剩下 2 个无同主题组——这是真实观测值，不是「没跑」。
- 目录取并集的理由同样来自真机：不带 agent scope 调 `skills.list()` 只返回 2 个技能，只用现读会误报「没有同主题组」。
## v1.1.0 — 2026-11-12

淘汰机制的三件配套（只动插件台账，技能文件依旧一个字不碰）。

### Added
- **可预演**：`skill_usage { dryRun: true }` 只读预演，返回 `dryRun: true` 与 `wouldArchive: [{name, reason, days, uses}]`。语义是只读：不刷目录、不跑 curator、不落盘，返回后 `usage.json` 逐字节不变；目录名单不可信（`catalogAt` 缺失）时如实报 `wouldArchive: []` + `dryRunReason: 'catalog-untrusted'`，不瞎判。
- **可观测**：`lastCuration = { at, archived, archivedNames, skipped: { alreadyArchived, catalogUntrusted, notDue, neverUsed } }`，`skill_usage_status` 增加 `lastCuration`（可为 `null`）。跳过原因来自 `decideCuration` 的 `skip` 返回值（即 `classifyUsage` 的真实判定），不另造口径。
- **可审计**：真归档往 `<storeDir>/archive-manifest.jsonl` 追加一行 JSON（字段固定 `ts, by:'curator', name, reason, days, uses`）；文件超过 2MiB 时先轮转成 `archive-manifest.jsonl.1` 再新写（只留一份历史）。写 manifest 失败只记 `stats.lastError`，不影响归档主流程。

### Changed
- `runCurator` 与 dry-run 共用 `planCuration`：先算后动，保证「预演说会归档谁」和「真跑会归档谁」永远是同一套判据。
- `decideCuration` 在 `action:'none'` 时多返回 `skip` 字段（`alreadyArchived` / `catalogUntrusted` / `notDue` / `neverUsed`），纯函数签名向后兼容。

### Verification
- `_selftest/tests/skill-usage.test.mjs`：20 → 28 项，全过。新增覆盖：dry-run 前后 `usage.json` 逐字节 + mtime 不变、`lastCuration.skipped` 四桶分桶（含 `neverUsed=1`）、manifest 行数与字段、>2MiB 轮转、manifest 写失败不影响归档。
- `node --check index.js` 通过；另用宿主真实 schema 校验器（`dsh-tools/lib/types/json-schema.js`）对四个工具的输出 schema 与真实返回值跑校验，violations 全为 `[]`（`oneOf` 表达可空、无 type 数组）。

## v1.0.3 — 2026-11-02

### Fixed
- `firstSeenAt` 不再冒充 `lastUsedAt` 进 stale 判定：插件首装把历史技能记在同一天，14/30 天后不会集体翻成 stale / archive-candidate（误报扫描 #43）。
- 技能名归一化后再匹配，`skill_usage_mark` 不再因多空格 / 大小写差异报未知技能（#44）。

### Verification
- `_selftest/tests/skill-usage.test.mjs` 补 76 行回归（先红后绿）；README「2026-11-02 升级记录」。

## v1.0.2（补记于 2026-10-31）

### Added
- `skill_usage`：统计每个技能被加载次数、最后一次使用时间，按 `all|used|unused|attention` 过滤。
- 陈旧阈值：`staleAfterDays`（默认 14）/ `archiveAfterDays`（默认 30），标记「该复核 / 可归档」。
- `skill_usage_mark`：人工复核标记（不会编辑或删除技能本身）。
- 用量数据落 `storeDir`（本机 `D:\AI\dsh-data\skill-usage`）。

### Verification
- 单测 + 验证门通过；真机：13 个技能，used 2 / unused 11（5 个为打包内置 office 技能）。
