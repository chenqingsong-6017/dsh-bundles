# dsh-updater —— 插件更新器 + GitHub 学习台

给本机的 DSH 插件一条**可验证、可回退**的"从远端长进"的通道。

两个能力，共用一套安全边界：

| | 做什么 | 花不花 token |
|---|---|---|
| **A 版本同步** | `check` 比对远端提交 → `apply` 克隆+校验+备份+落位 → `rollback` 一键还原 | 不花（纯 git） |
| **B 学习台** | `study` 把公开仓库克隆到本地、出源码地图，之后 agent 用 read/grep 自己读、自己提炼、自己改 | 不花（插件不调模型） |

> 曾经有过第三个能力「自动进化」(`updater_evolve`)：自己搜 GitHub → 克隆 → 调模型产提案。
> 实测后**主动砍掉了**，原因见下面「B 部分刻意不在插件里调 LLM」。

---

## 为什么这样设计

### 全走 git，不碰 GitHub API

实测本机：

- `api.github.com` 未认证配额只有 **60 次/小时**
- `raw.githubusercontent.com` **超时**（该域名被单独干扰）
- `git ls-remote` **1.3 秒**、`git clone` 正常

所以拉取、比对、克隆全走 git 协议，两个坑都没有。`updater_check` 走 `ls-remote`，**零 API 配额消耗**。

### B 部分刻意不在插件里调 LLM

这个方向**真做过一版，然后砍掉了**（`updater_evolve`）。当时的做法是：插件自己搜 GitHub → 克隆参考仓库 → 把目标源码和参考实现塞进 prompt → 调 `ctx.llm` 让模型产改进提案 → 审过后精确替换。

技术上完全跑通了，也真的改对了东西（在 `dsh-verify` 上抓到两处注释与代码打架的地方，其中一处是人工漏改的 bun 探测）。但结论是不划算：

1. **「从 GitHub 学习」这一环实测是空转的。** GitHub 上 DSH 插件生态还很新，搜「test runner detect」返回的是 PHP 的 TDDRunner 和 Rust 的 RAZ——模型自己都判定"与 DSH 插件的工具注册模型差异太大，没有可借鉴的实现细节"。
2. **它唯一做出成绩的那件事，是审自己的代码，不是学别人。** 而"审代码"这件事 agent 做得更好：能读全文、能 grep 交叉验证、能跑测试、能多轮纠正；插件只有**单轮**调用 + 截断 22000 字符的源码 + 没工具。
3. **成本不划算**：每跑一次 = 一次模型调用 + 一次搜索 + 克隆两个仓库（遇到过 76 秒的），产出通常 0-2 条浅层改动。

现在的分工是：

1. `updater_study` 负责**搬运**：克隆到 `learn/<slug>/`，返回文件树、`package.json`、README 头、入口文件预览
2. **agent 负责推理**：用常规 read / grep 读那个目录，提炼可借鉴点，写 diff 提案
3. 你审批后，agent 改代码
4. 重载验证

每一步都可检查、可复现。插件是哑的，判断在 agent 和用户手里。

### apply 不自己重载

`updater_apply` 只把文件落到本地目录，**不**调 `plugin_manager`。插件里没有、也不该有那个服务——自己改 profile 会绕开它的校验。落位后它会返回 `reloadHint`，由 agent 走 `remove_bundle` + `install_bundle`（热替换不换 JS 模块代际，必须重装）。

---

## 工具

### `updater_status`

诊断。存储位置、git/node 是否可用、每个源的本地目录 / 已装版本 / 已应用提交 / 备份占用 / 是否在写入白名单内、已克隆的学习样本。

先跑这个，确认闸门和登记状态。

### `updater_source`

登记更新源。`add` / `remove`（remove 只忘记登记，不动文件）。

| 字段 | 说明 |
|---|---|
| `name` | 稳定短键，如 `dsh-memory` |
| `repo` | git 远端 URL 或本地裸仓库路径 |
| `ref` | 分支 / tag / 提交 SHA，默认 `HEAD` |
| `subdir` | 插件在仓库里的子目录；插件在仓库根就留空 |
| `localDir` | 本地插件目录，**必须在 allowedRoots 内** |
| `bundleName` | 装上去的包名，只用于报告 |

### `updater_check`

对每个源跑 `git ls-remote`，比对远端提交与本机已应用提交。不写盘、不耗 API 配额。

状态：`up-to-date` / `behind` / `baseline-missing`（还没 apply 过，不谎报"落后"）/ `no-local` / `error`。

### `updater_apply`

