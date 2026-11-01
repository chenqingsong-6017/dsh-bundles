# dsh-eventlog

> 本地事件日志（照 Windows 事件查看器的模型）。**不进上下文**，需要时用 `log_query` 查。

## 它解决什么

`dsh-audit` 只记「agent 副作用调用」，`dsh-memory` 只记自己的变更——剩下的**静默失败**没人记：
插件加载失败、工具报错、hooks 误拦、重启前后状态、依赖缺失。这些**不报错、但行为已经不对**的事，没日志就永远查不出来。

本机真实教训：DSH rc.3→rc.5 后 computer-use 20 个工具静默归零（零日志零报错）；10-31 通知全哑，说不清几点开始坏的。

## 什么时候用

| 场景 | 用哪个工具 |
|---|---|
| 「怎么突然就这样了」——要倒带 | `log_query { since: '2d', level: 'warn' }` |
| 改动/重启后确认真的生效 | `log_query { code: 'LOG-START', since: '1h' }` |
| 记一条里程碑或静默失败 | `log_write { channel: 'plugin', code: 'PLUGIN-LOAD-FAIL', level: 'error', message: '...' }` |
| 日志本身健康吗 | `log_status` |

## 模型（Windows 事件查看器 → 本插件）

| Windows | 本插件 |
|---|---|
| Channel（应用程序/系统/安全） | `channel`：system / plugin / memory / hook / agent / restart |
| Level（信息/警告/错误/严重） | `level`：info / warn / error / fatal |
| Event ID | `code`：稳定短码（`TOOL-ERROR`、`LOG-START`、`MEM-CONFLICT`…） |
| Provider | `source`：插件名 / 模块 |
| 事件数据 | `data`：≤900 字符的小 JSON（**不放密钥与长正文**） |
| 按天滚动 + 保留天数 | `events-YYYY-MM-DD.jsonl`，默认保留 30 天 |
| 筛选查看 | `log_query` |
| 日志状态 | `log_status` |

## 数据布局

```
D:\AI\dsh-data\logs\
├── events-2026-11-01.jsonl      # 每天一个；单文件 > 8MB 时滚动成 .1.jsonl
└── events-2026-10-31.jsonl
```

单行一条事件：

```json
{"ts":"2026-11-01T01:10:00.000Z","time":1761959400000,"level":"warn","channel":"agent","code":"TOOL-ERROR","source":"web_fetch","message":"web_fetch 调用失败：..."}
```

## 设计约束

1. **不进上下文**：永不注册 systemPrompt 层，零常驻 token 成本。
2. **fail-safe**：所有写盘/清理都在 try/catch 里，失败只记 `lastError`，绝不抛给会话或其它插件。
3. **不重复**：不记全量工具调用（那是 `dsh-audit` 的活），只记错误与运维事件。
4. **自动捕获很克制**：只接 `session/event` 里的 `tool/result`（`message.isError === true` 或带 `error`）→ `TOOL-ERROR`；其余靠 `log_write` 主动写。
   真实形状是 `tool/call { callId, name }` + `tool/result { message: { isError, toolCallId, content } }`，工具名靠 `callId` 映射回查（v0.1.0 读错字段记成 `unknown / [object Object]`，v0.1.1 修）。
5. **可重造物**：日志按天滚动、超保留天数自动清（删除三查的免审通道：随时可重造的运行产物）。

## 配置（cordis.patch.yml 或 profile 层）

```yaml
config:
  storeDir: D:\AI\dsh-data\logs
  keepDays: 30
  minLevel: info          # 低于此级别不落盘
  captureToolErrors: true # false 可关掉自动捕获
```

## 验证记录

| 项 | 结果 |
|---|---|
| `node --check index.js` | 通过 |
| 单测 `_selftest/tests/eventlog.test.mjs` | 见验证门输出 |
| 真机写入 / 查询 / 状态 | 待重启后验证（见 `D:\AI\dsh-data\restart\pending.md`） |
| 统一契约（v0.1.4，2026-11-01） | `log_status` 新增 `ready` / `unavailableReason`（真判断：对日志目录做一次「建目录 → 列目录 → 写探针 → 删探针」）；`log_write` 失败带 `code`（`EMPTY_MESSAGE` / `LEVEL_FILTERED` / `WRITE_FAILED`） | 可写目录 → `ready:true`；目录建不出来 → `ready:false` + 「不可用：日志目录不可写/不可读（…）：ENOTDIR…」；三种失败码逐个实测 ✅ |

> **生效需重启 DSH**（插件 index.js 只在进程启动时求值）。
