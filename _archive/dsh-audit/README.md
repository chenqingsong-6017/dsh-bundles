# dsh-audit —— agent 操作安全审计

DSH bundle（Host 侧插件）：把 **agent 每一次有副作用的工具调用**记进本地 JSONL 审计日志，按危险程度分级，参数自动脱敏。事后可以查「它到底动过什么」。

## 为什么需要

DSH 的权限模型管的是「**能不能做**」（审批、沙箱），但不管「**做过什么**」。长会话跑下来，agent 可能改过几十个文件、执行过一堆命令，事后想复盘：

- 它有没有碰过 `.ssh` / `.env` / 系统目录？
- 有没有跑过危险命令（递归删除、`git reset --hard`、`DROP TABLE`、关机）？
- 上次批量回滚是什么时候？

这些在会话日志里有，但要翻几千条事件才能拼出来。这个插件把它们**实时**抽出来，落成一行一条、可搜索的账。

## 和 checkpoint 的分工

| | dsh-checkpoint | dsh-audit |
|---|---|---|
| 记什么 | **文件内容**快照（写前留底） | **调用意图**（工具名 + 参数摘要） |
| 覆盖范围 | 只有被写/改的文件 | 命令、写操作、第三方工具、读敏感文件…… |
| 用途 | 回滚 | 复盘 / 问责 / 异常发现 |
| 数据源 | 工具执行前钩子 | 官方 `session/event` 事件流 |

两者互补：checkpoint 保证「能恢复」，audit 保证「说得清」。

## 分级规则

| 等级 | 触发条件 |
|---|---|
| **high** | 破坏性命令：`rm -rf` / `Remove-Item -Recurse` / `del /s` / `format X:` / `git reset --hard` / `git clean -f` / `git push --force` / `DROP\|TRUNCATE TABLE` / 关机重启 / `chmod 777` / `icacls grant` / `mkfs` / `diskpart` / `reg delete` / `curl … \| bash`；<br>命中敏感路径：`.ssh` / `id_rsa` / `.aws` / `.env` / `.npmrc` / `.netrc` / `credentials` / `secrets` / `.git/config` / `C:\Windows` / `System32` / `SAM` / `.kube/config`；<br>批量回滚（`checkpoint_restore all:true`）、卸载插件 |
| **medium** | 普通写入（`write` / `edit` 落到普通路径）、执行类工具、第三方 MCP 工具（`mcp__*`） |
| **low** | 其他未知但有副作用的工具（不漏账） |
| 不记录 | 纯只读且不敏感的调用（`read` / `grep` / `glob` / `repo_*` / `memory_list` / `usage_*` 等）——**但只读工具碰敏感路径照样记 high** |

## 工具

| 工具 | 作用 |
|---|---|
| `audit_report` | `range`（today/7d/30d/all）× `groupBy`（risk/tool/day）汇总，附最近 5 条高危 |
| `audit_search` | 按关键词 / 工具名 / 风险等级搜索，返回最新在前 |
| `audit_status` | 诊断：目录、天数文件、条数、字节、时间范围、保留天数、事件订阅是否在线、最近错误 |

## 配置

```yaml
- id: audit
  name: '@local/dsh-audit'
  config:
    storeDir: 'D:\AI\dsh-data\audit'   # 不配则 DSH_PROFILE_DIR 或 ~/.dsh/dsh-audit
    timeZone: 'Asia/Shanghai'          # 决定按天切文件的时区
    keepDays: 30                       # 超过这么多天的 audit-YYYY-MM-DD.jsonl 会被清理
```

**包本身不写死绝对路径**；上面的路径是本机的用户级覆盖，写在 profile 的 `cordis.patch.yml`。

## 数据长什么样

一天一个文件：`audit-2026-10-26.jsonl`，每行一条：

```json
{"ts":"2026-10-26T14:31:04.120Z","time":1793...,"session":"session-c3b2...","tool":"pwsh","risk":"high","reasons":["递归/强制删除"],"summary":"echo \"… rm -rf /tmp/x\"","cwd":"D:\\…"}
```

**只记**：时间、会话 id、工具名、风险、命中原因、脱敏后的参数摘要、cwd。
**不记**：工具返回内容、prompt、回复正文、原始密钥（`api_key=` / `Authorization:` / `sk-…` / `ghp_…` / `xox*-…` 都会被替换成 `***`）。

## 安装 / 卸载

```text
plugin_manager install_bundle  target = D:\AI\dsh-bundles\dsh-audit
plugin_manager remove_bundle   target = @local/dsh-audit
```

## 验证记录（2026-10-26，本机 desktop profile，真实事件）

| 项 | 结果 |
|---|---|
| 单测 | `_selftest/tests/audit.test.mjs` **8 项全过**（命令分级、敏感路径、只读白名单、写 medium、MCP medium、批量回滚/卸载 high、未知工具 low、脱敏）✅ |
| 订阅 | `audit_status` 显示「事件订阅：在线」，目录 `D:\AI\dsh-data\audit` ✅ |
| medium 实测 | `write D:\AI\dsh-data\tmp\audit-probe.txt` → 记为 `[medium] write` ✅ |
| high 实测 | `pwsh` 执行 `echo "… rm -rf /tmp/nonexistent-audit-probe"` → 记为 `[high] pwsh (递归/强制删除)` ✅ |
| 汇总 | `audit_report groupBy=risk`：合计 3 次（高 1 / 中 2 / 低 0），并列出最近高危 ✅ |
| 搜索 | `audit_search` 命中 3/3 条，时间倒序 ✅ |
| schema | `schema-check.mjs` 3 个工具 PASS ✅ |
| 数据落盘 | `D:\AI\dsh-data\audit\audit-2026-10-26.jsonl`，C 盘无残留 ✅ |

## 剩下的边界

- 只记 `tool/call`（**调用意图**）。被审批拒绝、执行失败也照样留一条——对审计来说这恰好是有用的信息；
- 不记录纯只读且不敏感的操作，否则日志会被 `grep`/`read` 淹没；
- 事件是 post-commit 的，热路径上只做一次小的 `appendFileSync`；写失败会记录到 `audit_status.lastError`，不会影响会话；
- **不防篡改**：本地 JSONL 谁都能改。要防篡改得配 hash chain 或把日志投递到外部系统；
- 参数摘要最多 200 字符，超长的被截断（脱敏在截断前做）；
- 敏感路径靠正则认，可能误报（比如命令里恰好出现 `.env` 字样）——宁可多报，不漏报。
