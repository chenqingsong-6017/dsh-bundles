# CHANGELOG — dsh-notify

本文件于 2026-10-31 按「改到谁补谁」的规则建立；v0.1.0 为存量版本补记。

## v0.1.1 — 2026-10-31

### Fixed
- **桌面通知恢复**：`inject` 从 `['tools']` 改为 `['tools', 'subprocess']`。根因是 cordis 4.x 的 `ctx.get()` 只返回「提供者已激活」的服务（`impl.fiber.state === 2`），v0.1.0 在 `apply()` 阶段取 `subprocess` 时为 undefined，`canToast` 永久为 false，2026-10-27 起全部通知退化为只写日志。
- 对照证据：同仓 `dsh-updater` 声明了 `inject = ['tools', 'subprocess']`，`resolveExecutable('git'|'node')` 正常，说明服务本身存在；手工调用 WinRT Toast 脚本 exit=0 / `toast-ok`，说明通道可用。

### Verification
- 单测 + 验证门通过；重启后真调 `notify` 工具，`notify_status.transport` 应为 `toast`。

## v0.1.0（补记于 2026-10-31）

### Added
- 回合结束事件订阅：完成 / 失败 / 中断可分别开关（`notifyOnComplete` / `notifyOnError` / `notifyOnInterrupt`），短于 `minDurationMs` 的回合不打扰。
- `notify` 工具：agent 可在长任务中途主动喊人；`notify_status` 收口通道、计数、最近错误。
- 三级传输回退：PowerShell 5.1 WinRT Toast → pwsh WinForms 气泡 → 仅日志；记录按天落 `storeDir`。
