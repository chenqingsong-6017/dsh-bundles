# dsh-bundles —— 自研 DSH 插件源码仓

插件源码统一在这里（profile 用 `link:D:/AI/dsh-bundles/<插件>` 链接安装）；数据一律落 `D:\AI\dsh-data`，不落 C 盘。

| 目录 | 用途 |
|---|---|
| `dsh-*` | 各插件源码（`index.js` + `cordis.patch.yml` + `package.json` + locale/icon/README） |
| `_selftest/` | 开发期自检：`selfcheck.ps1`（五层）+ `tests/*.test.mjs`（验证门会自动跑） |
| `_ops/` | 只跑一次或排障用的运维脚本（不装进 profile） |
| `_research/` | 调研、决策、复盘（结论类文档，不进插件包） |

收工前自检：

```powershell
pwsh -NoProfile -File D:\AI\dsh-bundles\_selftest\selfcheck.ps1
```

退出码 0 = 五层全绿：结构 → schema → 单元测试 → profile 安装一致性 → **装配顺序**。

## pre-execute 拦截链顺序：有意义的，不是随手排的

`tools/pre-execute` 是 Cordis 的 **waterfall**（环绕中间件）：监听器按**注册顺序**观察，返回结果即短路，不调用 `next()` 的层之后的监听器根本拿不到这次调用。
官方原文：

- [`docs/tool-execution-pipeline.zh.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-execution-pipeline.zh.md)：`tools/pre-execute` 瀑布先执行，然后是单调守卫、`tools/execute`、`tools/post-execute`。
- [`docs/cordis-primer.zh.md` §Cordis Waterfall 语义](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.zh.md#cordis-waterfall-semantics)：监听器按注册顺序执行；不调用 `next()` 直接返回则短路。

本机 profile 的 bundle 数组下标就是注册顺序，所以这三个插件的相对位置决定了拦截链次序：

| 位置（数组下标，0 起） | 插件 | 职责 | 为什么必须在这 |
|---|---|---|---|
| #5 | `@local/dsh-checkpoint` | 写前留底（快照） | 必须最先：它是唯一「先留底再放行」的层，且无条件 `next()`。若它前面出现任何早停（含将来新增的 allow 层），这次调用就不留底，回滚能力直接丢失。 |
| #26 | `@local/dsh-hooks` | 硬红线（hooks.json 七层，`onError: deny`） | 必须在 auto-approve 前：hard deny 不能被策略层代审掉。auto-approve 可以 `deny` 并短路；若它在前，hooks 的 37 条规则根本不会被求值，红线从「硬拦」退化为「依赖策略层不误判」。 |
| #28 | `@local/dsh-auto-approve` | 策略代审（可 deny/ask） | 必须最后：它的 `allow` 分支要先 `next()` 看下游是否要人工确认，才能「只收紧、不放松」地放行；放在硬层之前会把硬层挡在它的下游之外。 |

依据补充：auto-approve 自己的注释（`dsh-auto-approve/index.js:20-21`）承认「若别的插件在本插件之前返回 ask/deny，本插件拿不到这次调用」——这正是 waterfall 的早停性质，也是本顺序必须被机器守住的原因。

**怎么守（可证伪）**：

```powershell
node _selftest\assembly-order.mjs            # 顺序对 → exit 0；反序/缺层 → exit 1 并解释早停语义
```

- `selfcheck.ps1` 第 5 层调用它；顺序被改就红。
- `_selftest/tests/assembly-order.test.mjs` 用**反序 profile fixture** 证明检查会红（不是永远绿），并覆盖「缺层」「profile 结构不对」两种静默通过风险。
- 改动 profile 的 bundle 顺序后必须重跑；不要靠肉眼。

### 其他链路上的缝（2026-11-02 实测订阅关系，本轮未加顺序检查）

| 链路 | 订阅者 |
|---|---|
| `tools/post-execute` | `dsh-hooks`、`dsh-path-rules`、`dsh-staleness-watch` |
| `agent/pre-step` | `dsh-subagent-brief` |
| `agent/turn-stopping` | `dsh-memory`、`dsh-hooks` |
| `systemPrompt.context()` | `dsh-memory`、`dsh-path-rules` |

这些链路的先后目前**没有**像 pre-execute 这样被机器守住；改 profile 顺序或新增订阅者时要自己复核（后续可加同类检查）。