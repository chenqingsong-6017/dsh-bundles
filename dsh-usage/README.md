# dsh-usage —— 跨会话 token 用量与成本报表

DSH bundle（Host 侧插件）：把本机**所有会话**的 token 用量扫出来，按天 / 模型 / 会话出报表；配了价格表就顺便算钱。

## 为什么需要

DSH 官方有 `token-meter`（当前会话的计量）和 `session-stats`（单会话统计），但没有"**跨会话、跨天、跨模型**"的累计视图。用的是按量计费的模型时，这个问题很实际：这周花了多少？哪个会话最贵？缓存到底省了多少？——这些数据其实一直都在磁盘上，只是没人把它聚合出来。

## 数据从哪来（关键设计）

DSH 把每个会话的完整事件流压缩存在：

```
~/.dsh/sessions/<工作区>/<会话id>/session.v4.jsonl.zstd
```

每条 `assistant/message` 事件都带 `usage`（input / output / cacheRead / cacheWrite）和 `message.source`（provider + model）。所以本插件**只读历史日志**，做法是：

1. 解压 + 逐行解析每个会话日志，按 `(日期, provider, model)` 聚合成桶；
2. 每个文件按 `(size, mtimeMs)` 做指纹缓存 —— 没变就不重扫，变了的那个文件才重解析；
3. 把索引存到 `config.storeDir` 的 `usage.json`（只存数字和模型名，**绝不保留 prompt / 回复正文**）。

**零上下文税**：不注册 system-prompt 段落、不订阅热路径事件、不发任何模型请求。插件只在工具被调用时读盘。

## 工具

| 工具 | 作用 |
|---|---|
| `usage_report` | `range`（today / 7d / 30d / all）× `groupBy`（day / model / session）出报表，含总计；配了价格则带成本 |
| `usage_status` | 诊断：`ready` / `unavailableReason`、索引存在哪、索引了多少会话文件/调用、最后扫描时间、价格表是否配置、运行时版本，以及对第一个会话文件的**实时探针**（lines / calls / code / error） |

## 契约（2026-11-01 统一规格）

| 字段 | 含义 |
|---|---|
| `ready` | 能不能给出**完整**报表：价格表已配置 **且** 会话日志根目录可读（只查配置与可读性，不发网络） |
| `unavailableReason` | `ready=false` 时的原因，逐条用「；」列出（如「未配置价格表（只能报 token，不报成本）」）；就绪时为空串 |
| `probe.code` | 探针的稳定错误码：正常 `''`，解压/解析失败 `USAGE_PARSE_FAILED`（细节仍在 `probe.error`） |

`usage_status` 的 render 在 `ready=false` 时首行显示 `不可用：<reason>`（`ready=true` 时显示 `状态：就绪`）。
`ready=false` 只代表「有一块能力现在给不出」，`usage_report` 本身照样能跑（没价格表就只报 token）。

## 配置

```yaml
- id: usage
  name: '@local/dsh-usage'
  config:
    storeDir: 'D:\AI\dsh-data\usage'   # 索引落盘位置（不配则 DSH_PROFILE_DIR 或 ~/.dsh/dsh-usage）
    timeZone: 'Asia/Shanghai'          # 报表日期按哪个时区切（不配则系统时区）
    currency: 'CNY'
    prices:                            # 每百万 token 单价；不配则只报 token，priced: false
      deepseek-flash:
        input: 0.5
        output: 8
        cacheRead: 0.05
        cacheWrite: 0.5
```

**包本身不写死任何绝对路径** —— 默认就能在任何机器上跑；上面的路径是本机的用户级覆盖，写在 profile 的 `cordis.patch.yml` 里。

价格表用模型名前缀匹配（`deepseek-` 能同时命中 `deepseek-flash` / `deepseek-pro`），精确命中优先。

## 安装 / 卸载

```text
plugin_manager install_bundle  target = D:\AI\dsh-bundles\dsh-usage
plugin_manager remove_bundle   target = @local/dsh-usage
```

