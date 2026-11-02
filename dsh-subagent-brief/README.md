# dsh-subagent-brief —— 子 agent 摘要契约（agent/pre-step 版）

> 学谁：Claude Code 的 subagent —— 子 agent 在自己的上下文里干完活，回给主 agent 的是一份短摘要，原始长输出留在子会话里。
> 一句话：子 agent 的**结算消息正文**超过 1200 字符，就在父 agent 的每一步之前截成"前 1200 字符 + 一句去哪看"。
> v2（2026-10-30）：拦截点从 `tools/post-execute` 改为 `agent/pre-step` —— 旧版在真实 subagent 上是空转的（原因见文末「v1 的教训」）。

## 它解决什么

DSH 的 `subagent` / `subagent_fork` 会把子会话结果送回主干。读一遍文件列表、跑一遍构建日志、汇报一遍改动，几千上万字符直接进主上下文：

- 一次 3500 字符的子 agent 报告 ≈ 主干上下文 0.35%（按 1M 窗口算），一天跑十次就是 3.5%；
- 更糟的是**越长的报告越没人看**——主干真正需要的是"做完了没有 / 结论是什么 / 有没有坑"，而不是子 agent 复述的每一行文件内容。

Claude Code 的做法是让子 agent 天生只回摘要（隔离上下文 + 摘要回传）。本插件在 DSH 上补上后半段：**即使子 agent 不自觉写长了，主干也只会收到摘要。**

## 拦截点在哪（源码依据，不是猜）

**来源层级：源码**（DSH 0.2.1-rc.5 的 app.asar，2026-10-30 解包确认）

1. 子会话结果**不走**工具返回值，也不经过 `tools/post-execute`：`subagent` 工具的返回值只有 `{ kind: 'activation', subagentId }`。
2. 结果由 @deepseek-ai/dsh-subagent 的 `createSettlementMessage()` 构造一条 **user 消息**投递给父会话，形状大致是：

```
content: [
  { type: 'text', text: <结算摘要> },
  { type: 'text', text: 'Its closing message:' },
  ...子 agent 的最终文本块,                          ← 只有这些算「正文」
  { type: 'text', text: 'Structured result: ...' },  ← 原样保留
  ...诊断块                                           ← 原样保留
]
source: { kind: 'subagent-settled', form: 'notice', summary, senderSessionId }
```

3. 这条消息进父 agent 的 inbox，在**每一步之前**经过 `agent/pre-step` waterfall（来源：@deepseek-ai/dsh-agent-loop，payload = `{ messages, turn, step, signal }`，默认返回 `{ kind: 'enter', messages }`，也可能 `kind === 'reject'`）。

所以本插件监听 `agent/pre-step`：先 `await next()`，只在 `decision.kind === 'enter'` 时遍历 `decision.messages`，挑出 `message.source.kind === 'subagent-settled'` 的那条，截断它的正文。

## 为什么在消息边界截断，而不是只靠提示词自觉

两条路解决的是两个不同的问题，缺一不可：

| 层面 | 手段 | 强项 | 弱项 |
|---|---|---|---|
| 提示词（正面引导） | 在 AGENTS.md / 子 agent 任务里写"只回 10 行摘要" | 摘要**有信息量**：模型会挑重点、会换措辞压缩 | 只是"请求"，模型可以不听；上下文一长、任务一急就失效 |
| 消息边界（限高杆，本插件） | `agent/pre-step` 上超过阈值就截 | **确定生效**：不看模型脸色，最坏情况可预测 | 截出来的是"前 N 字符"，不是"重点"；可能切断关键结论 |

所以本插件**不替代契约，只兜底**：契约负责"摘要该写什么"，插件负责"再长也进不了主干"。两者合起来，最坏情况从"主干被 3 万字灌爆"退化成"主干看到 1200 字符的半份报告 + 一句明确提示"。

也正因为截断是**笨办法**，尾注必须写清楚"原文 N 字符、完整内容在子会话、要细节就去问"——让模型知道信息不全，才会去补齐，而不是拿半份报告当全部事实。

