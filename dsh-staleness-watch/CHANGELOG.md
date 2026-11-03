# CHANGELOG — dsh-staleness-watch

本文件于 2026-10-31 按「改到谁补谁」的规则建立；当前版本为存量版本，本节为补记。

## v0.1.2 — 2026-11-02

### Fixed
- **element_token 寻址时 key 分裂**（误报扫描 #33）：旧 `targetKey = pid + (args.window_id ?? '-')`，用 `element_token` 寻址（参数常无 `window_id`）时 key 变 `pid|-`，而 `get_window_state(pid, window_id)` 复位的是 `pid|12345` → block 模式下「刚快照过仍被拦」，拦下来还让人再快照一次。
- 现在缺 `window_id` 时按 pid 反查最近一次快照的 window_id（`snapshots.byPid`），查不到才退回 pid 级 key `pid|*`；快照同时复位该 pid 的 pid 级 key；拦截文案对 `pid|*` 只提示 `get_window_state(pid=…)`。

### Tests
- 先加用例跑旧代码：4 次 element_token 盲操作 + 快照后 guard 仍拦截（用例失败）；改后放行。
- 新增：element_token 与显式 window_id 共享同一计数器、缓存按 pid 隔离。`_selftest/tests/staleness-watch.test.mjs` 9 项通过。

### Known limitations
- 未用真实 cua 工具跑 `click({pid, element_token})` + `mode:block` 复现（扫描报告 #33 建议的真机复核）；本次验收是 mock ctx 单测级。

## v0.1.1（补记于 2026-10-31）

### Added
- 运行时陈旧检测：按「pid + window_id」跟踪桌面/浏览器类工具的目标；同一目标连续盲操作（未先快照）超过 `maxBlindActions`（默认 3）时告警。
- 两种模式：`warn`（只在结果里追加告警，不打断）/ `block`（在 `tools/guard` 拦下一次输入操作，要求先快照）。
- 动作类与快照类工具用正则归类，覆盖 cua / browser 两套命名。

### Verification
- 单测 + 验证门通过；无工具接口，行为靠 hooks 管线观测（本次体检期间未刻意触发）。

### Known limitations
- 只对命中正则的桌面/浏览器工具生效；纯文本工具不参与。
