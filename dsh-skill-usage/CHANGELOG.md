# CHANGELOG — dsh-skill-usage

本文件于 2026-10-31 按「改到谁补谁」的规则建立；当前版本为存量版本，本节为补记。

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
