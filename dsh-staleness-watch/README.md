# dsh-staleness-watch —— 陈旧快照告警

Host 插件：把"动作之后必须重新观察"从提示词约束变成**事件级策略**。挂在工具管线上，盯着桌面/浏览器类工具的目标（pid + window）。

- **安装位置**：`D:\AI\dsh-bundles\dsh-staleness-watch`
- **挂载点**：`tools/post-execute`（观测层）+ `ctx.tools.guard()`（强制层）

## 两种模式

| 模式 | 行为 | 何时用 |
|---|---|---|
| `warn`（默认） | 在工具结果里追加告警，**永不打断** | 日常，靠模型自觉 |
| `block` | 连续盲操作达到阈值后，**拦截下一次输入操作**，要求先取快照 | 需要硬保证时 |

`block` 用的是 `ctx.tools.guard()` 而不是 `post-execute`——因为 post 阶段动作已经发生，拦不住；guard 在动作之前运行，返回字符串即拒绝。

## 配置

```yaml
- id: staleness-watch
  name: '@local/dsh-staleness-watch'
  config:
    mode: block            # warn（默认）| block
    maxBlindActions: 3     # block 模式下连续多少次输入操作后拦截
```

## 跟踪哪些工具

- 输入类：`click` / `type_text` / `press_key` / `hotkey` / `scroll` / `drag` / `set_value` / `launch_app` / `bring_to_front`
- 快照类（用于清零）：`get_window_state` / `get_browser_state` / `get_desktop_state` / `verify_state`

按 `pid + window_id` 分组计数，不同目标互不影响；不带目标参数的工具直接忽略。

## 验证记录（2026-10-25）

| 模式 | 覆盖 |
|---|---|
| warn | 10 项全过：快照基线、首次点击、复用旧 token 告警、快照后清零、连续盲操作×3、不同 pid 隔离、非 cua 工具忽略、结果形态不改写 |
| block（maxBlindActions=2） | 6 项全过：达到阈值后拦截、提示先取快照、快照后放行 |

实测拦截文案：

```
staleness-watch 已拦截: 目标 pid=100 window=7 已连续 2 次输入操作未重新观察。
请先调用 get_window_state(pid=100, window_id=7) 取得新快照,确认页面/窗口的实际状态后再继续。
```

## 边界

- 只按 `pid/window_id` 识别目标；某些工具用别的定位方式时不会被统计；
- 不感知"内容是否真的变了"，只计"有没有重新观察"；
- `block` 模式会改变执行结果（拒绝），排查问题时先切回 `warn`。

## 验证记录（2026-11-01，统一契约：ready / unavailableReason / 错误 code）

| 项 | 结果 |
|---|---|
| `staleness_status` | 新增（本插件首个工具）；`ready` 现算：配置合法 + `ctx.tools.guard` 与 `ctx.on('tools/post-execute')` **真的挂上了**（挂载结果记在局部变量里，不是写死） |
| 挂载方式 | 两个回调从内联箭头改成命名常量（`guardHook` / `postHook`），挂载成功才置位；行为与文案未变 |
| `ready:false` 的 code | 配置非法 → `STALENESS_CONFIG_INVALID`；钩子缺失 → `STALENESS_HOOKS_UNAVAILABLE` |
| `node --check index.js` | 通过 |
| `node _selftest/tests/staleness-watch.test.mjs` | 6 项通过，退出码 0 |
| 契约真机校验 | 正常挂载 `ready:true`；去掉 `ctx.tools.guard` 后 `ready:false`；`mode: nonsense` / `maxBlindActions: -1` → `ready:false` |
