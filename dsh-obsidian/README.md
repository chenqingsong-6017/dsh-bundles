# dsh-obsidian

> Obsidian 库的**只读索引**（P1）。把 `vault` 扫成一份索引，给 AI 检索、读单篇、看健康度；**绝不写库**。

## 为什么需要它

vault 是人的成品层（画像 / 3观 / 日志 / 调研索引）。没有索引时，AI 想找「哪张卡讲过 X」只能 glob + read 逐个翻；库一大就会变成几十次读盘。
本插件把 vault 扫成 `D:\AI\dsh-data\obsidian\index.json`，提供四个只读工具。写入（改卡片、晋升草稿）归 P2，另做 —— 见 `dsh-创建/_research/obsidian-vault-plan-2026-11.md` §5。

## 工具

| 工具 | 作用 | 关键点 |
|---|---|---|
| `obsidian_status` | 库健康度：笔记/视图/附件数、断链数、解析失败数、索引是否过期 | 会轻扫目录核对「索引 vs 实际文件」 |
| `obsidian_index` | 重建索引（写 `index.json`，临时文件 + rename 原子替换） | 返回耗时与字节数，可当场核对 |
| `obsidian_search` | 按标题 / 别名 / 标签 / 正文打分检索，可按 `type` / `domain` / `tag` 过滤 | 索引缺失或库变过时**在内存里重建**再答，不阻塞 |
| `obsidian_note` | 按 vault 相对路径读单篇：frontmatter + 正文 + 出链 | 路径越界直接拒（`../`、绝对路径） |

## 只读保证

1. **不写 vault**：没有任何 `writeFile` 指向库目录；唯一写入是 `<storeDir>/index.json`。
2. **原子写**：先写 `index.json.tmp-<pid>` 再 `rename`，中途崩溃不会留下半个 JSON。
3. **不写 `.obsidian/`**：扫描时整目录跳过（`.git` / `node_modules` / `.trash` 同样跳过）。
4. **fail-safe**：扫不到、解析不了只记 `lastError` 并在 `obsidian_status` 里暴露，不抛给会话。

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
  buildOnStart: true     # 启动时顺带建一次索引（只读扫库，失败不影响启动）
```

## 与 dsh-memory 的分工

- `memory.json` = AI 的权威记忆（每轮注入，有字符预算）。
- `vault` = 人的成品层 + AI 的结构化读源（本插件只读）。
- 两者**不做自动同步**：真要做单向镜像时走 `memory_export`（人看），不在本插件里偷偷写库。

## 验证记录

| 项 | 结果 |
|---|---|
| `node --check index.js` | 通过 |
| 单测 `_selftest/tests/obsidian.test.mjs` | 见验证门输出（纯函数 + 临时 vault 夹具 + 4 个工具真调用） |
| 真机（重启后） | 待验：`obsidian_status` 的笔记数应与资源管理器手点一致；`obsidian_search` 能命中画像卡 |

## 已知边界（诚实清单）

- **P1 只读**：不能改卡片、不能晋升草稿；写能力留到 P2（要做 mtime/hash 校验 + 冲突即放弃）。
- **解析是 YAML-lite**：只支持标量 / 行内列表 / 缩进列表；嵌套属性（Obsidian 不支持）不处理。
- **链接解析按 basename 取第一个**：vault 里同名笔记会有歧义，`obsidian_status` 的 `brokenLinks` 只统计「解析不到」，不报歧义。
- **检索是词项打分**：中文按子串命中、不切词；量级到几千篇时再考虑倒排索引（触发线见方案 §7）。

