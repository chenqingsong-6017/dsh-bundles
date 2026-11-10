# CHANGELOG

## v0.1.0（2026-11-10）

- 首个可用版本：事实信号 → skill 候选 → held-out 检查 → 入库全链路。
- 借鉴 EvoSkill（失败分析聚类）/ HSE（按项目分层）/ Voyager（held-out），按 DSH 约束降级为零 LLM。
- 5 个工具：skill_forge_status / run / candidates / verify / admit。
- 入库写 <dshHome>/skills/<name>/SKILL.md（draft），证据链强制。
