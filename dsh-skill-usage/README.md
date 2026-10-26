# dsh-skill-usage —— 技能用量统计 + 陈旧标注

DSH bundle（Host 侧插件）：统计每个 skill 被加载了多少次、最后一次是什么时候，标出长期没用的技能供人工复核。

- **安装位置**：`D:\AI\dsh-bundles\dsh-skill-usage`（D 盘，不在任何工作区里，工作区删除/移动不影响它）
- **数据位置**：`D:\AI\dsh-data\skill-usage\usage.json`（bundle patch 里的 `storeDir`，不落 C 盘）
- **生效范围**：desktop profile 的 bundle 列表，**所有会话、所有工作目录**都生效（与 cwd 无关）

参考 Hermes Agent 的 Curator（用量驱动的技能生命周期），但按 DSH 的边界做了两处降级：**只统计与标注，从不删除、不改写任何 skill**；不往系统提示里注入内容（每步改 prompt 会破坏前缀缓存）。

## 工具

| 工具 | 作用 |
|---|---|
| `skill_usage` | 列出用量与状态。`filter` = `all`（默认）/ `used` / `unused` / `attention`（陈旧 + 可归档），`limit` 默认 40。输出面向人：状态写成【常用】/【从未用过】/【陈旧】/【建议归档】，不暴露内部枚举值 |
| `skill_usage_mark` | 标记"已复核"（可带 ≤200 字备注）。复核会给提醒续期，而不是永久压掉 |

## 状态机

锚点 = `max(lastUsedAt, reviewedAt)`；超过阈值没动就升级：

| 状态 | 含义 |
|---|---|
| `new` | 目录里有、从没被加载过（且首次登记未超阈值） |
| `active` | 最近用过（在 `staleAfterDays` 内） |
| `stale` | 超过 `staleAfterDays` 没动 |
| `archive-candidate` | 超过 `archiveAfterDays` 没动 |
| `unknown` | 一条记录的时间信息都拿不到（理论上不该出现） |

默认阈值 14 天 / 30 天，可在 batch 里改：

```yaml
- insert:
    - id: skill-usage
      name: '@local/dsh-skill-usage'
      config:
        staleAfterDays: 14
        archiveAfterDays: 30
        storeDir: 'D:\AI\dsh-data\skill-usage'   # 可选：数据落哪个盘
```

## 机制

1. **计数**：挂 `tools/result`（只读观察），工具名是 `skill` 且没有报错时，从参数里取技能名，`uses += 1`、`lastUsedAt = now`。参数键可能变，兜底会拿参数值去匹配已知技能名。
2. **目录**：`skills.list({ scope: agent })` —— 必须带 scope，否则只看得到全局层，漏掉 agent preset 自己那层的技能（本机实测：不带 scope 只有 8 个，带上后 12 个）。
3. **持久化**：`config.storeDir`（本机为 `D:\AI\dsh-data\skill-usage\usage.json`；未配置时默认 `~/.dsh/dsh-skill-usage/`），变更后 150ms 防抖原子写，卸载前 flush。
4. **不删除**：`skill_usage_mark` 只写 `reviewedAt` / `note`，永远不碰技能文件本身。

## 已知边界

- **`/name` 显式调用计不到**：那是 `agent/pre-step` 的注入路径，不经过 `skill` 工具（Hermes 也有同样分叉）；
- 只统计当前 profile + 当前工作目录视图里可见的技能；
- 不做系统提示注入：需要在会话里看用量时，让模型调 `skill_usage`；
- 不做自动归档：DSH 的技能目录是只读视图，删除应当由用户或另一个显式工具完成。

## 验证记录（2026-10-25，本机 desktop profile）

- 安装 → `application: applied`；工具 `skill_usage` / `skill_usage_mark` 出现在工具表
- 目录：修复 scope 后从 8 个技能变为 12 个（含 preset 层的 `cordis-*` / `agent-experience`）✅
- 计数：调用 `skill(name="agent-experience")` 后 `filter=used` 返回 `agent-experience · active · 用 1 次` ✅
- 标注：`skill_usage_mark` 写入备注；`filter=attention` 为空（刚复核，提醒已续期）✅
- **持久化 + 陈旧判定**：把 store 里该记录改成 40 天前使用、45 天前复核 → remove+install（等价重启）→ `filter=attention` 返回 `archive-candidate · 40 天未动 · 备注…` ✅
- 纯函数单测：`classifyUsage` 8 个用例全过（fresh / 20 天 / 35 天 / 从未用 2 天 / 从未用 45 天 / 刚复核 / 复核过期 / 无锚点）
- 测试数据已清理，`skill_usage` 复核为干净状态（12 个技能、全 `new`）

## 安装 / 卸载

```powershell
plugin_manager action=install_bundle target=D:\AI-date\dsh-date\dsh-创建\skill-usage
plugin_manager action=remove_bundle target=@local/dsh-skill-usage
```

改代码后需要 `remove_bundle` + `install_bundle` 才会加载新的模块代际。
