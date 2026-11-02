# dsh-checkpoint —— 写前快照 + 一键回滚

DSH bundle（Host 侧插件）：在 agent **写/改/删文件之前**把原内容留底，需要时用一个工具调用回滚。

- **安装位置**：`D:\AI\dsh-bundles\dsh-checkpoint`（D 盘，不在任何工作区里，工作区删除/移动不影响它）
- **数据位置**：`D:\AI\dsh-data\checkpoint\snapshots.json`（bundle patch 里的 `storeDir`，不落 C 盘）
- **生效范围**：desktop profile 的 bundle 列表，**所有会话、所有工作目录**都生效（与 cwd 无关）
- **配套说明**：`D:\AI-date\dsh-date\dsh-创建\hermes-lessons-for-dsh.md`（从 Hermes 学到的设计）

灵感来自 Hermes Agent 的 checkpoint 机制，按 DSH 的扩展点重做。

## 工具

| 工具 | 作用 |
|---|---|
| `checkpoint_list` | 列出可回滚目标：`[N 字节]` 表示修改过、`[新建→回滚即删]` 表示 agent 创建的文件 |
| `checkpoint_diff` | **回滚前先看**：先给"会恢复/会删除/会重建各几个"的摘要，再按文件给 `+A/-R 行` 与行级 diff（`@@` 行号 + 2 行上下文）；`path` 支持文件名片段（输入 `hermes-lessons` 就能命中 `hermes-lessons-for-dsh.md`） |
| `checkpoint_restore` | `path` 回滚单个/整个目录（支持唯一路径后缀）；`all: true` 回滚全部，**必须同时传 `confirm: true`**；修改过的恢复内容，创建过的删除 |
| `checkpoint_forget` | **只丢快照、不动文件**（`path` 或 `all: true`），用来清掉过时/失效目标 |
| `checkpoint_prune` | **按会话 / 按时间清理快照记录**（`sessionId` / `olderThanDays`，可组合）：默认 `dryRun: true` 只报告"会清几条"，真删必须 `dryRun: false` + `confirm: true`；只丢记录、**永不读写用户文件**；受保护目录里的快照永远跳过 |
| `checkpoint_status` | 诊断：存档路径、钩子计数、捕获/跳过统计、加载时丢弃的失效快照数 |

## 机制

1. **抓取点**：`tools/pre-execute`（每次工具派发前必过的 waterfall）。
   - `write` / `edit`：从参数取目标路径，按会话工作目录解析；文件存在就记 `modified` + 原文，不存在就记 `created`。
   - `pwsh` / `bash` / `sh` / `shell` / `terminal`：命令行里出现破坏性动词（`Remove-Item`/`del`/`rm`/`mv`/`ren`/`Set-Content`/`Out-File`/`sed -i`/`> 重定向`）时，提取路径候选，对**已存在**的文件留底。
2. **持久化**：快照写到 `config.storeDir`（本机为 `D:\AI\dsh-data\checkpoint\snapshots.json`；未配置时默认 `~/.dsh/dsh-checkpoint/`），启动时加载、变更后 150ms 防抖原子落盘，插件卸载前强制 flush。
3. **回滚**：修改过的用 `fs.writeText(target, 原文)`；创建过的用 node fs 删除。两者都先按**当前会话**解析沙箱策略——`read-only` 直接拒绝，`workspace-write` 下还要求目标在会话 cwd 之内。`path` 参数支持三种匹配：全等、唯一后缀、目录前缀（传一个目录会批量命中，回滚/对比都能用）。
4. **安全刹车**（v1.2 → v1.3）：
   - `all: true` 必须显式 `confirm: true`，否则直接报错并提示先 `checkpoint_diff all:true` 看影响面；
   - `config.protectDirs`（本机配置了 `D:\AI\dsh-bundles`）里的目标，回滚/删除也要 `confirm: true`，防止把**正在运行的插件源码**当成"agent 新建的文件"删掉；
   - **采集排除**（v1.3）：受保护目录 + 本插件自己的数据目录**根本不进账本**——改插件源码或插件写数据都不会污染列表（`checkpoint_status` 的 `skipped.excluded` 可核对）；
   - 加载时自动丢弃"文件不存在且父目录也不存在"的失效快照（目录迁移/删除留下的旧路径），避免误回滚时按旧路径重建目录（例如写回 C 盘）；丢弃数量见 `checkpoint_status`。
