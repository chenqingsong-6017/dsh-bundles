# Changelog

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
