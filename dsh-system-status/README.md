# dsh-system-status

一个工具看全局：把工作区的体系体检（`_ops/system-health.mjs`）包成 `system_status`。

## 为什么

现有 22 个插件各有一个 `*_status`，模型要了解全局得逐个查；脚本层其实早就有总览，只是工具层没入口。本插件只做一件事：**把「整体」变成一次调用能看到的答案**。

## 工具

### `system_status`

| 参数 | 类型 | 说明 |
|---|---|---|
| `workspaceDir` | string? | 要体检的工作区根；省略则用当前工作目录 |
| `layers` | string[]? | 只返回指定层（如 `["L1"]`）；省略返回全部 |

返回：`{ ok, workspaceDir, at, verdict, failed, total, durationMs, rows[], unavailableReason? }`

## 配置（profile `cordis.patch.yml`）

```yaml
- id: system-status
  name: "@local/dsh-system-status"
  config:
    workspaceDir: 'D:\AI-date\dsh-date\dsh-创建'   # 可选
    timeoutMs: 120000                              # 可选，默认 90000
```

## 设计纪律

- **只读**：不写任何文件（体检脚本自己写 health-log，本插件不碰）。
- **单一实现**：不重写体检逻辑，spawn 现有脚本——口径跟着 `_ops` 走。
- **不粉饰**：找不到脚本 / 超时 / JSON 不合法，一律返回 `ok:false` + `unavailableReason`，绝不报「全部正常」。
