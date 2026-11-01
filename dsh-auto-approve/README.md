# dsh-auto-approve —— 分类器代审（v1：规则引擎）

机器守住边界，人不必逐条点。

DSH 每次工具派发前都会过一层 tools/pre-execute。本插件在这里按 JSON 规则给这次调用下一个结论：**放行 / 需人工确认 / 拒绝**；没命中的调用原样交回既有审批链路，行为和不装插件完全一样。

## 学的谁

Claude Code 的 **auto 档（分类器代审）**：机器先判这次调用该不该直接放行，人只在边界上确认。DSH 原本只有「三档预设 + 人工审批」两层，中间那层代审是空的；本插件补的就是这一层。

## 与官方 dsh-experimental-auto-review 的关系（先查官方有没有）

DSH 安装包自带可选 bundle `@deepseek-ai/dsh-experimental-auto-review`：它是 Auto 预设下的 **LLM 审阅门**——每次工具派发前问一次模型，按 low/medium/high 风险给出 allow/deny，experimental，依赖 llm 服务，每次调用一次模型请求。

本插件不重复它，两者定位不同，也可以二选一：

| 维度 | 官方 auto-review | 本插件 v1 |
|---|---|---|
| 判断方式 | LLM 语义审阅 | 确定性正则规则 |
| 延迟 / 成本 | 每次调用一次模型请求（100 ms–2 s + token） | 纯正则 0.02–0.5 ms，零 token |
| 可预测性 | 同一输入可能不同结论 | 同一输入必然同一结论，可回归测试 |
| 前置条件 | Auto 预设 + llm 服务 + 密钥 | 无（内置红线开箱即用） |
| 定位 | 「语义上像不像危险操作」 | 「日常这类调用准不准放行」 |

同时开启时本插件只收紧、不放松：命中 deny/ask 早退；命中 allow 也要先问下游，下游 deny 照样拦。

## 与 dsh-hooks 六层护栏的分工

- **dsh-hooks 拦硬红线**：danger-guard 37 条（卷影/备份删除、凭据倾倒、代理执行、持久化、编码命令、反弹 shell、凭据外发、不可逆删除）、self-guard、fs-guard、code-guard、cred-guard、gui-guard，全部 onError: deny。它们是「守门」，宁可误杀。
- **本插件做日常放行判断**：内置只保留 5 条最不可逆的红线，其余交给规则文件，用来**少点确认**。默认**不做 allow 放行**（没有配置 allow 规则时，行为等于没装），避免和 hooks 抢同一个判断。
- 两层同时存在时：hooks 的 deny 不会被本插件放松；本插件的 deny 也不会因为 hooks 放行而失效。

## 规则文件

两个位置，**项目级优先**：

- 项目级：`<cwd>/.dsh/auto-approve.json`
- 用户级：`$DSH_HOME/auto-approve.json`（没设 DSH_HOME 时是 `<用户主目录>/.dsh/auto-approve.json`，用 `os.homedir()` 拼，不写死用户名）

JSON 数组（也接受 `{"rules": [...]}` 形式），每条：

    {
      "name": "跑测试",
      "tool": "^bash$",
      "match": "(pnpm|npm) test",
      "decision": "allow",
      "reason": "跑测试不需要每次点确认"
    }

- `name`：规则名，出现在判定理由和 status 里；不写自动编 #1、#2…
- `tool`：工具名正则，可省（省了匹配所有工具）
- `match`：对 `JSON.stringify(工具参数)` 做匹配的正则，可省。所以 bash/pwsh 的 command、write/edit 的 file_path 都在里面
- 正则统一按 `i` 编译（不区分大小写），**不要写 `(?i)`，JS 不支持**
- `decision`：只认 `allow` / `ask` / `deny`
- `reason`：人话理由，会原样出现在拒绝/确认提示里
- 单条坏规则只丢那一条；整个文件坏了只丢那一层（规则按空处理），错误进 status，**绝不抛错、绝不让工具调用挂掉**
- 按 mtime + size 缓存，改完不用重启，下一次调用就读新文件

