# CHANGELOG — dsh-checkpoint

本文件于 2026-10-31 按「改到谁补谁」的规则建立；当前版本为存量版本，本节为补记。

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
