# dsh-hooks —— 用户级 Hooks：把纪律写成配置，而不是再写一个插件

> 一句话：**一个 `hooks.json`，就能在工具调用前拦一道、在调用后回灌一句。** 不用写插件、不用重启。

## 1. 为什么做这个

2026 年同类产品的分水岭是「审批自动化 + 纪律内建」。Claude Code 的 hooks 覆盖 17 个生命周期事件，官方最推荐的用法只有两条：

- `PreToolUse` —— 在危险命令**执行之前**拦下；
- `Stop` —— 回合结束前起一个子 agent 读文件、跑测试，**证明活干完了才允许结束**。

DSH 的事件底座其实比它更硬（`tools/pre-execute` 可 `allow / deny / ask / cancel`），但**只对插件作者开放**：普通用户想加一条「`rm -rf /` 先拦一下」，得自己写一个插件。

本插件把那层能力产品化：**一张事件表 + 一个 JSON 文件**。

## 2. 支持的事件

| 事件（别名也认） | 挂在 DSH 的 | 能力 |
|---|---|---|
| `tool.pre`（`PreToolUse`） | `tools/pre-execute` | **唯一能拦动作的**：`allow` / `deny` / `ask` |
| `tool.post`（`PostToolUse`） | `tools/post-execute` | 只观察；stdout 作为提示回灌给模型 |
| `session.start`（`SessionStart`） | `agent/created` | 观察（日志 / 通知） |
| `turn.stop`（`Stop`） | `agent/turn-stopping` | 观察；**不能否决回合**——要否决请用 dsh-proof 的验证门 |

> `turn.stop` 不能否决是 DSH 事件签名决定的（返回 `void`）。想要「测试不过就不许收工」，正解是 `dsh-proof`：它在 `npm run check` 失败时把 agent steer 回来。

## 3. 配置

放在哪（按优先级，第一个存在的生效，**多个文件会合并**）：

1. `config.file`（本插件行的显式指定，写了就不再读别的）
2. `$DSH_HOOKS_FILE`
3. `<会话工作目录>/.dsh/hooks.json` —— **工作区级**，随项目走、可进 git
4. `$DSH_HOME/hooks.json` —— 全局
5. `$DSH_PROFILE_DIR/hooks.json` —— 本 profile

最小示例：

```json
{
  "hooks": [
    {
      "name": "danger-guard",
      "event": "tool.pre",
      "match": "^(bash|pwsh)$",
      "run": "node \"D:/AI/dsh-bundles/dsh-hooks/examples/guard-danger.mjs\"",
      "timeoutMs": 4000
    }
  ]
}
```

字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `event` | ✅ | `tool.pre` / `tool.post` / `session.start` / `turn.stop`，别名见 §2 |
| `run` | ✅ | shell 命令（Windows 走 cmd.exe，类 Unix 走 sh） |
| `match` | | 工具名的正则（大小写不敏感）；`tool.*` 事件不写则匹配所有工具 |
| `name` | | 日志里显示的名字，默认 `event#序号` |
| `timeoutMs` | | 默认 5000，上限 60000 |
| `onError` | | 钩子崩溃/超时时怎么办：`allow`（默认）或 `deny` |
| `cwd` | | 钩子的工作目录，默认会话工作目录 |
| `enabled` | | `false` 临时停用 |

## 4. 钩子进程契约（照 Unix 惯例，不发明协议）

```
stdin  : 一行 JSON —— {event, tool:{name,arguments}, agent:{id}, cwd, timestamp, host}
stdout : 空 → 放行
         JSON {"decision":"deny|ask|allow","reason":"…","message":"…"} → 采纳
         tool.post 的纯文本 → 作为提示回灌给模型
exit 2 : 视为 deny，stderr 当理由（grep/diff 同款惯例）
exit ≠0: 按 onError 处理，并记进 hooks_status
超时    : 按 onError 处理
```

## 5. 附带工具

| 工具 | 作用 |
|---|---|
| `hooks_status` | 配置在哪、每个事件几条、本轮执行/拒绝/确认计数、最近执行、配置错误 |
| `hooks_test` | **不执行真动作**，只跑匹配的钩子看它会怎么判（改完配置先跑这个） |
| `hooks_reload` | 强制重读配置（平时不用：文件按 mtime 自动热加载） |

