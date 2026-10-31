# CHANGELOG — dsh-hooks

本文件于 2026-10-31 按「改到谁补谁」的规则建立；当前版本为存量版本，本节为补记。

## v0.1.0（补记于 2026-10-31）

### Added
- 用户级 hooks：`hooks.json` 把 `tool.pre` / `tool.post` / `session.start` / `turn.stop` 事件映射成命令，支持 `allow` / `ask` / `deny`，`onError` 可配置（护栏全用 `deny`）。
- 工具：`hooks_status`（配置来源、每条钩子、执行统计、最近记录、错误）、`hooks_test`（对单个事件做 dry-run）、`hooks_reload`。
- 示例护栏脚本：danger / fs / code / cred / self / gui 六层（见 `examples/`）。

### Verification
- 单测 + 验证门通过（含 67 条安全护栏回归）；真机：`hooks_status` 报 6 条钩子、0 误拦。
