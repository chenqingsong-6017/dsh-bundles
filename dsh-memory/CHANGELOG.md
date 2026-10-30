# CHANGELOG

本文件从 v3.20 起建立（按「改到谁补谁」的规则补上）。更早的版本记录见 [README.md](README.md) 的版本节。
格式：Keep a Changelog；版本号跟 `package.json`。

## v3.21.0 — 2026-10-30

### Added
- `memory_history`：读 append-only 变更日志（add / update / remove，带时间戳与被删正文），支持按 id / event 过滤。
- `memory_purge`：批量物理删除归档条目，必须 `confirm:true`，支持 `ids` / `olderThanDays` 过滤；只碰归档，生效记忆不动。
- `history.jsonl`：persist 成功后按基线 diff 追加事件（2 MB 轮转，写失败 fail-safe）。

### Changed
- **默认存储预算 `DEFAULT_MAX_BYTES` 8000 → 12000**（依据：mem0 / memobase 存储无上限、容量只在注入侧卡；注入预算不变）。

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