`name` 必填。`dryRun: true` 只克隆+校验+算差异，**不写盘**；真正落盘要 `confirm: true`。

流程：浅克隆 → 定位子目录 → 静态校验 → 算差异 → 整目录备份 → 落位。

校验门（任何 error 都会中止，本地不动）：
- `package.json` 存在且合法
- `dsh.bundle.patch` 声明且指向的文件存在
- 入口文件存在，且有 `export function apply` 或 `export default`
- 所有入口级 `.js` 过 `node --check` 语法检查

`prune` 默认 **false**：本地插件常有人工改动，盲目对齐会让它们消失。要完全对齐才传 `prune: true`。

### `updater_rollback`

从最近（或指定）备份还原。`confirm: true` 必填。

**回滚前会先把当前状态另存一份**（`safety-<时间戳>`），所以"回滚的回滚"也可用。安全备份只保留最近 3 份。

### `updater_study`

`repo` 必填。克隆到 `<storeDir>/learn/<owner-repo>/`，返回：

- `dir` / `focusDir`（传了 subdir 时）
- `sha`、文件数、总大小
- `tree`（最多 240 项）
- `packageJson`、`readme`（截断）、`entrypoints`（入口文件预览）

同一个 repo 再调会**复用**已有副本（`reused: true`），`fresh: true` 强制重克隆。

---

## 典型用法

### 从 GitHub 跟进一个插件

```
updater_source  add  name=dsh-memory repo=https://github.com/你/dsh-memory.git localDir=D:\AI\dsh-bundles\dsh-memory
updater_check                          # 看有没有新提交
updater_apply   name=dsh-memory dryRun=true    # 先看差异，不写盘
updater_apply   name=dsh-memory confirm=true   # 确认后落位
plugin_manager  remove_bundle → install_bundle # 重载
```

出问题：

```
updater_rollback name=dsh-memory confirm=true  # 一键还原
```

### 单机自托管：插件还没有自己的 GitHub 远端

本机插件是 `link:` 安装的，**源码目录就是运行目录**。没有远端时的用法是让裸仓库保存「下一个版本」：

```powershell
# 1) 建一个本地裸仓库
git init --bare D:\AI\dsh-data\updater\remotes\你的插件.git

# 2) 在一个开发区里工作（不要直接在插件目录改，否则 apply 就没意义了）
#    把插件当前内容复制到开发区，init/commit/push 当作基线

# 3) 登记
#    updater_source add name=你的插件 repo=D:\AI\dsh-data\updater\remotes\你的插件.git localDir=D:\AI\dsh-bundles\你的插件
```

之后：在开发区改 → `git push` → `updater_check` 看到 `behind` → `updater_apply` 落位 → 重载。坏了就 `updater_rollback`。

这也是 `dsh-verify` 试点的做法（见验证记录第 5 节）。等哪天有了 GitHub 仓，只改 `updater_source` 里的 `repo` 就行，别的不用动。

### 从 GitHub 学一个插件

```
updater_study repo=https://github.com/seaison/dsh-plugin-eva-theme.git
# 返回里拿到 dir，然后：
#   read  dir/package.json
#   grep  "ctx.effect" dir/index.js
# 自己提炼 → 写提案 → 改代码
```

---

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: updater
  name: "@local/dsh-updater"
  config:
    storeDir: 'D:\AI\dsh-data\updater'   # 数据落盘位置
    allowedRoots:                        # 写入白名单（硬闸门）
      - 'D:\AI\dsh-bundles'
    backupsToKeep: 5                     # 每个源保留几份备份
    gitTimeoutMs: 120000                 # 单条 git 命令超时
```

存储结构：

```
D:\AI\dsh-data\updater\
  sources.json                每个源的登记与已应用提交
  backups\<名字>\<时间>-<sha>\tree\   整目录备份（不含 .git / node_modules）
  staging\                    克隆暂存，用完即清
  learn\<owner-repo>\         学习样本