## 判定模型

1. 收集命中：项目级规则 → 用户级规则 → 内置红线
2. 取最严：**deny > ask > allow**；同级并列时项目级先行（顺序本身就是优先级）
3. 无命中：交回原链路，行为完全不变

交给 tools/pre-execute 的结论：

| 命中 | 返回 | 说明 |
|---|---|---|
| deny | `{ kind: 'deny' }` | 直接拒绝，**不调 next()**（早停） |
| ask | `{ kind: 'ask' }` | 先调 next()，下游已 deny/cancel 就听下游的；否则走审批 UI |
| allow | `{ kind: 'allow' }` | 先调 next()；**只有下游本来要人工确认时才降级为放行**；下游 deny/cancel 保持 |
| 无命中 | `next()` | 恰好一次，原有审批策略照旧 |

代审的全部价值在 allow 那一行：下游本来会弹审批，这里直接放行省掉一次点击；但本就要拒绝的调用照样拒绝。

## 内置红线（没有配置也生效，只 deny）

| id | 拦什么 | 刻意不误伤 |
|---|---|---|
| rm-root | rm -rf /、rm -fr /、--no-preserve-root | rm -rf /tmp/build、rm -rf node_modules、rm -rf ~/ |
| windows-format | format C:、Format-Volume | pnpm run format、git log --format=%H |
| vssadmin-shadows | vssadmin delete shadows | vssadmin list shadows |
| ssh-write | 写 .ssh/ 目录（只对写类工具：write/edit/bash/pwsh/run_code/terminal…） | 用 read 读 .ssh 不拦（读凭据归 hooks 的 cred-guard） |
| credentials-write | 写 .credentials、.credentials.yaml 等 | 参数里出现 credentials 字样但没写文件的不拦 |

红线可以整体关：配置 `builtins: false`（不建议，除非你另有等价护栏）。

**只查路径与命令文本，不查文件内容**（踩过的坑）：write/edit 的 content、bash 的 description 里出现 `.ssh/`、`rm -rf /` 只是文字，按整段参数 JSON 匹配会把「写安全文档」也拦掉。所以内置红线只从这些参数取文本：

- 命令/代码类：command、code、script、text（bash / pwsh / run_code / terminal）
- 路径类：file_path、filePath、path、target、target_path、new_path、old_path（write / edit / apply_patch…）

自己写在规则文件里的规则没有这个限制：match 默认匹配整段 JSON.stringify(args)，想更精确就把 tool 写细一点（例如只对 `^bash$` 生效）。

## 两个工具

### auto_approve_check（干跑，调规则用）

参数：`{ tool, arguments }`。不执行任何动作，只跑一遍策略，返回人话决策。

真实输出（本机实测）：

    拒绝：命中内置红线「删除根目录」
    理由：命令行里有 rm -rf /，会清空整块磁盘，没有后悔药。
    判定耗时 0.547 ms；改规则不用重启，下一次调用就读新文件。

    不干预：没有规则命中 bash —— 这次调用交回原有审批链路，该问还是会问。
    要给这类调用定策略：在 .dsh/auto-approve.json 加一条规则（tool 写工具名正则、match 写参数正则），改完不用重启。
    想看现在读的是哪些文件、有多少条规则：调 auto_approve_status。

### auto_approve_status（诊断）

规则文件路径与是否读到、各层规则数、本次运行决策统计、最近 20 条判断（HH:MM:SS、工具、决策、规则、耗时 ms）、配置错误、v2 分类器是否启用。**内部计数只在这里出现**（plugin-ux R7）。

## 配置项（cordis.patch.yml）

    - insert:
        - id: auto-approve
          name: '@local/dsh-auto-approve'
          config:
            enabled: true          # 总开关
            builtins: true         # 内置红线
            maxRecords: 20         # status 显示多少条最近判断（1-200）
            llm:
              enabled: false       # v2 预留，默认关
              timeoutMs: 1200
            # userFile / projectFile 可覆盖规则文件路径（测试与特殊布局用）

