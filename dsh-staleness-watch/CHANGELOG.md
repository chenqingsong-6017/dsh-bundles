# CHANGELOG — dsh-staleness-watch

本文件于 2026-10-31 按「改到谁补谁」的规则建立；当前版本为存量版本，本节为补记。

## v0.1.1（补记于 2026-10-31）

### Added
- 运行时陈旧检测：按「pid + window_id」跟踪桌面/浏览器类工具的目标；同一目标连续盲操作（未先快照）超过 `maxBlindActions`（默认 3）时告警。
- 两种模式：`warn`（只在结果里追加告警，不打断）/ `block`（在 `tools/guard` 拦下一次输入操作，要求先快照）。
- 动作类与快照类工具用正则归类，覆盖 cua / browser 两套命名。

### Verification
- 单测 + 验证门通过；无工具接口，行为靠 hooks 管线观测（本次体检期间未刻意触发）。

### Known limitations
- 只对命中正则的桌面/浏览器工具生效；纯文本工具不参与。
