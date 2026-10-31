# CHANGELOG — dsh-browser-bundle

## 1.0.2 — 2026-10-31

### Fixed
- 依赖版本从过期的 `0.2.1-rc.3` 同步到当前安装包 `0.2.1-rc.5`（与 profile 实际装配版本一致），消除清单漂移。

### Verification
- 真机：`browser_navigate about:blank` + `browser_snapshot` 成功（Playwright MCP 后端走本机 Edge）。

## 1.0.1 — 补记于 2026-10-31

### Added
- 配置型 bundle（无代码）：一份 patch 挂载 `@deepseek-ai/dsh-browser-use` 与 `dsh-experimental-browser-use-playwright-mcp`，`executablePath` 指向本机 Edge，`mode: launch`、`headless: false`。
