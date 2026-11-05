# Changelog

## 1.0.0 (vendored 2026-11-05)

- 上游来源：https://github.com/5D-artist/dsh-archived-purge @ 6c484e695690b3ace35001fbbb6222e8f8a0ee58（2026-11-04，MIT）。
- 本仓副本：`D:\AI\dsh-bundles\dsh-archived-purge`，由本工作区维护；上游变更需手动同步并在本文件记一笔。
- 功能：设置 → 归档清理，列出全部已归档会话（按工作区分组、显示体积/最后活动/日志缺失、运行中标记），支持全选/逐条选择后永久删除；删除四类痕迹——会话日志目录、投影缓存单文件、工作区记账（`Workspace.detachSession`）、归档集合（`workspaceRegistry.unarchiveSession`），并级联清理 `origin: subagent` 的子会话日志；拒绝运行中的会话。
- 纳入验证门：`_selftest/tests/archived-purge.test.mjs`（7 条）。
