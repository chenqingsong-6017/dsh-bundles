# dsh-memory —— 跨会话持久记忆

DSH bundle（Host 侧插件）：把"用户级事实"存下来，注入**每个会话**的系统提示；agent 自己维护。

学的是谁：Hermes Agent 的 `MEMORY.md` / `USER.md`，Claude Code 的用户级 `CLAUDE.md`。DSH 官方没有对应能力，这是补齐的最大一块。

- **安装位置**：`D:\AI\dsh-bundles\dsh-memory`
- **数据位置**：`D:\AI\dsh-data\memory\memory.json`（bundle patch 的 `storeDir`，不落 C 盘）
- **生效范围**：desktop profile，所有会话。v3.0 起按 cwd 判定——带 `workspaces` 的条目只在匹配工作区注入，其余全局生效

## 工具

| 工具 | 作用 |
|---|---|
| `memory_list` | 列出记忆（id / 标签 / scope / kind / 是否失效 / 使用次数 / 文本），显示存储占用、**本轮注入字符数**与**实际注入的文本块** |
| `memory_search` | BM25 检索（IDF + 长度归一 + 标签加权 + **别名加权 ×2.5 + 同义扩展**，v3.5），命中条目自增使用计数；**query 里出现 `m\d+` 时按 id 直取**（v2.7） |
| `memory_add` | 追加一条（≤600 字符），可带 `scope / kind / tags / aliases`；完全相同文本自动去重；**与在库条目相似度 ≥0.62 时提示邻居**（v2.7） |
| `memory_update` | 改文本 / 标签 / scope / kind / pinned；`supersede: true` 时新值生效、旧条目留档不再注入 |
| `memory_merge` | 多条合并成一条原子事实，被合并的留档失效 |
| `memory_audit` | 只读审计（给模型）：重复候选（bigram 相似度）、过期候选（从未使用且 >N 天）、使用排行、scope 分布、预算 |
| `memory_review` | 记忆概览（给人看，v2.8）：已过期 / 未证实 / 从未引用 / 硬规则四段 + scope 分布 + 容量，写入 `review-latest.md` |
| `memory_remove` | 删某条（物理删除；要留历史用 `memory_update` 的 supersede） |

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
- `memory_search` 用 **BM25**（中文 unigram+bigram、tag 命中加权、IDF + 长度归一），不是语义/向量检索；记忆体量小，够用。
- v1.2 起注入预算默认 1500 字符（原 1200）：pinned 全文 + 索引行 + 出局诊断；条目「原子化」与按工作区作用域（scope）留给 v2。

## v1.2 分层注入格式 + BM25 检索（2026-10-29）

改动来源：GitHub 社区 6 个 DSH 记忆插件源码调研（见工作区 `_research/dsh-memory-community.md`）。抄的是机制，不是代码。

- **索引行升级**：未展开条目不再只给 48 字摘要，改为 `- (m23) [project] 2026-10-28 摘要…` —— id 可按需续取正文、日期可判断"这条还成不成立"。
- **出局诊断行**：装不下的条目在块尾逐条点名 `⚠ 另有 12 条未注入：m15 m14 …（用 memory_search 按 id 或关键词取全文）`，**零静默丢失**（v1.1 是「17 条未展开，其中 8 条略去」，被略掉的根本看不见）。
- **BM25 替换命中计数打分**：原来「整串 +3 / 分词 +2」没有 IDF、没有长度归一，常见词一命中就同分（实测 `记忆 插件` → 10 条全 2 分）。现在 IDF 压常见词、长度归一压长条目，tag 命中 ×2。

### 验证记录（2026-10-29，真实 23 条数据 / 5236 字符）

| 项 | 结果 |
|---|---|
| 单测 | `_selftest/tests/memory.test.mjs` **15 项全过**（原 9 项 + 新增 6 项：索引行格式、出局诊断、非 pinned 不全文、IDF 抑制常见词、排序、tokenize） |
| 真实注入块 | 预算 1500：全文 3 条（pinned）+ 索引 12 条 + 诊断点名 8 条，**23 条全部可见或可知**（改前：4 全文 + 9 索引 + **10 条完全不可见**） |
| 零静默丢失 | 断言"每条要么有索引行、要么在诊断行里被点名"，15 项测试里专门覆盖 ✅ |
| 打分饱和 | `记忆 插件` 得分从「10 条同 2 分」变成 m4 11.63 / m16 5.08 / m2 3.87 / m3 3.54 … 有区分度 ✅ |
| 语法/结构 | `node --check` 通过；`npm run check` 三门全绿 ✅ |
| 生效条件 | 宿主插件是 pnpm link 安装（`profiles/desktop/package.json:17`），**需重载 bundle 或重启 DSH** 才用上新代码；本会话内验证用的是直接 import 真实 store 渲染 |

## v1.3 按本轮消息召回（context.agent.session，零模型调用）

v1.2 解决了「看得见」，v1.3 解决「看得准」：注入时读**本轮用户消息**，用 BM25 打分，命中置信足够高就把该条**全文**放进块里（否则不浪费预算）。