## v1 / v2 边界

**v1 只做规则引擎**，原因：

- **可预测**：同一调用必然同一结论；出事能复盘到「命中哪条规则、来自哪个文件」
- **零延迟零成本**：纯正则 0.02–0.5 ms（实测见下），不花 token、不依赖网络
- **可测试**：18 项测试覆盖解析、优先级、红线、误伤边界、fail-safe、端到端；改规则不会引出无法解释的行为

**v2 才考虑 LLM 分类器**，代价先写清楚：

- 每次调用一次模型请求：延迟 100 ms–2 s，token 成本随调用量线性涨
- 判定不稳定：同一输入可能不同结论，要有评测集与消融才能证明「比规则更准」
- 依赖密钥与网络：失效时 fail-open（放松）或 fail-close（挡住一切），都是取舍
- 接口已留：配置 `llm.enabled` + `config.classifier(payload)` 注入的函数；超时 / 抛错 / 返回形状不对一律按「不干预」处理。**本插件不实现网络调用、不读密钥、不打包模型客户端。**
- 语义判定的正主是官方 `dsh-experimental-auto-review`，v2 若要接，优先考虑复用它而不是再造一套

## 真实验证记录（2026-10-30，本机 DSH 0.2.1-rc.3 桌面版 / Node 22）

命令 1：语法门

    node --check D:\AI\dsh-bundles\dsh-auto-approve\index.js
    → SYNTAX OK（exit 0）

命令 2：结构 + 行为测试（18 项，node 直接跑）

    node D:\AI\dsh-bundles\_selftest\tests\auto-approve.test.mjs

    ✓ 结构合规、apply 可挂载
    ✓ 规则文件路径：项目级在前、用户级由 DSH_HOME / 主目录拼出
    ✓ 规则解析：数组 / {rules} / 坏 JSON / 坏正则 / 坏 decision 都不抛错
    ✓ 内置红线命中：rm -rf /、format、vssadmin delete shadows、写 .ssh、写 .credentials
    ✓ 内置红线不误伤：/tmp、node_modules、--format=、list shadows、只读 .ssh、format 脚本
    ✓ 内置红线只查路径与命令文本：写文档提到 .ssh / rm -rf / 不误伤
    ✓ 优先级：deny > ask > allow；同级时项目级先行
    ✓ 无命中返回 none（调用方据此 next() 不干预，保持既有行为）
    ✓ 端到端：命中 deny → next 不被调用（早停），理由可操作
    ✓ 端到端：无命中 → next 恰好一次，原有行为不变
    ✓ 端到端：命中 allow + 下游要审批 → 直接放行（省掉一次点击）
    ✓ 端到端：allow 不放松下游 deny（只收紧、不放松）
    ✓ 端到端：命中 ask → 人工确认（下游已 deny 则听下游）
    ✓ 端到端：无配置时内置红线照拦
    ✓ status：规则文件 / 条数 / 统计 / 最近 20 条 / 人话渲染
    ✓ auto_approve_check：干跑给人话决策（拒绝 / 不干预）
    ✓ 坏配置 fail-safe：不干预 + 记进 status + 工具调用不挂
    ✓ v2 分类器接口：默认关闭、注入后接管、异常 fail-safe

    auto-approve: 18 项通过（exit 0）

