# dsh-memory 运维手册（一页）

数据位置：`D:\AI\dsh-data\memory\`（memory.json / candidates.json / memory.json.bak-* / memory.json.corrupt-*）
源码：`D:\AI\dsh-bundles\dsh-memory`；重载用 `plugin_manager remove_bundle` + `install_bundle`（宿主不热换模块）。

## 例行

| 频率 | 做什么 | 命令 |
|---|---|---|
| 每周 | 体检（数据完整性/容量/备份/候选/重复/密钥） | `node D:\AI-date\dsh-date\dsh-创建\_tools\memory-doctor.mjs` |
| 每周 | 记忆质量审计（重复/过期/使用排行） | 让 agent 调 `memory_audit`（或看注入块统计） |
| 每月 | 质量对照（36 题微基准） | `node D:\AI\dsh-bundles\_selftest\memory-bench.mjs` |
| 改完插件 | 单测 + 全栈自检 | `node _selftest\tests\memory.test.mjs`；`pwsh -File _selftest\selfcheck.ps1` |

## 备份与恢复

- 自动：**每天第一次写入前**自动备份 `memory.json.bak-YYYYMMDD`，保留最近 10 份（超出自动清理）。
- 手动：`Copy-Item memory.json memory.json.bak-manual-<日期>`；迁移脚本自己也会先备份。
- 恢复最近备份：`pwsh -File D:\AI-date\dsh-date\dsh-创建\_tools\restore-memory-backup.ps1`
- 恢复指定备份：加 `-BackupName memory.json.bak-YYYYMMDD`。

## 损坏处理（重要）

解析失败时插件**不会覆盖**，而是：① 把原文件改名 `memory.json.corrupt-<时间戳>` ② 进入只读保护态（所有写工具报错）③ `memory_list` 显示 `health: corrupt` 与副本路径。

修复步骤：
1. 用编辑器检查 `memory.json.corrupt-*`，修成合法 JSON（或从 `.bak-*` 挑一份最新的）；
2. 把修好的文件改名回 `memory.json`；
3. 重载插件（remove_bundle + install_bundle）或重启 DSH；
4. 跑一遍 doctor 确认 `损坏副本` 变回 PASS，再把旧 corrupt 文件删掉。

## 迁移

- 当前 schema v2；v1→v2 迁移：`node _tools\migrate-memory-v2.mjs`（幂等，先备份；`--force` 强制重写）。
- importance 回填：`node _tools\backfill-importance.mjs`（幂等，先备份）。
- 改 schema 的规矩：先加字段（normalizeEntry 保留未知字段）→ 再写迁移脚本 → 再改渲染/工具 → 最后做回填；任何一步都要能回滚（备份 + restore 脚本）。

## 调参（都在 cordis.patch.yml）

| 参数 | 默认 | 作用 |
|---|---|---|
| `maxBytes` | 8000 | 存储预算（生效条目正文字符）；满仓后 add 被拒 |
| `maxInjectChars` | 1500 | 每轮注入预算（不含包装/诊断约 200 字符） |
| `relevanceFloor` | 0.15 | 相关性覆盖率下限；调高更保守（少注入、少误报） |
| `captureCandidates` | true | 影子候选；false 关闭 |
| `scopeRoots` | 内置三域映射 | cwd → scope 域，用于召回加分与跨域压缩 |

## 出问题先看哪

| 症状 | 先看 |
|---|---|
| 记忆块里出现「损坏保护中」 | 本文「损坏处理」 |
| `memory_add` 报「超预算」 | `memory_audit` 看占用/重复/过期，删或合并 |
| 记忆块内容不对/不看场合 | 检查 `scope` 与 query 门（`relevanceFloor`）；跑 bench 看指标 |
| 改了代码不生效 | 插件是 pnpm link 安装，必须重载/重启 |
| 想确认某条记忆 | `memory_search`（按 id 或关键词）；`memory_list` 看全量 |
