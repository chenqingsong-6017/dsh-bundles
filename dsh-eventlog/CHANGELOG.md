# CHANGELOG

格式：Keep a Changelog；版本号跟 `package.json`。

## v0.1.4 — 2026-11-01

### Changed
- **统一状态契约**：`log_status` 新增 `ready` / `unavailableReason`（两者都进 `required`）。`ready` 是真判断——对日志目录做一次真实探针（建目录 → 列目录 → 写 `.write-probe-<pid>.tmp` → 删掉），不靠 `accessSync(W_OK)`（Windows 上对 ACL 不可信）。探针文件名不匹配 `events-*.jsonl`，不会被 `log_query` 或条数统计算进去。
- `log_status` 变了一点副作用：为判定「可写」，每次调用会在日志目录里建一个探针文件并立刻删掉（工具描述里已注明）。
- **错误码**：`log_write` 失败返回 `code`——`EMPTY_MESSAGE` / `LEVEL_FILTERED`（低于 `minLevel`，原来静默 `ok:false` 无原因）/ `WRITE_FAILED`；成功时 `code` 仍是写入事件的 code（如 `MILESTONE`），由 `ok` 区分。

### Tests
- `_selftest/tests/eventlog.test.mjs` 16 项全过；另做真实模块验证：可写目录 → `ready:true`，目录建不出来 → `ready:false` + 「不可用：日志目录不可写/不可读（…）：ENOTDIR…」；`log_write` 三种失败码逐个实测。

## v0.1.3 — 2026-11-01

### Fixed
- **轮转碎成一条一文件**：`append()` 只在「基文件 > 8MB」时按 `.1/.2/...` 找第一个**不存在**的编号，导致基文件一旦超阈值，之后每条事件都新建一个文件（实测：12.67MB 基文件后连写 3 条生成 `.1~.4`，一天能碎出几千个文件）。现在按「候选文件是否已满」判断，`.1` 满了才建 `.2`。
- **空事件会被写进去**：`log_write({ message: "   " })` 原来 `ok:true` 并落一条空 message 事件，现在直接拒绝（`ok:false`）并写 `lastError` 说明原因。
- **成功却被记成失败**：捕获条件原来只要 payload 里有 `error` 字段就记 `TOOL-ERROR`；显式 `isError:false` 的调用也被误报。现在显式成功一律跳过。

### Tests
- 新增 3 项（轮转续写 / 空 message 拒绝 / 显式成功不误报）→ 单测 13 → 16 项。
## v0.1.2 — 2026-11-01

### Fixed
- **只落错误类名、丢真实原因**：v0.1.1 按 `message.error → message.content → data.error` 取值，但真实 payload 里 `message.error` 不存在、`data.error` 只有 `{ name: CodeRunFailedError, code: CODE_RUN_FAILED }`，于是日志写成「run_code 调用失败：CodeRunFailedError」——等于没记原因（2026-11-01 重启后实测到）。
- 取值顺序改为 `message.error → message.content → data.message → data.content → data.error`（正文优先、类名兜底），并只取首行，调用栈不进 message。
- 顺带兼容 `session.id`，避免会话列留空。

### Tests
- 新增 1 项：content 有正文、error 只有类名时，message 必须是正文首行、不含类名、不含 ` at ` 栈帧 → 单测 12 → 13 项。
## v0.1.1 — 2026-11-01

### Fixed
- **自动捕获读错事件字段**：v0.1.0 读 `data.isError` / `data.name`，但真实 `tool/result` 形状是 `{ message: { isError, toolCallId, content } }`，工具名只在 `tool/call` 里 —— 结果记成 `source: unknown`、`message: unknown 调用失败：[object Object]`（2026-11-01 真机日志里实测到 1 条）。
- 现在按 `tool/call` 的 `callId` 建 200 条上限的映射回查工具名，错误正文取 `message.error` → `message.content[].text` → `data.error` 依次回退，逐层 `String` 保护，不会再出现 `[object Object]`。
- 兼容 v0.1.0 的旧形状（顶层 `isError` / `name`），已有调用方不受影响。

### Tests
- 新增 1 项：真实 payload（`message` 包装 + `callId` 映射 + 正文断言 + 不出现 `[object Object]`）→ 单测 11 → 12 项。
## v0.1.0 — 2026-11-01

### Added
- 首个版本：照 Windows 事件查看器模型的本地事件日志。频道 / 级别 / 稳定事件码 / 来源 / 数据载荷。
- `log_write`：写一条事件（给 agent 与其它插件的通用入口）。
- `log_query`：按 channel / level（≥）/ code / since / until / keyword 查，倒序、有 limit。
- `log_status`：文件数 / 条数 / 字节 / 最早最新 / 保留策略 / 本次已写 / 最后错误。
- 自动捕获：`session/event` 里 `tool/result` 且 `isError === true` → `TOOL-ERROR`（warn）。
- 启动即写 `LOG-START` 事件，解决「什么时候开始不对」。
- 按天滚动 + 单文件 8MB 滚动 + `keepDays` 自动清理 + `minLevel` 过滤。

### Design
- **不进上下文**：不注册 systemPrompt 层。
- **fail-safe**：写失败只记账不抛。
- **不重复**：全量工具调用审计仍归 `dsh-audit`。
