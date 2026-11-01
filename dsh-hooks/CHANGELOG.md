# CHANGELOG — dsh-hooks

本文件于 2026-10-31 按「改到谁补谁」的规则建立；当前版本为存量版本，本节为补记。

## v0.1.1 — 2026-11-01

### Changed
- **统一状态契约**：`hooks_status` 新增 `ready` / `unavailableReason`（两者都必填，`unavailableReason` 为空串表示可用）。`ready` 是真判断——hooks.json 存在、每个文件都读得动、且至少 1 条钩子；`ready:false` 时渲染首行固定为「不可用：<原因>」（未配置时追加配置写法与最小示例）。
- **错误码**：`hooks_test` 认不出 event 时返回 `code: 'UNKNOWN_EVENT'`；`hooks_reload` 按情况返回 `CONFIG_INVALID` / `CONFIG_MISSING` / `NO_HOOKS`（成功为 `''`）。
- `load()` 增加 `unreadable` 计数，把「文件读不到」与「配置写错」分开，状态判定不再混为一谈。

### Verification
- `node --check` 通过；`_selftest/tests/hooks.test.mjs` 10 项全过。
- 真实模块验证：真 hooks.json → `ready:true`；`DSH_HOOKS_FILE` 指向不存在文件 → `ready:false` + 「不可用：没有找到 hooks.json（候选：…）」；`hooks_test` 传 `nonsense` → `code=UNKNOWN_EVENT`。

## v0.1.0（补记于 2026-10-31）

### Added
- 用户级 hooks：`hooks.json` 把 `tool.pre` / `tool.post` / `session.start` / `turn.stop` 事件映射成命令，支持 `allow` / `ask` / `deny`，`onError` 可配置（护栏全用 `deny`）。
- 工具：`hooks_status`（配置来源、每条钩子、执行统计、最近记录、错误）、`hooks_test`（对单个事件做 dry-run）、`hooks_reload`。
- 示例护栏脚本：danger / fs / code / cred / self / gui 六层（见 `examples/`）。

### Verification
- 单测 + 验证门通过（含 67 条安全护栏回归）；真机：`hooks_status` 报 6 条钩子、0 误拦。
