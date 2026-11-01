# dsh-browser-bundle —— 浏览器使用

配置型 bundle：挂载两行官方插件，另带一个**只做诊断**的宿主半体。

| 行 | 插件 | 作用 |
|---|---|---|
| `browser-use` | `@deepseek-ai/dsh-browser-use` | 共享的浏览器能力注册表 |
| `browser-use-playwright` | `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` | Playwright MCP 后端，跑本机 Edge/Chromium |

- **安装位置**：`D:\AI\dsh-bundles\dsh-browser-bundle`
- **安装**：`plugin_manager action=install_bundle target=D:\AI\dsh-bundles\dsh-browser-bundle`

## 工具

| 工具 | 作用 |
|---|---|
| `browser_status` | 诊断口（2026-11-01 统一契约）：只报 `ready` / `unavailableReason` / `note`。判据 = `browserUse` 服务存在且已注册 provider（= Playwright MCP 后端起来了）；不可用时 render 显示「不可用：<reason>」 |

宿主半体 `index.js`（patch 里的 `browser-status` 行）**只注册这一个工具**，不注册浏览器工具、不改两行挂载配置。
它刻意不 `inject: ['browserUse']`：挂载失败时这一行仍要能加载，否则最需要诊断的时候反而没有工具可问。

## 配置

patch 里 `browser-use-playwright` 的配置（本机）：

```yaml
config:
  mode: launch            # 由 bundle 自己拉起浏览器
  headless: false         # 有头模式，便于观察
  executablePath: 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
```

- 想用别的浏览器：改 `executablePath`（Chrome / Chromium 均可）；
- 想看它到底在干什么：保持 `headless: false`；
- 无头跑：`headless: true`。

## 验证记录（2026-10-25）

- 两行插件 `enabled + active`；agent 侧能看到 `browser_*` 系列 MCP 工具（工具名 `mcp__playwright-mcp__*`）。
- 本机 Playwright MCP 进程以 Edge 可执行文件启动（profile 的 node_modules 里有 `@playwright/mcp`）。

## 验证记录（2026-11-01，统一契约）

- `_selftest/tests/browser-bundle.test.mjs`：runSmoke 结构合规 + `browser_status` 可用/不可用两分支契约断言，全过。
- `_selftest/schema-check.mjs`：`browser_status` PASS（schema 结构 + render 冒烟）。
- **未做真机验证**：新增的 patch 行要等 profile 重组后才注册工具，当前运行进程内还没有 `browser_status`。

## 边界

- 浏览器权限/登录态跟随 `executablePath` 指向的浏览器用户目录；
- 页面操作是真实浏览器行为，会留下访问痕迹；
- 与 `dsh-computer-bundle` 互不干扰（一个管浏览器，一个管桌面窗口）。
