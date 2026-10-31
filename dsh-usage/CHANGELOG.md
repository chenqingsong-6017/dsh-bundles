# CHANGELOG — dsh-usage

本文件于 2026-10-31 按「改到谁补谁」的规则建立；当前版本为存量版本，本节为补记。

## v0.1.0（补记于 2026-10-31）

### Added
- 扫描 `sessionsRoot` 下全部会话日志建索引，按天 / 模型 / 会话出报表（`usage_report`）。
- 配了价格表（`pricesFile` → `prices.json`）就折算金额，货币与时区可配（本机 CNY / Asia/Shanghai）。
- `usage_status` 收口索引文件数、总调用数、最后扫描时间、诊断信息。
- 只读、零上下文税：不做模型请求。

### Verification
- 单测 + 验证门通过；真机：93 个会话文件 / 6324 次调用，`pricesConfigured=true`。