## 它做什么（行为）

1. 监听 `agent/pre-step`：先 `const decision = await next()`；`decision.kind !== 'enter'` 时原样返回；
2. 只处理 `message.source?.kind` 在 `sourceKinds` 里的消息（默认 `['subagent-settled']`）；
3. 以 `'Its closing message:'` 块为界：
   - **之前**的块（结算摘要、标记块）原样保留；
   - **之后**只把 `type === 'text'` 的正文块计入长度，累计到 `maxChars`（默认 1200）为止；
   - 超了就截断、追加中文尾注，并**丢弃**超预算的正文块（那就是长报告本体）；
   - 以 `'Structured result:'` 开头的块、以 `Diagnostic` / `诊断` 开头的诊断块、非 text 块**原样保留、不参与正文预算**；
4. 不改 `source` / `summary` / `role` 与消息其它字段；返回**新的** messages 数组与新消息对象，不原地改外部对象；
5. **幂等**：正文里已经带本插件尾注的消息直接放行（哪怕它仍比阈值长）；
6. 正常用户消息、短结算消息、无 `source` 的消息、`reject` 决策：**原对象返回，不复制不改写**。

尾注长这样（真实输出）：

```
…- 第 17 条：这里是一段相当长的子 agent 汇报，包含结论、路径、行号与待办。
（已按摘要契约截断：原文 3512 字符，完整内容在子会话，需要细节请让子 agent 只报关键结论）
```

## 配置

`cordis.patch.yml` 里默认就这三项：

| 项 | 默认 | 说明 |
|---|---|---|
| `maxChars` | `1200` | 正文累计超过就截。非正整数一律回落到 1200 |
| `sourceKinds` | `["subagent-settled"]` | 拦哪些来源的消息。显式给空数组 = 一个都不拦 |
| `enabled` | `true` | `false` 时整个插件不处理（但仍会记录 pre-step 概览供排查） |

## 诊断

`subagent_brief_status`（唯一一个工具，内部计数只在这里出现）。
统一契约（v0.2.1，2026-11-01）：返回值必带 `ready` 与 `unavailableReason`（空串=可用）；`ready` 判的是**配置阈值是否有效**（没配=用默认值算有效；配了必须是 ≥1 的数字），`ready:false` 时渲染只输出「不可用：<原因>」。这一行即验证记录：`maxChars:800` → `ready:true`；`maxChars:0` → `ready:false` + 「不可用：配置阈值 maxChars=0 无效（应为 ≥1 的数字），实际按默认 1200 截断」；不配 → `ready:true`。

```
摘要契约：已启用 —— 子 agent 结算消息的正文超过 1,200 字符就收成摘要。
拦截来源：subagent-settled
上次 pre-step：14:03:40 第 3 回合第 7 步，2 条消息（来源：user、subagent-settled）
本次运行截断 2 次，共替你省下 4,542 字符。
最近记录：
  14:03:40  subagent-settled  3,512 字符 → 1,241 字符
  14:03:41  subagent-settled  3,009 字符 → 1,277 字符
```

- 「上次 pre-step」是排查用的：能直接看到**钩子有没有被调用、看到了几条消息、来源分别是什么**。如果它一直是"还没看到过 pre-step 事件"，说明钩子没挂上或父 agent 还没跑下一步，而不是阈值没到。
- 「原长度 → 新长度」是消息里**所有 text 块的总长**（前 / 后），差值就是这次省下的上下文。

关闭状态下会说明怎么开回来：

```
摘要契约：当前是关闭状态，子 agent 的长结算消息会原样回到主干。
想开启：把配置里的 enabled 改回 true（默认就是开着的）。
```

## 建议写进工作区 AGENTS.md 的契约（≤8 行）

插件只保证"不会太长"，不保证"摘要好用"。要让摘要**有信息量**，配一段提示词契约：

```
## 子 agent 摘要契约
- 子 agent 的最终回复 ≤ 10 行，只写三件事：做了什么 / 结论 / 未完成或风险。
- 不贴代码、不贴文件全文、不复述读到的内容。
- 需要细节只报「去哪看」：文件:行号、命令名、子会话里的哪一段。
- 交付物是文件就报路径，不要内联内容。
- 主干要更多细节时，会再让子 agent 只回答那一个具体问题。
```