```

---

## 安全边界

写入受三层限制，任何一层不过就拒绝：

1. **白名单**：`localDir` 必须在 `allowedRoots` 内
2. **受保护路径**：拒绝 `Windows` / `Program Files` / `ProgramData` / `.dsh` 路径段
3. **环境目录**：拒绝 `DSH_PROFILE_DIR` / `DSH_HOME` 之内

另外：

- `apply` / `rollback` 必须 `confirm: true`
- `apply` 写盘前先做完整备份；写盘中途失败会**立即用备份还原**
- 备份不含 `.git` / `node_modules`：apply 从不改 `.git`，备份它纯属浪费（eva-theme 的 `.git` 有 21 MB）

### 两个实测踩到的坑（已修）

1. **`raw.githubusercontent.com` 超时** → 不用它，全走 git
2. **全局 `core.autocrlf` 会让新克隆的文本变 CRLF**，apply 就会把所有文件行尾改掉。实测在 eva-theme 上表现为 **57 个文件"全部改动"**。修法：所有 git 命令强制 `-c core.autocrlf=false -c core.eol=lf`

---

## 验证记录

### 1. 端到端（真 git、真克隆、真备份回滚）

`_selftest/tests/updater.test.mjs`，**23 项全部通过**。做法是 mock 一个最小 ctx（`tools.register` 收集 + `subprocess` 用真 `child_process` 驱动真 git），直接调用每个工具的 `execute`。场景：

- 本地裸仓库当远端，真 commit + 真 push
- 登记 → 首次 check 报 `baseline-missing`（不谎报落后）
- `dryRun` 通过校验且**不写盘**
- 无 `confirm` 时拒绝写入
- 白名单外 `localDir` 拒绝登记
- `apply` 成功，本地 `package.json` 真变成 1.0.0，默认保留本地独有文件
- 远端推到 v2 → check 报 `behind` → `apply prune=true` 成功，本地独有文件被清
- `rollback` 成功，版本真回到 1.0.0，且有安全备份
- **校验门拦截**：远端提交一个语法错误的 `index.js`，apply 报 `rejected`，本地文件**逐字节未变**
- `study` 克隆成功出源码地图；再调一次 `reused: true` 不重复克隆

### 2. 真实 GitHub 联调

`_selftest/updater-live.mjs` 对着**真实公开仓库 + 本机真实插件**跑 dryRun（不写盘）：
仓库 `https://github.com/seaison/dsh-plugin-eva-theme.git`，本地 `D:\AI\dsh-bundles\dsh-plugin-eva-theme`。

```
check     1780 ms  →  远端 f8b96381，baseline-missing
dryRun    7751 ms  →  status=validated  files={0,0,0}  （新增0/改动0/删除0）
diffStat  新增 0 · 改动 0 · 删除 0
issues    [warn] 没有 icon.svg；[warn] 没有 locale/   ← eva-theme 本身确实没有
本地仍为 0.51.2（dryRun 未写盘）
study     4820 ms  →  98 个文件，sha=f8b96381，树的头几项是 README/LICENSE/assets
```

**关键结论**：本地是同一提交的 `git clone`，逐字节比对结果正是**零差异**。这一条同时证明了两件事——CRLF 修复生效（修前报 57 个假改动），`.git` 噪音消除（修前 diffstat 16 行全是 `.git` 内部文件）。

### 3. 真实 DSH 运行时调用（装进插件后，走真正的工具通道）

安装返回 `application: applied`，然后在**真实运行时**里逐个调：

```
updater_status   → 存储 D:\AI\dsh-data\updater；git 可用；node 24.21.0；白名单 D:\AI\dsh-bundles；0 个源
updater_study    → ✓ @ f8b96381，98 个文件 / 21774 KB
                   dir=D:\AI\dsh-data\updater\learn\seaison-dsh-plugin-eva-theme
updater_source   → ✓ 已登记 eva-theme → github.com/seaison/dsh-plugin-eva-theme
updater_check    → 检查了 1 个源，0 个有新提交；· eva-theme 未建立基线（首次 apply 后即可比对）  远端 f8b96381
```

`check` 报 `baseline-missing` 是**正确**行为：本地还没通过本插件 apply 过，没有已应用提交可比；远端提交已经真实拿到了（`f8b96381`）。

### 4. 测试期间发现并修掉的 4 个 bug

