# CHANGELOG

本文件从 v3.20 起建立（按「改到谁补谁」的规则补上）。更早的版本记录见 [README.md](README.md) 的版本节。
格式：Keep a Changelog；版本号跟 `package.json`。

## v3.20.0 — 2026-10-30

### Added
- `memory_restore`：把被预算保护挤掉（deprecated 且未被取代）的条目恢复为生效记忆，恢复前查预算。
- `memory_list` 的 `includeArchived` 参数与 `active` / `includeArchived` 返回字段。
- 导出 `isArchivedEntry(entry)`，归档判定收口到一处。
- `archive.json` 旁路归档文件（冷存），损坏时 fail-safe。

### Changed
- **归档条目不再写入 `memory.json`**：主库只存生效条目，归档落 `archive.json`；加载时合并回内存态，检索/审计行为不变。
- `memory_list` 默认**不返回**归档条目（此前 93 条会全吐出来，37 KB/次）；表头改为「N 条生效 / M 条归档」。

### Verification
- 单测 117 项通过；三道门通过。
- 真实库副本冒烟：48 条 → 47 生效 + 1 归档，零写入。
- bench 零回归（recall@1 100% / @3 100% / 负例误注入 9.5%）。

### Notes
- 生效需重启 DSH。
- 存量归档懒迁移（首次写库时搬进 `archive.json`）。
