# dsh-obsidian

> Obsidian 库的**索引**（P1 只读）+ **受控写**（P2）。把 `vault` 扫成索引给 AI 检索；写只允许进白名单目录，默认不覆盖、冲突即放弃。

## 为什么需要它

vault 是人的成品层（画像 / 3观 / 日志 / 调研索引）。没有索引时，AI 想找「哪张卡讲过 X」只能 glob + read 逐个翻；库一大就会变成几十次读盘。
本插件把 vault 扫成 `D:\AI\dsh-data\obsidian\index.json`，提供四个只读工具 + 一个受控写工具。

## 工具

| 工具 | 作用 | 关键点 |
|---|---|---|
| `obsidian_status` | 库健康度 + 记忆指针漂移 | 断链数、解析失败、索引是否过期、`memoryPointers` 断指针 |
| `obsidian_index` | 重建索引 | 临时文件 + rename 原子替换，返回耗时与字节数 |
| `obsidian_search` | 按标题 / 别名 / 标签 / 正文打分检索 | 可按 `type` / `domain` / `tag` 过滤；索引过期时内存重建 |
| `obsidian_note` | 按 vault 相对路径读单篇 | frontmatter + 正文 + 出链；路径越界直接拒 |
| `obsidian_write` | 受控写（P2） | 白名单内、create 不覆盖、hash/mtime 不符即放弃 |

## 写入边界（P2）

1. **白名单**：默认只允许写 `00-Inbox/ai-drafts/`；`10-Life/` 等正文区一律拒写。
2. **受保护目录硬拒**：`.obsidian/`、`90-Shared/91-Templates/` 即使配进白名单也不许写。
3. **默认不覆盖**：`create` 模式遇到已存在文件直接失败（`file_exists`），改内容必须用 `append` 或 `section`。
4. **section 只替换一段**：按标题定位，只改该标题下的正文，同级的其他段原样保留。
5. **冲突即放弃**：给了 `expectedHash` 或 `expectedMtime` 时，实际不符就返回 `conflict`，绝不猜谁的版本对。
6. **原子写**：tmp + rename，写一半崩了不会留半篇。

失败返回 `code`：`denied` / `escape` / `file_exists` / `conflict` / `section_not_found` / `no_file` / `too_large` / `write_disabled`。

## 索引数据布局

```
D:\AI\dsh-data\obsidian\
└── index.json     # 一次全量快照：vault / builtAt / newestMtime / counts / links / parseErrors / notes[]
```

`notes[]` 每条的字段：`path / name / title / type / domain / status / review / tier / confidence / id / tags / aliases / mtime / size / links[] / text`（`text` 压成单行、上限 8000 字符，只给检索用）。

## 配置（cordis.patch.yml 或 profile 层）

```yaml
config:
  vaultDir: D:\AI-date\obsidian\vault
  storeDir: D:\AI\dsh-data\obsidian
  memoryPath: D:\AI\dsh-data\memory\memory.json   # 指针漂移检查的数据源
  buildOnStart: true                               # 启动时顺带建一次索引（只读扫库，失败不影响启动）
  writeEnabled: true                               # false = 回到纯只读模式
  writeAllowlist:                                  # 只有这些前缀可写
    - 00-Inbox/ai-drafts/
```

## 记忆指针约定

想让记忆条目不膨胀，正文写进 vault，记忆里只留一行指针：

```
细节见 vault://10-Life/13-Life-Plan.md
```

`obsidian_status` 会扫 `memory.json` 里所有 `vault://` 指针，报 `total` 与 `broken`（断掉的指针 + 对应记忆 id）。这是仿 Basic Memory 的 `sync_status`：索引落后要能被看见，而不是等人踩空。

## 与 dsh-memory 的分工

- `memory.json` = AI 的权威记忆（每轮注入，有字符预算）。
- `vault` = 人的成品层 + AI 的结构化读源（本插件读，写只进 `00-Inbox/ai-drafts/`）。
- 两者**不做自动同步**：跑 `obsidian_status` 看指针断没断；迁移策略见 `dsh-创建/_research/obsidian-vault-plan-2026-11.md` §8。

## 验证记录

| 项 | 结果 |
|---|---|
| `node --check index.js` | 通过 |
| 单测 `_selftest/tests/obsidian.test.mjs` | 10 项通过（P1 8 项 + P2 受控写 2 项：纯函数与工具） |
| 真机 P1（2026-11-01） | ✅ notes=21 / bases=4 / links=18 / brokenLinks=0 / parseErrors=0；重建 2ms、index.json 25.7KB |
| 真机 P2 | 待重启后填：受控写真调用（白名单 / 拒覆盖 / section / 冲突 / 断指针） |

## 已知边界（诚实清单）

- **写只进白名单**：这是设计，不是遗漏。要让 AI 直接改正文，得先改白名单配置并想清冲突策略。
- **冲突检测靠调用方传 expectedHash**：不传就只保证「不覆盖已有文件」，不保证「你看到的是最新版」。
- **解析是 YAML-lite**：只支持标量 / 行内列表 / 缩进列表；嵌套属性（Obsidian 不支持）不处理。
- **链接解析按 basename 取第一个**：vault 里同名笔记会有歧义，`brokenLinks` 只统计「解析不到」，不报歧义。
- **检索是词项打分**：中文按子串命中、不切词；量级到几千篇时再考虑倒排索引（触发线见方案 §7）。
- **指针漂移只报不修**：`memoryPointers` 不会自动改记忆，断链要人决定删还是补。
