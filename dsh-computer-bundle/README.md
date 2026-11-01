# dsh-computer-bundle —— 桌面操作

配置型 bundle：挂载两行官方插件，另带一个**只做诊断**的宿主半体。

| 行 | 插件 | 作用 |
|---|---|---|
| `computer-use` | `@deepseek-ai/dsh-computer-use` | 共享的桌面操作能力注册表 |
| `computer-use-cua-native` | `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native` | Cua Driver 原生后端（Windows 二进制） |

- **安装位置**：`D:\AI\dsh-bundles\dsh-computer-bundle`
- **安装**：`plugin_manager action=install_bundle target=D:\AI\dsh-bundles\dsh-computer-bundle`

## 工具

| 工具 | 作用 |
|---|---|
| `computer_status` | 诊断口（2026-11-01 统一契约）：只报 `ready` / `unavailableReason` / `note`。判据 = `computerUse` 服务存在且已注册 provider（= Cua Driver 原生后端起来了）；不可用时 render 显示「不可用：<reason>」 |

宿主半体 `index.js`（patch 里的 `computer-status` 行）**只注册这一个工具**，不注册桌面工具、不改两行挂载配置。
它刻意不 `inject: ['computerUse']`：挂载失败时这一行仍要能加载，否则最需要诊断的时候反而没有工具可问。

## 能力

agent 侧会看到 `cua_driver_*` 系列工具：窗口快照（UIA 树 + 截图）、元素/坐标点击、输入、按键、滚动、拖拽、启动应用等。

## 使用要点

- 每次动作前先取一次 `get_window_state`（或 `get_desktop_state`）拿新鲜快照；元素 token 会随快照失效；
- 默认用 `delivery_mode: background` 投递，前台只在该方式被拒后才用；
- 动作后要**重新观察**再继续——这一条由同机的 `dsh-staleness-watch` 在工具管线层兜底（连续盲操作会告警/拦截）。

## 验证记录（2026-10-25）

- 两行插件 `enabled + active`；`cua_driver_*` 工具已在本会话可用（做过真实窗口快照与后台点击）。
- CUA 原生二进制随插件依赖安装，无需额外配置。

## 验证记录（2026-11-01，统一契约）

- `_selftest/tests/computer-bundle.test.mjs`：runSmoke 结构合规 + `computer_status` 可用/不可用两分支契约断言，全过。
- `_selftest/schema-check.mjs`：`computer_status` PASS（schema 结构 + render 冒烟）。
- **未做真机验证**：新增的 patch 行要等 profile 重组后才注册工具，当前运行进程内还没有 `computer_status`。

## 边界

- 只操作本机桌面；远程桌面（RDP）场景行为取决于会话是否被前台化；
- 与 `dsh-browser-bundle` 分工：浏览器内操作用 Playwright 后端，桌面窗口用 CUA。
