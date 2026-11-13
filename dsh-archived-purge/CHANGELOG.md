# Changelog

## 2.2.0 (2026-11-13)

- **设置页新增自动清理卡片**（清掉欠账 #13）：状态与节拍、上次/下次运行、隔离区清单（标题、体积、剩余天数）、逐条「还原」、「立即检查」只预演。
- **客户端重构**：`createPanel`（1096 行）拆成 8 个 hook（`useArchiveData` / `useGroups` / `useSelection` / `useScanFlow` / `useDeepScope` / `useDeleteRun` / `useGcFlow` / `useLeftoverFlow` / `useAutoSweep` / `useEscapeKey`）与 20 个纯展示组件；`client.js` 1126 → 1066 行；结构与质量基线同步收紧（fn 1096→1030、ccn 91→21、depth 5→2）。
- **单文件约束写进注释**：`dsh-client-modules` 是扁平模块图（一个 bundle 一个节点，边只指向平台共享表），客户端不能拆文件——避免下一个人重复踩。
- 测试：客户端 harness 支持函数组件就地展开；新增自动卡片用例；插件测试 74 → **75**。



## 2.1.0 (2026-11-13)

- **对话里能看见、能还原**：新增三个模型工具——`archived_purge_status`（一句话结论 + 上次/下次 + 隔离区清单 + 一轮预演，逐条说明「为什么不动」）、`archived_purge_restore`（按 `entryId` 把一条隔离会话搬回原位，目标被占用则跳过不覆盖）、`archived_purge_run`（默认预演，`confirm:true` 才真跑，与节拍共用同一份 `runOnce`）。输出遵守 `plugin-ux.md`：第一行是结论，计数进 payload。
- **补真机契约测试**：新增 `test/auto-http.test.mjs` 10 条，用真 `apply()` 驱动 `/auto`、`/auto/run`、`/auto/restore`、`/auto/purge-expired` 与三个工具，钉住「默认预演不搬一个字节」「apply 后文件消失、restore 后回来」「驻留/在跑/协议缺失一律跳过」；测试共 74 条（39 上游 + 11 隔离区 + 15 自动引擎 + 10 本轮）。
- `registerTools` 在 Host 没有 `tools` 服务时静默跳过（旧测试上下文不再因此崩）。


## 2.0.0 (2026-11-13)

- **自动清理（默认开启）**：挂载后延迟 90 秒首跑，之后每 6 小时一轮（`setInterval(...).unref()` + `ctx.effect` 清理）。只处理「归档 + 超过 `graceDays`（默认 30 天）无活动 + 无工作 + 无定时任务」的会话，分两阶段：
  1. **隔离**：把会话日志目录、投影缓存行、该会话产出的工作区文件 `rename` 进 `<DSH_HOME>/storages/archived-purge/quarantine/<stamp>-<id>/`（同盘原子移动，`EXDEV` 才退回复制+删源）；归档标记与工作区记账**此时不动**，所以还原是完整的一条。
  2. **到期清除**：满 `retainDays`（默认 7 天）后删隔离区文件，再走公开 API `detachSession` + `unarchiveSession` 清记账与标记；驻留会话延后到下次启动由 `finalizePending()` 收尾（与手动删除同一规则）。
  3. **到期前重问活**：永久删是唯一不可逆的一步，所以清除前再问一次 `workspace/session-activity`——活跃就顺延并记 `active-at-expiry`；问不到就记 `activity-unknown-at-expiry`，宁可留。
  4. **取消归档＝要它**：用户把一条 held 会话取消归档后，下一轮自动把它还原（Hermes「只归档不删」的推论），记在 `reconciled`。
- **节拍走官方通道**：`ctx.interval` + `inject` 里声明 `timer`（base 层服务）；实测不声明会 `cannot get property "timer" without inject`、插件 `fiberPhase: failed`。服务缺席时 `lib/auto.js` 退回 unref 的 `setTimeout`。- **可还原**：每个隔离条目在任何一次移动之前就写好 `manifest.json`（原路径、字节数、到期时间），`POST /auto/restore` 搬回原位；目标已被占用则逐条跳过并列原因，绝不覆盖。
- **配置与代码分离**：`<DSH_HOME>/storages/archived-purge/config.json`（`enabled` / `intervalHours` / `startupDelaySeconds` / `graceDays` / `retainDays` / `maxPerRun` / `maxBytesPerRun` / `skipWithSchedules` / `notify`），每轮重新读文件，改完零重启；`enabled: false` 立刻停。
- **审计不写记忆**：每轮决策追加一行到 `<DSH_HOME>/storages/archived-purge/purge-log.jsonl`（隔离/清除/跳过原因分布/错误），另有 `auto-state.json` 记 `lastRunAt` 与上一轮结果。
- **新增路由**：`GET /auto`、`POST /auto/run`（默认 dry-run，`apply: true` 才动文件）、`POST /auto/restore`、`POST /auto/purge-expired`。
- **安全边界**：年龄读不出（`unknown-age`）、宿主无 `workspace/session-activity`（`activity-unknown`）、有定时任务（`has-schedules`）、驻留内存（`resident`）、仍在跑（`session-active`）一律跳过并记原因；`maxPerRun` 与 `maxBytesPerRun` 是硬预算，超了断在下一条而不是删一半。
- **结构**：路由抽到 `lib/routes.js`，自动引擎 `lib/auto.js`，隔离区 `lib/quarantine.js`（依赖注入、可单测）；入口 `index.js` 1540 → 1360 行（结构闸冻结基线只减不增）。
- 测试：39 → **61**（新增 `test/quarantine.test.mjs` 11 条、`test/auto.test.mjs` 11 条）。