5. **预览**：`checkpoint_diff` 用行级 LCS 算 diff，输出带 `@@ -a,b +c,d @@` 的 hunk（各 2 行上下文）；任一侧超过 600 行退化为"只给行数统计"；渲染超过 200 行会截断。状态分 `modified` / `created`（回滚即删）/ `missing`（快照后文件被删）/ `unchanged`。
6. **预算**：单文件 1 MiB、最多 200 个目标、总量 64 MiB，超了淘汰最旧的；更主动的清理见第 7 条。
7. **清理（v1.3+ → v1.5，`checkpoint_prune`）**：两个可选过滤条件，同时传时取交集——
   - `sessionId`：只清该会话产生的快照（会话 id 取自 `exec.agent.id`，v1.5 起随每条记录落盘；旧存档没有这个字段，按"未知会话"处理）；
   - `olderThanDays`：只清 `capturedAt` 早于 N 天的快照（时间戳缺失/坏掉按"未知时间"处理）。

   安全设计（红线）：
   - **默认 `dryRun: true`**：只返回 `matched` / `wouldForget` / `protected` / `unknown`，不改内存、不改存档；
   - **真删必须 `dryRun: false` 且 `confirm: true`**，否则直接报错；
   - 不带任何过滤条件直接报错，不会"手滑清空全部"（想丢弃全部仍用 `checkpoint_forget` 的 `all: true`）；
   - 执行体只做 `records.delete` + 现有原子落盘，**从不调用任何文件删除/写入接口**——清理永远不碰用户工作区文件；
   - `protectDirs` 里的快照**永不清理**（保护逻辑对清理同样生效，受保护目标即使会话+时间都命中也会被跳过）；
   - 旧存档向后兼容：缺 `sessionId` / 缺 `capturedAt` 不报错，且这类记录不会被清理命中（宁可留着也不误删）。

## 剩下的边界（不是实现问题）

- **外部进程 / IDE / 其他插件**绕开工具管线直接改文件，拦不到；
- **git 操作**（`git checkout`、`git reset --hard`）恢复哪些文件取决于仓库状态，没有安全的通用快照方式；
- **shell 路径靠正则提取**，best-effort：变量、通配符、管道拼接出来的路径可能漏抓；
- 非文本文件、超过大小上限的文件不记录；
- 回滚动作本身是工具调用（走正常审批/guard），但插件内部的 fs 写入不会二次触发工具级审批，只受会话沙箱约束。

## 验证记录（2026-10-25，本机 desktop profile，v2）

安装 → `application: applied`，插件行 `enabled + active`，`checkpoint_status` 显示存档路径 `D:\AI\dsh-data\checkpoint\snapshots.json`（旧路径 `C:\Users\cqs6017\.dsh\dsh-checkpoint\snapshots.json` 已迁移并删除）。

| 场景 | 结果 |
|---|---|
| 改文件 → 回滚 | `seed.txt` 由 "SEED v2" 回滚为 "SEED v1" ✅ |
| **持久化**：记录后 remove+install 插件（等价重载）再回滚 | 重载后 `checkpoint_list` 仍能看到该文件，回滚结果正确 ✅ |
| **新建文件**：`write` 创建新文件 → 回滚 | 文件被删除，`Test-Path` = False ✅ |
| **shell 删除**：`Remove-Item shell.txt` → 回滚 | 删除前已捕获 9 字节原文，回滚后内容为 "SHELL v1" ✅ |
| 定向回滚 | `path="other.txt"` 只恢复匹配目标 ✅ |
| **v1.2 安全刹车** | `restore all` 不带 confirm → 拒绝并列出 27 个受影响目标；`restore path` 指向 `D:\AI\dsh-bundles\...` → 拒绝（受保护目录）✅ |
| **失效快照清理** | 旧 C 盘 / 旧工作区路径（文件与父目录都已不存在）在加载时自动丢弃 3 条 ✅ |
| **checkpoint_forget** | 丢弃 Temp 测试记录 1 条，文件未动、剩余数量正确 ✅ |
| **v1.3 采集排除** | 改插件源码（`dsh-checkpoint/index.js`、README）后：`checkpoint_list` 仍是 3 条、`skipped.excluded` 计数 +2 —— 内部改动不再污染账本 ✅ |
| **v1.3 列表体验** | 列表改为"共 N 个（修改 X / 新建 Y）"，最多显示 20 条，时间只到 `HH:MM:SS`，超出提示用 `path` 指定 ✅ |
| **v1.4 回滚预览** | 先给摘要（会恢复 1 / 会删除 0 / 会重建 0），再给 `■ 文件` + `改动 +20 / -6 行` + 缩进 diff；`path="hermes-lessons"` 这种片段也能命中文件 ✅ |
| **diff 预览**（修改） | `checkpoint_diff path="demo.txt"` 输出 `+2 -1` 与 2 行上下文的 hunk，内容与预期一致 ✅ |
| **diff 预览**（删除/新建） | shell 删除的文件显示 `missing, -2`；agent 新建的文件显示 `created（回滚会删除它）` ✅ |
| **目录级操作** | `path="diff-demo"` 一次匹配 3 个目标：恢复 2 个、删除 1 个 ✅ |
| **diff 辅助函数单测** | `diffTextLines` / `buildHunks` 12 个用例全过（相同、替换、追加、清空、超大退化、单/多 hunk、行号与上下文形状） |

