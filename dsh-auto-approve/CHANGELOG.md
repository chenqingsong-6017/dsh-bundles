# CHANGELOG — dsh-auto-approve

## 0.1.2 — 2026-11-02

- 修复（扫描 #1 #2 收尾）：两条凭据/`.ssh` 红线维持「写动词 + 目标」成对判定；补回归样本：`git log -- .credentials.yaml`、`echo 'see .credentials'`、`Select-String 'ssh|credentials'` 放行，`Set-Content` 写 `.ssh` 拒绝。
- 修复（扫描 #4）：用户规则未写 `fields` 时默认只看命令/路径字段，不再对整段参数 JSON 匹配；显式 `fields: ["content"]` / `["*"]` 才扩大范围（写文档正文提到规则关键词不再误命中）。
- 修复（扫描 #3）：规则文件 >64KB / 读失败整份忽略时，`lastError` + `status.errors` 可见（不静默 fail-open），补端到端断言。
- 备注：本片只跑单测（`node _selftest/tests/auto-approve.test.mjs`），未做真机工具调用。

## 0.1.1 — 2026-10-30

- 修复：干跑/诊断工具（`auto_approve_check` / `auto_approve_status`）自身也会被策略判断，导致无法用它调试危险规则；改为豁免，真实工具仍照拦，并补第 19 项测试。
- 真机验证：参数含危险命令的调用被插件拒绝（中文人话理由）；豁免后干跑可正常返回 deny 判定。

## 0.1.0 — 2026-10-30

- 首版：在 `tools/pre-execute` 上做确定性规则代审（allow / ask / deny + 5 条内置红线 + fail-safe 不干预），`auto_approve_check` 干跑、`auto_approve_status` 诊断。