## 已知边界（诚实清单）

- **依赖官方的消息形状**：分界标记 `'Its closing message:'` 是 `createSettlementMessage()` 里写死的字符串。DSH 改文案或改结构后，本插件会"找不到标记 → 不处理"，不会误伤（保守放行），但也就失效了。排查：看 `subagent_brief_status` 的「上次 pre-step」，消息里有 `subagent-settled` 却没截断，就是形状变了。
- **诊断块靠前缀启发式**：源码里的诊断块具体文案没有稳定契约，本插件只认 `Diagnostic…` / `诊断…` 前缀。认不出的块会被当正文一起进预算（宁可少保留，也不误删）。
- **截断后主干只能"再查"**：被切掉的细节不在主干上下文里，要么让子 agent 重报一句结论，要么自己读文件。插件不做二次摘要、不做语义压缩、不调用模型。
- **切点在"最后一个换行"，不是"重点"**：报告如果前半段是背景、后半段才是结论，可能只留下背景。这是笨办法的代价，靠上面的契约补。
- **只处理 text 块**：结构化结果（`Structured result:`）、图片等非 text 块完全不处理——那些不是"回灌的长文"，截了反而坏。
- **只在 `agent/pre-step` 生效**：不改 `tools/post-execute`，也不拦 subagent 的入参。
- **长度按 UTF-16 码元算**：中文一个字算 1，emoji 算 2，与真实 token 数不是等比关系（1200 字符中文 ≈ 600–900 token）。
- **截断结果会比阈值略长**（多约 55 字符尾注）：这是有意的，必须告诉模型"内容不全"。
- **误判概率极低但存在**：如果子 agent 的原文恰好包含本插件尾注的固定开头，会被当成"已截断"而放行（措辞很特殊，正常不会撞）。
- **一次 pre-step 里多条结算消息**：逐条处理、逐条计数（各自的原长度 → 新长度）。

## maxChars 调参建议

| 你的情况 | 建议 |
|---|---|
| 默认起步 | **1200**（约中文 600–800 字，够写"做了什么/结论/风险"三段） |
| 子 agent 经常在截断后丢结论 | 提到 **1500–2000**，把尾注和完整结论都包进来 |
| 主干上下文紧张、报告普遍注水 | 降到 **800–1000**，逼子 agent 只报关键结论 |
| 只做单点问答的子 agent（如"这个函数在哪调用"） | 不建议低于 **400**：尾注本身约 55 字符，再小就只剩一句话能进来 |

不要设超过 3000：一次子 agent 就吃掉 3k 字符，多来几次等于没设。调完用 `subagent_brief_status` 看"最近记录"里的实际 原长度 → 新长度，再决定要不要动。

## 验证记录

### v0.2.1（2026-11-01，统一状态契约）

`subagent_brief_status` 加 `ready` / `unavailableReason`：`node --check` 通过、`_selftest/tests/subagent-brief.test.mjs` **34 项全过**（其中「返回值与 output schema 严格一致」的 key 集合已同步为新契约）；真实模块验证 `maxChars:800` → `ready:true`、`maxChars:0` → `ready:false` + 「不可用：配置阈值 maxChars=0 无效（…）实际按默认 1200 截断」、不配 → `ready:true`。

### v2（2026-10-30，agent/pre-step 机制）

**1. 结构合规**：`runSmoke("dsh-subagent-brief")` 通过（package.json / patch / locale 中英 / icon / 入口 export / apply 可挂载）。

**2. 行为测试：34 项全过**

```
node D:\AI\dsh-bundles\_selftest\tests\subagent-brief.test.mjs
→ subagent-brief: 34 项通过（退出码 0）
```

