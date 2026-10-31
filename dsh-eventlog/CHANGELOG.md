# CHANGELOG

格式：Keep a Changelog；版本号跟 `package.json`。

## v0.1.0 — 2026-11-01

### Added
- 首个版本：照 Windows 事件查看器模型的本地事件日志。频道 / 级别 / 稳定事件码 / 来源 / 数据载荷。
- `log_write`：写一条事件（给 agent 与其它插件的通用入口）。
- `log_query`：按 channel / level（≥）/ code / since / until / keyword 查，倒序、有 limit。
- `log_status`：文件数 / 条数 / 字节 / 最早最新 / 保留策略 / 本次已写 / 最后错误。
- 自动捕获：`session/event` 里 `tool/result` 且 `isError === true` → `TOOL-ERROR`（warn）。
- 启动即写 `LOG-START` 事件，解决「什么时候开始不对」。
- 按天滚动 + 单文件 8MB 滚动 + `keepDays` 自动清理 + `minLevel` 过滤。

### Design
- **不进上下文**：不注册 systemPrompt 层。
- **fail-safe**：写失败只记账不抛。
- **不重复**：全量工具调用审计仍归 `dsh-audit`。
