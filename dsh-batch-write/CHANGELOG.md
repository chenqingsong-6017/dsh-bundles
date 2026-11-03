# CHANGELOG — dsh-batch-write

## v0.2.0 — 2026-11-03

### Added（B4 write gate：`_research/harness-patterns/synthesis-2026-11-03.md`）
- **写前预演闸**：`apply:true` 的 ops 必须与此前一次成功的 dry-run 完全相同（sha256 比对），否则抛 `BATCH_NO_PREVIEW` 并提示先预演。dry-run 有失败项不记闸。

### Verification
- 测试 6 → 7 组：未预演直接 apply 拒绝且文件不动、dry-run 后 apply 放行、ops 变化后重新拒绝。

## v0.1.0 — 2026-11-03

### Added
- `batch_write` / `batch_write_status` 两个工具：批量改 N 文件、内部先读后写、默认 dry-run、落盘前备份、保护路径拒绝（`_ops/bulk-write.mjs` 的规则下沉）。