装完刷新页面。卸载不会删索引文件（`storeDir` 下的 `usage.json` 保留，重装后直接复用）。

## 验证记录（2026-10-26，本机 desktop profile，真实数据）

| 项 | 结果 |
|---|---|
| 单测 | `_selftest/tests/usage.test.mjs` **8 项全过**（时区切日、会话 id、价格匹配、成本计算、文件枚举、聚合、多帧解压、多帧端到端）✅ |
| 真实扫描 | 15 个会话日志 / **339 次模型调用**，索引 4.6 KB，首次全量约 1 秒 ✅ |
| 按天报表 | 2026-10-26：278 次（in 1.69M / out 298.2K / 缓存读 86.42M）；2026-10-25：62 次 ✅ |
| 按模型 | `deepseek-official/deepseek-flash` 340 次，in 1.84M / out 407.0K / 缓存读 95.77M ✅ |
| 按会话 | 两个会话分别 174 / 104 次，数字与按天报表合计一致 ✅ |
| 增量 | 第二次调用不重扫（指纹未变），索引文件 mtime 不变 ✅ |
| 数据落盘 | `D:\AI\dsh-data\usage\usage.json`，C 盘无残留 ✅ |
| schema | `schema-check.mjs` 2 个工具 PASS ✅ |

## 验证记录（2026-11-01，统一契约）

| 项 | 结果 |
|---|---|
| 单测 | `_selftest/tests/usage.test.mjs` **9 项全过**（新增契约断言：`usage_status` required 含 `ready`/`unavailableReason`、`probe` required 含 `code`、不可用分支 render 出现「不可用：」）✅ |
| schema | `_selftest/schema-check.mjs`：`usage_report` / `usage_status` PASS ✅ |
| 同构 | 一次性脚本真跑 `execute()`（本机真实数据）：`ready=true`、`unavailableReason=""`、返回键与 schema 严格同构 ✅ |
| 真机 | **未做**：运行中的进程还没重载本插件行，工具面里的 `ready` 要等 profile 重组后再确认 ⏳ |

## 踩过的坑（重要）

**DSH 自带的是 Electron 44 / Node 24.21，它的 zstd 解压只解第一帧。**

会话日志是**多帧 zstd**（实测一个 1.8 MB 文件有 **834 帧**，DSH 每追加一块就一帧）。而：

| API | Node 26（独立 node） | Node 24.21（DSH 内置） |
|---|---|---|
| `zstdDecompressSync(整个 buffer)` | 全部解出 | **只解第一帧** |
| `createReadStream().pipe(createZstdDecompress())` | 全部解出 | **只解第一帧** |

表现就是插件"扫描了 15 个文件但 0 次调用"，且不报错。**修复方式**：按 zstd frame magic (`28 B5 2F FD`) 切开逐帧解压再拼接（见 `decompressSessionBuffer`），并在单测里用"两段独立压缩拼接"固定这个回归。

## 剩下的边界

- 只认 `*.jsonl.zstd`（DSH 0.2.x 的 v4 会话格式）；更早的未压缩格式扫不到；
- 增量以**文件**为单位：文件一变就整文件重解析（1.8 MB 压缩约 60-80 ms，可接受）；
- 日期按本地时区切分，跨时区迁移会让历史日期边界略有偏移；
- **会话被删除后，其历史也会从报表里消失**（报表永远反映磁盘现状，不做独立归档）；
- 成本只算 token 单价，不含套餐折扣、免费额度、按次计费等情况，属于"账面估算"；
- 只统计 `assistant/message` 的成功调用；失败的请求若有 usage 也会被计入（DSH 目前失败一般不记 usage）。

## 2026-11-02 升级记录

- 按 `_reports/plugin-falsepositive-scan-2026-11-01.md` 修：价格表前缀匹配收紧（需显式 * 通配）；event.time 缺失跳过并计数，不用 Date.now 冒充（#47 #48）。