命令 3：真实调用纯函数（测单次判定耗时，7 个 case）

    node D:\AI\dsh-data\tmp-verify-auto-approve.mjs

    --- bash {"command":"rm -rf /"}
    拒绝：命中内置红线「删除根目录」
    理由：命令行里有 rm -rf /，会清空整块磁盘，没有后悔药。
    判定耗时 0.547 ms；改规则不用重启，下一次调用就读新文件。
    --- bash {"command":"rm -rf /tmp/build"}
    不干预：没有规则命中 bash —— 这次调用交回原有审批链路，该问还是会问。
    --- bash {"command":"vssadmin delete shadows /all /quiet"}
    拒绝：命中内置红线「删除卷影副本」
    理由：命令行里有 vssadmin delete shadows，会删掉系统还原点与卷影备份。
    判定耗时 0.016 ms
    --- bash {"command":"git log --format=%H -3"}
    不干预：没有规则命中 bash
    --- write {"file_path":"C:\\Users\\x\\.ssh\\config"}
    拒绝：命中内置红线「写 .ssh 目录」
    判定耗时 0.024 ms
    --- read {"file_path":"C:\\Users\\x\\.ssh\\config"}
    不干预：没有规则命中 read
    --- bash {"command":"pnpm test"}
    不干预：没有规则命中 bash
    --- 坏 decision 的解析结果: {"rules":[],"errors":["第 1 条：decision 必须是 allow / ask / deny"]}

单次判定 0.016–0.55 ms，满足「单次判断纯正则，10 ms 量级」的要求。

**2026-11-01 接口契约补丁**：`auto_approve_status` 增 `ready` / `unavailableReason`（判据＝插件启用且「项目级/用户级规则文件可读 或 内置红线开着」），`required` 含 `ready`，`ready:false` 时 render 首行「不可用：<原因>」；本插件不返回错误对象（坏配置一律 fail-safe 放行并记进 `status.errors`），`code` 只需保留原有的 `AUTO_APPROVE_DENIED`。实测：项目级规则文件可读 → `ready:true`；`enabled:false` → `ready:false`（理由「插件已停用」）；无规则文件 + `builtins:false` → `ready:false`；`node --check` 通过、`auto-approve.test.mjs` 19 项全过。

安装/重载由 Lead 统一做：源码在 `D:\AI\dsh-bundles\dsh-auto-approve`，用 plugin_manager install_bundle 安装，重载用 remove_bundle + install_bundle。

## 已知边界（诚实清单）

- **审批策略是 never 时，ask 会直接失败**：DSH 的 serviceAsk 在没有审批通道、或调用没有 agent 可路由时直接返回 deny（源码：dsh-tools 的 serviceAsk）。所以本插件的 ask 规则在 `approval=never` 下等价于更硬的拒绝。**适用场景是 workspace-write + approval=ask**；本机现状（danger-full-access + never）下，ask 规则等于拒绝，属预期行为。
- **只审外层工具派发**：run_code 内部发起的 PTC 子调用不经过这里（官方 auto-review 也刻意排除外层 run_code）。
- **监听顺序依赖插件加载顺序**：若别的插件在本插件之前就返回 ask/deny，本插件拿不到这次调用。所以「本插件判 allow 却仍被拦」是可能的；反方向不会（本插件只收紧）。
- **只有正则，没有语义**：命令拆分、编码绕过（cer""tutil、base64）、多步攻击链拦不住——这是 dsh-hooks 与静态黑名单共同的已知缺口，也是 v2 存在的理由。
- **不落盘、不联网**：最近判断记录只在内存里（最多 200 条，status 默认显示 20 条），重启即清空。

## 文件清单

    package.json        # type: module、engines node>=22.19、exports 含 . / ./locale/*.json / ./icon、dsh.bundle.patch
    cordis.patch.yml    # insert 到 auto-approve，config 见上
    index.js            # export function apply(ctx, config)；导出纯函数给测试
    locale/zh.json      # meta.title / meta.description
    locale/en.json
    icon.svg
    README.md

测试：`D:\AI\dsh-bundles\_selftest\tests\auto-approve.test.mjs`

## 安装与重载（Lead 负责）

1. 源码在 `D:\AI\dsh-bundles\dsh-auto-approve`，不要放进工作区
2. `plugin_manager install_bundle` 安装；改完重载用 `remove_bundle` + `install_bundle`（热替换不换 JS 模块代际）
3. 装完先跑 `auto_approve_status`：确认两个规则文件路径、内置红线 5 条
4. 再跑 `auto_approve_check` 试几条日常命令（例如 pnpm test 应读作「不干预」或「放行」，取决于规则）
