# dsh-memory 运维手册（一页）

数据位置：`D:\AI\dsh-data\memory\`。v4.1 起默认 SQLite 单文件 `memory.db`（另有 `-wal` / `-shm`），日常看「SQLite 后端」一节；旧 JSON 三件套 `memory.json` / `archive.json` / `aliases.json`、旁路 `candidates.json` / `history.jsonl` / `review-latest.md`、备份目录 `backups\` 都在同一目录。
源码：`D:\AI\dsh-bundles\dsh-memory`；重载用 `plugin_manager remove_bundle` + `install_bundle`（插件走 link 安装，也可触发一次 profile 重组换文件，见工作区 `AGENTS.md` 的「改动要不要重启」）。

## 例行

| 频率 | 做什么 | 命令 |
|---|---|---|
| 每周 | 体检（数据完整性/容量/备份/候选/重复/密钥） | `node D:\AI-date\dsh-date\dsh-创建\_tools\memory-doctor.mjs`（注意：只读 `memory.json`，SQLite 后端下看到的是迁移时快照，见下节「健康检查」） |
| 每周 | 记忆质量审计（重复/过期/使用排行） | 让 agent 调 `memory_audit`（或看注入块统计） |
| 每月 | 质量对照（36 题微基准） | 在 `D:\AI\dsh-bundles` 下跑 `node _selftest\memory-bench.mjs` |
| 改完插件 | 单测（旧 JSON 后端 + SQLite 回归） | 在 `D:\AI\dsh-bundles` 下跑 `node _selftest\tests\memory.test.mjs` 与 `node _selftest\tests\memory-sqlite.test.mjs` |
| 改完插件 | 14 工具 schema 不许变（逐位比对） | 在工作区根跑 `node _ops\memory-tool-schema.mjs --compare _reports\memory-tool-schema-before.json`（退出码 1 = 有差异） |
| 改完插件 | 全栈自检 | 在 `D:\AI\dsh-bundles` 下跑 `pwsh -File _selftest\selfcheck.ps1` |

## SQLite 后端（v4.1 起默认）

### 确认当前后端

- `memory_status.storeFile` 以 `memory.db` 结尾 = SQLite；以 `memory.json` 结尾 = 旧 JSON 后端。
- 配置在 `cordis.patch.yml` 的 `dsh-memory.config`：`storage`（`sqlite` / `json`）、`retrieval`（`index` / `scan`）。**非法值会静默回落**（`storage` 回 `json`、`retrieval` 回 `index`），所以 `storeFile` 还是 `memory.json` 时先查拼写。
- 数据目录里 `memory.db` 存在 = 已迁移过。SQLite 后端下 `memory.json` / `archive.json` 不再被写（保留为迁移源 + 回滚备份）；`aliases.json` 仍随每次落盘同步（防丢副本，条目里也存一份）；`candidates.json` / `history.jsonl` / `review-latest.md` 位置与行为不变。
- 用量计数（`usedCount` / `lastUsedAt`）最多延迟 60s 落盘（正常设计，压掉旧实现每次搜索整库写的写放大）；进程崩溃最多丢最近 60s 计数，不影响正文。

### 备份

| 时机 | 产物 | 说明 |
|---|---|---|
| 迁移前（一次性，自动） | `backups\pre-sqlite-<YYYYMMDDHHmmss>\` | `memory.json` / `archive.json` / `aliases.json` / `candidates.json` + `manifest.json`（字节数 + sha256）；原文件不覆盖 |
| 每天第一次写前（自动） | `memory.db.bak-YYYYMMDD` | `VACUUM INTO` 的完整快照（WAL 数据已合并），保留最近 10 份，按 mtime 轮转 |
| 手动另存 | `memory.db.bak-manual-<日期>` | 在数据目录执行 `Copy-Item memory.db.bak-YYYYMMDD memory.db.bak-manual-<日期>` |

**WAL 模式下不要只拷 `memory.db`**：同目录还有 `memory.db-wal` / `memory.db-shm`，只拷主文件可能缺最近提交。要拿完整快照就复制 `memory.db.bak-YYYYMMDD`（VACUUM 产物，自包含）。

### 回滚到 JSON 后端

1. 在工作区根 `D:\AI-date\dsh-date\dsh-创建` 导出当前 DB（只读 DB、不删任何东西；覆盖 JSON 前脚本自己会备份到 `backups\pre-rollback-<ts>\`）：

```powershell
cd D:\AI-date\dsh-date\dsh-创建
node _ops\memory-rollback-sqlite.mjs --dry-run   # 预览：总条数 = 生效 + 归档、nextId、别名数
node _ops\memory-rollback-sqlite.mjs --apply     # 导出 memory.json / archive.json / aliases.json
```

2. 把 `cordis.patch.yml` 的 `storage` 改成 `'json'`，重载插件；
3. `memory_status.storeFile` 确认变回 `memory.json`；`memory_list(includeArchived: true)` 的条数与导出结果一致；
4. `memory.db` 保留不删（取证 / 再迁移用）。

脚本默认读 `D:\AI\dsh-data\memory`，换目录加 `--store-dir <路径>`；导出后回读核对条目数，不一致退出码 1（别切后端）。

### 迁移失败 / DB 损坏

- **迁移失败**（`MEMORY_MIGRATION_FAILED`）：原 JSON 未动、临时库已删、插件拒绝启动（fail-loud）。看 `memory_status.unavailableReason` 或宿主日志定位原因；清理残留锁后重试，或把 `storage` 改回 `'json'` 继续用旧后端。
- **迁移锁残留**（`MEMORY_MIGRATION_LOCKED`）：确认没有迁移进程在跑，删除 `memory.db.migrating` 后重载/重启。
- **DB 损坏**（`PRAGMA quick_check` 不过 → `health: corrupt`、写工具被拒）：插件不自动改名、不删 `memory.db`（原文件留证）。修复：
  1. 停插件（或先把 `storage` 改 `'json'`，避免后续误写）；
  2. 数据目录里把 `memory.db`（连同 `-wal` / `-shm`）改名留证，如 `memory.db.corrupt-<日期>`；
  3. `Copy-Item memory.db.bak-YYYYMMDD memory.db`（没有可用快照就改走回滚 JSON / `backups\pre-sqlite-*`）；
  4. 重载插件 → `memory_status.ready` 应为 `true`、`storeFile` 指向 `memory.db`；
  5. `memory_list` 抽查条数，确认无误后再按删除三查清理 corrupt 文件。
- **DB schema 太新**（`MEMORY_SCHEMA_TOO_NEW`）：库是更新版插件写的 → 升级插件，或从备份恢复；**不要**用旧插件继续写。

### 健康检查

以 `memory_status` 为主：`ready` / `code` / `unavailableReason` / `storeFile` / `health` / `storeBytes` / 条目数与预算占用。`ready=false` 的常见 code：

| code | 先做什么 |
|---|---|
| `MEMORY_SQLITE_UNAVAILABLE` | 运行时不支持 `node:sqlite`（需 Node ≥23.4）→ 升级 DSH，或改 `storage: 'json'` 回滚 |
| `MEMORY_STORE_CORRUPT` | 按上面「DB 损坏」处理；JSON 后端则是把修好的 JSON 改名回 `memory.json` 后重载 |
| `MEMORY_STORE_READONLY` | 上次落盘失败 → 查磁盘空间 / 权限 / 只读属性，修好后重载 |
| `MEMORY_STORE_UNWRITABLE` | 数据目录不可写 → 查 ACL / 只读 |
| `MEMORY_MIGRATION_FAILED` / `MEMORY_MIGRATION_LOCKED` | 见上 |

两个仍是 JSON 时代的工具，SQLite 下别误用：

- `_tools\memory-doctor.mjs`：只读 `memory.json`，看到的是「迁移时快照」，不能当当前库状态；
- `_tools\restore-memory-backup.ps1`：只恢复 `memory.json.bak-*`，只在切回 `storage: json` 后才生效。

## 备份与恢复（JSON 后端）

- 自动：**每天第一次写入前**自动备份 `memory.json.bak-YYYYMMDD`，保留最近 10 份（超出自动清理）。
- 手动：`Copy-Item memory.json memory.json.bak-manual-<日期>`；迁移脚本自己也会先备份。
- 恢复最近备份：`pwsh -File D:\AI-date\dsh-date\dsh-创建\_tools\restore-memory-backup.ps1`
- 恢复指定备份：加 `-BackupName memory.json.bak-YYYYMMDD`。

## 损坏处理（JSON 后端）

解析失败时插件**不会覆盖**，而是：① 把原文件改名 `memory.json.corrupt-<时间戳>` ② 进入只读保护态（所有写工具报错）③ `memory_list` 显示 `health: corrupt` 与副本路径。（SQLite 后端的损坏处理见上节，不自动改名。）

修复步骤：
1. 用编辑器检查 `memory.json.corrupt-*`，修成合法 JSON（或从 `.bak-*` 挑一份最新的）；
2. 把修好的文件改名回 `memory.json`；
3. 重载插件（`remove_bundle` + `install_bundle`）；
4. 跑一遍 doctor 确认「损坏副本」变回 PASS，再把旧 corrupt 文件删掉。

## 迁移

- 数据 schema 当前 v2；SQLite 库自身的 `meta.schema_version = 1`（插件防呆用，与数据 schema 独立）。`meta.schema_version` 高于插件支持时拒绝启动（`MEMORY_SCHEMA_TOO_NEW`），只升不降。
- JSON → SQLite：**自动，无需手工命令**——首次以 `storage: 'sqlite'` 启动且 `memory.db` 不存在时执行；细节见 README「迁移与回滚」。
- JSON 后端时代的 v1→v2 迁移：`node _tools\migrate-memory-v2.mjs`（幂等，先备份；`--force` 强制重写）。
- importance 回填：`node _tools\backfill-importance.mjs`（幂等，先备份）。
- 改 schema 的规矩：先加字段（`normalizeEntry` 保留未知字段）→ 再写迁移脚本 → 再改渲染/工具 → 最后做回填；任何一步都要能回滚（备份 + restore 脚本）。

## 调参（都在 cordis.patch.yml）

| 参数 | 默认 | 作用 |
|---|---|---|
| `storage` | 代码 `json` / 生产 patch `sqlite` | 存储后端；`json` 是回滚开关 |
| `retrieval` | `index` | 检索路径；`scan` = 回退 v4.0.1 全量遍历 |
| `maxBytes` | 12000 | 存储预算（生效条目正文字符）；满仓后 add 被拒（先自动归档，可逆） |
| `maxInjectChars` | 2500 | 每轮注入预算（不含包装/诊断约 150–200 字符） |
| `relevanceFloor` | 0.15 | 相关性覆盖率下限；调高更保守（少注入、少误报） |
| `captureCandidates` | true | 影子候选；false 关闭 |
| `captureRuleFiles` | true（本机置 false） | 规则文件沉淀开关 |
| `scopeRoots` | 内置三域映射 | cwd → scope 域，用于召回加分与跨域压缩 |

## 出问题先看哪

| 症状 | 先看 |
|---|---|
| `memory_status.storeFile` 还是 `memory.json` | 配置 `storage` 是否仍是 `json` / 拼错（非法值静默回落 json）；插件是否已重载 |
| `ready=false` + `MEMORY_SQLITE_UNAVAILABLE` | Node 太旧 / `node:sqlite` 不可用 → 升级 DSH 或回滚 JSON |
| 启动报 `MEMORY_MIGRATION_FAILED` / `MEMORY_MIGRATION_LOCKED` | 本文「迁移失败 / DB 损坏」 |
| 启动报 `MEMORY_SCHEMA_TOO_NEW` | 插件比库旧 → 升级插件；别用旧插件写 |
| 记忆块出现「损坏保护中」 | 本文「损坏处理」；SQLite 看「DB 损坏」 |
| `memory_add` 报「超预算」 | `memory_audit` 看占用/重复/过期，删或合并 |
| 记忆块内容不对/不看场合 | 检查 `scope` 与 query 门（`relevanceFloor`）；跑 bench 看指标 |
| 检索结果数量/排序和以前不同 | 先切 `retrieval: 'scan'` 对照；若一致，是 FTS 索引问题 → 重载让索引自检重建 |
| 改完代码不生效 | 插件是 link 安装，重载/重组后生效；见工作区 `AGENTS.md`「改动要不要重启」 |
| 想确认某条记忆 | `memory_search`（按 id 或关键词）；`memory_list` 看全量 |
