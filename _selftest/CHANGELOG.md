# CHANGELOG — _selftest（测试基建）

本文件记录 `_selftest` 自身的变更（不是某个插件的变更）；各插件仍用自己的 `<插件>/CHANGELOG.md`。
建立于 2026-11-02，按「改到谁补谁」推进。

## 2026-11-02 — 测试临时目录统一回收 + 门禁兜底

### Fixed
- **memory 系列测试临时目录泄漏**（本仓实测 5 小时积 153 个目录 / 23.7 MB）：
  - `mkdtempSync` 建的目录，`node:sqlite` 连接锁住 `memory.db` 时 `rmSync` 在 Windows 上报 EBUSY，被 `catch` 静默吞掉；
  - `memory-v42.test.mjs` 的 `reference` / `budget` 两个用例压根没写清理；
  - 清理内联在断言之后而非 `finally`，测试中途失败即跳过。
- **`eventlog.test.mjs:175`**：建了 `dsh-eventlog-q-` 目录，但 `rmSync` 删的是块外的 `dir`（删错对象）。
- **`metrics-stability.test.mjs`**：`metrics-empty-` 块整块无清理。

### Added
- `tests/_tmp-dirs.mjs`：临时目录统一入口，三道保险——
  1. 目录名带 pid，下次运行认出「上次进程已死」的遗留；
  2. `process.on('exit')` 兜底删自己的；
  3. `sweepAllTestDirs()` 按进程启动时刻判定全部测试遗留（前缀表见源码，刻意列全不通配，避免误删 `dsh-subprocess-*` 等运行时目录）。
- `gate/check.mjs` 在测试门前调用一次 `sweepAllTestDirs()`，单点兜底：以后哪个测试文件漏了都会被补扫。

### Verification
- 三个受影响测试：9 / 5 / 131 项全过，exit=0。
- 全量门禁：34 个测试通过（31.4s），exit=0。
- 造 2 个带测试前缀的假遗留目录 → 跑门禁后被清、本次零新增。
- commits：`2820935`（memory 专项）、`d05485d`（全量推广）。

### Known limitations
- `TEST_PREFIXES` 手工维护：新增测试若用新前缀，须补进表里，否则 `sweepAllTestDirs` 扫不到。
- 只扫 `%TEMP%`；`checkpoint` / `butler-tidy` / `repomap` 用 `DATA_ROOT` 等其它目录，实测无泄漏，未纳入。
- 若多个测试进程**并行**跑，理论上 A 会误清 B 启动前建的目录；`gate` 是串行 `spawnSync`，无此风险。
