# dsh-skill-forge

把「刚做完的事」锻造成可复用的技能（`SKILL.md`），并**原生注册进 DSH 的技能目录**。

学自 Hermes Agent 的三样长处：

| Hermes | 本插件 |
|---|---|
| `/learn`：材料 → 技能 | `skill_forge` 工具：结构化草稿 → 校验 → 落盘 → 注册 |
| 硬性写作标准（描述 ≤60 字符等） | `validateDraft()` 内置同样的规矩，不合格直接拒写并说明理由 |
| Curator：用量驱动归档 | `skill_forge_retire` 归档（移动不删除，可人工恢复） |

刻意**不学**的一样：Hermes 有后台自动沉淀；DSH 插件不该偷偷调模型改自己（`dsh-updater` 的
`evolve` 已实测后砍掉），所以这里只做「agent 起草 → 插件校验落盘」。

## 与官方技能同等待遇

用官方的 `ctx.skills.registerProvider()` 注册 provider，因此锻造出的技能会：

- 出现在系统提示的技能索引里（模型可主动调用）；
- 可被内置 `skill` 工具加载；
- 可被用户 `/技能名` 直接调用；
- `dsh-skill-usage` 的用量统计同样覆盖。

rank 取 700（高于官方 bundled 的 600），同名时自造技能优先。

## 两条硬规矩及理由

1. **description ≤ 60 字符、一句话、以句号结尾** —— 技能索引每轮都进系统提示，超出部分被截断，
   等于白写。
2. **body 必须含「## 何时用 / ## 步骤 / ## 验证」** —— 没有验证方式的技能不可信，
   下次照做时无法判断是否成功。

## 存储与归档

```
D:\AI\dsh-data\skills\
  ├─ windows\nvidia-driver-upgrade\SKILL.md
  ├─ dev\某技能\SKILL.md
  └─ _archive\旧技能-2026-10-29T00-30-00\SKILL.md
```

- 布局：`<category>/<name>/SKILL.md`，`category` 缺省 `misc`；
- `skill_forge` 带 `overwrite: true` 覆盖时，旧版先归档；
- `_archive` 目录不参与技能收集，也不被扫描。

## 工具

| 工具 | 用途 |
|---|---|
| `skill_forge` | 锻造/覆盖技能（name, description, body, category?, overwrite?） |
| `skill_forge_search` | 关键词检索自造技能（名字权重 3、描述 2、正文 1） |
| `skill_forge_retire` | 归档技能，使其退出技能目录 |

## 已知边界

- 技能目录由 DSH 收集器缓存，刚锻造的技能可能要等下一次收集才进提示；`skill_forge_search`
  立即可查。
- 不做语义检索（技能体量小，关键词够用）。真需要时另做 `dsh-rag`。
- 不自动清理长期未用的技能；配合 `dsh-skill-usage` 的 stale/archive-candidate 提示人工归档。

## 验证记录

见同目录 `SELFTEST.md`。