| 组 | 覆盖 |
|---|---|
| 纯函数（4 项） | 尾注/幂等判定、maxChars 归一化（含非法回落）、sourceKinds 归一化、cutAt 断行/CRLF/emoji |
| summarizeNotice（13 项） | 普通消息不动、短结算不动、阈值边界（等/超）、长结算截断+尾注、摘要/source 不回改、Structured result 与诊断块保留、非 text 块不动、多段正文按预算切、幂等、无标记放行、标记容错（无冒号）、畸形消息、isBodyPart 判定 |
| pre-step 端到端（10 项） | 正常用户消息不动、结算被截且其它消息原样、二次幂等、无 source 不动、其它来源不动、同一步多条都处理、reject 原样、payload 畸形不崩、payload 无 messages 回落 decision.messages、status 计数/记录/limit/lastSeen/主输出 |
| 配置（4 项） | maxChars+sourceKinds 覆盖、空 sourceKinds 全放行、enabled=false、非法 maxChars 回落 1200 |
| 空态（1 项） | 「还没有截断过 / 还没看到 pre-step」友好文案 |

**3. 真实数据口径（mock ctx 上跑真实插件代码，非估算）**

- 造一条 4019 字符的结算消息（摘要 + Its closing message: + 120 行正文），走真实 `apply()` + 假 `next()`：**4019 → 1277 字符**（正文截到 1200 内的行尾 + 尾注），摘要块与标记块原引用不变，`source` 原样；
- 同一条再喂一次：原样放行（幂等），`truncatedCount` 不增加；
- 带 `Structured result:` 与诊断块的长消息：正文被截，两个块**原引用不变、仍在原位**。

**4. 真机验证：已通过（2026-10-30 14:56，DSH 0.2.1-rc.5）**

重启加载 v2 后，让子 agent 在最终回复里写 2500+ 字长文（任务里明确不要摘要、不要写文件）：

| 观察点 | 实测 |
|---|---|
| `subagent_brief_status.sourceKinds` | `["subagent-settled"]`（v2 已加载） |
| `truncatedCount` / `charsSaved` | **1 / 4498** |
| `recent` | 14:56:16，`subagent-settled`，**5497 → 999 字符** |
| `lastSeen` | 7 条消息：6×`agent-message` + 1×`subagent-settled` |
| 主干实际收到 | 结算消息结尾出现「（已按摘要契约截断：原文 5359 字符，完整内容在子会话，需要细节请让子 agent 只报关键结论）」 |

结论：`agent/pre-step` 钩子名与 waterfall 形状与源码一致；截断只作用于结算消息的正文，子 agent 的 6 条中途消息原样保留（那是 `agent-message` 来源，不在拦截范围）。

### 若以后失效，怎么排查

先看 `subagent_brief_status` 的 `lastSeen`：能看到 `subagent-settled` 但 `truncatedCount` 不增，说明消息形状变了（标记文案或 source.kind 被官方改掉），按「已知边界」第 1 条修常量。

## 安装

```
"@local/dsh-subagent-brief": "link:D:/AI/dsh-bundles/dsh-subagent-brief"
```

加进 profile 的 `dependencies` 与 `dsh.profile.bundles`，`pnpm install` 建 Junction，重启 DSH。重载必须 `remove_bundle` + `install_bundle`（热替换不换 JS 模块代际）。

## 卸载

从 profile `package.json` 的 `dependencies` 和 `dsh.profile.bundles` 里删掉 `@local/dsh-subagent-brief`，`pnpm install`，重启。本插件不写任何磁盘数据、不联网、不改别人的文件。

## v1 的教训（为什么改拦截点）

v1 在 `tools/post-execute` 上截「工具返回的 content」。2026-10-30 真机实测：子 agent 写 3900 字报告，主干收到的结算消息**没有**尾注、`truncatedCount` 仍为 0。原因就是上面「拦截点在哪」的第 1 条：子会话结果根本不经过工具返回值。v1 因此被关掉，v2 按源码把拦截点挪到 `agent/pre-step`。

## 2026-11-02 升级记录

- 按 `_reports/plugin-falsepositive-scan-2026-11-01.md` 修：清单类交付放宽额度到 3000；幂等只认尾注形态，引用同款文案不再误判（#39 #40）。
