# dsh-butler-tidy · 内务司整理工具

给「亲爱的管家」用的文件整理插件：**先盘点、再出方案、确认才动手、动完能撤销**。
设计上参考了 [organize-tool](https://organize.readthedocs.io/en/v2.0.0/)（规则 + 模拟运行）、
[FolderSorter](https://pypi.org/project/foldersorter/0.2.0/)（预览优先 + 撤销）、
Hazel / File Juggler（按类型、日期、名称匹配）。

## 工具

| 工具 | 作用 | 会动文件吗 |
|---|---|---|
| `tidy_scan` | 盘点 C/D 盘：可清空间、散乱热点、余量；`topLevel:true` 加做**整盘顶层体量排行**；`path:...` 做**深度探查**（体积构成 / 四类引用 / 运行中进程 / 文件占用 / 特征标记 / 能否动的结论）；`health:true` 做**系统体检**（7 天错误数、开机耗时、自启未运行、已装软件数、开机时长）；`residue:true` 做**应用残留探查**（失效 PATH、幽灵服务、失效自启、失效计划任务）；`events:true` 做**事件日志归类**（系统/应用错误按来源+ID 聚合，附噪音判定） | 否 |
| `tidy_plan` | 出方案：按类型/月份分类文件、列子目录归并候选、校验改名 | 否 |
| `tidy_apply` | 执行（`confirm:true` 才动）：整理 / 目录归并 / 改名 / 清理 | 是 |
| `tidy_undo` | 撤销上一次操作（按清单反向搬回） | 是 |
| `tidy_status` | 诊断：数据目录、记录数、红线数、限额、**台账统计** | 否 |
| `inventory_add` | 登记一条安装记录（名称 / 类型 / 路径 / 版本 / 来源 / 卸载命令 / 数据目录），可选自动扫六类关联引用；写 `inventory.json` 并重生成 `inventory.md` | 只写台账 |
| `inventory_list` | 列出台账条目（默认只在用，可按类型 / 状态过滤；有截断提示） | 否 |
| `plan_uninstall` | 卸前只读预演：按名称或路径找条目，列出六类受影响引用、目标与数据目录体积、运行中进程、红线提醒、建议步骤；**不删任何东西** | 否 |
| `inventory_check` | 卸后只读复核：逐条查路径 / 数据目录是否还在、引用是否残留，分「记录有但已不在 / 引用残留 / 正常」；可标 `stale` 或收进 `removed` 历史 | 只改台账 |

### 四种动作（`tidy_plan` / `tidy_apply` 的 `kind`）

| kind | 作用 | 可撤销 |
|---|---|---|
| `organize` | 把某目录的文件按类型或月份归入子文件夹（可选递归 3 层） | ✅ |
| `folders` | 把平级子目录归并进目标文件夹（可顺手改名）；搬前**先查服务/自启/计划任务/开始菜单引用**，有引用则拒绝，除非 `force:true` | ✅ |
| `rename` | 按给定清单给文件改名（建议英文名，扩展名会自动保留） | ✅ |
| `empty` | 找出并清理空目录（自底向上多轮，父目录空了也会一并收走） | ❌ 删空目录无内容风险，可重建 |
| `dupes` | 查重复文件：先按大小分组，再「部分哈希 → 全量哈希」两段筛；确认后多余副本移入隔离区（`_dupes/`），可 `tidy_undo` 取回 | ✅ 移入隔离区 |
| `residue` | 应用残留处置：**只动用户级**（用户 PATH 失效项与重复项、HKCU 自启失效项），写清单可 `tidy_undo` 恢复；系统级（幽灵服务、系统任务、系统 PATH）只报告，需管理员 | ✅ 用户级可撤 |
| `clean` | 只删白名单里的临时文件/更新缓存/崩溃转储（回收站需点名） | ❌ 不可恢复 |

## 安装 / 卸载台账（v0.11.0）

> 目的：几个月后还能干净卸载。装完顺手登记，卸前先预演，卸后核对残留。全程只写台账文件，不动用户文件、不改注册表、不停服务。

**固定流程**：

1. 装完 → `inventory_add`：记名称 / 类型 / 路径 / 版本 / 来源 / 卸载命令 / 数据目录，顺带扫出六类关联引用；
2. 卸前 → `plan_uninstall`：只读预演，列出会被影响的引用、目标与数据目录体积、运行中的进程、红线提醒和建议步骤；
3. 卸后 → `inventory_check`：逐条对账，分「记录有但已不在 / 引用残留 / 正常」，失联条目标 `stale` 待核对，确认干净的用 `markRemoved` 收进历史；
4. 平时 → `inventory_list` 看台账（`tidy_status` 里也有一行台账统计）。

### 台账结构（`inventory.json`）

```json
{
  "version": 1,
  "nextId": 2,
  "entries": [
    {
      "id": "inv-0001",
      "name": "某便携软件",
      "kind": "portable",
      "path": "D:\\Tools\\某某",
      "version": "1.2.3",
      "source": "官网下载",
      "uninstallCmd": "",
      "installedAt": "2026-10-29T05:00:00.000Z",
      "updatedAt": "2026-10-29T05:00:00.000Z",
      "dataDirs": ["D:\\Tools\\某某\\data"],
      "refs": {
        "services": [], "startup": [], "tasks": [],
        "shortcuts": [{ "name": "某某", "detail": "D:\\Tools\\某某\\app.exe" }],
        "pathEntries": [], "registryKeys": []
      },
      "notes": "",
      "status": "active",
      "removedAt": "",
      "stale": false
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `id` | 自动编号，`inv-0001` 起 |
| `kind` | `installer` 安装包 / `portable` 便携版 / `dsh-plugin` DSH 插件 / `dev-tool` 开发工具 |
| `path` | 安装目录或主程序（登记时必须存在） |
| `uninstallCmd` | 卸载命令或卸载器路径（便携版可留空） |
| `dataDirs` | 卸载时要一起处理的配置 / 存档 / 数据目录 |
| `refs` | 六类关联引用：服务 / 开机自启 / 计划任务 / 开始菜单 / PATH / 注册表键 |
| `status` | `active` 在用 / `removed` 已卸载（历史保留，不物理删记录） |
| `stale` | 记录与磁盘对不上，待人工核对 |

同名重复登记视为**更新**（只覆盖本次给的可选字段，保留首次登记时间）；同一路径换个名字登记会被拒绝。

### 引用扫描范围

- 服务（`Win32_Service` 的 PathName）、开机自启（`Win32_StartupCommand`）、计划任务（`Get-ScheduledTask` 的 Actions）、开始菜单快捷方式（用户 + 全局 `.lnk`）；
- PATH：用户级与系统级里包含该路径的段；
- 注册表键：三个 Uninstall 根（HKLM 64 / HKLM WOW6432Node / HKCU）的 `InstallLocation` / `UninstallString` / `DisplayIcon` / `InstallPath`，以及 `App Paths`。**不扫** CLSID / 文件关联 / COM 注册——那类残留靠 `tidy_scan residue:true` 兜底。

系统级引用（服务、系统 PATH、HKLM 键、全局任务）**只报告不动手**，需要管理员权限的动作由人执行。

### 数据位置

- `<storeDir>/inventory.json` —— 程序用（原子写：同目录临时文件 + rename）；
- `<storeDir>/inventory.md` —— 人读视图，每次写台账后重新生成；
- 默认 `storeDir` 仍是 `D:\AI\dsh-data\tidy`。

台账解析失败（JSON 坏了 / 缺 `entries` / 文件为空）时，四个工具一律**拒绝写入**并报出文件路径，不会静默清空。

### 边界

- `inventory_check` 每次最多重扫 8 条已失联条目的引用（25 秒总预算），量大时分批或用 `name` 指定；
- `markRemoved` 默认关闭：要显式传 `true`，且只在「路径与数据目录都没了、也没有引用残留」时才会标；
- 复核默认只改 `stale` 标记（`markStale` 默认 `true`，只在 inventory.json 里打标记，不删记录）；想完全只读就传 `markStale:false`，想跳过后台扫描再传 `scanRefs:false`；
- 数据目录体积按「最多量 8 个、每个 1.5 秒」有界估算，超预算标「只量了一部分」；
- 只登记「已经存在」的路径；还没装的东西不能先记。

## 分类规则

- `by-type`（默认，英文分类名）：`Documents` / `Spreadsheets` / `Presentations` / `Images` / `Videos` /
  `Audio` / `Archives` / `Installers` / `Fonts` / `Subtitles` / `Logs` / `Code` / `Misc`
- `by-date`：按修改时间归到 `YYYY-MM` 文件夹
- 自定义：在 profile 的 `cordis.patch.yml` 里给 `typeMap` 加扩展名映射

## 安全设计

1. **先预览后动手**：`tidy_plan` 纯计算；`tidy_apply` 没有 `confirm:true` 一律拒绝。
2. **可撤销**：每次操作写 `manifests/<kind>-<时间戳>.json`（临时文件 + rename 原子落位），`tidy_undo` 按清单反向搬回；原位已有同名文件则跳过，不覆盖；`renameSync` 落位前再判一次目标存在（`DEST_EXISTS`，不静默覆盖）。清单写失败时返回 `MANIFEST_WRITE_FAILED` 并说明「文件已动、无法撤销」。
3. **红线目录**：`C:\Windows`、`C:\Program Files*`、`C:\ProgramData`、用户 `AppData`、
   `D:\AI\dsh-bundles`（插件源码）、`D:\AI\deepsek harness`、`D:\AI\hermes-agent`、
   `D:\AI-date\workbuddy-date\学习`（记忆红线）。采集阶段就排除。
4. **C 盘根目录拒绝整体整理**；只整理显式指定的文件夹。
5. **清理只碰白名单目录**；回收站属谨慎项，必须点名；`Windows.old` 只报告，需管理员处理。
6. **不动快捷方式与系统文件**：`.lnk`、`.url`、`desktop.ini`、`Thumbs.db` 一律跳过。
7. **有界采集**：盘点上限 8 万项 / 7 秒；目录体积最多量 20 个、超预算标「未量」不谎报 0；
   单次执行上限 300 条（`maxFiles` 可调，1-2000）：`organize` 按文件数、`clean` 按清理条目数截断，
   超限时返回实际处理数与 `remaining`，再执行一次继续。`clean` 的 `targets:[]` = 一条都不删（`EMPTY_TARGETS`），
   不是「全删」；不传 `targets` 才按默认 `policy:safe` 清理。
8. **搬目录前查依赖**（v0.4）：移动前探测服务、开机自启、计划任务、开始菜单快捷方式是否引用该目录，
   命中就列为 `blockers` 拒绝执行——避免"改名一时爽，引用全断光"。
   确需强搬时传 `force:true`，并自行准备好修改这些引用。

## 配置

```yaml
- id: butler-tidy
  name: "@local/dsh-butler-tidy"
  config:
    storeDir: 'D:\AI\dsh-data\tidy'   # 默认就在这里（本机约定不落 C 盘）
    protectDirs:                      # 追加自己的红线
      - 'E:\不许动的目录'
    typeMap:                          # 追加/覆盖分类
      '.log': 'Logs'
      '.dxf': 'Drawings'
    junkDirs:                         # 追加可清目录（id/path 必填，policy ∈ safe|cautious|admin，默认 safe）
      - id: my-temp
        label: 我的构建临时目录
        path: 'E:\build\tmp'
        policy: safe
```

数据目录（默认 `D:\AI\dsh-data\tidy`）：

- `manifests/organize-*.json` / `folders-*.json` / `rename-*.json` —— 撤销依据
- `tidy.log.jsonl` —— 操作流水
- `inventory.json` —— 安装 / 卸载台账（程序用）
- `inventory.md` —— 台账人读视图（每次写台账后重新生成）

## 验证记录

### v0.11.0（2026-10-29）安装 / 卸载台账

`_selftest/tests/butler-tidy.test.mjs`（结构冒烟 + 台账行为），**12 项检查、80 余条断言全过**：

- 4 个新工具注册齐全；9 个工具的输出 schema 与返回值逐字段核对通过（含 render 冒烟）；
- `inventory_add` → `inventory_list` 往返：编号 `inv-0001` 递增、同名再登记变「更新」、类型过滤生效；
- `inventory.json` 原子写、`inventory.md` 每次重生成、无临时文件残留；
- `plan_uninstall` 只读：执行前后目标目录还在、台账内容一字未改，输出六类引用结构 + 体积 + 进程 + 红线 + 建议步骤；
- `inventory_check` 识别「记录有但已不在」与「引用残留」，失联条目标 `stale`，确认后 `markRemoved` 进历史；
- 台账写坏时 `inventory_add` / `inventory_check` 报错且原文件一字未动；
- `tidy_status` 台账统计（条目 / 在用 / 已卸载 / 待核对）与台账一致。

示例（自测数据，非实机安装）：登记「测试应用」（`inv-0001` · 便携版 · 1 个数据目录）→ `plan_uninstall` 给出「便携版直接删目录 / 数据目录去留 / 卸后复核」3 步 → 删掉目录后 `inventory_check` 报「安装路径与数据目录都已不在，也没有关联引用」→ `markRemoved:true` 标为已卸载，历史仍可查。

### 接口契约补丁（2026-11-01）

`tidy_status` 增 `ready` / `unavailableReason`（判据＝数据目录真能读：`readdirSync(storeDir)`；目录还没建也算未就绪），`required` 含 `ready`，`ready:false` 时 render 首行「不可用：<原因>」；工具的错误返回统一带 `code`（UPPER_SNAKE：TARGET_REJECTED / TARGET_UNREADABLE / MISSING_INPUT / CONFIRM_REQUIRED / NO_MANIFEST / MANIFEST_NOT_FOUND / MANIFEST_UNREADABLE / EMPTY_QUERY / NOT_FOUND / INVENTORY_UNREADABLE / EMPTY_NAME / INVALID_KIND / EMPTY_PATH / BAD_PATH / PATH_MISSING / PATH_CONFLICT / INVENTORY_WRITE_FAILED），hint 与 render 文案不变。实测：目录存在 → `ready:true`、不存在 → `ready:false` + 「不可用：数据目录还没建…」；`inventory_add` 缺 name → `code:'EMPTY_NAME'`、`tidy_apply` 缺 confirm → `code:'CONFIRM_REQUIRED'`；`node --check` 通过、`butler-tidy.test.mjs` 12 项全过（含 9 个工具的输出 schema 严格核对）。

### v0.2.0 → v0.3.0（2026-10-27）

`D:\AI\dsh-bundles\_selftest\tidy-selftest.mjs`，假 ctx 直接驱动五个工具，**32 项断言全过**：

- 归类：10 个文件分入 8 类；`.lnk`/`desktop.ini` 跳过；不递归时子目录不入列
- 预览/确认：方案阶段零移动；无 `confirm` 拒绝执行
- 整理与撤销：移动 10 个 → 撤回 10 个，原位恢复、旧分类文件夹清空
- 目录归并：候选列出 `old-app` → 归并入 archive → 撤销还原
- 改名：`中文名.pdf → chinese-name.pdf`（自动保留扩展名）；目录改名不补扩展名；拒绝带路径的名字；无 confirm 拒绝；撤销还原原名
- 红线：`C:\Windows\Temp` 与 `C:\` 根目录均被拒
- 诊断：三类清单计数正确

**实机**：`Downloads` 2 个安装包归入 `安装包\`（96.7 MB，已记录可撤销）；
清理临时文件 85,465 个、释放 2.5 GB（19 个占用中的跳过）。

### 踩过的坑（v0.2 修复）

| 坑 | 现象 | 修正 |
|---|---|---|
| 清单排序按文件名 | `folders-*` 排在 `organize-*` 后面，`tidy_undo` 撤销错了对象 | 改为按时间戳排序 |
| 同秒两份清单 | 整理+改名同一秒发生，撤销取错 | 文件名加毫秒 |
| 数据默认落 C 盘 | 清单写进 `%USERPROFILE%\.dsh`，违反本机约定 | 默认 `D:\AI\dsh-data\tidy`，无 D 盘才退 |
| 未量目录显示 0 B | 大目录多时后面的目录误报 0 B | 加 `measured` 标记，显示「未量」 |
| 盘根改名必失败 | 目标是 `D:\` 下的对象时 `mkdirSync('D:\\')` 抛 EPERM，改名全挂 | 只在父目录不存在时才 mkdir |
| **改目录名前不查引用**（v0.4 补） | 把 `D:\YULE` 改名后，13 个开始菜单快捷方式、6 个服务、10 个注册表卸载项、1 个计划任务全部指旧路径 → 图标变白、卸载失灵 | 搬前用 `detectDependencies` 探测四类引用，命中即 `blockers` 拒绝；确需强搬传 `force:true` |
| 系统级开始菜单不可写 | `C:\ProgramData\...\Start Menu` 下的 `.lnk` 改不动（管理员所有） | 插件只动用户级；系统级需管理员修 |

## 已知边界

- 空目录清理：删的是空目录本身，没有文件损失；但**不可 tidy_undo**（空目录重建即可）。
- 重复文件检测：只比对 4 KB ~ 100 MB 的普通文件，超大文件不参与（避免长时间读盘）；
  处置方式是「移入隔离区」而非直接删，确认无用再删 `<storeDir>\_dupes\`。
- 改名支持**文件和目录**；文件会自动沿用原扩展名，目录不会补。
- 被占用的目录（有进程持有句柄、或资源管理器正打开）无法移动，会明确报「占用」并跳过。
- 浏览器缓存、缩略图缓存只报告不清理（需先关程序，交给系统设置更稳）。
- `Windows.old` 需要管理员权限，插件只提示，不执行。
- 回收站按当前用户可见范围删除，别的账户的会跳过并计入「跳过」。
- 大目录体积受每目录 20,000 项 / 1.5 秒上限约束，超出标「体积未量全」。
- 台账引用扫描只覆盖上面列的六类；CLSID / 文件关联 / COM 注册不在其中，卸载后建议再跑一次 `tidy_scan residue:true` 补扫孤儿引用。
- `inventory_check` 的复核只对「路径已不在」的条目重扫引用；路径还在的条目只核对存在性与数据目录缺项。

## 2026-11-02 升级记录

- 按 `_reports/plugin-falsepositive-scan-2026-11-01.md` 修：红线保护目录当前不存在时 tidy_status 点名告警（#37）。

> **能力边界（与相邻插件的分工）以工作区权威源 `_contracts/plugin-boundaries.md` 为准**（2026-11-12 立；与 negative-asset 的语义差异见该文件 §2）。
