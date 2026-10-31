# CHANGELOG — dsh-butler-tidy

本文件于 2026-10-31 按「改到谁补谁」的规则建立；当前版本为存量版本，本节为补记。

## v0.11.0（补记于 2026-10-31）

### Added
- 文件整理四步：`tidy_scan`（盘点）/ `tidy_plan`（方案）/ `tidy_apply`（确认后执行）/ `tidy_undo`（按 manifest 撤销）。
- 整理规则：按类型 / 按月份；`conflict: rename|skip`；单次上限 `maxFiles`（默认 300）。
- 清理只碰白名单临时位置；`PROTECT` 名单在代码层拦截（含 D:\AI-date\workbuddy-date\学习 红线）。
- 安装台账：`inventory_add` / `inventory_list` / `inventory_check` / `plan_uninstall`（只读卸载预演，含服务/启动项/计划任务/快捷方式/PATH/注册表引用扫描）。
- `tidy_status` 收口诊断字段。

### Verification
- 单测 + 验证门通过；真机：16 个 manifest、台账 11 条活跃、保护项 9 条。
