# CHANGELOG

格式：Keep a Changelog；版本号跟 `package.json`。

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

