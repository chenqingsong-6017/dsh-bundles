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
| `skill_usage_status` | 只读诊断：数据目录**真的可写**（写探针文件再删）、`usage.json` 能否解析、账本条数与目录技能数、阈值与计数。`ready:false` 时给 `unavailableReason` + `code` |

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

## 验证记录（2026-11-01，统一契约：ready / unavailableReason / 错误 code）

| 项 | 结果 |
|---|---|
| `skill_usage_status` | 新增；`ready` 现算：数据目录写探针文件再删（Windows 上 `accessSync(W_OK)` 对目录太宽松，不用它）+ `usage.json` 可解析 |
| 错误 `code` | 2 处错误带 `SKILL_USAGE_ARG_MISSING` / `SKILL_USAGE_UNKNOWN_SKILL` |
| `node --check index.js` | 通过 |
| `node _selftest/tests/skill-usage.test.mjs` | 7 项通过，退出码 0 |
| 契约真机校验 | 可写目录 `ready:true`；存档坏 JSON → `SKILL_USAGE_STORE_UNREADABLE`；目录不可建 → `SKILL_USAGE_STORE_UNWRITABLE` |

## 2026-11-02 升级记录

- 按 `_reports/plugin-falsepositive-scan-2026-11-01.md` 修：firstSeenAt 不再冒充 lastUsedAt 进 stale 判定；技能名归一化后再匹配（#43 #44）。

## 2026-11-05 升级记录（体检接入：给淘汰机制装发条）

- 导出 `DEFAULT_THRESHOLDS`（14/30 天）：`_ops/metric-probes.mjs` 的探针直接 import 本模块的 `classifyUsage` 与阈值，不在体检里重写一份判定——否则会出现「体检说陈旧、插件说不陈旧」的双口径。
- 体检接入：`node _ops/system-health.mjs` 新增 L6 段（技能陈旧 ≥14 天 = warn；技能负资产 ≥30 天 = FAIL 且 exit 1），该脚本已被 `npm run check` 串进收工流程，等于把 Hermes Curator 的「后台定时器」换成本地「收工必跑的门」。
- 实测：正常路径 13 条账本全绿（13/6/7，陈旧 0、负资产 0）；造一份 46.6 天未用的假账本 → `[FAIL] L6 技能负资产` 且 `exit=1`，证明检查能失败。
- 行为等价：`apply` 仍读同样的默认值，只是常量换成导出对象；`node --check` 与 `skill-usage.test.mjs` 均通过。

## 2026-11-05 Curator 实装（对齐 Hermes 的自动归档）

**为什么做**：上一版只有账本与判据，没有任何东西会「自动推进」——账本自己不会响。Hermes 靠 gateway housekeeping 定时器自动标 stale / 归档；DSH 没有插件级定时器，就在插件内自己跑。

**怎么跑**：插件挂载时跑一次 + `setInterval` 每 6 小时一次（`unref`，不拖住宿主退出）；`skill_usage` 每次调用也顺手跑一次。不依赖外部计划任务，也不依赖模型记得来查。

**判据**（`decideCuration` 纯函数，已导出并单测）：

| 情况 | 动作 |
|---|---|
| 目录内（本次刷新看见）且 ≥30 天没动 | 归档，`archivedReason=unused-30d` |
| 上次在目录里见过、本次没见（技能已移出） | 归档，`archivedReason=not-in-catalog` |
| 目录名单不可信（`catalogAt` 缺失） | **不归档**（宁可漏，不误伤） |
| 已归档 / 未到 30 天 | 不动 |

**边界**：只写账本 `archivedAt/archivedReason`，**绝不碰技能文件**（目录是只读视图）。默认列表隐藏已归档，`skill_usage { filter: 'archived' }` 可查；`skill_usage_restore` 清标记并刷新复核时间（否则下一次 curator 会立刻再归档，restore 等于没做）。

**计数**：`uses`（工具加载）+ `patchCount`（mark 复核）。**view 不做**——DSH 没有技能详情页，把「出现在列表里」当 view 会污染数据，宁可空着也不造假数。

**与 Hermes 对照**：阈值 14/30、自动运行、自动推进、不删除可恢复、只动自己的数据——五项对齐；差一项：Hermes 能归档**技能文件**，我们只能归档**账本条目**（技能目录只读，这是 DSH 的能力边界，不是偷懒）。

**验证**：`skill-usage.test.mjs` 20 项（新增 5 条纯函数判据 + 端到端自动归档/filter=archived/restore）；真机 `skill_usage` 输出「已归档 0」，13 条无异常归档。
