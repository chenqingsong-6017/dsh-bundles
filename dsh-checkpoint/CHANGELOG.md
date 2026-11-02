# CHANGELOG — dsh-checkpoint

本文件于 2026-10-31 按「改到谁补谁」的规则建立；当前版本为存量版本，本节为补记。

## v1.5.2 — 2026-11-03

### Fixed（安全，来源：`_reports/global-audit-ops-2026-11-03.md` C1/C4）
- **红线目录硬拒绝**：新增内置红线 `C:\Windows` / `Program Files` / `ProgramData` / `%USERPROFILE%\AppData` / `D:\AI-date\workbuddy-date\学习` / DSH 安装目录（`path.dirname(process.execPath)`）/ `%USERPROFILE%\.dsh`（凭据目录），并支持 `config.redlineDirs` 追加。**命中红线的 restore/delete 一律拒绝，`confirm: true` 也不放行**；UNC / `\\?\` 等无法判定真实位置的路径按红线处理。此前 `学习` 不在 protectDirs，红线文件的旧内容会被直接写回，且 `created` 记录会被直接删除。
- **采集阶段排除红线**：`excludeDirs` = 红线 + `protectDirs` + 本插件数据目录，红线内容不再进快照库（已存在的旧记录仍可由 `checkpoint_forget` 丢弃）。
- **单目标 restore 补确认**：目标不在当前会话工作区、也不在 `config.allowRestoreDirs` 白名单内时，必须 `confirm: true`（与 `tidy_undo` / `updater_rollback` 的约定拉齐）；工作区内维持免确认。`all: true` 仍是必须 confirm；回滚全部时红线目标进 `failed`、其余照常。

### Verification
- `node _selftest/tests/checkpoint.test.mjs` 25 → 34 项：红线三种目录（学习空间 / DSH 安装目录 / `.dsh` 凭据目录）× confirm true/false 全部拒绝且零写入；`all:true` 普通目标照常回滚、3 个红线目标全部 `failed`；普通路径无 confirm 拒绝且文件不动、带 confirm 才回滚；工作区内目标免 confirm；采集侧红线/保护目录计 `skipped.excluded` 不进账本。
- `node --check index.js` 通过。

## v1.5.0（补记于 2026-10-31）

### Added
- 写前快照：`write` / `edit` 命中前把原内容留底（`kind: modified|created`）。
- 回滚：`checkpoint_restore`（单文件或 `all:true` 需 `confirm`）、`checkpoint_forget`、`checkpoint_prune`。
- 预演与查看：`checkpoint_diff`（行级 diff）、`checkpoint_list`、`checkpoint_status`。
- 快照存储落 `storeDir`（本机 `D:\AI\dsh-data\checkpoint`）；过期清理与保护目录。

### Verification
- 单测 + 验证门通过；真机：165 个快照 / 459 KB。

### Known limitations
- 只保护 `write` / `edit`；`bash` / `run_code` 内写文件不受保护（与 AGENTS.md 已知缺口一致）。
