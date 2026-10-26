# dsh-memory —— 跨会话持久记忆

DSH bundle（Host 侧插件）：把"用户级事实"存下来，注入**每个会话**的系统提示；agent 自己维护。

学的是谁：Hermes Agent 的 `MEMORY.md` / `USER.md`，Claude Code 的用户级 `CLAUDE.md`。DSH 官方没有对应能力，这是补齐的最大一块。

- **安装位置**：`D:\AI\dsh-bundles\dsh-memory`
- **数据位置**：`D:\AI\dsh-data\memory\memory.json`（bundle patch 的 `storeDir`，不落 C 盘）
- **生效范围**：desktop profile，所有会话 / 所有工作目录（与 cwd 无关）

## 工具

| 工具 | 作用 |
|---|---|
| `memory_list` | 列出记忆（id / tag / pinned / 文本），显示存储占用、**本轮注入字符数**与**实际注入的文本块** |
| `memory_search` | 按关键词检索（子串命中权重高于分词命中，tag 也参与），返回匹配条目全文与分数。注入块把某条降级成索引行时用它取全文 |
| `memory_add` | 追加一条（≤600 字符），完全相同的文本自动去重；可选 `pinned: true` 置顶 |
| `memory_update` | 改某条的文本 / tag / pinned 标记 |
| `memory_remove` | 删某条 |

## 机制

1. **注入**：`ctx.systemPrompt.context({ name: 'dsh-memory', order: 900, text: () => block })` —— 每次装配系统提示时渲染当前记忆为：

   ```xml
   <memory>
   以下是跨会话记住的用户/项目事实（越靠后越新）。把它们当背景，不要逐条复述；与用户本轮明确指令冲突时，以本轮指令为准。
   - 用户要求：所有回答用中文；插件代码与数据都放 D 盘，不落 C 盘。
   </memory>
   ```

   注入**分两层**（v1.1）：存储可以长（`maxBytes`），但每轮 prompt 成本封顶（`maxInjectChars`）。
   - `pinned` 条目优先全文注入（硬规则用它）；其余从新到旧连续取，装不下就停；
   - 没拿到全文的降级成一行索引 `- (m7) [tag] 摘要…`，索引最多列最新 10 条；
   - 末尾提示 agent 用 `memory_search` 按关键词取全文。
   - 实测：25 条 / 3320 正文字符时，全量注入 3488 字符 → 分层后 1387 字符（**省 60%**）。`maxInjectChars` 约束的是正文行，头部/索引/页脚另有约 150–200 字符固定开销。

2. **不做会话内冻结快照**（和 Hermes 不同）：Hermes 冻结是为了缓存稳定，但 DSH 本来就每步重新装配 context，记忆又只在显式增删改时变化，频率极低。牺牲这点缓存换"刚记住的下一步就生效"，更符合实际用法。
3. **超预算拒绝写入**，不自动淘汰：上限 4000 字符（可配 `maxBytes`），超了就让 agent 先看 `memory_list` 再 `memory_remove`，避免悄悄丢用户信息。
4. **纯文本 JSON 存储**，原子写（临时文件 + rename），不写会话日志、不新增事件类型。

## 配置

```yaml
- insert:
    - id: memory
      name: '@local/dsh-memory'
      config:
        storeDir: 'D:\AI\dsh-data\memory'   # 数据放哪
        maxBytes: 8000                      # 存储预算（字符），超了拒绝写入
        maxInjectChars: 1200                # 每轮注入预算（字符），成本封顶
```

## 验证记录（2026-10-25，本机 desktop profile）

| 项 | 结果 |
|---|---|
| 安装 | 首次安装报 `ReferenceError: tools is not defined`（漏了 `const tools = ctx.tools`），修复后 `application: applied` |
| 注入**实测** | `memory_add` 后再下一轮请求，运行时上下文里出现 `<memory>…</memory>` 块，内容与写入一致 ✅ |
| 即时生效 | `memory_update` 改文本后，下一次请求的注入块立刻是新文本 ✅ |
| 落盘 | `D:\AI\dsh-data\memory\memory.json` 内容与工具返回一致（含 id / tag / 时间戳）✅ |
| 重载恢复 | `remove_bundle` 后注入块**立即消失**（teardown 干净）；`install_bundle` 后从磁盘恢复两条记忆，注入块重新出现 ✅ |
| C 盘 | `~/.dsh/dsh-memory` 不存在（数据只在 D 盘）✅ |

## 验证记录 v1.1 分层注入 + 检索（2026-10-26，真实数据）

| 项 | 结果 |
|---|---|
| 单测 | `_selftest/tests/memory.test.mjs` 9 项全过（含旧 3 项向后兼容用例）✅ |
| 真实数据不退化 | 现有 5 条 / 644 正文字符，`maxInjectChars: 1200` → 注入 737 字符，**仍是全量逐条**，没有降级 ✅ |
| 放大后省 token | 模拟 25 条 / 3320 正文字符：全量 3488 字符 → 分层 1387 字符，**省 60%** ✅ |
| pinned 优先 | 放大场景中 `pinned` 条目保持全文并带 📌 标记 ✅ |
| 索引引导 | 未展开条目降级为 `- (mN) [tag] 摘要…`，页脚提示 `memory_search` ✅ |
| 检索打分 | `scoreMemory`：整体子串命中 3 分、分词命中各 2 分、tag 参与、空查询 0 分 ✅ |
| schema 自检 | `_selftest` 的 schema-check 识别到 17 个工具（新增 `memory_search`），0 失败 ✅ |
| 全栈自检 | `selfcheck.ps1` 211 项全绿 ✅ |

## 已知边界

- **全局一份**，不按项目分（定位就是"用户级记忆"；项目约定请写 AGENTS.md）；
- 注入发生在请求装配时：同一轮里刚写的内容对**下一条**模型请求生效；
- 去重只跳过完全相同的文本，不做语义合并；
- 没有自动整理/过期机制（Hermes 的 Curator 那种）——需要时再单独做；
- `memory_search` 是子串 + 分词计分的轻量检索，不是语义/向量检索（记忆体量小，够用；真要语义检索再换后端）。
