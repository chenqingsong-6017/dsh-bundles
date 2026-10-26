# dsh-history —— 历史会话全文检索 + 阅读

DSH bundle（Host 侧插件）：把本地历史会话当成可搜索的语料，能按关键词找"以前聊过什么/定了什么"，也能直接读某个会话的最近对话。

- **学谁**：claude-mem 的"把历史会话语料化"思路（SQLite+FTS5 检索），以及 Claude Code 的 `/resume` 会话找回体验。
- **为什么自己做**：DSH 里官方有 `session-query-sqlite`（FTS5 检索后端），但本机 profile 里是 `path: ':memory:'` + `openAt: never`（关掉的），而且**没有配套的模型工具**（`session_search` 只是前端 Remote API，不是 agent 可调用的工具）。所以自己做一个最小可用的。
- **数据从哪来**：会话日志本身就在 `~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd`，Node ≥22.15 自带 zstd 解压，不需要索引库、不引入依赖。

- **安装位置**：`D:\AI\dsh-bundles\dsh-history`
- **生效范围**：desktop profile，所有会话；数据只读，不写任何文件

## 工具

| 工具 | 作用 |
|---|---|
| `history_search` | 全文搜（标题 / 用户消息 / 助手回复），返回会话标题、工作区、命中片段（最多 3 条/会话） |
| `history_read` | 读某个会话的最近 N 条消息（按 id / id 前缀 / 标题片段定位），不带工具噪音 |
| `history_status` | 会话库位置、会话数、每个会话的标题/工作区/时间/消息数 |

## 机制

1. 扫描 `$DSH_HOME/sessions`（默认 `~/.dsh/sessions`）下所有 `session*.jsonl.zstd`。
2. 按 `mtime + size` 做内存缓存，文件变了才重新解析（7 个会话 ≈ 4 MB，毫秒级）。
3. 解析出：session 头的 `id/cwd/createdAt/agentPreset`、`session/title` 的标题、`user/message` 与 `assistant/message` 的文本块（跳过 reasoning）、`tool/call` 计数。
4. 搜索是**子串匹配**（大小写不敏感），命中位置截取 `maxSnippet` 个字符的上下文；按会话更新时间倒序。

> **关键坑（实测踩到）**：会话日志是**多帧追加**的 zstd 流。某些 Node/Electron 版本的 `zstdDecompressSync` 只解第一帧——表现是"只读出 session 头、消息和标题全空"。插件里因此按 zstd magic（`28 B5 2F FD`）把缓冲切成帧逐个解压再拼接，并对"magic 出现在压缩数据里"的假分界做了合并重试兜底。

## 配置

```yaml
- insert:
    - id: history
      name: '@local/dsh-history'
      config:
        maxResults: 8      # 搜索结果最多几个会话
        maxSnippet: 120    # 片段长度
        # sessionsDir: 'D:\AI\dsh-sessions'   # 可选覆盖
```

## 验证记录（2026-10-25，本机 desktop profile）

| 场景 | 结果 |
|---|---|
| `history_status` | 7 个会话，标题（Greeting / 你好 / 任务：…）、工作区、消息数、工具调用数全部正确 ✅ |
| `history_search query="plugin-ux"` | 命中 3 条（来自当前会话），片段带上下文和角色标签 ✅ |
| `history_read session="cc9c14ee"` | 返回该会话摘要（"你好"，84 条消息），最近 6 条含用户/助手对话 ✅ |
| 多帧 zstd 修复前后 | 修复前每个会话只有 1 条原始事件（= 只解第一帧）；修复后 90 条消息 / 642 次工具调用 ✅ |

## 剩下的边界

- **子串匹配，不是语义搜索**（没有向量化）；中文分词靠字面包含，效果够用但不智能；
- 只读 `*.jsonl.zstd`，不读正在写入的活跃流之外的临时文件；
- 助手消息里的 `reasoning` 块不计入搜索（避免思维链噪音），工具输出也不进检索；
- 单文件 >64 MB 跳过；缓存 16 个会话，超出按插入顺序淘汰；
- 不写任何文件、不进 agent 的事件流。
