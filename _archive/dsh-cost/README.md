# dsh-cost —— 成本与上下文 HUD

> 学谁：Claude Code 的 statusline、opencode 的实时 token 显示。
> 一句话：**每轮在系统提示里附一行**，让 agent（和你）随时知道"这个会话花了多少、上下文还剩多少"。

## 它解决什么

DSH 的 token-meter 只在后台计量，agent 自己看不到。结果是要么事后翻 `usage_report`，要么等上下文爆了才发现。这一行把成本变成"常驻可见"。

## 注入长什么样

```
<cost>本会话 12 次 · in 45.2k · out 8.1k · 缓存 320k(87%) · 上下文 62.3k/128k(49%)</cost>
```

- `本会话 N 次`：当前会话的模型调用次数
- `in / out`：输入 / 输出 token 累计
- `缓存 X(命中率)`：缓存读取量 + 命中率（cacheRead ÷ 总输入）
- `上下文 used/window(pct)`：**最近一次请求的输入总量**（≈ 当前上下文占用）/ 窗口大小
- 配置价格表后才追加金额；没配就只报 token

## 数据从哪来

- `assistant/message` 事件的 `usage.inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens`
- `request/context` 事件的 `contextWindow`

**不落盘**：重启后从当前会话事件重扫一遍建立基线，天然准确，也不引入第二个存储。首轮全量扫、之后只增量累加（`WeakMap` + `WeakSet`，会话结束自动回收）。

## 配置

```yaml
- insert:
    - id: cost
      name: '@local/dsh-cost'
      config:
        maxLine: 220          # 硬上限，超出截断
        currency: '¥'         # 只有填了 prices 才会报钱
        prices:               # 每百万 token 单价
          input: 0.5
          output: 8
          cacheRead: 0.05
          cacheWrite: 0.5
```

## 边界（刻意不做）

- **只统计当前会话**：跨会话报表用 `dsh-usage` 的 `usage_report`
- **不拦截、不告警**：只显示，不做"上下文超 80% 就压缩"这类动作（那是 context-guard 的事）
- 空会话（0 次调用）**不注入**，零成本
- 首轮扫描的是会话事件，长会话首轮扫描有一次性成本（几千条事件量级，可忽略）

## 诊断

`cost_status` —— 返回精确数字（calls / input / output / cacheRead / cacheWrite / contextUsed / contextWindow / cost / priced），渲染成人话三行。

## 验证记录（2026-10-29）

单测 `node _selftest/tests/cost.test.mjs` —— **10 项全过**：

| # | 项 |
|---|---|
| 1 | 结构合规、apply 可挂载 |
| 2 | fmtTokens：k / M / 去尾随零 |
| 3 | absorbEvent：累计 usage，用最近一次输入估算上下文占用 |
| 4 | 无 usage 的事件不改统计 |
| 5 | 零调用不注入 |
| 6 | renderCostLine：次数 / 输入 / 输出 / 上下文水位 |
| 7 | 缓存命中率 = cacheRead ÷ 总输入 |
| 8 | costOf：每百万 token 单价，缺价格表报 0 |
| 9 | maxLine 硬上限截断（含收尾标签） |
| 10 | 端到端：从会话事件建基线并注入 |

> 生效需重载插件 / 重启 DSH。
