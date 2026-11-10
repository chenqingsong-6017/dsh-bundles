# dsh-skill-forge

学习循环的第二段：把「事实信号」变成「可复用技能」，带证据链、过 held-out 才入库。

## 为什么有它

dsh-harvest 负责第一段（会话 → 事实候选），它明确把「流程与坑」留给技能。这个插件补上那一段：

    会话轨迹 → [harvest] 事实候选（纠错/规则）
             → [skill-forge] 聚类 → skill 候选 → held-out 检查 → 人工/agent 复核 → SKILL.md

学完前沿后按本机约束做的「我们自己的版本」（不是照抄任何一家）：

- **EvoSkill**（arXiv 2603.02766）：失败分析驱动 skill 发现 —— 我们的「纠错信号聚类」是它的降级版。
- **HSE**（arXiv 2610.35616）：分层证据聚合（任务 → 项目 → 跨项目）—— 我们按 cwd 分项目聚类。
- **Voyager**（arXiv 2305.16291）：held-out 验证才保留 —— 我们的 verifyCandidate 是它的机器化。

## 我们的取舍（诚实清单）

1. **零 LLM**：插件只做确定性流水线（聚类/模板/检查）。语义蒸馏由 agent 复核时完成——agent 本身就是模型，不需要插件再调一次。
2. **只读 harvest 产出**：不重读原始会话。采集归 harvest，蒸馏归这里，职责边界清晰。
3. **只写候选，不自动入库**：skill_forge_admit 必须 confirm:true；过不了 held-out 检查的候选直接拒绝。
4. **证据链**：每条坑必须带 session/seq/time/quote，无证据不收（与 harvest 同规矩）。
5. **幂等**：候选按 id 去重，重复跑不产垃圾。
6. **入库写官方 skill 根**：<dshHome>/skills/<name>/SKILL.md（dsh-skill-filesystem 的 rank 400 user-dsh 根），frontmatter 的 metadata.status=draft，复核后才改 stable。

## 工具

| 工具 | 作用 |
| --- | --- |
| skill_forge_status | 就绪状态：harvest 候选数 / skill 候选数 / 待审 / 技能根。只读 |
| skill_forge_run | 主流程：读 harvest → 挑纠错/规则 → 按 cwd 聚类 → 蒸馏候选（可调 threshold） |
| skill_forge_candidates | 看待审候选（置信度 / 证据条数 / 状态） |
| skill_forge_verify | held-out 检查：证据是否带 session/quote、有无触发条件与步骤 |
| skill_forge_admit | 采纳入库：confirm:true 才写 SKILL.md；同名不覆盖除非 force:true |

## 数据

- 候选：D:/AI/dsh-data/skill-forge/candidates.jsonl（id / name / description / whenToUse / steps / pitfalls / evidence / confidence / status）
- 原料：D:/AI/dsh-data/harvest/candidates.jsonl（由 dsh-harvest 产出）
- 技能：C:/Users/cqs6017/.dsh/skills/<name>/SKILL.md

## 验收（真机，2026-11-10）

- 造 3 条纠错信号（同主题 2 条 + 1 条不同主题）→ skill_forge_run 产出 2 个候选，置信度分别 high/medium
- skill_forge_verify 对缺证据候选报 SFE_NO_EVIDENCE
- skill_forge_admit 不带 confirm 报 SFE_CONFIRM_REQUIRED；带 confirm 写出 SKILL.md，frontmatter status: draft
- 入库后 dsh-skill-filesystem 监视目录，无需重启即出现在目录中
- 单测：node D:/AI/dsh-bundles/_selftest/tests/skill-forge.test.mjs

## 与管理线的关系

- 第一段：dsh-harvest（会话 → 事实候选）
- 第二段：**本插件**（事实信号 → skill 候选 → 入库）
- 生命周期：dsh-skill-usage（技能用量 / 陈旧 / 归档建议）
- 长篇知识：dsh-obsidian（vault 卡）
- 事实记忆：dsh-memory（memory_add 复核采纳 harvest 候选）

## 版本

v0.1.0 —— 首个可用版本：聚类 + 候选 + held-out + 入库全链路。见 CHANGELOG.md。
