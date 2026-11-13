# dsh-archived-purge

**DSH 归档会话清理：自动搬进隔离区（可还原），到期再永久删；也能全选手动删。**

[中文](#中文) · [English](#english)

DSH 自带的「归档」只是把会话从侧边栏隐藏，磁盘上的日志、投影缓存、工作区记账都还在，而且没有批量删除入口。这个插件在 **设置 → 归档清理** 里补上一页：按工作区分组列出全部归档会话，支持全选 / 逐条勾选，一次永久删除选中的会话及其本地存储。**v2.0 起还会自己按节拍跑**：久未活动的归档会话先被**搬进隔离区**（日志、投影缓存、产出的文件都在，随时可还原），过了保留期才连同工作区记账与归档标记一起永久删除 —— 自动但不粗暴。

## 功能

- **一眼看清**：顶部汇总归档会话数、占用空间、运行中数量与已选体积；按工作区分组显示标题、体积、最后活动时间与定时任务数量。
- **全选 / 分组 / 多选**：顶部全选，组头「全选本组」，逐行勾选，实时显示已选条数与总体积。
- **一次删干净**：确认弹窗默认勾选「彻底清理」，由 Host 从仍然可读的日志推导出整批可删资料
  - 会话日志目录 `<DSH_HOME>/sessions/--<cwd>--/<session-id>/`
  - 投影缓存行 `<DSH_HOME>/storages/session_projcache/sessions/<session-id>.json`
  - 工作区记账（公开 API `Workspace.detachSession`）
  - 全局归档集合（`workspaceRegistry.unarchiveSession`）
  - 该批会话 `write` / `edit` / `present` 写出的工作区文件（可展开逐项取消）
  - 删完这批后没有任何日志引用的附件对象
  - 指向这些会话的定时任务（目标已不存在，永远不可能再投递）
- **子代理级联**：仅删除 `origin: 'subagent'` 且挂在被删会话下的子会话日志；普通 fork 出来的会话不受影响。
- **可重建缓存单独开关**：`cache/attachments/request-images/` 默认不动，需要时勾选清空。
- **孤儿附件单独入口**：不删会话也能点「清理孤儿附件」，先 dry-run 报数字，再确认执行。
- **历史残留扫描**：每次删除都会在 `<DSH_HOME>/archived-purge-manifest.json` 记下该会话产出过的文件；之后点「扫描历史残留」一次性列出
  - 已删除会话产出的、仍在磁盘上的文件（**大小与 mtime 对不上就标记「已被改动」并跳过**）；
  - 残留日志目录（记账里已经没有、也读不出来的会话目录）；
  - 残留投影缓存行、失效的工作区记账、失效的归档标记；
  - 无人引用的附件与请求图缓存；
  
  逐类勾选后一次永久删除，已经不存在的东西不会重复列出。
- **安全护栏**：仍在运行工作的会话拒绝删除（按 `workspace/session-activity` 判定，不是「在内存里就算运行中」）；`sessionId` 白名单正则；删除路径必须落在 `sessions/` 与投影缓存根内；POST 校验同源；删除前二次确认并显示条数与体积。
- **失败可读**：被拒绝或失败时逐条列出会话与原因，不再只弹一句 `HTTP 400`。

## 安装

```sh
dsh plugin --profile desktop add github:5D-artist/dsh-archived-purge
```

Desktop 也可以在 **设置 → 插件 → 添加插件** 里填仓库地址：

```
https://github.com/5D-artist/dsh-archived-purge
```

装好后刷新页面（Host 端通常已热加载，浏览器端 bundle 需要重新加载）。

## 使用

1. 打开 **设置 → 归档清理**。
2. 点「全选」，或用组头「全选本组」、逐条勾选。
3. 点「删除所选」→ 确认弹窗里默认已勾选整批资料（可按需取消某一类或某个文件）→ 确认。

删除不可撤销，列表不会自动清理任何东西 —— 只有确认后的选中项才会被删。

## 自动清理（v2.0）

插件挂载后延迟 90 秒跑第一轮，之后每 6 小时一轮（官方 `ctx.interval`，随插件卸载自动清理；服务不可用时退回 unref 的 `setTimeout`，不拖住宿主退出）。**只对「归档了、且久未活动」的会话动手**，分两步：

1. **搬进隔离区**：归档 + 超过 `graceDays`（默认 30 天）没有新活动 + 当前没有任何工作在跑（`workspace/session-activity` 判定）+ 没有指向它的定时任务 → 把会话日志目录、投影缓存行、该会话写出的工作区文件**原样 rename 进隔离区**（同盘 rename，原子且瞬时）。归档标记与工作区记账**此时不动**：归档会话本来就隐藏，留着零副作用，还原才完整。
2. **到期永久删**：隔离满 `retainDays`（默认 7 天）后，删隔离区里的文件，再通过公开 API `detachSession` + `unarchiveSession` 清掉记账与标记（会话仍驻留内存时延后到下次启动，与手动删除同一规则）。

**为什么不是直接删**：删会话不可逆，而自动化的风险恰恰在「没人看着」。隔离区把「自动」与「不可逆」隔开 7 天——这 7 天里 `POST /auto/restore` 一条命令就搬回原位。

配置是文件，不是代码：`<DSH_HOME>/storages/archived-purge/config.json`（首次运行自动写入默认值）

```json
{
  "schema": 1,
  "enabled": true,
  "intervalHours": 6,
  "startupDelaySeconds": 90,
  "graceDays": 30,
  "retainDays": 7,
  "maxPerRun": 20,
  "maxBytesPerRun": 2147483648,
  "minArchiveAgeMinutes": 30,
  "skipWithSchedules": true,
  "purgeOnExpiry": true,
  "notify": true
}
```

`enabled: false` 立刻停自动；`purgeOnExpiry: false` 只隔离不清除（held 条目一直留着，等 `auto/purge-expired` 或改回 true）。改完不用重启，下一轮重新读文件。

### 取经结论与两处偏差（2026-11-13）

先查证再动手：官方**没有**会话清理/保留能力（可选 bundle 15 项无此类；`session-persistence` 与 `projection-cache` 的官方文档都写明「不删除、无清理接口、属带外维护」），所以自研成立。取了两条权威做法（Hermes Agent：生命周期只到归档、极少删除；claude-mem：永久删前重查活动、非法保留值 fail-safe 到更长），落地成本插件这边的三处：到期清除前**重问 `session-activity`**（活跃就顺延）、**取消归档等于「我要它」→ 自动还原 held 条目**、`purgeOnExpiry` 开关。

**偏差记录（按「标准优先」留档）**：

| 项 | 官方/权威说法 | 我们怎么做 | 为什么 + 回滚 |
|---|---|---|---|
| 节拍通道 | 插件 `ctx.interval`（base 层 `timer` 服务，随 fiber 释放） | 同官方，但 `inject` 里**必须加 `timer`**——不加会在加载时报 `cannot get property "timer" without inject`（2026-11-13 真机踩到，`fiberPhase: failed`） | 官方通道优先；`lib/auto.js` 仍留 unref `setTimeout` 兜底，退化为它只需删 `inject` 里的 `timer` 与 index.js 的 `interval` 适配 |
| 永久删默认值 | 权威共识是「默认只隔离，永久删显式 opt-in」（Hermes 干脆不删） | `purgeOnExpiry` **默认 true**（全自动清） | 陛下本轮明示「全自动删，但先进隔离区保留 N 天可还原」——隔离期即 opt-in 窗口；要更保守改 `false` 即停永久段 |
| 记忆联动 | claude-mem 有「清理不级联删记忆」 | 本插件**完全不碰记忆库**，审计只写 `purge-log.jsonl` | 陛下原话「我有日志，记忆多了不好」；也是「一条事实一个权威源」的落地 |

审计只写本地日志，**不写记忆库**：每轮决策追加一行到 `<DSH_HOME>/storages/archived-purge/purge-log.jsonl`（何时、隔离/清除了谁、跳过原因分布、错误），隔离条目自带 `manifest.json`（原路径清单、字节数、到期时间），还原靠它。

```sh
# 先看一轮会做什么（默认 dry-run，不动文件）
curl -X POST http://127.0.0.1:<port>/plugins/archived-purge/auto/run -H 'content-type: application/json' -d '{}'
# 真跑一轮（apply: true）
curl -X POST http://127.0.0.1:<port>/plugins/archived-purge/auto/run -H 'content-type: application/json' -d '{"apply":true}'
# 看一眼状态：配置、上一轮结果、隔离区清单、下次运行时间
curl http://127.0.0.1:<port>/plugins/archived-purge/auto
# 还原一条
curl -X POST http://127.0.0.1:<port>/plugins/archived-purge/auto/restore -H 'content-type: application/json' -d '{"entryId":"20261113T040506.000Z-session-xxxx"}'
```

（端口每次启动都变，以桌面快捷方式实际打开的 Web 地址为准。）

### 页面上长什么样

自动清理不藏在命令行里：**设置 → 归档清理** 的列表上方有一张卡片——

- 一行状态：`自动清理 · 开着` ＋ 节拍摘要（每 6 小时 / 归档 30 天未动才隔离 / 隔离保留 7 天）；
- 上次运行与下次约时间；没跑过就写「还没跑过第一轮」；
- 隔离区：条数、占用、最早几天后永久清除；每条带标题、体积与「还原」按钮（点了就把文件搬回原位，目标被占用则不覆盖）；
- 「立即检查」：只预演一轮，回一句「本轮会隔离 N 条，其余 M 条暂不动」，**永远不动文件**（真搬要交给节拍或工具 + confirm）。

结构上这一页也是重构过的：状态拆进 `useArchiveData` / `useSelection` / `useScanFlow` / `useDeepScope` / `useDeleteRun` / `useGcFlow` / `useLeftoverFlow` / `useAutoSweep` 这些 hook，界面拆成 `PanelHeader` / `Toolbar` / `AutoCard` / `ArchiveList` / `LeftoverPanel` / `ScopeBlock` / `ConfirmDialog` 等小组件；重构前那个 1096 行的大函数没了，文件从 1126 行降到 1066 行，冻结基线随之收紧。

### 对话里直接问（三个工具）

不想敲 curl 也行，插件向 Host 注册了三个模型工具，说一句人话就能用：

| 工具 | 用法 | 返回的第一行 |
|---|---|---|
| `archived_purge_status` | 「自动清理现在怎么样」 | `自动清理开着：每 6 小时一轮，归档 30 天未动才隔离，隔离保留 7 天后清除`，随后是上次/下次时间、隔离区清单（含 `entryId` 与剩余天数）、以及一轮预演：现在会隔离谁、其余为什么不动（`还在内存里` / `还没到宽限期` / `有定时任务` / `正在跑` …） |
| `archived_purge_restore` | 把某条隔离会话搬回来 | 传 `entryId`（从 status 拿）；目标路径若已被占用则逐项跳过并说明，绝不覆盖 |
| `archived_purge_run` | 立刻跑一轮 | **默认预演**；只有 `confirm: true` 才真搬文件——和节拍走同一份 `runOnce`，判据只有一份 |

工具输出按 `plugin-ux.md`：第一行是结论，计数与内部字段留在 payload 里；失败给三行式原因＋下一步。

## 删除范围

| 项目 | 是否删除 | 说明 |
|---|---|---|
| 会话日志目录 | ✅ | `session.vN.jsonl*` 整个会话目录 |
| 投影缓存行 | ✅ | 单会话 JSON，删除后按需重建 |
| 工作区记账 | ✅ | 走 `Workspace.detachSession`，不手改 `workspace.json` |
| 归档集合 | ✅ | 走 `unarchiveSession`，不手改注册表 |
| subagent 子会话日志 | ✅ | 仅 `origin: 'subagent'` 的后代 |
| 附件（`attachments/v1/objects/`） | ✅ 默认 | 只在没有其它日志引用时删除；先读日志收集引用，再删 |
| 该批会话写出的工作区文件 | ✅ 默认（可逐项取消） | 只列 `write` / `edit` / `present` 的路径，且必须位于会话 cwd 内 |
| 指向已删会话的定时任务 | ✅ 默认 | 通过公开 `ctx.schedule` 服务删除；目标不存在，任务不可能再触发 |
| 自动清理的隔离区（`storages/archived-purge/quarantine/`） | 🕒 暂存后删 | 自动路径先把文件搬进这里（同盘 rename），`retainDays` 内可 `restore` 还原，到期才永久删除 |
| 有定时任务的归档会话（自动路径） | ⏭️ 跳过 | 定时任务可能就是要它活着，自动模式不替人做这个决定（`skipWithSchedules`） |
| 请求图缩放缓存（`cache/attachments/request-images/`） | ⚙️ 可选 | 派生文件，可重建，默认不清 |
| 已删除会话的产出文件（历史残留） | ⚙️ 手动勾选 | 来自删除时写入的 manifest；大小/mtime 变过的不动 |
| 残留日志目录 / 投影缓存行 / 记账 / 归档标记 | ⚙️ 可选 | 「扫描历史残留」里逐类确认 |
| 其它工作区文件（脚本产出的视频等） | ❌ | 日志里没有可信的「谁产出的」记录 |
| fork 出来的普通会话 | ❌ | 只按 subagent 血缘级联 |

### 引用感知的附件清理怎么做

- DSH 的附件存储是**内容寻址且不可变**的，`dsh-attachment` 的文档写明：恢复或 fork 出来的会话可能共享同一批对象，因此 **reference-aware GC 被明确推迟，不绑定任何单个会话的删除**；上游现状是「附件永不删除」。
- 会话日志里只存 `{"type":"image","attachment":{"attachmentId":"sha256:…"}}` 这类引用，**没有「谁创建了它」的字段**，所以本插件按「先读后删」实现：先读完所有剩余日志收集摘要，再删对象；删单个会话时，它独占的对象自然变成孤儿，一次清扫即可。
- 三条安全规则：**读不全就不删**（任一日志读取失败即整次取消）、**10 分钟宽限期**（新对象可能还没写进日志）、**只删对象与派生缓存**，绝不碰日志之外的索引文件。
- 工作区文件同理：日志只记录 `write` / `edit` / `present` 的目标路径，脚本（pwsh/ffmpeg 等）产出的文件没有归属记录，插件不会靠时间戳猜；能被证明的才列出，默认全选但可逐项取消。
- 定时任务只删「投递目标就是这些会话」的行；只是在 `involvedSessionIds` 里提到过该会话的任务不动，避免误删仍然有效的提醒。

## 安全设计

- **运行中拒绝，但「在内存里」不等于运行中**：归档只是把会话从侧边栏隐藏，并不会销毁它 —— 最近用过的归档会话仍然驻留在 `ctx.sessions` 里。旧版把「存在」当成「运行中」，于是任何还热着的归档会话都删不掉，页面只显示 `部分删除失败: 0 / 4 · HTTP 400`。现在改为询问 Host 的 `workspace/session-activity` 瀑布（Agent 的 `turn`、任务注册表、子代理运行时、定时任务都会在这里应答，`archiveSession` 用的是同一道闸），只有真的有活要干时才拒绝，并说明是哪一类工作。
- **整批前置检查**：删除前先一次性检查这一批（含 subagent 后代），只要有一个还在跑就整批不动，不会出现「一半删了、一半留着」的残局。
- **驻留会话的记账延后回收**：文件可以立刻删（磁盘马上回收），但**不能**在会话还驻留内存时把它从工作区记账里摘掉 —— 那样它仍会被 `sessions.list()` 列出来，只是失去归属，于是掉进侧边栏的「未分组」。所以驻留目标的记账与归档标记会保留到**下次启动**（此时进程不再持有该会话），由 `finalizePending()` 收尾；页面在此期间只显示一行「另有 N 个已删除会话的记账将在下次启动时自动回收」。
- **附件 GC 的安全边界**：只删 `attachments/v1/objects/` 下没有任何日志引用的对象；任一日志读不出来就整次放弃；10 分钟内的新对象一律保留；`request-images` 只清派生缓存。
- **工作区文件的安全边界**：路径必须由 Host 自己扫描得出（浏览器传什么都要重新核对），必须是该批会话日志里 `write` / `edit` / `present` 的目标，必须位于会话 cwd 内，且**永不在 `DSH_HOME`、插件自身目录、`.git` / `node_modules` 内**；默认全选，但确认弹窗可展开逐项取消。
- **「彻底清理」不信任浏览器**：页面只发送 `everything: true`；具体删哪些文件、哪些附件、哪些任务全部由 Host 在删除前重新推导，浏览器只能缩小范围（改发显式 `files` 列表），不能扩大。
- **入口校验**：`sessionId` 必须匹配 `^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$`；请求必须同源、`application/json`、体大小受限。
- **路径边界**：待删路径必须 `path.relative` 落在 `sessions/` 或投影缓存根内。
- **不重写注册表**：归档集合与工作区记账都通过公开 service 方法修改，避免与运行中的注册表写入竞争。
- **自动路径先搬后删**：自动清理不做「删了就没了」的事 —— 第一轮只把材料 `rename` 进同盘隔离区（`EXDEV` 才退回复制+删源），manifest 在任何一次移动之前就写好，中途崩溃也能按清单还原；记账与归档标记留到隔离到期，所以「还原」是把完整的一条救回来，不是半条。
- **自动路径的多重拒绝**：年龄证不出来（日志里读不到活动时间）→ 跳过并记 `unknown-age`；宿主不提供 `workspace/session-activity` → 整轮跳过记 `activity-unknown`，不猜；有定时任务 → 跳过；单轮条数（`maxPerRun`）与字节（`maxBytesPerRun`）都是硬预算，超了断在下一条而不是删一半。
- **自动路径没有旁路**：`POST /auto/run` 默认 dry-run，只有显式 `apply: true` 才动文件；真实节拍走的也是同一个 `runOnce`，两条入口的判据只此一份。

## 兼容性

- 实测：**DSH 0.2.1-rc.5**（Desktop，Windows）。
- 需要 Host 服务：`webServer`、`workspaceRegistry`、`sessions`、`sessionPersistence`；`schedule` 为可选服务（没有装 Schedule 插件时只是不清理定时任务）。
- 存储布局：0.2.x 的 v4 会话日志、`workspace.json` schema v2、`session_projcache` 单记录文件、`attachments/v1/objects` 内容寻址对象。
- 仅 Web 客户端（`dsh.client.platform = web`）。

## Host 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/plugins/archived-purge/state` | 归档列表（标题、工作区、体积、最后活动、`active` / `activity` / `resident`，以及 `scheduleCount`） |
| POST | `/plugins/archived-purge/delete` | `{ "sessionIds": [...], "everything": true, "files": [...], "attachments": true, "requestImages": true }`；`everything` 由 Host 推导整批资料，`files` 只能缩小范围。请求本身合法时恒返回 200，`ok` / `code` / `message` / `results` / `artifacts` / `schedules` / `gc` 描述结果 |
| POST | `/plugins/archived-purge/scan` | `{ "sessionIds": [...] }` 只读预演：删掉这批会释放多少附件、请求图缓存多大、写出的工作区文件清单、指向它们的定时任务 |
| POST | `/plugins/archived-purge/gc` | `{ "dryRun": true, "requestImages": false }` 孤儿附件清扫；`dryRun: false` 才真删 |
| POST | `/plugins/archived-purge/leftovers` | 只读扫描历史残留：manifest 里的产出文件、残留日志目录/缓存行/记账/归档标记，以及孤儿附件 |
| POST | `/plugins/archived-purge/purge-leftovers` | `{ "files": [...], "logs": true, "caches": true, "accounting": true, "archived": true, "attachments": true, "requestImages": true }` |
| POST | `/plugins/archived-purge/client-error` | 客户端挂载失败上报，写入 `<DSH_HOME>/archived-purge-client-errors.log` |
| GET | `/plugins/archived-purge/auto` | 自动清理状态：`config` / `enabled` / `lastRunAt` / `lastResult` / `nextRunAt` / `held`（隔离区清单，含 `expiresInMs`、`restorePath`）/ `heldBytes` / `broken` |
| POST | `/plugins/archived-purge/auto/run` | `{ "apply": true }` 才真跑；缺省或 `false` 为 dry-run，返回与真跑同一份决策（`scanned` 本轮查看了几条 / `held` / `purged` / `reconciled` / `skipped` 原因分布 / `errors`） |
| POST | `/plugins/archived-purge/auto/restore` | `{ "entryId": "..." }` 把一条隔离条目的文件搬回原路径；目标已存在则跳过并列原因，条目保留 |
| POST | `/plugins/archived-purge/auto/purge-expired` | 只跑到期清理，不等下一轮节拍；未到期的隔离条目不动 |

删除接口的状态码约定：`400` 只用于请求体不是合法 JSON，`403` 只用于跨源，`405` / `415` 用于方法与 Content-Type；「没删成」属于业务结果，用 200 + `ok: false` + `message` 表达，页面据此逐条列出原因。

## 更新日志

### 2.2.0

- **设置页能看到自动清理了**：列表上方新增自动清理卡片——开关状态与节拍、上次/下次运行、隔离区清单（标题、体积、剩余天数）、每条「还原」按钮、「立即检查」只预演不动文件。欠账 #13 清账。
- **客户端重构**：把 1096 行的 `createPanel` 拆成 8 个数据/动作 hook 与 20 个纯展示组件（每个函数都在一屏内），`client.js` 1126 → 1066 行；结构与质量基线随之**收紧**（最大函数 1096 → 1030 即模块工厂本体、圈复杂度 91 → 21、嵌套 5 → 2）。客户端模块图是扁平的（`dsh-client-modules`：一个 bundle 一个节点，边只指向平台共享表），所以只能在单文件内拆函数，不能拆文件——这条写进了文件头注释，免得下次又试。
- **测试**：客户端 harness 补上函数组件展开（无 reconciler 时按 React 方式就地渲染），新增自动卡片用例（状态渲染、还原请求、检查请求不带 apply）；插件测试 74 → **75**。

## 更新日志

### 2.0.0

- **自动清理（默认开启）**：挂载后延迟 90 秒首跑、之后每 6 小时一轮；命中「归档 + 超过 30 天无活动 + 无工作 + 无定时任务」的会话先**搬进隔离区**，保留 7 天后才永久删除并清记账。节拍、宽限、保留期、单轮条数/字节、是否通知全部在 `<DSH_HOME>/storages/archived-purge/config.json`，`enabled: false` 即刻停。
- **可还原**：隔离条目自带 `manifest.json`（每个原路径、字节数、到期时间），`auto/restore` 一条命令搬回原位；目标已被占用时跳过并列原因，绝不覆盖。
- **自动但可观察**：新增 `GET /auto`、`POST /auto/run`（默认 dry-run）、`POST /auto/restore`、`POST /auto/purge-expired`；每轮决策追加一行到 `storages/archived-purge/purge-log.jsonl`，不写记忆库。
- **安全边界**：年龄证不出 → 跳过；宿主无 `session-activity` → 整轮跳过；有定时任务 → 跳过；驻留会话只搬文件、记账留到下次启动；`maxPerRun` / `maxBytesPerRun` 是硬预算。
- **结构**：HTTP 路由抽到 `lib/routes.js`，入口 `index.js` 从 1540 行降到 1360 行（冻结基线只减不增）；自动引擎 `lib/auto.js`、隔离区 `lib/quarantine.js` 各自独立、依赖注入可单测。
- 测试 39 → **61**（新增 `test/quarantine.test.mjs` 11 条、`test/auto.test.mjs` 11 条）。

### 1.3.0

- **一次点干净**：确认弹窗默认勾选整批资料，Host 新增 `everything: true` 语义 —— 在删除前按仍然可读的日志重新推导「该批会话写出的文件 + 只剩它们引用的附件」，浏览器不参与决定删什么，只能缩小范围。
- **新增定时任务清理**：目标会话被删后永远不可能再投递的 `schedule` 任务一并删除（通过公开 `ctx.schedule` 服务，Service 缺席时静默跳过）；列表行与扫描结果都会显示任务数量。
- **界面重做**：顶部四格汇总（归档数 / 占用 / 运行中 / 已选）、组头「全选本组」、行内体积与最后活动对齐、回合计费式「预计释放」、可展开的文件清单、移动端底部弹层；确认弹窗按类别展示清理范围，不再是一排复选框。
- 扫描结果新增 `schedules`；失败原因逐条列出（含定时任务删除失败）。
- 测试增至 39 项（Host 12 / 路由 11 / 清理 7 / 残留 5 / 客户端 4）。

### 1.2.0

- 新增**历史残留扫描**（`/leftovers`、`/purge-leftovers`，页面按钮「扫描历史残留」）：一次列出已删除会话产出的文件、残留日志目录、残留投影缓存行、失效的工作区记账、失效的归档标记、孤儿附件与请求图缓存，逐类勾选后永久删除。
- 删除时写入 `archived-purge-manifest.json`（记录 id / 标题 / cwd / 产出文件的大小与 mtime），这样日志没了之后仍能找回「这个会话产出过什么」；文件被改动过就标记并跳过，绝不误删。
- 残留判定都要求「确定不在」：既不在持久化列表、也不是活会话、也没有日志目录；残留日志目录只针对 manifest 里记录过、且已读不出来的 id。
- 测试增至 35 项（Host 11 / 路由 9 / 清理 7 / 残留 5 / 客户端 3）。

### 1.1.0

- 新增**深度清理**：删除对话框里可选「无人引用的附件」「请求图缩放缓存」，并勾选该批会话写出的工作区文件；新增独立的「清理孤儿附件」入口（先 dry-run 报数字再确认）。
- 新增引用感知的附件 GC（`lib/clean.js`）：先读完所有剩余日志收集 `sha256` 摘要，再删无人引用的对象；读取失败即整体放弃，10 分钟内的新对象一律保留。
- 工作区文件只按 `write` / `edit` / `present` 的显式路径识别，必须位于会话 cwd 内，且排除 `DSH_HOME`、插件自身目录、`.git` / `node_modules`；服务端重新扫描核对，浏览器传来的路径不能凭空删文件。
- 新增 28 项测试（Host 11 / 路由 8 / 清理 7 / 客户端渲染 2），客户端用最小 React 运行时真实挂载并点击。

### 1.0.2

- 修复 **删除后会话掉进侧边栏「未分组」**：文件删完之后，旧实现立刻摘掉工作区记账并解除归档；但驻留内存的会话仍会被 `sessions.list()` 列出，于是失去归属、以「未分组」重新出现。现在驻留目标的记账与归档标记保留到下次启动，由 `finalizePending()` 收尾（启动时、以及每次删除前都会跑一遍），页面只提示「另有 N 个已删除会话的记账将在下次启动时自动回收」。
- 列表不再显示「日志缺失」的幽灵行：没有日志的归档条目属于待回收记账，收尾时自动消失。
- README 补上「为什么不动附件与工作区文件」：上游 `dsh-attachment` 明确把 reference-aware GC 推迟，附件不可变且可能跨会话共享，工作区文件是用户产出。

### 1.0.1

- 修复 **归档会话永远删不掉、只报 `部分删除失败: 0 / 4 · HTTP 400`**：运行判定从「`ctx.sessions.get` 里还有没有」改为 `workspace/session-activity` 瀑布，驻留内存但空闲的归档会话现在可以正常删除。
- 删除改为**整批前置检查**：任一目标（含 subagent 后代）仍在运行则整批不删，并列出是哪一类工作（对话 / 任务 / 子代理 / 定时任务）。
- 删除接口不再用 `400` 表达业务失败，页面逐条显示失败会话与原因；列表不再把驻留会话标成「运行中」，状态取不到时标「运行状态未知」。
- 新增 `test/http.test.mjs`：直接驱动路由处理函数，锁定「驻留但空闲 → 200 且删除成功」「仍在运行 → 200 + 可读原因」两条契约。

## 开发

```sh
node --test test/host.test.mjs test/http.test.mjs test/clean.test.mjs test/leftovers.test.mjs test/client.test.mjs
```

`test/host.test.mjs` 在临时目录构造完整存储结构，覆盖列表、删除、运行中拒绝、驻留但空闲（回归）、整批前置检查、非法 ID、记账已从投影消失、subagent 级联、`everything` 清理与定时任务删除；`test/http.test.mjs` 用假的 `ctx` 驱动真实路由，锁定状态码、扫描与 GC 的响应体；`test/clean.test.mjs` 单测引用扫描、孤儿判定、只读对象删除、产出物识别；`test/client.test.mjs` 用最小 React 运行时真实挂载设置页并点击。全部不触碰真实数据。

```
index.js            Host 半：列表 / 删除 / 路由 / 边界校验
lib/clean.js        引用扫描、附件 GC、产出物识别与删除
client.js           Client 半：设置页、全选、确认弹窗、彻底清理
cordis.patch.yml    bundle patch
locale/{zh,en}.json 插件市场展示元数据
test/host.test.mjs  Host 单测
test/http.test.mjs  路由 / 扫描 / GC 集成测试
test/clean.test.mjs 清理模块单测
test/leftovers.test.mjs 残留扫描单测
test/client.test.mjs 客户端渲染与交互测试
```

## 已知限制

- 只能删除归档集合中的会话；活动会话请先归档。
- **1.2.0 之前删掉的会话没有 manifest**，它们产出过的文件无法再归属，扫描不会列出；附件/缓存/记账这类结构性残留仍然能扫到。
- 附件 GC 是**全量扫描**：会话越多、日志越大，耗时越长（本机 6 个会话/2820 条事件约几十毫秒）。
- 10 分钟宽限期内的附件对象不会被回收。
- 定时任务清理依赖可选的 `schedule` 服务；没有该服务时任务保持原样（页面也不会显示任务数）。
- 驻留会话的记账在下一次启动时回收（DSH 没有让第三方插件把会话逐出 `ctx.sessions` 的公开接口）。
- 工作区产出物只认 `write` / `edit` / `present` 的显式路径；`pwsh`/`ffmpeg` 等命令产出的文件不在清单里。
- 归档时间不是 DSH 的持久字段，列表用最后活动时间排序。
- 自动卡片里的「立即检查」只预演；真要立刻搬，用对话工具 `archived_purge_run` 并显式 `confirm: true`（或等节拍）。

## License

[MIT](LICENSE) © 2026 5D-artist

---

# English

**Automatic, reversible cleanup for archived DeepSeek Harness sessions: idle ones move into a quarantine and are restorable for a retention window; manual select-all delete is still there.**

DSH's built-in archive only hides a session from the sidebar; its log, projection cache and workspace accounting stay on disk, and there is no bulk delete. This plugin adds **Settings → Archive Cleanup**: every archived session grouped by workspace, with select-all / per-row selection and one permanent delete for the selection. Since **v2.0 it also runs on its own beat**: archived Sessions idle past a grace window are first **moved into a quarantine** (log, projection cache and produced files, all restorable), and only after the retention window are they permanently removed together with their workspace slot and archive marker — automatic, not reckless.

## Features

- Grouped by workspace with title, size, last activity and scheduled-task count; a top summary shows archived count, disk usage, running count and the selected size.
- Select all, a whole group, or individual rows, with a live count and total size.
- Permanent deletion of the session log directory, the projection-cache row, the workspace accounting slot (`Workspace.detachSession`) and the archive-set entry (`workspaceRegistry.unarchiveSession`).
- Cascades only `origin: 'subagent'` descendants; ordinary forks are left alone.
- Guards: a Session that still reports work is refused (decided by `workspace/session-activity`, not by "it is still in memory"), ids are allow-listed, every path must stay inside the session/cache roots, POSTs are same-origin, and deletion needs an explicit confirmation.
- Readable failures: a refused or failed delete lists each Session with its reason instead of a bare `HTTP 400`.
- **One-click deep clean (default)**: the confirmation dialog is pre-ticked to remove everything the Host can prove belongs to those Sessions — the workspace files their logs attributed, attachment objects no remaining log references, and scheduled tasks aimed at them. Each category can be unticked; the file list is collapsed until opened and every file can be excluded individually.
- The request-image downscale cache is regenerable and stays opt-in.
- **Standalone orphan sweep**: without deleting anything, dry-run first and then remove attachments no log references.
- **Leftover scan**: every delete records what the Session had produced in `<DSH_HOME>/archived-purge-manifest.json`; "Scan leftovers" then lists the produced files still on disk (size + mtime must match, otherwise the file is marked *changed* and skipped), orphan log directories, stale projection-cache rows, dangling workspace slots and archive markers, unreferenced attachments and the request-image cache — each category opt-in, removed for good on confirm.

## Install

```sh
dsh plugin --profile desktop add github:5D-artist/dsh-archived-purge
```

Or use **Settings → Plugins → Add plugin** with `https://github.com/5D-artist/dsh-archived-purge`.

## Usage

Settings → Archive Cleanup → select all → Delete selected → confirm. The dialog already covers the whole disposable set; untick a category or an individual file if something must stay. Nothing is deleted before that confirmation.

## Autopilot (v2.0)

The plugin takes its first pass 90 s after mount, then every 6 hours (`setInterval(...).unref()`; the timer never keeps the host alive). It only touches Sessions that are **archived and long idle**, in two phases:

1. **Hold**: archived + no activity for `graceDays` (30 by default) + nothing currently running (decided by `workspace/session-activity`) + no scheduled task aimed at it → the session log directory, the projection-cache row and the files the Session produced are **renamed into the quarantine** (same volume, atomic, no copy). The archive marker and workspace slot are left alone so a restore brings back a complete Session.
2. **Expire**: after `retainDays` (7 by default) the held bytes are deleted and the bookkeeping cleared through the public `detachSession` + `unarchiveSession` path (deferred to the next start while the Session is still resident, same rule as the manual delete).

Configuration is a file, not code: `storages/archived-purge/config.json` (written with defaults on first run). `enabled: false` stops it immediately; the file is re-read every round, no restart needed. The audit trail is `<DSH_HOME>/storages/archived-purge/purge-log.jsonl` — one JSON line per decision, no memory entries. Routes: `GET /auto` (status, held entries, next run), `POST /auto/run` (dry-run unless `{"apply":true}`), `POST /auto/restore` (bring one entry back), `POST /auto/purge-expired` (run only the expiry sweep).

Three model tools expose the same surface from chat: `archived_purge_status` (one-line conclusion, last/next run, held list, and a dry-run plan naming why each Session is left alone), `archived_purge_restore` (move one entry back by `entryId`, never overwriting a path that came back), `archived_purge_run` (dry by default; `confirm: true` moves bytes, through the same `runOnce` as the beat).

## Safety

Archiving hides a Session without disposing it, so a recently used archived Session stays resident in `ctx.sessions` — presence is not liveness. The purge asks the Host's `workspace/session-activity` waterfall (the same admission check `archiveSession` uses) and refuses only Sessions that still report running work, after a whole-batch pre-flight.

Deleting the files of a resident Session is fine; dropping its workspace slot while it is still listed is not — that is what made the Session reappear under the sidebar's *Ungrouped* bucket. So a resident target keeps its slot and archive marker until the process no longer holds it, and `finalizePending()` (on load, and before each batch) clears them on the next start. The page says how many entries are waiting.

Attachments and their derived request-image cache are not deleted by default: objects are content-addressed, may be shared by resumed or forked Sessions, and upstream `dsh-attachment` deliberately defers reference-aware GC. The deep clean supplies that missing half by reading every remaining log first: an unreadable log aborts the sweep, objects younger than ten minutes are kept (an attachment is published before the event that references it), and only objects no log mentions are removed. Workspace files are never guessed: only the explicit targets of `write` / `edit` / `present` are offered, they must live inside the Session's cwd, and the server never accepts a path it did not itself list; `DSH_HOME`, this plugin's own package, `.git` and `node_modules` are excluded. `everything: true` is resolved on the Host from the still-readable logs, so the browser can only narrow the set, never widen it. Scheduled tasks are removed only when their delivery target is one of the deleted Sessions. The workspace registry is never rewritten by hand; archive and accounting go through public service methods.

## Compatibility

Tested on DSH 0.2.1-rc.5 (Desktop, Windows). Requires `webServer`, `workspaceRegistry`, `sessions` and `sessionPersistence`; `schedule` is optional (without the Schedule plugin, tasks are simply left alone). Targets the 0.2.x v4 session layout, workspace schema v2 and the `attachments/v1/objects` store.

## Changelog

### 2.2.0

- **The automatic sweep is on the page**: a card above the list shows the beat, last/next run, the quarantine (title, size, days left) with a per-entry **restore** button, and a **check now** action that only previews — it never moves bytes.
- **Client refactor**: the 1096-line panel became eight data/action hooks plus twenty presentational components; `client.js` went 1126 → 1066 lines and the frozen baselines were tightened (max function 1096 → 1030 — that is now the module factory itself, complexity 91 → 21, depth 5 → 2). The client bundle graph is flat (one module per bundle, edges only to the platform table), so the file cannot be split — documented at the top of the file.
- Tests: the client harness now expands function components the way React renders them; a new case pins the auto card (status render, restore request, preview-only check). Plugin tests 74 → **75**.

## Changelog

### 2.0.0

- **Autopilot (on by default)**: first pass 90 s after mount, then every 6 hours. A Session that is archived, idle past `graceDays` (30), not running and free of scheduled tasks is **held** in a same-volume quarantine; after `retainDays` (7) it is permanently removed and its bookkeeping cleared. Beat, grace, retention, per-run count/byte budgets and notification are all in `storages/archived-purge/config.json`; `enabled: false` stops it at once.
- **Restorable**: every entry has a `manifest.json` (each original path, size, expiry); `auto/restore` moves the bytes back and never overwrites a path that came back.
- **Observable automation**: `GET /auto`, `POST /auto/run` (dry-run by default), `POST /auto/restore`, `POST /auto/purge-expired`; one JSON line per decision in `storages/archived-purge/purge-log.jsonl` (no memory entries).
- **Refusal before risk**: unprovable age → skipped; no `session-activity` waterfall → whole round skipped; scheduled tasks present → skipped; resident Sessions keep their bookkeeping until the next start; `maxPerRun` / `maxBytesPerRun` are hard budgets.
- **Structure**: HTTP routes moved to `lib/routes.js`, entry `index.js` down from 1540 to 1360 lines; the sweep (`lib/auto.js`) and the quarantine (`lib/quarantine.js`) are dependency-injected and unit tested.
- Test count 39 → **61** (11 new quarantine tests, 11 new autopilot tests).

### 1.3.0

- **Delete everything in one click**: the confirmation dialog is pre-ticked, and the Host gains `everything: true` — it re-derives the attributed workspace files and now-orphaned attachments from the still-readable logs just before deleting. The browser can only narrow that set.
- **Scheduled-task cleanup**: tasks whose delivery target is a deleted Session can never fire again and are removed through the public `ctx.schedule` service (silently skipped when the service is absent); rows and the scan report the task count.
- **Redesigned page**: four summary tiles (archived / on disk / running / selected), per-group select-all, aligned size and last-activity metadata, an "frees about" estimate, a collapsible file list, and a bottom-sheet dialog on narrow screens; the confirmation dialog now reads as a scope list instead of a checkbox wall.
- The scan response gained `schedules`; failures are listed per item, including schedule deletions.
- 39 tests now (host 12, routes 11, cleaner 7, leftovers 5, client 4).

### 1.2.0

- Added the **leftover scan** (`/leftovers`, `/purge-leftovers`, the "Scan leftovers" button): produced files of removed Sessions, orphan log directories, stale projection-cache rows, dangling workspace slots and archive markers, unreferenced attachments and the request-image cache — selected per category and deleted for good.
- A delete now writes `archived-purge-manifest.json` (id, title, cwd, and each produced file's size and mtime), so those files stay findable after the log is gone; a file whose size or mtime changed is flagged and never deleted.
- Every leftover check requires a definite miss: not in the persistence listing, not a live Session, no log directory; orphan log directories are only considered for ids the manifest recorded.
- 35 tests now (host 11, routes 9, cleaner 7, leftovers 5, client 3).

### 1.1.0

- Added the **deep clean**: the confirmation dialog can also remove unreferenced attachment objects, the request-image cache, and the workspace files the Sessions explicitly wrote; a standalone "clean orphan attachments" action dry-runs first.
- Added reference-aware attachment GC (`lib/clean.js`): read every remaining log for `sha256` digests, then delete only objects no log mentions; an unreadable log aborts the sweep and objects younger than ten minutes are kept.
- Workspace artifacts come only from `write` / `edit` / `present` paths inside the Session cwd, excluding `DSH_HOME`, this plugin's package, `.git` and `node_modules`; the server re-derives the allowed set, so a browser-supplied path can never delete a file the scan did not offer.
- 28 tests now cover the host, the routes, the cleaner and a mounted Settings page.

### 1.0.2

- Fixed Sessions falling into the sidebar's **Ungrouped** bucket after a delete: bookkeeping and the archive marker now stay until the Session leaves the store, and `finalizePending()` finishes them on the next start (also before every batch). The list reports how many entries are waiting.
- The list no longer shows ghost rows for archived entries whose log is gone.
- Documented why attachments and workspace files stay out of scope, with the upstream retention decision.

### 1.0.1

- Fixed archived sessions that could never be deleted ("0 / 4 · HTTP 400"): liveness now comes from `workspace/session-activity` instead of `ctx.sessions.get`, so resident-but-idle archived Sessions delete normally.
- The whole batch is pre-flighted: if any target (including a subagent descendant) still reports work, nothing is deleted and the report names the work family.
- The delete route no longer uses `400` for a business refusal; the page lists each failed Session with its reason, and the list stops labelling resident Sessions as running.
- Added `test/http.test.mjs`, which drives the real route handlers to pin the "resident but idle → 200 and deleted" and "still running → 200 with a readable reason" contracts.

## License

MIT © 2026 5D-artist

---

## 本仓副本的维护与验证记录

### 2026-11-11 · 升级到上游 1.3.0（vendored）

- **来源**：https://github.com/5D-artist/dsh-archived-purge ，commit `58a73c9`（2026-11-07，MIT；tag v1.2.0 之后含 1.3.0 的修正提交）。上一版基线 `6c484e69`（1.0.0，2026-11-04）。
- **为什么升级而不是继续分叉**：上游 1.0.1–1.3.0 已覆盖本仓此前自打的 release-then-delete 与「删后掉未分组」补丁，并新增本仓没有的四项能力（引用感知附件清理、产物 manifest 与历史残留扫描、定时任务清理、`everything` 语义）。继续分叉维护会越来越贵，改为「上游为主 + 只留一处本地增强」。
- **保留的本地增强（上游没有）**：删除后为每个 id 的两种拼写补播 `api-session/removed`；`POST /plugins/archived-purge/announce` 补播接口（清理客户端历史陈旧行）；客户端删除成功后 `sessions.refresh()` 重拉侧栏基线。对应 3 条测试在 `_selftest/tests/archived-purge.test.mjs` 末尾。
- **放弃的本地实现**：release-then-delete。上游用 `workspace/session-activity` waterfall 判定「是否真有活」；驻留但空闲的会话只删文件，记账与归档标记延后到下次启动 `finalizePending()` 回收（页面有提示）。强行 detach 内存中的 live 条目与宿主存储层竞争，风险更高。
- **验证记录（2026-11-11，DSH 0.2.2-rc.1，Windows）**：
  - ✅ 单测：上游 5 个测试文件 **39/39 PASS**（`node --test test/host.test.mjs test/http.test.mjs test/clean.test.mjs test/leftovers.test.mjs test/client.test.mjs`）。
  - ✅ 映射测试：`_selftest/tests/archived-purge.test.mjs` = 上游 39 条 + 本仓补丁 3 条 = **42 条全过**，已进 `npm run check` 验证门。
  - ✅ 测试稳定性：修掉上游 `http.test.mjs` 与插件启动 `finalizePending()` 的竞态（mock registry 写入重试 + 等 finalize settle 后再种 ghost）；修复前连跑 12 次有 2–5 次报「leftover scan … purges them」，修复后 http **12/12**、映射测试 **8/8** 稳定通过。
  - ✅ 真机宿主侧（profile 重组后零重启）：`GET /plugins/archived-purge/state` 返回 1.3.0 字段（`pendingFinalize` / `activity` / `activityUnknown` / `resident` / `scheduleCount`），**19 条归档会话**列举正常；`activity` 非 `activityUnknown` = rc.1 的 `workspace/session-activity` waterfall 正常应答。
  - ✅ 只读路由真机：`POST /scan`（2 个会话预演 ok）、`POST /leftovers`（扫描完成）、`POST /gc {dryRun:true}`（报 12 个孤儿附件 / 8.5 MB，未删）、`POST /announce` 空数组返回 `invalid-request`（补丁路由已注册）。
  - ⚠️ 未直证：设置页 GUI 渲染（1.3.0 页面重设计）。`archived-purge-client-errors.log` 不存在 = 客户端未见挂载失败，但浏览器端 bundle 重建后需要刷新页面（Ctrl+R）才能看到新 UI；真正机删除未执行（19 条归档会话是真实数据，不冒险）。
- **已知边界（升级后改写）**：驻留但空闲的会话——文件立刻删，记账与归档标记保留到下次启动回收；`activity-unknown`（宿主不提供 `workspace/session-activity`）时整批拒绝而不是冒险；附件/产物/定时任务的删除全部由 Host 从可读日志重新推导，浏览器只能缩小范围。
- **旧记录**：1.0.0 时代的维护与验证见 `CHANGELOG.md` 的 1.0.0 / 1.0.0-vendored.1–3 条目；核心结论不变——不走 `workspace.json` 手改，走宿主公开 API（`Workspace.detachSession` + `workspaceRegistry.unarchiveSession`）。
