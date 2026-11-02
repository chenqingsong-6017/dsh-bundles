# CHANGELOG — dsh-reasoning-slider

本文件于 2026-10-31 按「改到谁补谁」的规则建立；当前版本为存量版本，本节为补记。

## v0.2.0 — 2026-11-02（恢复）

### Added
- 从 git 历史 `531427e` 取回源码（2026-11-02 00:25 的 `f017ed2` 曾按用户「旧版删除」裁决删掉归档副本），重新装回 profile：`node_modules/@local/dsh-reasoning-slider` junction + `package.json` 依赖 + `dsh.profile.bundles` 条目。
- 恢复 `_selftest/tests/reasoning-slider.test.mjs`（契约测试）。

### Verification
- 宿主侧真机：`reasoning_status` 出现在工具列表并返回「就绪：客户端插件：滑条在 lib/client.js，走官方 Session RPC，无服务端工具」。
- rc.5 兼容核对（asar 源码）：`conversation.input.right`（list / session scope）仍在 `dsh-client-ui-conversation`；`modelCatalog` / `selectModel` Remote 仍在 `dsh-api-session-controller`；`ctx.slots.inject` + `register({name,id,order})` 签名与官方示例一致。
- 验证门 `npm run check` 通过。
- 待验收：客户端 UI 需刷新页面（`Ctrl+R`）后确认滑条回到输入栏右侧。

## v0.1.1 — 2026-11-01

## v0.1.1 — 2026-11-01

### Added
- 统一契约（工具面就绪度）：宿主半体 `lib/index.js` 新增最小诊断工具 `reasoning_status`，只报 `ready` / `unavailableReason` / `note`（客户端插件，无服务端工具 → 恒就绪）。`apply` 从空函数改为注册这一个工具，`inject` 补 `tools`。
- 滑条本身（`lib/client.js`）一字未改，行为不变。

### Verification
- `_selftest/tests/reasoning-slider.test.mjs` 全过（runSmoke 结构合规 + 契约断言：三字段在 required 里、返回值与 schema 严格同构、`note` 讲清是客户端插件）。
- 未做真机验证：新增工具要等 profile 重组后才会出现在工具列表（旧进程内仍是空 `apply`）。

## v0.1.0（补记于 2026-10-31）

### Added
- 客户端插件（`dsh.client`，platform: web）：输入栏右侧四档推理等级滑条，直接改当前会话 `reasoningEffort`。
- EVA 能量条外观：危险条纹标记 + 分段发光轨道 + 能量白核滑块 + 等宽百分比读数；拖动跟手、松手吸附档位。
- 键盘可达（方向键 / Home / End），注入 `@deepseek-ai/dsh-api-session-controller`、`dsh-client-locale`、`dsh-api-remotes`。

### Verification
- 单测 + 验证门通过；历史会话已实测槽位 active、拖拽与键盘改档生效（外观类插件，无宿主工具接口）。
