# CHANGELOG — dsh-repomap

本文件于 2026-10-31 按「改到谁补谁」的规则建立；当前版本为存量版本，本节为补记。

## v1.0.4 — 2026-11-03

### Fixed（正确性，来源：`_reports/global-audit-memory-2026-11-03.md` M7）
- **`repo_*` 默认扫描根落到插件进程 cwd（profile 目录）**：声明 `inject: ['tools','workingDirectory']` 后，默认根 = 会话工作目录；拿不到时回退 `config.workspaceDir` → DSH `storages/workspace.json` 最近工作区；都没有则报 `REPO_NO_WORKSPACE`，不再静默扫 profile（那会报「可用 0 个源文件」的假绿）。
- `repo_status` 新增 `rootSource`（`workingDirectory` / `workspaceDir` / `path` / `relative`）与 `warning`（默认根识别到 0 个源文件时提示显式传 `path`）。

### Verification
- `_selftest/tests/repomap.test.mjs` 17 项全过；默认根用例先在 HEAD 上红（0 源文件）再转绿；真机口径模拟 `rootSource=workingDirectory`、`sources=28`。
## v1.0.3 — 2026-11-02

### Fixed
- 超大文件跳过与符号截断在 `block` / render 里明示，不再静默失真——此前 `repo_map` 只给不全的结果，看不出「少了什么」（误报扫描 #50）。

### Verification
- `_selftest/tests/repomap.test.mjs` 补 27 行回归（先红后绿）；README「2026-11-02 升级记录」。

## v1.0.2（补记于 2026-10-31）

### Added
- `repo_map`：按符号被引用热度排序的文件地图，适配字符预算（`maxChars`）。
- `repo_outline`：单文件符号纲要（名称 / 类型 / 行号）。
- `repo_find_symbol`：符号定义定位（文件 / 行 / 类型）。
- 扫描时跳过超大文件并报告，避免把上下文撑爆。

### Verification
- 单测 + 验证门通过；真机：`repo_outline` 对 dsh-memory/index.js 返回 6 个符号及行号。
