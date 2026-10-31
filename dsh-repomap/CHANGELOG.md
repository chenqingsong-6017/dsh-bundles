# CHANGELOG — dsh-repomap

本文件于 2026-10-31 按「改到谁补谁」的规则建立；当前版本为存量版本，本节为补记。

## v1.0.2（补记于 2026-10-31）

### Added
- `repo_map`：按符号被引用热度排序的文件地图，适配字符预算（`maxChars`）。
- `repo_outline`：单文件符号纲要（名称 / 类型 / 行号）。
- `repo_find_symbol`：符号定义定位（文件 / 行 / 类型）。
- 扫描时跳过超大文件并报告，避免把上下文撑爆。

### Verification
- 单测 + 验证门通过；真机：`repo_outline` 对 dsh-memory/index.js 返回 6 个符号及行号。
