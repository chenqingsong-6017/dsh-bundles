# CHANGELOG

格式：Keep a Changelog；版本号跟 `package.json`。

## v0.3.0 — 2026-11-01

### Added
- `obsidian_lint`：按页面契约扫全库，报五类问题——必填字段缺失（type / domain / status）、`_index.md` 与 type 不一致、非导航页缺「一句话」结论头、id 重复、记忆指针指向非 active 页。只读，先强制重建索引再查。
- 纯函数导出：`lintIndex` / `pointerTargetsOf`。
- `journal` 类型免检「一句话」（日志是过程记录）；根级导航页（`Home.md` / `AGENTS.md`）豁免命名检查；模板目录默认跳过（`includeTemplates: true` 可纳入）。

### Design
- 只做五条能从「找得到 / 信得过 / 改得动」倒推出来的规则；重复检测、过期检测、tag 覆盖留给触发线，不预建。
- 真机首跑暴露两条误报（journal 被要求写结论、Home.md 被当成命名违规），按「规则服从目的」改规则，不改库。

## v0.2.0 — 2026-11-01

### Added
- `obsidian_write`：受控写（P2）。白名单（默认 `00-Inbox/ai-drafts/`）+ `create` 绝不覆盖 + `expectedHash` / `expectedMtime` 冲突即放弃；支持 `create` / `append` / `section` 三种模式，`section` 只替换指定标题下的正文。
- 原子写：tmp + rename，与 `index.json` 同一套路。
- `obsidian_status` 新增 `memoryPointers`：扫 `memory.json` 里的 `vault://相对路径` 指针，报总数与断链（仿 Basic Memory 的 `sync_status`）。
- 新纯函数并导出：`normalizeVaultPath` / `isWriteAllowed` / `sha256` / `sectionRange` / `applySection` / `parseMemoryPointers`。

### Changed
- 受保护目录硬拒：`.obsidian/`、`90-Shared/91-Templates/` 即使配进白名单也不许写。
- 配置新增 `writeEnabled`（默认 true）/ `writeAllowlist` / `memoryPath`。

### Design
- 依据：Basic Memory（文件是权威源、DB 是派生索引）与 obsidian-mcp-server（默认 `overwrite=false`、写路径白名单、section 局部替换）。思路借鉴，代码未复制（Basic Memory 为 AGPL v3）。
- 冲突策略是「放弃」不是「合并」：两处同时改时宁可这一轮不写，也不猜谁对。

## v0.1.0 — 2026-11-01

### Added
- 首个版本（P1 只读）：扫描 vault → `D:\AI\dsh-data\obsidian\index.json`。
- `obsidian_status`：笔记 / 视图 / 附件 / 目录数、链接总数与断链数、解析失败数、索引时间与是否过期、`lastError`。
- `obsidian_index`：重建索引，原子写（tmp + rename），返回耗时与字节数。
- `obsidian_search`：标题 / 别名 / 标签 / 正文词项打分，支持 `type` / `domain` / `tag` 过滤；索引过期时内存重建。
- `obsidian_note`：按 vault 相对路径读单篇（frontmatter + 正文 + 出链），路径越界拒绝。
- YAML-lite frontmatter 解析（标量 / 行内列表 / 缩进列表）；断链检测；`.obsidian`、`.git`、`node_modules`、`.trash` 跳过。

### Design
- **只读**：唯一写入是 `index.json`；不写 vault、不写 `.obsidian/`。
- **fail-safe**：扫描/解析失败只记 `lastError`，不抛。
- **不重复**：权威记忆仍归 `dsh-memory`；本插件只读 vault，不做双向同步。

