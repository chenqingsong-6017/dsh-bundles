# CHANGELOG — dsh-usage

本文件于 2026-10-31 按「改到谁补谁」的规则建立；当前版本为存量版本，本节为补记。

## v0.1.2 — 2026-11-02

### Fixed
- **价格表前缀匹配收紧**：按模型族前缀 `model.startsWith(key)` 误吞同前缀模型的问题，改为需显式 `*` 通配（误报扫描 #47）。
- **`event.time` 缺失不再冒充**：不再用 `Date.now()` 把旧事件归到「今天」，改为跳过并计数（#48）。

### Verification
- `_selftest/tests/usage.test.mjs` 补 37 行回归（先红后绿）；README「2026-11-02 升级记录」。

## v0.1.1 — 2026-11-01

### Added
- 统一契约（工具面就绪度）：`usage_status` 增加 `ready` / `unavailableReason`。判据 = 价格表已配置 **且** 会话日志根目录可读（只查配置与可读性，不发网络）；不可用时 render 首行显示「不可用：<reason>」，原因逐条列出。
- `usage_status.probe` 增加稳定错误码 `code`（解析/解压失败为 `USAGE_PARSE_FAILED`，正常为 `''`）。

### Verification
- `_selftest/tests/usage.test.mjs` 9 项全过（含新增契约断言：schema required 含两字段、探针 required 含 `code`、不可用分支 render 文案）。
- `_selftest/schema-check.mjs`：`usage_report` / `usage_status` PASS；一次性脚本真跑 `execute()`：真机数据下 `ready=true`、`unavailableReason=""`、返回键与 schema 严格同构。
- 未做真机（运行中进程内）验证：本插件行未重载。

## v0.1.0（补记于 2026-10-31）

### Added
- 扫描 `sessionsRoot` 下全部会话日志建索引，按天 / 模型 / 会话出报表（`usage_report`）。
- 配了价格表（`pricesFile` → `prices.json`）就折算金额，货币与时区可配（本机 CNY / Asia/Shanghai）。
- `usage_status` 收口索引文件数、总调用数、最后扫描时间、诊断信息。
- 只读、零上下文税：不做模型请求。

### Verification
- 单测 + 验证门通过；真机：93 个会话文件 / 6324 次调用，`pricesConfigured=true`。