- 取查询：`context.agent.session.deriveMessages()`（同步、无 I/O）→ 最后一条 user 消息的 text 分片 → 截 400 字符。拿不到会话就退化为 v1.2 的纯索引模式。
- 召回：`scoreEntries`（与 `memory_search` 同一套 BM25）；**置信门**：只有 top1 明显领先（≥ 1.5× 第二名）才给全文，最多 2 条、最多占预算 30%。理由：中文 unigram 匹配很吵，弱匹配给全文是纯浪费。
- 顺序：pinned 全文 → 本轮相关全文 → 索引行（新→旧）→ ⚠ 出局诊断 → 页脚统计。

### 验证记录（2026-10-29，真实 23 条数据）

| 场景 | 结果 |
|---|---|
| 无 query | 1593 字符 = 全文 3 + 索引 12 + 未注入 8（v1.2 行为不退化） |
| query「给插件更新」 | 1601 字符 = 全文 3 + **相关 1（m16 逐字注入）** + 索引 7 + 未注入 12 ✅ 置信 5.5× |
| query「整理电脑 空间」 | 1569 字符 = 相关 1（m11）+ 索引 7 ✅ |
| query「记忆功能 根治 下一步…」 | 1563 字符 = 相关 1（m4）+ 索引 9 ✅ |
| 弱匹配不浪费 | 低于 1.5× 的候选不给全文，只留在索引行/诊断行 |
| 假 ctx 端到端 | `agent.session.deriveMessages` 返回「给插件更新」→ 块里 m16 原文出现 ✅；无 agent 时退化正常 ✅ |
| 单测 | `_selftest/tests/memory.test.mjs` **18 项全过**（新增：相关全文带 id、pinned 不被挤、无 query 退化） |

## v2.0 原子化迁移（2026-10-29）

把 23 条「段落级」事实拆成 60 条**原子事实**（一条 = 一个可断言的事实），并给每条加上 `scope / kind / tags / migratedFrom`。

| 项 | 迁移前 | 迁移后 |
|---|---|---|
| 条目数 | 23 | 60 |
| 总字符 | 5236 | 3944 |
| 平均每条 | 228 | 66 |
| 最长一条 | 431 | 120 |
| pinned 硬规则 | 3 | 7 |
| scope | 无 | global / plugin-dev / data-infra / dsh-date / machine |

- **为什么拆**：228 字/条时，1500 字预算只能装 6 条左右；拆成 66 字/条后，同预算装下的正文数翻倍，且 BM25 命中更精确（长段落会把关键词稀释）。
- **数据安全**：迁移前已备份到 `D:\AI\dsh-data\memory\memory.json.bak-20261029043908`；迁移脚本幂等 `_tools/migrate-memory-v2.mjs`（已是 v2 就跳过）；回滚脚本 `_tools/restore-memory-backup.ps1`（默认取最新备份）。
- **可控项**：m6+m7（身份说明）合并去重成 3 条；「大肥鱼」条目保留；三条超 120 字的条目已压到 120 以内。

### 验证记录（迁移后真实数据）

| 项 | 结果 |
|---|---|
| 载入 | `memory_list`：60 条 / 3944 字符 / 5 种 scope / kind=rule+fact / 7 条 pinned / 60 条带 tags ✅ |
| 注入块 | 1648 字符 = 全文 7 + 索引 14 + ⚠ 点名 39（超 24 条时按 scope 汇总） ✅ |
| 检索 | `memory_search('验证门 失败 怎么处理')` → m48(17.4) / m47(13.0) / m49(11.5)，均带 `<data-infra>` ✅ |
| 本轮召回 | 模拟「给插件更新」→ 相关 1（m33 全文），块 1682 字符 ✅ |
| 字段持久化 | 单测：add → 重载 → scope/kind/tags 仍在（v2 字段不被 load/persist 洗掉） ✅ |
| 单测 | `_selftest/tests/memory.test.mjs` **22 项全过** ✅ |

> ⚠️ **重启窗口**：旧进程（v1.3）如果在新数据落盘后被调用 `memory_add/update/remove`，会把 v2 字段洗掉（v1.3 的 load 只认旧字段）。**迁移后请立刻重启 DSH**；万一被洗，跑 `node _tools/migrate-memory-v2.mjs --force` 或 `_tools/restore-memory-backup.ps1` 恢复。

## v2.1 维护闭环（2026-10-29）

记忆库能长，但必须能收拾：新增三个机制、一个工具，全部零模型调用。

- **时序失效（supersede）**：`memory_update({ supersede: true })` 不再原地覆盖，而是「新条目生效 + 旧条目 `supersededBy` 留档」；渲染只注入生效条目。回答「以前是什么」随时可查。
- **合并（`memory_merge`）**：把两条相近事实合成一条原子事实，被合并的自动失效 —— 治「同一件事写了两遍各占一段」。
- **审计（`memory_audit`）**：只读，输出重复候选（CJK bigram Jaccard ≥ 阈值）、过期候选（从未命中且 >30 天）、使用排行、scope 分布、预算。只给候选，**不自动删**。
- **使用计数（`usedCount / lastUsedAt`）**：注入层本轮相关的条目 + `memory_search` 命中的条目自增；同一轮同一 query 只计一次；按分钟节流落盘（避免每 step 写盘）。
- **预算只算生效条目**：`usedChars` 不再把失效历史算进去，`memory_list` 顶部显示「失效 N 条」。

### 验证记录（2026-10-29，真实 60 条数据）

