# CHANGELOG — dsh-browser-bundle

## 1.1.0 — 2026-11-01

### Added
- 统一契约（工具面就绪度）：bundle 从「纯 mount、无 js」改为带一个**只做诊断**的宿主半体 `index.js`，新增 `browser_status`，只报 `ready` / `unavailableReason` / `note`。判据 = `browserUse` 服务存在且已注册 provider；不可用时 render 显示「不可用：<reason>」。
- patch 增加诊断行 `browser-status`（`@local/dsh-browser-bundle`），排在两行挂载之后；**不注册任何浏览器工具、不改两行挂载配置**。
- 刻意不把 `browserUse` 写进 `inject`：挂载失败时诊断行仍要能加载，否则最需要诊断时反而没工具可问。

### Verification
- `_selftest/tests/browser-bundle.test.mjs` 全过（runSmoke 结构合规 + 可用/不可用两分支契约断言）。
- `_selftest/schema-check.mjs`：`browser_status` PASS（schema 结构 + render 冒烟）。
- 未做真机验证：新增的 patch 行需要 profile 重组后才会注册工具。

## 1.0.2 — 2026-10-31

### Fixed
- 依赖版本从过期的 `0.2.1-rc.3` 同步到当前安装包 `0.2.1-rc.5`（与 profile 实际装配版本一致），消除清单漂移。

### Verification
- 真机：`browser_navigate about:blank` + `browser_snapshot` 成功（Playwright MCP 后端走本机 Edge）。

## 1.0.1 — 补记于 2026-10-31

### Added
- 配置型 bundle（无代码）：一份 patch 挂载 `@deepseek-ai/dsh-browser-use` 与 `dsh-experimental-browser-use-playwright-mcp`，`executablePath` 指向本机 Edge，`mode: launch`、`headless: false`。
