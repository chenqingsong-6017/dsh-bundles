# CHANGELOG

格式：Keep a Changelog；版本号跟 `package.json`。

## v0.4.0 — 2026-11-02

### Changed
- `memoryPointers` 数据源改为 `readMemoryEntries`（与 `_ops/metric-probes.mjs:54-87` 同口径）：优先读记忆目录下的 `memory.db`（`node:sqlite` 只读、`SELECT payload FROM entries ORDER BY seq`、单条坏 payload 跳过），无 db / 打不开才回退 `memory.json.entries`——v4.1 后 memory.json 已冻结，直读会报旧数字。
- `memoryPointerReport()` 新增诊断字段 `source`（`sqlite` | `json`）/ `storeFile` / `entryCount`；`total`（去重后的指针数）/ `checked` / `ok` / `fileMissing` / `anchorMissing` / `broken` / `sample` 与锚点校验语义不变。`memoryPointerTargets()`（lint 用）同源。

### 验证
- 单测新增两组（临时目录，不碰真实数据）：memory.json 无指针 + memory.db 有指针 → `source='sqlite'`、`total` = db 去重指针数、坏 payload 跳过；只有 memory.json → `source='json'` 回退。
- 真机：`node _ops/apply-check.mjs --reload` 触发一次 profile 重组后调 `obsidian_status`，`memoryPointers.source='sqlite'`，`total` 与独立脚本从 `memory.db` 数出的指针数一致。

## v0.3.2 — 2026-11-02

### Added
- 记忆指针锚点校验：带 `#锚点` 的 `vault://` 指针现在同时校验「文件存在」与「锚点存在」；`broken[]` 用 `kind` 区分 `file-missing` / `anchor-missing`（`pointer` / `memoryIds` 向后兼容）。新增 `anchorChecked` / `anchorSkipped` / `fileMissing` / `anchorMissing` 计数，render 直接标出断在哪一半。
- 纯函数导出：`slugifyHeading`（对齐 github-slugger 2.0.0 的实测输出）/ `headingAnchors` / `matchHeadingAnchor` / `hasOneLiner`。
- 锚点三条匹配规则：① slug 全等 ② 数字节号 = 标题前导节号 ③ 标题前导片段（在标点/空白/连字符处断开，区别于裸 `startsWith`）。

### Fixed
- `missing_one_liner` 误报：真实库 5 张卡用 `> 一句话：`（非加粗）被当成缺结论头。改为按结构判定——`> 一句话：` / `> **一句话**：` / `> __一句话__：` / 半角冒号都算过，代码块里的不算，真缺仍报。
- `locale/zh.json` 不是合法 JSON（2026-11-02 21:2x 界面报「包元信息错误」）：`description` 里直接写了 Windows 路径 `D:\AI-date\obsidian\vault`，`\A` 不是合法转义，`JSON.parse` 抛 `Bad escaped character at position 67`。改为双反斜杠。同一类错已加进验证门（`_selftest/gate/check.mjs` 阶段 2b 解析所有插件的 `locale/*.json`，正反用例在 `gate-hollow.test.mjs` (v)/(vi)）。

### Changed
- 索引 `notes[]` 新增 `oneLiner`（索引期算一次，已剥 fenced code；超大文件为 `null` = 不判定）。旧索引没有该字段时退回扁平文本判断，不会误报。

### 验证
- 真实 vault lint：28 篇 / 0 错误 0 警告（改前 5 条误报）。
- 真实 `memory.json`：88 条 / 25 条唯一指针 / 24 条带锚点 / broken 0。
- strict GitHub slug 实测只过 4/25 → 21 条误报，是加 ②③ 两条兼容规则的直接依据。
- 负向对照（用例能失败）：关掉锚点判定 → 用例红；结论头退回字面量匹配 → 用例红。
- locale 修复验证：`JSON.parse` 前后对照（修前 `Bad escaped character at position 67`，修后输出 title/description 正常）；门禁新增 2b 段后真机跑 `node _selftest/gate/check.mjs` → `结构门：检查 38 个 locale 文件`、门通过；`gate-hollow.test.mjs` 16 条断言全过。

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