| 项 | 结果 |
|---|---|
| 审计真实库 | 60 条生效 / 0 失效 / 无重复候选 / 无过期候选 / scope 分布 data-infra 15 · machine 14 · plugin-dev 12 · dsh-date 12 · global 7 / 占用 3944/8000 / 注入 1712 字符 ✅ |
| 单测 | `_selftest/tests/memory.test.mjs` **29 项全过**（新增 7 项：supersede 不注入、注入统计、usedCount 自增、audit 找重复、merge 留档、update supersede、失效计数） |
| 工具数 | 7 个（原 5 + `memory_merge` / `memory_audit`） |
| 语法/结构 | `node --check` 与 schema 自检通过 |

> 生效仍需重载/重启 DSH（pnpm link 安装，宿主进程不热换模块）。

## 评测（`_selftest/memory-eval.mjs`）

把「该命中的有没有命中 / 硬规则在不在 / 注入有没有超预算」变成可复跑的数字：

```powershell
node D:\AI\dsh-bundles\_selftest\memory-eval.mjs            # 夹具召回 + 真实库卫生
node D:\AI\dsh-bundles\_selftest\memory-eval.mjs --fixture  # 只跑夹具（不依赖真实库）
```

| 指标 | 当前 | 阈值 |
|---|---|---|
| 夹具 recall@3（8 个查询） | **8/8 = 100%** | ≥ 80% |
| 真实库硬规则保留 | **7/7** | 100% |
| 失效条目漏注入 | 0 | 0 |
| 注入字符（真实库，预算 1500） | 1712 | ≤ 1750 |

> 夹具期望若指向 pinned 硬规则，按「必在场」计命中（它们不参与检索排名）。真实库卫生检查会在库不存在时自动跳过。

## v2.2 scope 加分 + 自动沉淀候选（2026-10-29）

### scope 加分

`systemPrompt.context` 的运行期上下文能拿到 session（官方 `dsh-working-directory` 同款），于是召回时按 cwd 映射到 scope 域并加权：

- 映射：`plugin-dev → D:\AI\dsh-bundles`、`data-infra → D:\AI\dsh-data`、`dsh-date → D:\AI-date\dsh-date`（可配置覆盖）；
- 命中的条目得分 ×1.4，**对不上不加分也不过过滤**（避免跨目录工作时误伤）；
- 配置里 `captureCandidates: false` 可关自动沉淀。

### 自动沉淀候选（影子模式）

回合结束时（`agent/turn-stopping`）用**纯规则**从本轮用户消息里抽候选：命中「记住 / 以后 / 下次 / 别再 / 不要 / 一律 / 永远 / 必须 / 规矩」且是陈述句、8–160 字、与现有记忆相似度 <0.7，就写进 `D:\AI\dsh-data\memory\candidates.json`（上限 50 条）。

- 注入块会多一行：`💡 候选记忆 N 条待确认（memory_candidates 查看）`；
- `memory_candidates` 工具：`list` 查看 / `accept` 入库 / `reject` 丢弃 / `clear` 清空；**不会自动入库**。
- 零模型调用；与已有记忆高度重合的句子不会重复进候选。

### 验证记录（2026-10-29）

| 项 | 结果 |
|---|---|
| 单测 | `_selftest/tests/memory.test.mjs` **35 项全过**（新增 6 项：detectScope、extractCandidates、scope 加分排序、回合结束抓候选、accept 后才入库、候选去重） ✅ |
| 工具数 | 8 个（+ `memory_candidates`） |
| 评测 | `memory-eval.mjs` 仍全绿（夹具 recall@3 8/8、真实库 7/7 硬规则、注入 1712 字符） ✅ |

> 生效仍需重载/重启 DSH。

## v2.3 三因子检索 + 相关性覆盖率门（2026-10-29）

调研来源：Generative Agents（recency + importance + relevance，α 全 = 1）、OpenAI Codex 的写入闸门、Google ADK 的双通道。落地时不调模型，全部规则化。

### 三个改动

1. **importance（1-10）**：`kind` 基线（rule 8 / preference 6 / fact 4 / note 2）+ `pinned +2` + `usedCount` 对数修正；显式字段优先（可用 `memory_add/update` 的 `importance` 参数手动指定）。已回填 60 条（分布：10×7 / 8×8 / 4×45）。
2. **recency（0-1）**：Generative Agents 原式 `0.995^小时`（半衰 ≈ 5.8 天），看 `lastUsedAt` 或 `updatedAt`。
3. **合成打分**：`composite = 相关性归一 + 0.5·importance/10 + 0.3·recency`，相关性仍是主导项；取 top-2，第二名要求 composite ≥ top/1.15。
4. **相关性覆盖率门（关键）**：`coverage = top 分数 ÷ 查询 idf 总和`，低于 `relevanceFloor`（默认 0.15）**一条相关全文都不注入**。用覆盖率而不是绝对分数，是为了让阈值与语料规模无关（小库/大库同一把尺，测试库 2 条也不会误杀）。

### 调参前后对照（同一套 36 题微基准，真实 60 条库）

| 指标 | v2.2（基线） | v2.3（现在） |
|---|---|---|
| recall@1 | 88.9% | 88.9% |
| recall@3 | 97.2% | 97.2% |
| MRR | 0.926 | 0.926 |
| **负例误注入率** | **83.3%** | **0.0%** |
| 平均注入字符 | 1732 | 1731 |

校准数据：36 条正例的 coverage 最低 0.186、6 条负例最高 0.128 —— 阈值 0.15 正好分开，且留了余量。

### 验证

