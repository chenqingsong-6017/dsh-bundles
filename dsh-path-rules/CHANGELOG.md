# CHANGELOG — dsh-path-rules

## 1.0.1 — 2026-11-01

- **统一状态契约**：`path_rules_status` 新增 `ready` / `unavailableReason`（两者都进 `required`，`unavailableReason` 为空串表示可用）。`ready` 是真判断——至少一个规则目录 `readdirSync` 成功（`exists` 字段即「读得动」）。`ready:false` 时渲染只输出「不可用：<原因>」。
- 该工具没有其它错误返回路径，因此本轮没有新增错误码；返回字段与 schema 仍严格一一对应（测试第 364–365 行的断言保持有效）。

## 1.0.0 — 2026-10-30

- 三层优先级：用户级 < 项目级 < 路径命中；同 `id` 时更近/更具体的层覆盖更远的层。
- `always: true` 核心层（预算 `maxAlwaysChars` 默认 2000，每轮注入）+ 路径命中层（`maxChars` 默认 3000，保留 v1 配置名）。
- 注入文本标明来源层级；`path_rules_status` 保留 v1 四个字段并新增 `layers` / `activeRules` / `alwaysBudget` / `pathBudget`。
- 向后兼容：老规则文件不改也照旧工作；25 项测试通过（v1 原有 10 项断言全部保留）。

## 0.1.0 — 2026-10-29

- 首版：frontmatter `paths:` glob 命中后注入规则正文。
