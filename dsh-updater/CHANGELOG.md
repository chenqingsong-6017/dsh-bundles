# CHANGELOG — dsh-updater

本文件于 2026-10-31 按「改到谁补谁」的规则建立；v0.1.0 为存量版本补记。

## v0.1.1 — 2026-10-31

### Fixed
- **回滚可能还原更旧的一份备份**：`listBackups` / `pruneBackups` 原来按目录名字排序，而备份名里的 `shortSha` / `baseline` 后缀会让「名字序」与「创建序」相反（同一秒内两次备份实测触发：本该回 1.0.0，实际回了 0.9.0）。现改为按文件系统创建时间（`birthtimeMs`，缺失时退 `mtimeMs`）排序，同时间才用名字兜底。
- `stamp()` 从秒级改为毫秒级，降低同秒撞名概率。

### Verification
- `updater.test.mjs` 新增回归：把两份备份改名成「名字序与创建序相反」，回滚仍须还原最新一份；断言数 23 → 25 通过。
- 验证门通过。

## v0.1.0（补记于 2026-10-31）

### Added
- 注册更新源（`updater_source`）：repo / ref / subdir / 本地目录 / bundle 名；本地目录限定在 `allowedRoots`。
- `updater_check`：`git ls-remote` 与本地基线比对，报告 up-to-date / behind / baseline-missing。
- `updater_apply`：浅克隆 → 静态校验 → 与本地 diff → 备份本地目录 → 覆盖（`--prune` 可选删除本地独有文件）。
- `updater_rollback`：按备份回滚，回滚前再留安全备份（可逆）。
- `updater_study`：克隆公开仓库到学习目录，返回文件树 / package.json / README / 入口预览。
- `updater_status`：git / node 可用性、源列表、备份占用。
