# CHANGELOG — dsh-butler-tidy

本文件于 2026-10-31 按「改到谁补谁」的规则建立；当前版本为存量版本，本节为补记。

## v0.11.4 — 2026-11-03

### Fixed（诊断口径）
- `tidy_status.limits` 文案没跟上 v0.11.3：仍写「单次最多整理 300 个文件」，从输出上看不出 `clean` 也受同一条上限约束（用户据此会以为 clean 上限没修）。改为「单次最多 300 条（organize 按文件数 / clean 按清理条目数，maxFiles 可调 1-2000）」，与实际行为一致。

### Verification
- `node --check index.js`；重组后真机 `tidy_status` 输出新文案。
## v0.11.3 — 2026-11-03

### Fixed（稳健性，来源：`_reports/global-audit-ops-2026-11-03.md` T4-T7）
- **T4 `clean` 无条目上限**：`tidy_apply clean` 现在与 `organize` 共用 `maxFiles`（默认 300，可调 1-2000），按清理条目截断并在 `remaining` 如实回报；超限时提示「再执行一次继续」。
- **T6 `targets: []` 语义**：空数组现在返回 `EMPTY_TARGETS`、一条不删（原来等价于「清全部安全项」）；不传 `targets` 才按 `policy:safe` 走默认清理。
- **T5 清单非原子写**：`writeManifest` 改临时文件 + rename 原子落位；写失败返回 `MANIFEST_WRITE_FAILED` 并明确「文件已动、这次无法 tidy_undo」。
- **T7 落位静默覆盖**：`movePath` 在 `renameSync` 前判目标存在，命中抛 `DEST_EXISTS`，不再静默覆盖（TOCTOU 窗口收紧到判存与 rename 之间）。
- **clean 红线复核**：清理白名单目录前再过一次 `isProtected`（fail-closed），配置注入的目录同样受红线约束。

### Added
- **`config.junkDirs`**：可追加可清目录（`id`/`path` 必填，`policy ∈ safe|cautious|admin`，默认 safe），用于机器相关的自定义临时目录。

### Verification
- `_selftest/tests/butler-tidy.test.mjs` 24 项全过；四条修复均先在 HEAD 上跑出新用例失败（红）再转绿；`node --check index.js` 通过。
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