| bug | 症状 | 修法 |
|---|---|---|
| 受保护路径写太宽 | 把 `AppData` 整段拦掉，临时目录里的合法插件被拒 | 只拦真正危险的路径段 + 显式判 `DSH_PROFILE_DIR` / `DSH_HOME` |
| `git diff --no-index` 比较两个目录 | `.git/` 的 index/pack/logs 全算差异，57 条噪音 + 泄漏绝对路径 | 改成按 `walkFiles` 干净视图自己比，unified diff 只对前 12 个改动文件生成 |
| `core.autocrlf` 污染 | 新克隆的文本变 CRLF，apply 会改掉所有文件行尾 | 所有 git 命令强制 `autocrlf=false`、`eol=lf` |
| `subprocess.spawn` 的 `cwd` 不能是 `undefined` | 真实运行时 `study` 报 `Cannot read properties of undefined (reading 'includes')`，还被 catch 伪装成"git clone 失败"；mock 测不出 | `git()` 里 cwd 缺省填 `process.cwd()` |
| Windows 上删 git 目录的 EPERM | `apply` 第一次跑就 `EPERM ... staging\...`；`cloneTo` 里先 `rmSync` 再建父目录，父链不存在时删目标失败 | 先 `mkdirSync` 父目录再删；新增 `forceRm`（清 `.git/objects` 只读位 + 重试） |
| 同大小的大文件被判成"改动" | 改行尾分类时把 >4 MB 且大小相同的文件直接判 `differ`，eva-theme 的 `nerv-boot-music.mp3` 因此误报 | 同大小的大文件直接视为相同（不读内容），避免误报也避免吃内存 |

### 5. 真实闭环试点：`dsh-verify` v1.0.1 → v1.1.0

用本地裸仓库当"远端"，对一个真实插件跑完整闭环（改→推→检查→应用→重载→回滚→再前进）：

```
远端      D:\AI\dsh-data\updater\remotes\dsh-verify.git
开发区    D:\AI\dsh-data\updater\work\dsh-verify
插件目录  D:\AI\dsh-bundles\dsh-verify
```

| 步骤 | 结果 |
|---|---|
| 推基线 | `4d9f8f5`，版本 1.0.1 |
| `source` 登记 | ✓ 本地 1.0.1 |
| `apply`（建基线） | 零内容改动，只把 `package.json` 的 CRLF 规范成 LF |
| 开发区改代码并推 | `558daf0`，版本 1.1.0，3 个文件 |
| `check` | `↑ dsh-verify 有新提交 远端 558daf0b` |
| `apply dryRun` | `1.0.1 → 1.1.0`，3 个改动，diff 正确 |
| `apply confirm` | ✓ 落位，备份 `20261027-225914-4d9f8f52` |
| 重载 | `version: 1.1.0`，探针 6 项全过、原回归 7 项全过 |
| `rollback` | ✓ 还原 7 个文件，另存 `safety-20261027-230025` |
| 重载后验证 | `version: 1.0.1`，行为真回到旧的错误值 |
| 再 `apply` 前进 | ✓ 回到 1.1.0，探针 6 项全过 |

**这次试点改了什么**（`dsh-verify` 的真实缺口）：

1. **`bun` 锁文件识别**：原来只认 pnpm / yarn / npm，bun 项目会被错跑成 `npm run test`。现在认 `bun.lockb` 和 `bun.lock`（Bun 1.2+）。
2. **`tsconfig.json` 兜底**：有 tsconfig 却没配 `typecheck` 脚本时，原来什么都检测不到。现在按包管理器跑 `tsc --noEmit`（npm→`npx`、pnpm→`pnpm exec`、bun→`bunx`）。

对照验证：旧版探针第一项就失败（`npm run test` ≠ `bun run test`），新版 6 项全过。

**试点里额外发现的事实**：`dsh-verify/package.json` 原本是 CRLF，其余 6 个文件是 LF——同一个插件目录里行尾不一致。`updater` 会把它单独报成"仅行尾不同"并在 apply 时统一成 LF，不会混进"内容改动"。

第 4 个是**mock 测试测不出来**的那类：本地测试用的替身能容忍 undefined 的 cwd，真实 `subprocess.spawn` 会在内部解引用时崩。装进 DSH 后一调就暴露，说明"只跑单测"不够，必须真实调用。

---

## 已知边界

- 只支持 git 远端。没有 git 就整体不可用（`updater_status` 会直接报）。
- **不做 merge**：本地人工改动不会与新版合并，apply 是"新版覆盖 + 备份留证"。
- `ref` 支持分支名和 tag；提交 SHA 能作为 `ref` 传入（clone 后 fetch + checkout），但不能走 `--branch`。
- 不跟踪远端版本号：check 比的是提交 SHA，`package.json` 的版本号只在 apply 后可见。
- 私有仓库需要本机 git 凭据。插件不处理认证（刻意清空 credential helper / askPass 以免卡在密码提示），失败会把 git stderr 原样带出来。
- 备份不含 `.git`：如果你的插件目录是 git 仓库，回滚**不会**还原 git 历史（但 apply 也从不改它）。

## 装法

```
plugin_manager install_bundle  target: D:\AI\dsh-bundles\dsh-updater
```

改动后用 `remove_bundle` + `install_bundle` 重载（热替换不换 JS 模块代际）。