## 1.3.0-vendored.1 (2026-11-11)

- **整体升级到上游 1.3.0**（https://github.com/5D-artist/dsh-archived-purge @ 58a73c9，2026-11-07，MIT），基线从 1.0.0（6c484e69）跨过 1.0.1 / 1.0.2 / 1.1.0 / 1.2.0 / 1.3.0：
  - 驻留但空闲的归档会话可删（1.0.1）：`workspace/session-activity` waterfall 判定「是否真有活」，替代本仓旧的 release-then-delete；
  - 删除后的驻留会话不再掉进「未分组」（1.0.2）：记账与归档标记延后到下次启动由 `finalizePending()` 回收；
  - 引用感知的附件清理（1.1.0）：先读日志收集引用，再删孤儿对象，读不全就整次放弃；
  - 删除产物的 manifest + 历史残留扫描（1.2.0）：`POST /leftovers` 与 `POST /purge-leftovers`；
  - `everything` 语义、定时任务清理、页面重设计（1.3.0）；`attachments:false` 显式退出（58a73c9）。
- **保留本地增强**：删除后为每个 id 的两种拼写补播 `api-session/removed`；新增 `POST /plugins/archived-purge/announce`；客户端删除成功后 `sessions.refresh()`。
- **移除本地旧实现**：release-then-delete（停 agent → flush → detach live 条目）不再保留——上游 1.0.1 的方案更稳（不强行 detach 内存中的会话，避免与宿主存储层竞争）。
- 测试：上游 5 个测试文件 39 条 + 本仓补丁 3 条 = 42 条全过；`npm run check` 验证门通过。
- 测试稳定性：修掉上游 `test/http.test.mjs` 与插件启动 `finalizePending()` 的竞态（mock registry 写入重试 + 等 finalize settle 后再种 ghost）——修复前连跑 12 次有 2–5 次报「leftover scan … purges them」，修复后 http 12/12、映射测试 8/8 稳定。
- 真机（DSH 0.2.2-rc.1）：`GET /state` 返回 1.3.0 字段（`activity` / `resident` / `scheduleCount` / `pendingFinalize`），`/scan`、`/leftovers`、`/gc`(dryRun)、`/announce` 均可用；`activity` 无 `activityUnknown` 标记 = rc.1 的 `workspace/session-activity` waterfall 正常应答。删除链路未在本轮真机执行（19 条归档会话是真实数据，不冒险）。

## 1.0.0-vendored.3 (2026-11-06 00:20)

- 仅验证记录，无代码改动：DSH 升级到 **0.2.2-rc.1** 后**全链路复验通过**——单测 11/11、`/state` 真机可用、rc.1 的 `workspace/archiveSession`+`unarchiveSession` 存在、**真机删除成功**（`deleted:1 / released:true / failed:0 / removedBytes:6034`，目录与投影缓存消失、10 秒不重建、归档集归零）。方法与临时验证路由的撤销证据见 README 文末。

## 1.0.0-vendored.2 (2026-11-05 23:10)

- **修「删了还在 / 回到未分组」**：宿主删除后显式 `emit('api-session/removed')`（两种 id 拼写），client 删除成功后调用 `sessions.refresh()` 重拉基线；新增 `POST /plugins/archived-purge/announce` 用于补播已删 id（清理客户端陈旧行）。
- 测试：11 条（新增 announce/双拼写两条）。

## 1.0.0-vendored.1 (2026-11-05 22:45)

- **release-then-delete**：归档会话处于「已挂载 / 运行中」时不再直接拒绝，而是先停 agent（cancel + 15s 有界等待）→ flush store → detach `sessions.store` / `agents.store` 条目，再删盘；释放不掉仍拒绝（避免存储层删后重建目录）。
- 客户端文案：运行中徽标与确认弹窗改为「运行中（删除会先停止）」/「运行中的会话会先停止」。
- 测试：8 条（新增「释放后删除」「释放失败拒绝」）。
- 来源：release 顺序参考 liuyu-f/dsh-plugin-session-cascade-delete（MIT）的 delete 链路。

## 1.0.0 (vendored 2026-11-05)

- 上游来源：https://github.com/5D-artist/dsh-archived-purge @ 6c484e695690b3ace35001fbbb6222e8f8a0ee58（2026-11-04，MIT）。
- 本仓副本：`D:\AI\dsh-bundles\dsh-archived-purge`，由本工作区维护；上游变更需手动同步并在本文件记一笔。
- 功能：设置 → 归档清理，列出全部已归档会话（按工作区分组、显示体积/最后活动/日志缺失、运行中标记），支持全选/逐条选择后永久删除；删除四类痕迹——会话日志目录、投影缓存单文件、工作区记账（`Workspace.detachSession`）、归档集合（`workspaceRegistry.unarchiveSession`），并级联清理 `origin: subagent` 的子会话日志；拒绝运行中的会话。
- 纳入验证门：`_selftest/tests/archived-purge.test.mjs`（7 条）。
