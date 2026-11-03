# dsh-harvest

把会话榨成「带证据的候选记忆」，并在删会话前当闸门。

## 为什么有它

会话和附件越攒越是负资产。正确顺序是先榨后删：榨出稳定事实 → 进候选 → 复核后入 memory / 技能 → 原料再删。
这个插件是学完 Hermes / Mem0 / Letta / Zep / AWS / OpenAI / LangMem 之后，按本机约束做的「我们自己的版本」。

## 我们的取舍（不是照抄）

1. 只榨事实级内容：规则 / 纠正 / 偏好。流程与坑留给技能，不在这里收（避免误收）。
2. 每条候选必须带证据：session / seq / time；无证据不收。
3. 只写候选，不自动写 memory；复核后由人或 agent 用 memory_add 采纳。
4. 零依赖、零模型调用；规则可读可改，成本为零。
5. 幂等：按会话文件 mtime + state 跳过；重复跑不产垃圾。
6. 会话只读；数据落 D 盘；不引向量库/图库（不预建昂贵结构）。

## 工具

| 工具 | 作用 |
| --- | --- |
| harvest_status | 就绪状态、会话数、候选数、待审数 |
| harvest_run | 扫会话→抽候选（可限定 workspace / session / limit / redo） |
| harvest_candidates | 看待审候选（带 session / seq / time 证据） |
| harvest_gate | 删除闸门：没被 harvest 覆盖的会话不许删 |
| workspace_status | 工作区审计：账本 vs 磁盘（引用缺失/未登记会话/是否已榨） |

## 数据

- 默认目录：D:\AI\dsh-data\harvest
- candidates.jsonl：候选（id / type / text / evidence / status / createdAt）
- episodes.jsonl：每个会话的摘要索引（标题 / 轮数 / 交付物 / 时间）
- state.json：已处理会话的 mtime 记录（幂等依据）

## CLI（开发与验收）

    node bin/harvest.mjs --status
    node bin/harvest.mjs --workspaces
    node bin/harvest.mjs --all
    node bin/harvest.mjs --workspace D:\AI-date\dsh-date\dsh-亲爱的管家
    node bin/harvest.mjs --session <会话id> --redo
    node bin/harvest.mjs --gate <会话id1,会话id2>

## 验收

- node tests/harvest.test.mjs 全绿。
- 同一会话跑两次：第二次 skipped = 1、candidatesAdded = 0。
- 删除闸门：未 harvest 的会话 id 必须 allowed = false。

## 工作区审计（v0.2.0）

DSH 的工作区/会话有账本（.dsh/storages/workspace.json）。删会话/删工作区必须走 DSH 的 API，
直接删磁盘会让账本与磁盘对不上。workspace_status 只读地报出这种漂移，删除动作仍由 DSH 完成。

## 下一步

- 装进 profile，挂会话结束/空闲触发（后台，不打断对话）。
- 候选复核：接受时走 memory_add，拒绝时记 rejected。
- 与 dsh-memory 的候选机制合并，避免两套候选库。
- v0.2 再考虑 LLM 抽取（只抽规则命中不了的决策/坑），默认关闭。