## 6. 两个现成示例

`examples/guard-danger.mjs` —— 拦住「删掉就回不来」的命令：递归删根目录/家目录/盘符、`format`、`mkfs`、`diskpart`、`Remove-Item -Recurse` 整个盘、直写 `/dev/sdX`。**故意不拦** `git reset --hard` 这类可恢复操作，避免变成天天点确认的噪音。

`examples/post-reminder.mjs` —— 每次 shell 调用后回灌一句提醒（默认配置里没启用，因为会刷屏；需要就加一条 `tool.post`）。

> 示例脚本都用 **node 而不是 echo**：Windows 的 `cmd.exe` 按控制台代码页（中文系统 GBK/936）输出，中文会乱码；node 写管道固定 UTF-8。插件侧也做了 GBK 回退解码，双保险。

## 7. 安全边界（说实话）

- 钩子是**你自己写的 shell 命令**，权限等价于你自己的终端。本插件不含任何内置放行策略，也不联网。
- `onError: "allow"` 是默认值：钩子挂了/超时不挡路。要「宁可错杀」，把它设成 `"deny"`。
- 钩子超时会 `kill` 自己那一层进程；**Windows 上它的子孙进程可能还活着**（job object 才管得住，本插件没做）。
- `tool.post` 只拿到调用参数，**拿不到执行结果**（DSH 这个事件的 payload 里没有结果摘要）——所以它适合做「提醒」，不适合做「按结果决策」。按结果决策请写在 `tool.pre` 或交给 `dsh-proof`。

## 8. 验证记录（2026-10-29，真实会话）

| 场景 | 操作 | 结果 |
|---|---|---|
| 结构 | `runSmoke('dsh-hooks')` | 包名/patch/locale/icon/入口全部合规 ✅ |
| 纯函数 | 事件别名、配置解析（坏条目逐条报错）、匹配、决策翻译（exit 0/2/1、超时、onError）、来源优先级、GBK 解码 | 10 项断言全过 ✅ |
| 端到端 | mock ctx 里挂 `tools/pre-execute` + `tools/post-execute`，起**真实子进程** | deny / 放行 / 后置回灌都对 ✅ |
| **真机拦截** | `pwsh: echo mkfs.test` | 被 `danger-guard` 拒绝，理由含「命中危险模式：建文件系统 / 分区操作」与放行办法 ✅ |
| **真机回灌** | `pwsh: node --check ...` | 结果前出现 `(dsh-hooks) 刚跑了 pwsh：…`（UTF-8 中文正常）✅ |
| 热加载 | 改 `hooks.json`（2 条 → 1 条）后直接查状态 | 立刻变成「已加载 1 条钩子」，无需重启 ✅ |
| 计数 | `hooks_status` | 执行 7 次、拒绝 2 次，逐条带时间戳与耗时（30–88ms）✅ |
| 统一契约（v0.1.1，2026-11-01） | `hooks_status` 新增 `ready` / `unavailableReason`（真判断：配置文件读得动且钩子数 >0） | 真配置 → `ready:true` 照常输出；`DSH_HOOKS_FILE` 指向不存在文件 → `ready:false` + 「不可用：没有找到 hooks.json（候选：…）」；`hooks_test('nonsense')` → `code=UNKNOWN_EVENT` ✅ |

安装方式（本机已在用）：

```
plugin_manager: install_bundle  target=D:\AI\dsh-bundles\dsh-hooks
```

卸载：`plugin_manager: remove_bundle target=@local/dsh-hooks`（配置文件留在原处，删不删随你）。

## 9. 已知限制

1. 钩子里 `runShell` 用 `shell: true`，**不支持管道式多次调用**（要串就用 `&&` 或写脚本）。
2. 每个事件按配置顺序**串行**执行；单条超时按 `onError` 处理，不会并行。
3. 配置上限默认 50 条（`config.maxHooks`），防止误写几百条拖慢每次工具调用。
4. `session.start` / `turn.stop` 在 `session/created` 之前拿不到工作目录时，只读全局与 profile 级配置（工作区级要等会话登记后才生效）。
