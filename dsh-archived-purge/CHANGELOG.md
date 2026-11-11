# Changelog

## 1.3.0-vendored.1 (2026-11-11)

- **整体升级到上游 1.3.0**（https://github.com/5D-artist/dsh-archived-purge @ 58a73c9，2026-11-07，MIT），基线从 1.0.0（6c484e69）跨过 1.0.1 / 1.0.2 / 1.1.0 / 1.2.0 / 1.3.0：
  - 驻留但空闲的归档会话可删（1.0.1）：`workspace/session-activity` waterfall 判定「是否真有活」，替代本仓旧的 release-then-delete；
  - 删除后的驻留会话不再掉进「未分组」（1.0.2）：记账与归档标记延后到下次启动由 `finalizePending()` 回收；
  - 引用感知的附件清理（1.1.0）：先读日志收集引用，再删孤儿对象，读不全就整次放弃；
  - 删除产物的 manifest + 历史残留扫描（1.2.0）：`POST /leftovers` 与 `POST /purge-leftovers`；
  - `everything` 语义、定时任务清理、页面重设计（1.3.0）；`attachments:false` 显式退出（58a73c9）。
- **保留本地增强**：删除后为每个 id 的两种拼写补播 `api-session/removed`；新增 `POST /plugins/archived-purge/announce`；客户端删除成功后 `sessions.refresh()`。
- **移除本地旧实现**：release-then-delete（停 agent → flush → detach live 条目）不再保留——上游 1.0.1 的方案更稳（不强行 detach 内存中的会话，避免与宿主存储层竞争）。
- 测试：上游 5 个测试文件 39 条 + 本仓补丁 3 条 = 42 条全过；`npm run check` 验证门通过。
- 真机（DSH 0.2.2-rc.1）：`GET /state` 返回 1.3.0 字段（`activity` / `resident` / `scheduleCount` / `pendingFinalize`），`/scan`、`/leftovers`、`/gc`(dryRun)、`/announce` 均可用；`activity` 无 `activityUnknown` 标记 = rc.1 的 `workspace/session-activity` waterfall 正常应答。删除链路未在本轮真机执行（19 条归档会话是真实数据，不冒险）。

## 1.0.0-vendored.3 (2026-11-06 00:20)

- 仅验证记录，无代码改动：DSH 升级到 **0.2.2-rc.1** 后**全链路复验通过**——单测 11/11、`/state` 真机可用、rc.1 的 `workspace/archiveSession`+`unarchiveSession` 存在、**真机删除成功**（`deleted:1 / released:true / failed:0 / removedBytes:6034`，目录与投影缓存消失、10 秒不重建、归档集归零）。方法与临时验证路由的撤销证据见 README 文末。

## 1.0.0-vendored.2 (2026-11-05 23:10)

- **修「删了还在 / 回到未分组」**：宿主删除后显式 `emit('api-session/removed')`（两种 id 拼写），client 删除成功后调用 `sessions.refresh()` 重拉基线；新增 `POST /plugins/archived-purge/announce` 用于补播已删 id（清理客户端陈旧行）。
- 测试：11 条（新增 announce/双拼写两条）。

## 1.0.0-vendored.1 (2026-11-05 22:45)

- **release-then-delete**：归档会话处于「已挂载 / 运行中」时不再直接拒绝，而是先停 agent（cancel + 15s 有界等待）→ flush store → detach `sessions.store` / `agents.store` 条目，再删盘；释放不掉仍拒绝（避免存储层删后重建目录）。
- 客户端文案：运行中徽标与确认弹窗改为「运行中（删除会先停止）」/「运行中的会话会先停止」。
- 测试：8 条（新增「释放后删除」「释放失败拒绝」）。
- 来源：release 顺序参考 liuyu-f/dsh-plugin-session-cascade-delete（MIT）的 delete 链路。

## 1.0.0 (vendored 2026-11-05)

- 上游来源：https://github.com/5D-artist/dsh-archived-purge @ 6c484e695690b3ace35001fbbb6222e8f8a0ee58（2026-11-04，MIT）。
- 本仓副本：`D:\AI\dsh-bundles\dsh-archived-purge`，由本工作区维护；上游变更需手动同步并在本文件记一笔。
- 功能：设置 → 归档清理，列出全部已归档会话（按工作区分组、显示体积/最后活动/日志缺失、运行中标记），支持全选/逐条选择后永久删除；删除四类痕迹——会话日志目录、投影缓存单文件、工作区记账（`Workspace.detachSession`）、归档集合（`workspaceRegistry.unarchiveSession`），并级联清理 `origin: subagent` 的子会话日志；拒绝运行中的会话。
- 纳入验证门：`_selftest/tests/archived-purge.test.mjs`（7 条）。
