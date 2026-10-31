# CHANGELOG — dsh-updater

本文件于 2026-10-31 按「改到谁补谁」的规则建立；当前版本为存量版本，本节为补记。

## v0.1.0（补记于 2026-10-31）

### Added
- 注册更新源（`updater_source`）：repo / ref / subdir / 本地目录 / bundle 名；本地目录限定在 `allowedRoots`。
- `updater_check`：`git ls-remote` 与本地基线比对，报告 up-to-date / behind / baseline-missing。
- `updater_apply`：浅克隆 → 静态校验 → 与本地 diff → 备份本地目录 → 覆盖（`--prune` 可选删除本地独有文件）。
- `updater_rollback`：按备份回滚，回滚前再留安全备份（可逆）。
- `updater_study`：克隆公开仓库到学习目录，返回文件树 / package.json / README / 入口预览。
- `updater_status`：git / node 可用性、源列表、备份占用。

### Verification
- 单测 + 验证门通过；真机：git 与 node 均可解析，eva-theme 源存在（baseline-missing：只跟踪未应用）。
