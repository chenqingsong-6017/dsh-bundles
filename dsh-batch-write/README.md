# dsh-batch-write

> 一句话：把「改多文件请走 `_ops/bulk-write.mjs`」这条**提示词规则**，下沉成一个模型可直接调用的工具。

## 为什么有它

2026-11-03 的规则→机制审计发现：`friction.md` 第 1 条要求「多文件改写走 bulk-write.mjs」，但它只是一个脚本，模型得**记得**去调——这是典型的「规则层」而非「机制层」。改成工具后，模型看到的是能力，不是待记的规矩。

## 工具

| 工具 | 作用 |
|---|---|
| `batch_write` | 一次改 N 个文件；内部先读后写；默认 dry-run；`apply:true` 才落盘并备份 |
| `batch_write_status` | 就绪检查：备份根、保护规则数、上次运行 |

## 安全（缺一不可）

- **默认不落盘**：`apply` 不是 `true` 就只预演。
- **落盘前备份**：写到 `D:\AI\dsh-data\batch-write\backup\<ts>\`。
- **受保护路径一律拒绝**：规则目录、hooks、护栏脚本、凭据、系统目录。
- **replace 歧义即拒**：`old` 命中多处而没给 `all:true` 时报错，不猜。

## 用法

```json
{ "ops": [
  { "path": "docs/a.md", "mode": "replace", "old": "旧句", "new": "新句" },
  { "path": "docs/b.md", "mode": "append", "content": "\n新段落" }
] }
```

**write gate（0.2.0）**：`apply:true` 之前必须先用**完全相同的 ops** 跑过一次 dry-run，否则拒绝（`BATCH_NO_PREVIEW`）。这是写前确认的机制化——预演即确认，跳过预演的直接写一律不放行。

## 验证

见 `_selftest/tests/batch-write.test.mjs`（本插件自己的行为断言）。
> **能力边界（与相邻插件的分工）以工作区权威源 `_contracts/plugin-boundaries.md` 为准**（2026-11-12 立；与 checkpoint 的关系见该文件 §2）。
