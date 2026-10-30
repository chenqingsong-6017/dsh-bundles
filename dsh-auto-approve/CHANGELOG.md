# CHANGELOG — dsh-auto-approve

## 0.1.1 — 2026-10-30

- 修复：干跑/诊断工具（`auto_approve_check` / `auto_approve_status`）自身也会被策略判断，导致无法用它调试危险规则；改为豁免，真实工具仍照拦，并补第 19 项测试。
- 真机验证：参数含危险命令的调用被插件拒绝（中文人话理由）；豁免后干跑可正常返回 deny 判定。

## 0.1.0 — 2026-10-30

- 首版：在 `tools/pre-execute` 上做确定性规则代审（allow / ask / deny + 5 条内置红线 + fail-safe 不干预），`auto_approve_check` 干跑、`auto_approve_status` 诊断。
