# dsh-browser-bundle —— 浏览器使用

配置型 bundle：不写代码，只把两个官方插件挂进 profile。

| 行 | 插件 | 作用 |
|---|---|---|
| `browser-use` | `@deepseek-ai/dsh-browser-use` | 共享的浏览器能力注册表 |
| `browser-use-playwright` | `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` | Playwright MCP 后端，跑本机 Edge/Chromium |

- **安装位置**：`D:\AI\dsh-bundles\dsh-browser-bundle`
- **安装**：`plugin_manager action=install_bundle target=D:\AI\dsh-bundles\dsh-browser-bundle`

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

## 边界

- 浏览器权限/登录态跟随 `executablePath` 指向的浏览器用户目录；
- 页面操作是真实浏览器行为，会留下访问痕迹；
- 与 `dsh-computer-bundle` 互不干扰（一个管浏览器，一个管桌面窗口）。
