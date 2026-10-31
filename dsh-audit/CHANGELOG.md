# CHANGELOG — dsh-audit

本文件于 2026-10-31 按「改到谁补谁」的规则建立；当前版本为存量版本，本节为补记，不虚报发布日期。更早历史见 git log 与 README。

## v0.1.0（补记于 2026-10-31）

### Added
- 订阅 DSH `session/event` 追加流，对有副作用的工具调用逐条写 JSONL 审计日志，按天切分。
- 风险分级：high（破坏性命令 / 敏感路径 / 批量回滚 / 卸载插件）、medium（普通写入、下载执行、未知工具）、low（其余）。
- 参数摘要脱敏（api key / token / password / bearer → `***`）；不记录工具返回、prompt、回复正文。
- 只读工具默认不记，但命中敏感路径照样记 high。
- 工具：`audit_report` / `audit_search` / `audit_status`；`keepDays` 默认 30 天，超期在下次写入时清理。

### Verification
- 单测 + 验证门通过；真机：5263 条记录 / 2.2 MB / 2026-10-26~31，`watching=true`、`lastError=""`。
