# CHANGELOG — dsh-butler-tidy

本文件于 2026-10-31 按「改到谁补谁」的规则建立；当前版本为存量版本，本节为补记。

## v0.11.2 — 2026-11-03

### Fixed（安全，来源：`_reports/global-audit-ops-2026-11-03.md` T1/T2/T3）
- **T1 · S1 `confirm` 字符串击穿**：7 处 `Boolean(args?.confirm)` 改为严格 `args?.confirm === true`（`tidy_apply` 的 folders/rename/clean/empty/dupes/residue 分支 + `tidy_undo`）。`confirm:"false"` / `"true"` / `1` / `{}` 现在一律 `CONFIRM_REQUIRED`（字符串 `"true"` 也按未确认处理，安全侧）。
- **T2 · S1 红线目录绕过**：新增 `realPathOf` / `hasReparsePoint` / `isUnsafePath`，红线判定前先 `realpathSync.native` 解析并拒绝 UNC / `\\?\` / `\\.\` 前缀与 junction / 符号链接；`validateTarget`、`inspectTarget`、`collectFiles`、`findEmptyDirs`、`findDuplicates`、`doApplyFolders`、`plan_uninstall` 全部改走统一 `isProtected`（fail-closed）。junction 指向红线、`\\?\D:\...`、`\\localhost\D$\...` 三种写法现在都给出「不可动」。
- **T3 · S2 `tidy_scan path=` 误报可动**：`inspectTarget` 与 `validateTarget` 共用同一判定，junction 指向红线时结论为「勿动」。

### Verification
- `node _selftest/tests/butler-tidy.test.mjs` 12 → 18 项：`confirm:"false"/"true"/1/0/{}/null` 全部拒绝且文件未动；`tidy_undo` 同样拒；junction / `\\?\` / `\\localhost\D$` 三种绕过各一条拒绝用例（junction 用临时目录构造、测完 `cmd /c rmdir` 清理）；普通临时目录仍能正常出方案（反向保险）。
- `node --check index.js` 通过。未执行任何真实删除/移动。

## v0.11.0（补记于 2026-10-31）

### Added
- 文件整理四步：`tidy_scan`（盘点）/ `tidy_plan`（方案）/ `tidy_apply`（确认后执行）/ `tidy_undo`（按 manifest 撤销）。
- 整理规则：按类型 / 按月份；`conflict: rename|skip`；单次上限 `maxFiles`（默认 300）。
- 清理只碰白名单临时位置；`PROTECT` 名单在代码层拦截（含 D:\AI-date\workbuddy-date\学习 红线）。
- 安装台账：`inventory_add` / `inventory_list` / `inventory_check` / `plan_uninstall`（只读卸载预演，含服务/启动项/计划任务/快捷方式/PATH/注册表引用扫描）。
- `tidy_status` 收口诊断字段。

### Verification
- 单测 + 验证门通过；真机：16 个 manifest、台账 11 条活跃、保护项 9 条。
