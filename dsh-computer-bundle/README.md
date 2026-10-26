# dsh-computer-bundle —— 桌面操作

配置型 bundle：不写代码，只用一份 patch 把两个官方插件挂进 profile。

| 行 | 插件 | 作用 |
|---|---|---|
| `computer-use` | `@deepseek-ai/dsh-computer-use` | 共享的桌面操作能力注册表 |
| `computer-use-cua-native` | `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native` | Cua Driver 原生后端（Windows 二进制） |

- **安装位置**：`D:\AI\dsh-bundles\dsh-computer-bundle`
- **安装**：`plugin_manager action=install_bundle target=D:\AI\dsh-bundles\dsh-computer-bundle`

## 能力

agent 侧会看到 `cua_driver_*` 系列工具：窗口快照（UIA 树 + 截图）、元素/坐标点击、输入、按键、滚动、拖拽、启动应用等。

## 使用要点

- 每次动作前先取一次 `get_window_state`（或 `get_desktop_state`）拿新鲜快照；元素 token 会随快照失效；
- 默认用 `delivery_mode: background` 投递，前台只在该方式被拒后才用；
- 动作后要**重新观察**再继续——这一条由同机的 `dsh-staleness-watch` 在工具管线层兜底（连续盲操作会告警/拦截）。

## 验证记录（2026-10-25）

- 两行插件 `enabled + active`；`cua_driver_*` 工具已在本会话可用（做过真实窗口快照与后台点击）。
- CUA 原生二进制随插件依赖安装，无需额外配置。

## 边界

- 只操作本机桌面；远程桌面（RDP）场景行为取决于会话是否被前台化；
- 与 `dsh-browser-bundle` 分工：浏览器内操作用 Playwright 后端，桌面窗口用 CUA。