以上测试的临时目录与旧存档均已清理；`checkpoint_status` 复核快照数为 0。

## 验证记录（2026-10-26，v1.5 清理策略）

先判断现状：快照记录**已有 `capturedAt` 时间戳**，但**没有 `sessionId`**。所以先补记录字段（v1.5 起从 `exec.agent.id` 写入，存档 version=3），旧存档缺字段按"未知"兼容；按时间清理直接基于 `capturedAt`。

真实验证（`node D:\AI\dsh-bundles\_selftest\tests\checkpoint.test.mjs`，退出码 0，21 项通过；原 7 项 diff/hunk 用例全部保留）：

| 场景 | 结果 |
|---|---|
| **旧存档兼容**：v2 存档缺 `sessionId` / 缺 `capturedAt` | 正常加载 6 条，不报错 ✅ |
| **dryRun 默认**：`olderThanDays: 30` | 报 3 条待清、受保护跳过 1 条；存档未改写、6 条记录仍在、6 个用户文件全在 ✅ |
| **按会话**：`sessionId: "sess-a"` | 命中 2 条；受保护跳过 1 条；缺 sessionId 的旧记录按 unknown 跳过 ✅ |
| **交集**：sess-a 且 >30 天 | 仅命中 old-a ✅ |
| **confirm 红线**：`dryRun: false` 无 `confirm` | 报错，记录不变 ✅ |
| **真清理**：`dryRun: false` + `confirm: true` | 丢弃 3 条、剩余 3 条；**所有用户文件仍存在** ✅ |
| **原子落盘** | 350ms 后存档只剩 3 条，受保护记录在内 ✅ |
| **protectDirs**：会话+时间双命中 | `matched: 0` / `protected: 1`，受保护快照保留；即使它是唯一命中项也不清 ✅ |
| **原工具行为不变** | `restore all` 无 confirm 仍拒绝；`forget all` 仍只丢快照、不动文件 ✅ |
| **采集字段** | 新记录写入 `sessionId`（取自 `exec.agent.id`）、`capturedAt` 可解析、存档 `version: 3` ✅ |
| **schema 自检** | `node _selftest/schema-check.mjs` → 18 个工具全 PASS（含 `checkpoint_prune`）✅ |

测试临时目录统一用 `D:\AI\dsh-data\_selftest-checkpoint-*`，跑完自动删除，不落 C 盘。

**2026-11-01 接口契约补丁**：`checkpoint_status` 增 `ready` / `unavailableReason`（判据＝storeDir 真能写：建目录 + 写探针再删，不碰快照存档），schema `required` 含 `ready`，`ready: false` 时 render 首行「不可用：<原因>」；所有抛错带 `code`（MISSING_TARGET / NOT_FOUND / CONFIRM_REQUIRED / MISSING_FILTER / INVALID_ARGUMENT / SANDBOX_READ_ONLY / OUTSIDE_WORKSPACE），人话消息不变。实测：storeDir 指到不存在的盘 → `ready:false` + 「不可用：storeDir 不可写…」；正常目录 → `ready:true`；`node --check index.js` 通过、`node _selftest/tests/checkpoint.test.mjs` 21 项全过。

## 安装 / 卸载

```powershell
# 安装（当前 profile）
plugin_manager action=install_bundle target=D:\AI\dsh-bundles\dsh-checkpoint

# 卸载
plugin_manager action=remove_bundle target=@local/dsh-checkpoint
```

改代码后需要 `remove_bundle` + `install_bundle` 才会加载新的模块代际（热替换不换 JS 模块）。

## 2026-11-02 升级记录

- 按 `_reports/plugin-falsepositive-scan-2026-11-01.md` 修：restore/forget/diff 严格匹配：歧义命中 ≥2 个直接拒绝并列出候选（#29，高）。
