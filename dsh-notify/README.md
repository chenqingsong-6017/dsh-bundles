# dsh-notify —— 任务完成 / 失败通知

DSH bundle（Host 侧插件）：长任务跑完或失败时给你发**桌面通知**；短问答保持安静。另提供一个 `notify` 工具，agent 可以在任务中途主动喊你。

## 为什么需要

DSH 跑一个任务可能要好几分钟。你切走去干别的，回来才发现：

- 「其实 8 分钟前就跑完了」
- 「3 分钟前就报错了，白等」

这个插件在**回合结束**时判断值不值得打扰，而不是每轮都叮一声。

## 什么时候会通知

| 场景 | 默认行为 |
|---|---|
| 回合完成，耗时 ≥ 60 秒 | ✅ 通知 |
| 回合完成，耗时 < 60 秒 | 静默（避免噪音） |
| 回合失败 / 出错 | ✅ 立即通知（不受时长限制） |
| 撞到 max-tokens | ✅ 通知 |
| 被中断 | 静默（`notifyOnInterrupt: true` 可开） |

判定都在 `shouldNotify()` 里，配置项都能关。

## 三级回退（这是本插件最容易踩坑的地方）

通知发送按顺序尝试：

1. **原生 Toast** —— `powershell.exe`（Windows PowerShell **5.1**）+ WinRT `ToastNotificationManager`
2. **托盘气泡** —— `pwsh` + WinForms `NotifyIcon.ShowBalloonTip`（不依赖 WinRT）
3. **只记日志** —— 前两条都不行时，写一行到 `notify-*.jsonl`，不报错、不影响会话

### ⚠️ 两个真实踩过的坑

**坑 1：pwsh 7 加载不了 WinRT 类型。**

```
pwsh 7.6.7 → ERR: 找不到类型 [Windows.UI.Notifications.ToastNotificationManager, ...],
             ContentType=WindowsRuntime
```

PowerShell 7 基于 .NET Core，**移除了 WinRT 类型投影**。同样一行代码在 `powershell.exe` 5.1 里可以。所以原生 Toast 这一步必须用 5.1 解释器，不能用 `pwsh`。

**坑 2：5.1 里 WinRT XmlElement 的 `InnerText` 不可写。**

网上的大部分示例写 `$xml.GetElementsByTagName('text')[0].InnerText = '标题'`，在 5.1 里会抛：

```
The property 'InnerText' cannot be found on this object.
```

可靠写法是用 `XmlDocument.LoadXml('<toast>…</toast>')` 直接构造整段 XML（本项目用的就是这个）。

**坑 3（自己的 bug）**：第一版脚本 `catch { exit 0 }`，把失败伪装成了成功。现在失败一律 `exit 2`，上层据此区分「真的弹出来了」和「只是没报错」。

## 工具

| 工具 | 作用 |
|---|---|
| `notify` | 立刻给人类发一条通知（长任务中途汇报、请求关注） |
| `notify_status` | 诊断：可用通道、最近实际通道、触发阈值、发送计数、日志位置、最近错误 |

## 配置

```yaml
- id: notify
  name: '@local/dsh-notify'
  config:
    storeDir: 'D:\AI\dsh-data\notify'
    timeZone: 'Asia/Shanghai'
    minDurationMs: 60000        # 只有超过这么久的回合完成才通知
    notifyOnComplete: true
    notifyOnError: true
    notifyOnInterrupt: false
    sound: true                 # false 时 Toast 静音（嵌 <audio silent="true"/>）
```

**包本身不写死绝对路径**；上面的路径是本机用户级覆盖，写在 profile 的 `cordis.patch.yml`。

## 数据

`notify-YYYY-MM-DD.jsonl`，一行一条发送记录：

```json
{"ts":"2026-10-26T14:42:00.000Z","time":1793...,"title":"任务完成","body":"「dsh-创建」跑完了，用了 3 分钟 · 会话 c3b2eae9","kind":"complete","transport":"toast","session":"c3b2eae9"}
```

只记**通知本身**（标题、正文、类型、实际通道），不记会话内容。

## 安装 / 卸载

```text
plugin_manager install_bundle  target = D:\AI\dsh-bundles\dsh-notify
plugin_manager remove_bundle   target = @local/dsh-notify
```

## 验证记录（2026-10-26，本机 desktop profile）

| 项 | 结果 |
|---|---|
| 单测 | `_selftest/tests/notify.test.mjs` **7 项全过**（触发规则、文案、XML 转义、截断、Toast 脚本、气泡脚本、时区）✅ |
| 通道诊断 | `notify_status`：通知通道「可用（5.1 Toast → WinForms 气泡 回退）」✅ |
| 真实发送 | `notify` → `已发送桌面通知（Toast）`，`lastTransport = toast` ✅ |
| 失败检测 | 用 pwsh 7 发时正确返回失败（退出码 2），而不是假装成功 ✅ |
| schema | `schema-check.mjs` 2 个工具 PASS ✅ |
| 数据落盘 | `D:\AI\dsh-data\notify\`，C 盘无残留 ✅ |

## 剩下的边界

- 通知内容会被**锁屏/专注助手**拦掉——这是系统设置，插件无法绕过；`notify_status` 只能告诉你脚本有没有执行成功，不能证明你真的看见了；
- 原生 Toast 的 AppUserModelID 固定用 `DeepSeek Harness`；若系统要求注册 AUMID 才能显示，回退的托盘气泡仍然可用；
- 只处理 `turn/end` 级别的事件；子代理/后台任务的完成通知没有单独做；
- `sound: false` 只静音 Toast 本身；托盘气泡的提示音由系统控制，无法静音。
- **依赖 `subprocess` 服务**：`canToast` 需要 `ctx.get('subprocess')`。v0.1.0 的 `inject` 只声明了 `['tools']`，而 cordis 4.x 的 `ctx.get` 只返回「提供者已激活」的实现（`cordis/lib/index.js`：`strict` 检查 `impl.fiber.state === 2`），`apply()` 时服务尚未就绪 → `canToast` 永久 false，10-27 起所有通知只写日志。v0.1.1 起 `inject` 补上 `'subprocess'`，cordis 会保证服务先就绪；判断逻辑本身不变，拿不到时仍降级为只写日志（fail-safe）。
