# CHANGELOG — dsh-subagent-brief

## 0.2.0 — 2026-10-30

- **破坏性改动**：拦截点从 `tools/post-execute` 改为 `agent/pre-step`——v1 经真机验证为空转（DSH 的 subagent 结果走会话消息，不经过工具返回值）。
- 只处理 `source.kind = 'subagent-settled'` 的结算消息；以 `Its closing message:` 为界只截正文，保留结算摘要 / `Structured result:` / 诊断块；幂等。
- 配置项 `tools` 改为 `sourceKinds`；`subagent_brief_status` 新增 `lastSeen`（消息数 + 各条来源）。
- 真机验证：5497 → 999 字符，`truncatedCount = 1`；同一步 6 条 `agent-message` 原样保留。

## 0.1.0 — 2026-10-30

- 首版（v1，空转）：在 `tools/post-execute` 上截「工具返回的 content」。
