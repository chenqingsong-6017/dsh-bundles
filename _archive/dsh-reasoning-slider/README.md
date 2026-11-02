# dsh-reasoning-slider

输入栏右侧的**EVA 能量条**：危险条纹标记 + 分段发光轨道 + 能量白核滑块 + 等宽百分比读数。拖动跟手、松手吸附到档位，直接改当前会话的 `reasoningEffort`。

## 设计来源

| 参考作品 | 借用的语言 |
|---|---|
| [HanaAyane/dsh-reasoning-effort](https://github.com/HanaAyane/dsh-reasoning-effort)（249★） | 发光滑块、档位与百分比读数并列 |
| [yuhub233/dsh-effort-slider](https://github.com/yuhub233/dsh-effort-slider)（37★） | 能量条质感：发光渐变 + 白炽核心 |
| [Bai-2008/dsh-better-panel](https://github.com/Bai-2008/dsh-better-panel)（16★） | 连续拖动 + 松手吸附、白色圆钮 |
| [2768651338/dsh-effort-slider](https://github.com/2768651338/dsh-effort-slider)（20★） | Claude Code 式无级拖动 + 吸附 |

## 它做什么

- 轨道：26px 高的能量槽，内含分段栅格（每 18px 一格）、危险条纹端标、按比例填充的发光渐变、白色能量核滑块
- 读数：右侧等宽百分比（`000%`–`100%`），切换中变暗并呼吸，失败时显示 `LINK LOST` 2 秒
- 交互：原生 `<input type=range>`（`step=0.01`）提供连续手感，`pointerup` 时 `Math.round` 吸附到档位；键盘 ←/→、Home/End 直接切档
- 读写走官方会话接口；模型无推理元数据（或只有一档）时整个控件不渲染
- 颜色全部来自主题令牌（暗色 = 明日香红、亮色 = 绫波丽蓝），可跟随任意主题

## 实现方式（不点 DOM、不覆盖官方组件）

| 用途 | 接口 |
|---|---|
| 读当前等级 | `ctx.sessions.binding(sessionId).session.projections.faceOf('modelSelection')` |
| 读档位表 | `ctx.remote.session.modelCatalog()` → `groups[].models[].reasoning.efforts` |
| 写等级 | `ctx.remote.session.selectModel({ sessionId, provider, model, reasoningEffort })` |

挂载点：官方扩展槽 `conversation.input.right`（list），注册 id `reasoning-slider`、`order: 20`。

## 工具

| 工具 | 作用 |
|---|---|
| `reasoning_status` | 诊断口（2026-11-01 统一契约）：只报 `ready` / `unavailableReason` / `note`。纯客户端插件没有服务端工具 → 恒 `ready=true`、`unavailableReason=""` |

滑条本身不走工具面（`lib/client.js` 直接调会话 RPC），所以这个工具只回答「你ready吗」，不承担任何功能。

## 安装与卸载

```text
plugin_manager install_bundle  target = D:\AI\dsh-bundles\dsh-reasoning-slider
plugin_manager remove_bundle   target = @local/dsh-reasoning-slider
```

装完刷新页面。

## 验证记录

- 安装：`application: applied`；条目 `include:reasoning-slider` = active
- 客户端注册：`Slots.listSubTree(conversation.input.right)` 出现 occupant `reasoning-slider`
- 接口：与官方 `dsh-client-ui-model-selection` 使用同一套 `modelCatalog` / `selectModel` / `modelSelection` 投影
- 几何：轨道两端 8px 内缩，fill 与 core 同用 `calc(8px + (100% - 16px) * ratio)`，两端对齐
- 视觉迭代：分段条 → Claude 文字档位 → GPT 药丸 → 圆头滑条 → chip+浮层 → **EVA 能量条（当前）**
- 真机验证（2026-10-26，浏览器直连本机 GUI）：
  - 首版组件在槽位里**崩溃**（`cannot get property "locale" without inject`），槽位渲染为 `data-slot-error` 占位符；已修：`inject` 补 `locale` 与 `remote.session`
  - 投影为空时回退到 `catalog.default`（与官方选择器一致）
  - 修复后实测：`catalog=1, groups=2, efforts=4 (off/low/high/max)`，拖动到 max → `selectModel` 生效，诊断状态 `effort: null → "max"`，模型菜单同步显示 Max
  - 尺寸实测：composer 卡片宽 774px 时，条宽 200px 模型选择器仍显示文字；条宽 250px 时模型选择器被压成纯图标。当前 200×28，与「完全权限」(103×28)、模型选择 (250×28) 同高
- 比例对齐（按宿主实测值调）：圆角 3→0（主题里相邻按钮都是 0）、内缩 2px 让填充成为 28px 外壳里的 24px 量规、危险条纹 9→8px、刻度间距 16px、读数 11→12px 以接近模型按钮的 13px 标签
- 全量检查（2026-10-26，真机浏览器 + 宿主接口）：
  - 四档逐级提交：`0/1/2/3` → 读数 `000/033/067/100%`，模型选择器同步 `Off/Low/High/Max`
  - 键盘：`←` `→` `Home` `End` 均生效（Max→High→Max→Off→Max 实测）
  - 响应式（composer 卡片 712px / 视口 820）：媒体查询把条缩到 120px，模型选择器保持文字（257px）；视口 1440 时条 201px
  - 控制台错误：**0**（修复前为 2 条组件崩溃）
  - 清理：临时诊断路由 `/dsh-rs-report`、`/dsh-rs-state`、`/dsh-rs-url` 已全部删除（现均 404），client 里的上报代码同步移除
  - 静态检查：`node --check` 两个半边通过；package/locale JSON 可解析；icon.svg 合法
- 统一契约（2026-11-01）：Host 半体新增 `reasoning_status`（`ready` / `unavailableReason` / `note`），
  单测 `_selftest/tests/reasoning-slider.test.mjs` 覆盖「三字段在 required 里 + 返回值与 schema 严格同构 + note 讲清是客户端插件」；
  新增工具要等 profile 重组后才会进工具列表，**本次未做真机验证**（滑条侧代码一字未改）。
