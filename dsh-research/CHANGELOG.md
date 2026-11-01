# CHANGELOG

格式：Keep a Changelog；版本号跟 `package.json`。

## v0.1.2 — 2026-11-01

### Changed
- **统一状态契约**：`research_status` 新增 `ready` / `unavailableReason`（两者都进 `required`）。`ready` 是真判断：`store.json` 存在、JSON 解析得开、`tasks` 是数组；不存在 / 坏 JSON / 结构不对都 `ready:false` 并在原因里给出路径与实际错误。`ready:false` 时渲染只输出「不可用：<原因>」。
- **错误码**：所有 `ok:false` 返回都带 `code`（UPPER_SNAKE）——`QUESTION_TOO_SHORT` / `DECISION_TOO_SHORT` / `TASK_LIMIT` / `CLAIM_TOO_SHORT` / `INVALID_TIER` / `NO_TASK` / `TASK_CLOSED` / `EVIDENCE_LIMIT` / `EVIDENCE_UNVERIFIABLE` / `STORE_WRITE_FAILED` / `UNVERIFIED_BLOCKED` / `REPORT_TOO_LARGE` / `STATUS_FAILED` / `UNEXPECTED_FAILURE`；成功返回 `code: ''`。

### Tests
- `_selftest/tests/research.test.mjs` 9 组全过；另做真实模块验证：store 可读 → `ready:true`，store 缺失 / 坏 JSON → `ready:false` + 「不可用：…」。

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

