# CHANGELOG — dsh-path-rules

## 1.1.0 — 2026-11-12

- **常驻预算按工作区覆盖**：新增 `maxAlwaysCharsByWorkspace`（配置在 `cordis.patch.yml`）——本开发工作区 3000、其余工作区仍 2000；键按绝对路径归一（正/反斜杠、尾斜杠、大小写都命中），未命中回默认。
- **诊断与行为一致**：`path_rules_status` 的 `alwaysBudget.maxChars` / `maxAlwaysChars` 报「当前会话 cwd 的生效值」，不再只报基准 2000（否则配置生效了状态还报旧值，属「诊断是假证据」）。
- 依据 `_research/decisions/0003-fast-gate-and-workspace-budget.md`；`_selftest/tests/path-rules.test.mjs` 补 6 条断言（命中 / 未命中 / 归一 / 默认）。

## 1.0.2 — 2026-11-02

- **Windows 大小写不敏感匹配**：`ruleMatches` 归一化为小写后再匹配——`paths: "D:/AI/Dsh-Bundles/**"` 与实际路径 `D:/AI/dsh-bundles/...` 能命中，路径规则不再靠大小写运气（误报扫描 #16）。
- **cwd 外绝对路径命中**：绝对路径不再先 `path.relative(cwd, …)` 变成 `../../x` 再匹配，跨目录操作时规则照常激活（#17）。
- **被跳过的规则不再静默**：`always` 认不出的布尔值、以及 >32KB / stat 失败 / 读失败的规则文件进 `path_rules_status.warnings`（#18 #19）。
- 依据 `_reports/plugin-falsepositive-scan-2026-11-01.md`；`_selftest/tests/path-rules.test.mjs` 补 53 行回归（先红后绿）。

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
