# CHANGELOG

格式：Keep a Changelog；版本号跟 `package.json`。

## v0.1.1 — 2026-11-01

### Fixed
- **默认工作区解析错**：插件进程的 cwd 是 profile 目录（`C:\Users\…\.dsh\profiles\desktop`），v0.1.0 直接拿 cwd 当工作区，导致 ① 报告默认写进 profile 的 `_research/` ② 相对 `文件:行` 引用解析不到（真机验证时实测：`outPath: _research/x.md` 落到了 profile 下）。
- 现在按 `config.workspaceDir` → DSH `storages/workspace.json` 里最近更新的工作区 → cwd 逐级回落；相对 outPath 与相对文件引用都用同一个根。

### Tests
- 新增 1 条：`readActiveWorkspace` 取最近工作区、缺失时回落空串、无 env 不抛 → 单测 8 → 9 组。
## v0.1.0 — 2026-11-01

### Added
- 首个版本：调研工作台（任务 / 证据 / 体检 / 报告 / 状态）。
- `research_new`：decision 少于 8 字拒绝（强制先想清「这条结论要决定什么」）。
- `research_evidence`：要求 `https://…` 或 `文件:行`；无落点必须 `inferred:true`（进未验证区）；`tier=search` 置信度压到 `medium` 及以下。
- `research_check`：统计无落点 / 推断 / 未核对链接 / 断引用 / 低置信度，给出 `canClose`。
- `research_report`：Markdown（结论表 + 未验证区 + 统计），原子写；缺证据拒绝（除非 `allowIncomplete:true`）；可 `close`。
- `research_status`：任务数 / 开放数 / 证据数 / 层级分布 / 存储字节 / `lastError`。
- 文件引用核查：查存在、类型、行号范围（> 8MB 只提示不逐行）。

### Design
- **纯数据**：store 是 JSON、报告是 Markdown，随时可导出/迁移。
- **fail-safe**：读写失败只记 `lastError`，不抛。
- **不替人判断**：只做「缺什么」的机械检查。

