# dsh-research

> 把「调研方法」做成**工具边界**的工作台：决策问题不具体开不了任务；结论没有落点进不了证据表；文件引用真的去查；缺证据不让出报告。

## 为什么需要它

工作区规矩（`.dsh/rules/research.md`）早就写了五条：先写清决策问题、证伪优先、每条结论回到一行证据、回不去的标推断、出处分层。
但**靠人记就会漏**：已经出现过「先找资料后想问题」「把搜索摘要当证据」。这个插件不替你判断对错，只机械地卡住三件事：

| 规矩 | 怎么落地成边界 |
|---|---|
| 先写清「这条结论要决定什么」 | `research_new` 的 `decision` 少于 8 字直接拒 |
| 每条结论能回到一行证据 | `research_evidence` 必须给 `https://…` 或 `文件:行`；确实没取证就 `inferred:true`，会被归到「未验证」 |
| 文件引用可核对 | `文件:行` 会真的查文件在不在、行号在不在范围内，断了就报 |
| 搜索摘要不是一级证据 | `tier=search` 的置信度被强制压到 `medium` 及以下 |
| 不能带着空洞结论出报告 | `research_report` 在存在无落点结论时拒绝，除非显式 `allowIncomplete:true` |

## 工具

| 工具 | 作用 |
|---|---|
| `research_new` | 开任务：question + decision（+ slug/tags）。decision 含糊直接拒 |
| `research_evidence` | 记一条结论 + 落点：`claim` / `tier` / `ref` / `quote` / `confidence` / `inferred` |
| `research_check` | 机械体检：无落点几条、断引用几条、推断几条、能否收尾 |
| `research_report` | 出 Markdown 结论文档（证据表 + 未验证区），原子写；可 `close` 收尾 |
| `research_status` | 存储健康度：任务数 / 开放数 / 证据数 / 各层级分布 / 最近错误；带 `ready` / `unavailableReason`（`store.json` 读不动时渲染「不可用：<原因>」） |

`tier` 取值（与 `docs.md` 出处分层一致）：`paper`（论文）/ `official`（官方文档或博客）/ `source`（源码）/ `readme`（插件 README）/ `search`（搜索摘要）。

## 数据布局

```
D:\AI\dsh-data\research\
└── store.json          # 版本化 JSON：{version, tasks:[{id, question, decision, tags, status, evidence[]}]}
```

报告默认写到 `<workspace>\_research\research-<id>.md`；用 `outPath` 可指定别处（例如 vault 的 `30-Build/33-Research/`）。

## 配置（cordis.patch.yml 或 profile 层）

```yaml
config:
  storeDir: D:\AI\dsh-data\research
  outDir: D:\AI-date\dsh-date\dsh-创建\_research
  workspaceDir: D:\AI-date\dsh-date\dsh-创建   # 相对文件引用的解析根（默认 cwd）
```

## 典型流程

1. `research_new({question, decision})` —— 先想清楚要决定什么。
2. 取证：`research_evidence` 逐条记，`ref` 写 url 或 `文件:行`；没证据的先标 `inferred:true`。
3. `research_check` —— 看还缺什么，补完再往下。
4. `research_report({close:true})` —— 出 md，结论 + 未验证两段分开。

## 验证记录

| 项 | 结果 |
|---|---|
| `node --check index.js` | 通过 |
| 单测 `_selftest/tests/research.test.mjs` | 见验证门输出（纯函数 + 临时 store + 5 工具真调用 + fail-safe） |
| 真机 | 见下方「真机验收」 |
| 统一契约（v0.1.2，2026-11-01） | `research_status` 加 `ready`/`unavailableReason`（store 可读+结构对才 true）；所有 `ok:false` 返回带 `code`。实测：store 正常 → `ready:true`；store 不存在 → `ready:false` + 「不可用：store.json 不存在（…）：先跑一次 research_new」；store 坏 JSON → 见「读不了：…」 ✅ |

## 已知边界（诚实清单）

- **不联网**：`url` 只校验格式，不通就核不到内容；「链接未核对」会在返回值与报告里说明。
- **不判断结论对错**：只检查「有没有落点、落点能不能核」，逻辑对不对仍由人/agent 负责。
- **文件引用按 `workspaceDir`（默认 cwd）解析**：跨工作区引用要给绝对路径。
- **没有任务删除/合并**：`status: closed` 只做收尾，历史保留在 store（可手工编辑）。