| 项 | 结果 |
|---|---|
| 单测 | `_selftest/tests/memory.test.mjs` **39 项全过**（新增 4 项：importanceOf、recencyOf、覆盖率门、importance 写入/更新） ✅ |
| 微基准 | 负例误注入 83.3% → 0.0%，recall 不掉；命令 `node _selftest/memory-bench.mjs` ✅ |
| 评测 | `memory-eval.mjs` 夹具 recall@3 8/8、真实库 7/7 硬规则 ✅ |
| 回填脚本 | `_tools/backfill-importance.mjs`（幂等；已备份 `memory.json.bak-20261029045541`） ✅ |

> 生效仍需重载/重启 DSH。

## v2.4 跨域索引压缩 + 按需引导（2026-10-29）

调研依据：Cursor 的四态（alwaysApply / globs / description / @）与 Windsurf 的「作用域即可见性」。

### 改动

1. **跨域索引压缩**：注入时知道当前 cwd 的 scope。同域与 `global` 给完整索引行（`- (m4) [ux] 2026-10-25 摘要`），**跨域只留 `- (m54) <data-infra>`** —— 跨域事实「知道存在、要看再搜」，不把别域细节当本域规则。
2. **页脚显式引导**：`（全文 7 · 索引 12 · 跨域 7 · 未注入 34；跨域或更早的记忆用 memory_search 按 id / 关键词取）`。
3. **子代理降级：未实现（诚实记录）**。调研里 Claude Code / Cognition 都强调「记忆不要无差别透传给子代理」，但 DSH 的宿主未暴露稳定的「当前 agent 是否子代理」标识（Agent 的 parent 在 fiber 内部，session 文件是 zstd 压缩的日志），本插件拿不到可靠判据，与其猜错不如不做。留待宿主提供信号后再补。

### 实测（真实 60 条库，cwd 在 dsh-创建）

| 项 | v2.3（无 scope） | v2.4（scope=dsh-date） |
|---|---|---|
| 注入字符 | 1730 | 1746 |
| 完整索引行 | 14 | 12 |
| 跨域紧凑行 | 0 | **7** |
| 未注入条目 | 39 | **34** |

同样预算下，「可见条目」从 14 条变成 19 条（12 完整 + 7 紧凑），跨域细节不再占摘要。

### 验证

| 项 | 结果 |
|---|---|
| 单测 | `_selftest/tests/memory.test.mjs` **41 项全过**（新增 2 项：跨域压缩与页脚、统计区分 indexed/compact） ✅ |
| 微基准 | 36 题仍全绿（recall@3 97.2%、负例误注入 0%） ✅ |
| 全栈自检 / 门 | 325 项 + `npm run check` 全绿 ✅ |

> 生效仍需重载/重启 DSH。

## v2.5 长期运维 P0：损坏保护 + 自动备份 + 体检（2026-10-29）

背景：管理方案见工作区 `memory-ops-plan.md`；这一版把「会丢数据 / 不会自己报警」两类风险先堵上。

### 1. 损坏保护（防静默清空）

- 解析失败时**不再从空开始**：把原文件改名 `memory.json.corrupt-<时间戳>` 留证，进入**只读保护态**。
- 保护态下所有写工具（add/update/remove/merge/candidates）直接报错并给出副本路径；`memory_list` 返回 `health: "corrupt"` 与 `healthNote`。
- 修好（合法 JSON 改名回 `memory.json`）并重载后自动恢复。

### 2. 每日自动备份 + 轮转

- 每次**当天第一次写**之前自动复制 `memory.json.bak-YYYYMMDD`；同一天多次写只备份一次。
- 只保留最近 **10 份**备份（按 mtime 清理），避免目录膨胀。

### 3. 体检脚本与手册

- `_tools/memory-doctor.mjs`：解析 / schema / id 唯一 / 单条长度 / importance 值域 / nextId / 容量 / 增量 / 重复 / 疑似密钥 / 损坏副本 / 备份 / 候选池，输出 PASS/WARN/FAIL 与退出码。
- `memory-OPS.md`：一页运维手册（例行、备份恢复、损坏处理、迁移、调参、排障索引）。
- 每周一 09:00 提醒跑体检（DSH 日程 `schedule-cb7e4ada`）。

### 验证（真实库 60 条）

| 项 | 结果 |
|---|---|
| 单测 | **43 项全过**（新增 2 项：损坏保护改名+拒写、每日备份与 10 份轮转） ✅ |
| doctor | 真实库跑出 14 项检查，仅「近 7 天新增 60」WARN（迁移继承时间戳所致），退出码 0 ✅ |
| 微基准 / 评测 | recall@3 97.2%、负例误注入 0%，评测脚本全绿 ✅ |
| 全栈自检 / 门 | 325 项 + `npm run check` ✅ |

> 生效仍需重载/重启 DSH。

## v2.6 信任字段（2026-10-29）—— 学 OKF v0.2

