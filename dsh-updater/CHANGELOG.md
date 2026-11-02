# CHANGELOG — dsh-updater

本文件于 2026-10-31 按「改到谁补谁」的规则建立；v0.1.0 为存量版本补记。

## v0.1.2 — 2026-11-03

### Fixed（安全，来源：`_reports/global-audit-ops-2026-11-03.md` U1）
- **`updater_rollback` 的 `backup` 参数路径穿越**：原来直接 `path.join(backupsDir, sourceName, wanted)`，`..\..\..\evil` 可穿越到备份根目录之外；配合 `restoreDir` 的「树外即删」等于用任意目录覆盖插件源码。现在 `backup` 必须是单段名字（拒绝路径分隔符 / `..` / 盘符 / 绝对路径 / UNC），且 resolve 后必须落在该源的备份根目录内、并在 `listBackups` ∪ `safety-*` 清单里，否则 `UPDATER_ARG_INVALID`，且在「回滚前安全备份」之前就拒绝（不执行任何回滚动作）。
- **`restoreDir` 越界防护**：备份树必须在备份根目录内；备份内相对路径经 `safeJoinInside` 校验，含 `..` / 绝对路径 / 盘符一律 `UPDATER_ARG_INVALID`。
- **「树外即删」限定白名单**：`backupDir` 现在写 `backup.json` 元数据（记录备份覆盖的文件 + 本次 apply 新增的文件），回滚只删「本次 apply 新增」的那些文件；老备份没有元数据时只允许删插件产物（`package.json` / `index.js` / `locale/*` 等），白名单外的用户文件保留并在结果消息里报数。

### Verification
- `node _selftest/tests/updater.test.mjs` 25 → 27 项：`backup:'../../'`、`'..\\..\\evil'`、`'C:\\...'`、UNC、带分隔符、未知名六种写法全部 `UPDATER_ARG_INVALID`，本地文件未改、安全备份未创建（证明没有真回滚）；合法显式备份名仍可回滚，且白名单外 `user-notes.md` 保留未删。
- `node --check index.js` 通过。

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
