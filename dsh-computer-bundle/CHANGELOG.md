# CHANGELOG — dsh-computer-bundle

## 1.0.2 — 2026-10-31

### Fixed
- 依赖版本从过期的 `0.2.1-rc.3` 同步到当前安装包 `0.2.1-rc.5`（与 profile 实际装配版本一致），消除清单漂移。

### Verification
- 真机：`cua get_screen_size`（2560x1440）/ `list_windows` 成功；cua 工具收窄为 20 个（`_ops/cua-tool-filter.mjs`）。

## 1.0.1 — 补记于 2026-10-31

### Added
- 配置型 bundle（无代码）：一份 patch 挂载 `@deepseek-ai/dsh-computer-use` 与 `dsh-experimental-computer-use-cua-driver-native`（Cua Driver 原生后端）。

### Known limitations
- 隐式会话长时间空闲后会报 `this session has ended`；需重启 DSH 或显式 `start_session` 并传 `session`。