**问题**：记忆里「确认的事实」和「我猜的」长得一模一样。一旦把猜测当事实用，后续决策全歪。
**学谁**：[simple-agent-memory](https://github.com/brianschroeder/simple-agent-memory) 的 Open Knowledge Format v0.2（`status` / `verified` / `stale_after` / `sources`），对应调研报告 §7.5「provenance + 晋级闸门」。

### 字段契约

| 字段 | 类型 | 缺省 | 语义 |
|---|---|---|---|
| `status` | `draft` / `stable` / `deprecated` | 无（= 未标注，行为同 v2.5） | draft=未证实猜测；stable=已确认；deprecated=历史留档，**永不注入** |
| `staleAfter` | `YYYY-MM-DD` | 无 | 依赖会变的事实（版本号 / API 行为）写它；过期后注入带 ⏰ |
| `verifiedBy` | string | 无 | 谁复核过（工具写入 `agent`） |
| `verifiedAt` | ISO 时间 | 无 | 复核时间；`memory_update verified:true` 写入，`false` 清除 |
| `sources` | string[] | 无 | 证据（URL / 文件路径）；**不许编造** |

### 注入标记

- `❓未证实` —— `status: draft`
- `⏰待重验` —— `staleAfter` 早于今天
- `✓已验证` —— 有 `verifiedAt`

有标记时，注入块头部加一行 legend 解释含义；**没有任何标记时输出与 v2.5 逐字一致**（不插 legend，零 token 成本）。

### 生命周期

```
写入 → draft（可选，未证实）
     → stable（确认后）
     → deprecated（被取代：supersede 自动标 / 手动标）
复核 → memory_update verified:true → ✓已验证
过期 → staleAfter 到期 → ⏰待重验 → 重验后再 verified:true
```

### 工具参数

- `memory_add`：新增可选 `status` / `staleAfter` / `sources`
- `memory_update`：新增可选 `status` / `staleAfter` / `sources` / `verified`
- 非法 `status` 或 `staleAfter` 格式 → **明确报错**，不静默忽略
- `memory_audit`：新增 `draft` / `recheck` 两个计数

### 向后兼容（实测真实库）

63 条真实记忆（全部没有新字段）过一遍 `normalizeEntry` + `renderMemory`：

| 检查 | 结果 |
|---|---|
| 字段集变化 | **0 条** |
| 字段值变化 | **0 处** |
| 注入块含 legend | 否（无标记） |

即：**老数据行为完全不变**，新字段只在显式写入时出现。

### 验证

| 项 | 结果 |
|---|---|
| 单测 | **51 项全过**（v2.6 新增 8 项：兼容、白名单、trustMark、deprecated 不注入、draft 标记、add 校验、verified 置位/清除、落盘后存活） |
| 真实数据兼容 | 63 条 0 差异 ✅ |

> 本版生效需重载插件 / 重启 DSH。

## v2.6.1 schema 单一真相源（2026-10-29）

**真实调用暴露的存量 bug**：`memory_list` 直接返回 `invalid output`：

```
"value.entries[3].lastUsedAt" is not a declared property
"value.entries[63].status" is not a declared property
```

**根因（两处）**：

1. `lastUsedAt` 从 v2.1 起就会写进条目（被 `memory_search` 命中时），但对外 schema **从来没声明过**——只要有一条记忆被搜到过，`memory_list` 就炸。这是存量 bug，不是 v2.6 引入的。
2. `listSchema` 和 `entrySchema` 是两份手写的重复定义；v2.6 给后者加了信任字段，前者没跟上。

**修法**：

- 抽出模块级 `memoryEntrySchema` 作为**唯一真相源**，覆盖 `normalizeEntry` 能产出的全部 21 个字段（含 `lastUsedAt` / `validFrom` / `supersededBy` / `paths`）；
- `listSchema` / `entrySchema` 全部引用它，以后加字段只改一处；
- 新增 2 项回归测试：`normalizeEntry` 产出的字段必须 ⊆ schema；`memory_list` 实际返回值不得含未声明字段。

**教训**：53 项单测全绿也测不到这个——测试直接调 `execute()` 拿 JS 对象，不做 JSON Schema 校验；**schema 与实际返回值的匹配只有真实工具调用才会验**。这和 `path-rules` 的 cwd bug 是同一类：单元测试覆盖不了「宿主校验层」。

**真实验证记录**：

| 项 | 结果 |
|---|---|
| `memory_add` 带 status/staleAfter/sources | ✅ 返回 entry 含全部三个字段 |
| `memory_audit` | ✅ `draft=1 recheck=1` |
| 注入块 | ✅ 系统提示里出现 legend + `(m64)❓未证实 ⏰待重验 [probe] ...` |
| 删除探针后注入恢复干净 | ✅ 无 legend、无标记（无标记时不加说明） |
| `memory_list` | ❌ 当前实例仍报 invalid output（修复需下次重载生效） |

**验证**：单测 53 项全过（+2）。

> v2.6.1 生效需重载插件 / 重启 DSH。

## v2.7 三处「记忆看不见」的修复（2026-10-29）

来源：对标 mem0 / Letta MemFS / A-MEM / Cognee 之后，只挑「实测缺口能对上」的三处改，不做架构重写。

### 1. 跨域压缩保留主题（v2.4 的设计缺陷）

v2.4 把跨域条目压成 `- (m54) <data-infra>`，只剩一个域标签。改前注入块里 m57–m63 这批**最近的**记忆全部不可读——模型看不出讲什么，自然不会去 `memory_search`，等于这 7 条不存在。

现在压到 **14 字主题**：`- (m63) <data-infra> 安装台账已登记 11 条（G…`。每条只多约 14 字符，换来「知道存在且知道讲什么」。

### 2. `memory_search` 认 id（文档与实现不一致）

注入块从 v1.1 起一直写着「用 memory_search 按 id 或关键词取全文」，但 BM25 **不认 id**——实测搜 `m33` 命中 **0 / 63**。

修法：query 里出现 `m\d+` 就按 id 直取，排最前，输出多一个 `byId` 字段。

### 3. `memory_add` 提示相似邻居（A-MEM strengthen 的零模型版）

A-MEM 用 LLM 判断新记忆与邻居是否要互相演化；我们不做额外 LLM 调用，改用已有的 `textSimilarity`（CJK bigram Jaccard）：写入前扫一遍在库条目，相似度 ≥0.62 的取前 2 条，返回 `similar`，并提示「memory_update 合并，或 supersede 推翻旧条」。

**只提示、不自动合并**——守住 dsh-memory「给候选不自动改」的一贯原则。

### 验证

| 项 | 结果 |
|---|---|
| 单测 | `_selftest/tests/memory.test.mjs` **56 项全过**（原 53 + 新增 3） ✅ |
| 三道门 | `npm run check` 全过（语法 15 入口 / 结构 20 manifest / 测试 cost+memory） ✅ |
| 真实库 | 63 条、scope=dsh-date：注入块 **1748 字符**，跨域压缩行全部带主题 ✅ |
| 负例 | 不相似的写入不产生 `similar`；不存在的 id 不产生 `byId` ✅ |

> v2.7 生效需重载插件 / 重启 DSH（同 v2.6.1）。

## v2.8 综合改进：自动时效 + 记忆概览 + 预算口径（2026-10-29）

综合三轮对标（开源中间件 mem0 / Letta / A-MEM / MemOS / Cognee；大厂产品 OpenAI Dreaming / LangMem；上下文工程 Manus / Karpathy），只落地三处「实测缺口能对上、且不碰注入主逻辑」的改动。

### 1. `staleAfter` 按 kind 自动推导

依据：OpenAI 2026 记忆架构升级里，事实回忆 82.8%、偏好遵循 71.3%，而**跨时间准确性只有 75.1%**——时间失效是全行业最弱的一环，靠人记得手填 `staleAfter` 不现实。

| kind | 自动时效 |
|---|---|
| `fact` | +90 天 |
| `note` | +30 天 |
| `rule` / `preference` | 不设（长期约定，设了只会天天报警） |

只对新写入生效，存量条目不动。显式传 `staleAfter` 优先。

### 2. `memory_review`：给人看的视图

`memory_audit` 是给模型的；缺的是人能一眼扫完的。新增 `memory_review`，分四段：⏰ 已过期待重验 / ❓ 未证实 / 🕸 从未被引用 / 📌 硬规则，另附 scope 分布与容量，写入 `storeDir/review-latest.md`。

真实库首次跑：63 条 → 26 条从未被引用、7 条硬规则、注入 1742/1500（超 242）。

### 3. 预算口径显式化

`maxInjectChars` 只管正文行，头部 / 索引 / 诊断另有固定开销，总长会略超。`memory_list` 新增 `injectedOverBudget`，渲染时直接标「⚠超预算」，不再让人猜。

### 验证

| 项 | 结果 |
|---|---|
| 单测 | **60 项全过**（原 56 + 新增 4） ✅ |
| 真实库 | `memory_review` 落盘 review-latest.md，计数 63 条 / 过期 0 / 未证实 0 / 未引用 26 / 硬规则 7 ✅ |
| 三道门 | `npm run check` 语法 + 结构 + 测试 ✅ |

> v2.8 生效需重载插件 / 重启 DSH。

## v2.9 学习进化：遗忘曲线 + 沉淀管道工程化（2026-10-29）

标准：每条机制都要能解释、能测、能回滚，不做「能跑就行」。

### 1. 遗忘曲线（`effectiveImportance`）

原来重要度是静态的；现在叠加「多久没被命中」的衰减。

| 距上次命中 | 系数 |
|---|---|
| ≤ 7 天 | 1.0 |
| ≤ 30 天 | 0.9 |
| ≤ 90 天 | 0.7 |
| 更久 | 0.5 |

`pinned` 与 `rule` **永不衰减**（硬约定）。只影响注入排序，**不改存储值、不删任何条目**，改一行常量即可关闭。

真实库实测：今天 0/63 衰减（记忆都还新），**30 天后 48/63 会降权**。这是设计意图，也是有意的风险——
衰减只作用于「本轮相关全文」的排序，不影响索引区（索引按新→旧），所以注入块结构不会被整体打乱；
且下限是 0.5×，不会归零。已知代价：冷门但正确的事实会越排越后（固有特性，需要人工确认时用 `memory_review` 捞）。

### 2. 巩固信号

被引用 ≥3 次且非 pinned 的条目，在 `memory_review` 里进「⭐ 该升级」段，提示升 `pinned` 或调高 `importance`。
真实库当前命中 2 条：`m7×3`、`m33×5`。

### 3. 沉淀管道工程化

| 问题 | 改法 |
|---|---|
| 规则只认命令式（记住/以后/别再），「实测结论」类知识全漏 | 新增「实测结论」「结论/归因」两类，并按信号强度排序（具体在前、泛化在后，避免「结论是必须X」被「必须」抢先命中） |
| 整段消息塞进候选，不是原子事实 | 先按 `。；;！!` 与换行切句，逐句判定，单条消息最多 2 条 |
| 候选池只增不减 | TTL 7 天，过期自动标 `expired`（保留记录不删），不再虚报「N 条待确认」 |

### 验证

| 项 | 结果 |
|---|---|
| 单测 | **63 项全过**（原 60 + 新增 3） ✅ |
| 真实库 | 衰减 0/63（今天）；30 天后模拟 48/63；巩固候选 2 条 ✅ |
| 三道门 | `npm run check` 语法 + 结构 + 测试 ✅ |

> v2.9 生效需重载插件 / 重启 DSH。

## v3.0 工作区条件注入（2026-10-29）

**问题（实测）**：7 条 `pinned` 全是 `global`，其中 `m10/m11/m12` 三条礼仪规则（178 字）只在两个工作区适用，却每轮全文注入到所有工作区。`scope` 粒度不够——它们和本工作区同属 `dsh-date`。

**做法**：条目可带 `workspaces`（绝对路径前缀）。当前 cwd 不匹配 → 整条不注入（仍能被 `memory_search` 搜到）。没设 `workspaces` 的条目行为完全不变。

**实测**：

| 工作区 | 改前 | 改后 |
|---|---|---|
| dsh-创建 | 注入 1742 · pinned 7 · 索引 12 | 注入 1762 · **pinned 4** · 索引 **17** |
| 亲爱的管家 | 1742 · pinned 7 | 1742 · pinned 7（完全不变） |

**反直觉的结论**：注入总长没降，反而 +20。因为索引区会填满剩余预算——腾出的 178 字立刻被 5 条新索引吃掉。所以这项改动的收益**不是省 token，而是相关性**：本工作区不再看到不生效的礼仪规则，同样预算多放 5 条有用索引。

至于「超支 242」这个数：它来自 `<memory>` 包装 + 头部 + 页脚 + 出局诊断的固定开销，`maxInjectChars` 本来就只管正文行。想真正压下来只能减少条目，不能靠调排序。

### 验证

| 项 | 结果 |
|---|---|
| 单测 | **65 项全过**（原 63 + 新增 2） ✅ |
| 真实库 | 本工作区 pinned 7→4、索引 12→17；礼仪工作区逐字不变 ✅ |
| 三道门 | `npm run check` 语法 + 结构 + 测试 ✅ |

### 数据变更

`m10/m11/m12` 已加 `workspaces`（改前整体备份在 `memory.json.bak-before-workspaces`）。

> v3.0 生效需重载插件 / 重启 DSH。

## v3.1 记忆自我污染修复（2026-10-29）

**实测抓到的第一个真实故障**：沉淀管道上线后，候选池冒出两条垃圾——

- `把它们当背景，不要逐条复述`（`<memory>` 块的头部提示语）
- `其他工作区一律不套用 - 📌 用户陈青松是「皇上」…`（注入块内容片段）

**根因**：DSH 会把 `systemPrompt.context` 注入的 `<memory>` 块并进 user 消息，而 `turn-stopping` 取「最后一条 user 消息」时没剥离它 → 记忆抓到了自己。若确认，它会进入下一轮注入再被抓一次，越滚越蠢。

**两层修法**：

| 层 | 做法 |
|---|---|
| 源头 | `turn-stopping` 里 `replace(/<memory>[\s\S]*?<\/memory>/g, ' ')` 剥掉注入块，剥完为空则直接返回 |
| 兜底 | `extractCandidates` 加污染门：含 `📌` / `<memory>` / `</memory>` / 注入头提示语 / 「用 memory_search 按 id」的句子一律不收 |

**验证**：

| 项 | 结果 |
|---|---|
| 污染门 | 三条注入块样本全部 0 命中 ✅ |
| 正常捕获 | 「这个方案已实测失败，因为权限不够」→ 1 条 ✅ |
| 单测 | **66 项全过** ✅ |

### 数据留档（用户确认）

`m34 / m44 / m45` 三条确认失效的条目已标 `status: deprecated`——保留记录、永不注入，未删除。注入块内已无残留，未注入从 40 降到 36。

备份：`memory.json.bak-before-deprecated`、`candidates.json.bak-before-reject`。

> v3.1 生效需重载插件 / 重启 DSH。

## v3.2 记忆库整理（2026-10-29）

用户要求「整理一下记忆」。诊断结论和直觉不同：**没有重复**（bigram 相似度 ≥0.41 的对为 0 组），问题是**同主题被拆得太碎**——63 条里大量是「一个软件三条」，检索时彼此稀释。

### 做法

按主题簇合并：同簇多条 → 1 条完整条目，原文全部 `supersededBy` 留档（可随时恢复，**未删除任何一条原数据**）。

| 簇 | 原 | 合并后 |
|---|---|---|
| WorkBuddy 清理红线 | m5+m6 | m65 |
| VirtualBox + 归档区 | m25+m26+m27 | m66 |
| GlassBoard | m28+m29 | m67 |
| 抖音启动 | m30+m31+m32 | m68 |
| skill-forge | m37+m38+m39 | m69 |
| 验证门 | m47+m48+m49 | m70 |
| 评测套件 | m54+m55+m56+m58 | m71 |
| Hermes | m13+m14+m16+m17+m18 | m72 |
| 官方优先 | m7+m8+m9 | m73 |
| 插件更新流程 | m33+m35+m36 | m74 |
| 竞品调研 | m50–m53 | m75 |
| 工作区地图 | m41+m42+m43+m46 | m76 |
| 安装台账 | m61+m63 | m77 |
| 评测发布 | m59+m60 | m78 |

### 结果

| 指标 | 整理前 | 整理后 |
|---|---|---|
| 生效条目 | 60 | **31** |
| 正文 | 4275 字符 | 4025 字符 |
| 注入块 | 1762 | **1620** |
| 未注入条目 | 40 | **8** |

正文只降 250 字——因为合并保留了全部信息，压的是**碎片**不是内容。真正的收益是「未注入 40 → 8」：几乎所有记忆现在都在注入块里可见或可索引。

### 口径发现（待修）

`memory_review` 的 `counts.total = 34`，实际生效 31。差异是 3 条 `status: deprecated`（m34/m44/m45）——`activeEntries()` 只过滤 `supersededBy`，没过滤 `deprecated`，而 `renderMemory` 两者都过滤。两处口径不一致，下一版统一。

备份：`memory.json.bak-before-merge1/2/3`。

## v3.3 生效口径统一（2026-10-29）

**v3.2 整理时暴露的 bug**：`memory_review` 报 `total: 34`，实际只注入 31 条。

**根因**：`activeEntries()` 只判断 `supersededBy`，没判断 `status: 'deprecated'`——
而 `renderMemory` 两者都过滤。于是同一批数据在两处得到不同结论：预算虚高、审计偏大、概览多算 3 条。

**修法**：

| 位置 | 改动 |
|---|---|
| `isActive()` | 加 `status !== 'deprecated'`，与 `renderMemory` 对齐 |
| `memory_list` | `superseded` 改为真正的 supersede 计数；新增 `archived`（全部不生效条目） |
| `memory_audit` | 同上；schema 的 `required` 补 `archived` |

**验证（真实库 77 条）**：

```
review.counts.total = 31
list 实际生效      = 31
audit.active       = 31   ← 三处一致
audit.active + archived(46) = total(77)  ← 恒等式成立
usedChars 4025 = 生效正文 4025  ← 预算不再虚高
```

新增单测断言「review.total === audit.active」「active + archived === total」「superseded 不含 deprecated」。

> v3.3 生效需重载插件 / 重启 DSH。

---

## v3.5 检索桥接：别名 + 同义扩展（2026-10-29）

### 起因：一个错的数字

先做了「换皮问法」测试：同一件事用户换种说法（「收工前谁拦着我别提交」），能不能召回。
原基准报 recall@3 = 30.6%，但查下来 **36 条正例里 27 条的目标 id 已被合并/废弃**——
基准从不跟随 `supersededBy` 链，那些用例数学上不可能命中。

| 指标 | 修基准前（错分母） | 修基准后 |
|---|---|---|
| recall@1 | 27.8% | 88.2% |
| recall@3 | 30.6% | 100.0% |
| MRR | 0.287 | 0.936 |

修法：`_selftest/memory-bench.mjs` 增加 `resolveExpected()`，沿 `supersededBy` 解析到当前生效条目；
链尾已废弃的用例作废、单独报数（不计入分母）。同时新增 `memory-bench-paraphrase.json`（23 条换皮问法）。

### 改动

| 位置 | 改动 |
|---|---|
| 条目 schema | 新增 `aliases: string[]`；`memory_add` / `memory_update` 都支持 |
| `bm25Doc` | aliases 并入文档词表，命中权重 `×2.5`（> tag `×2`） |
| `expandQuery()` | 14 组领域同义（生效↔重载↔装完、验证门↔收工前…），只在命中同义组时扩展；**单字不扩展**，扩展词权重 0.5 |
| `scoreEntriesStrict()` | 新增：只用 text + tags，不含别名、不做扩展，**专供相关性门槛** |

### 踩到的坑（别重犯）

第一版把 aliases 并进文档词表后，**负例误注入 0% → 75%**：
「帮我写个 Python 快排」「MySQL 索引优化怎么做」被判相关并注入全文。
原因：门槛 = top 分 ÷ 查询 IDF 总和，别名把 top 分抬高了。
第二版门槛改用严格分仍 25%——因为严格分虽不加权，aliases **仍在文档词表里**，
「怎么生成」这个别名里的「怎么」照样命中「怎么做」。

**最终语义**：别名是「查询侧桥」不是「原文内容」→ 严格分的文档只取 `text + tags`。

### 结果

| 基准 | 指标 | 改前 | 改后 |
|---|---|---|---|
| 原有 34 条 | recall@1 / @3 | 88.2% / 100% | **97.1% / 100%** |
| 原有 34 条 | MRR | 0.936 | **0.985** |
| 换皮 23 条 | recall@1 / @3 | 91.3% / 91.3% | **100% / 100%** |
| 换皮 23 条 | MRR | 0.913 | **1.000** |
| 两个基准 | 负例误注入 | 0% | **0%（守住）** |

### 诚实的边界

- 换皮用例与别名都是我写的，**收益上限偏高**；真实用户问法需继续收集。
- 样本 23 + 34 条，读「100%」要小心，它是这套样本上的 100%。
- 别名是手工回填的 32 条。长期要靠**写入习惯**：memory_add 时顺手给 3–5 个别名，
  否则新记忆没桥、旧桥随合并失效。
- 注入仍是 ~1631 字符 / 预算 1500、覆盖 100%：这是 P1「装不下」的问题，不是检索问题。

> v3.5 生效需重载插件 / 重启 DSH。

