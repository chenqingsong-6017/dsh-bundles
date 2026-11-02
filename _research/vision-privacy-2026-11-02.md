# vision 隐私 / permission / git 远程 —— B 类方案（2026-11-02）

> **只出方案：本轮没改任何配置、没改插件代码、没重启。** 证据均为 2026-11-02T21:1x 本机实测；读不到的标「未验证」。
> 采样上下文：cwd=D:\AI-date\dsh-date\dsh-创建；profile=desktop；源码副本在 profile node_modules（非 Git 工作树）。

## Part 1 · vision 隐私：三个可选配置

### 实测基线（先摆事实）
- **默认会出网**（上游 README 原话）：图片/裁剪 + 提示词 + 请求元数据发给视觉供应商；新装默认开匿名 OVH 兜底 —— `node_modules/dsh-vision-router/README.zh.md:22`
- OVH 端点 + 元数据（另收源 IP）：`README.zh.md:231`（`oai.endpoints.kepler.ai.cloud.ovh.net`）
- 默认值（源码）：`localOnlyVision` 默认 false、`freeFallback` 默认 true —— `index.js:254-255`；4 个匿名 OVH 模型 `apiKeyEnv: ''` —— `lib/core-primitives.js:1784-1787`
- 本机 patch **没覆盖这两个开关**：`cordis.patch.yml:92-97` 只有 progressiveTools/onboardingSeen/routingMode → 生效值 = 默认值
- 本机**没有任何本地视觉后端**：`~/.dsh/logs/vision-router/vision-router.log` 2026-11-02T13:10:22.926Z `localOllama=off localLmStudio=off`；`Get-Command ollama` 空、`tesseract` 也空（连本地 OCR 都没装）
- 凭据只有一家：`~/.dsh/.credentials.yaml` 的键只有 `DEEPSEEK_API_KEY`（其余 version/records/kind/payload 是结构键）；未发现自备视觉模型 key
- 官方会话日志上传已关：`cordis.patch.yml:130-133` `enabled: false`
- 会话识图开关记录：`~/.dsh/storages/vision_router_session_policy/policies` 实测 **131 文件 / 124 条 record.enabled=true / 7 条 false**（口径：逐文件读 `record.enabled`@21:18；source user 10 + delegation 121）。任务书写的 127/120 差 4 是**采样时点不同**：采样当下仍在写入（最新 mtime=21:18:33）；且这些是「会话识图开关/委派继承」记录，**不是出网次数**
- 插件自身另有出网元数据：版本检查（日志 2026-11-01T08:30:46 `update available 3.1.0 -> 3.1.1`），不含图片

### A. 彻底 localOnly + 关 freeFallback
```yaml
- id: vision-router
  name: dsh-vision-router
  config:
    progressiveTools: false
    onboardingSeen: true
    routingMode: auto
    localOnlyVision: true    # 新增
    freeFallback: false      # 新增
```
- **会失去什么：识图能力全停。** 本机 0 个回环视觉端点，而开启后只允许回环端点执行（`README.zh.md:235`）→ `vision_describe/detect/ground`、结构化预识别、图片轮路由都无后端，只能失败。纯本地像素工具（crop/colors/pixel_diff/trace/extract_foreground/html_screenshot）仍在；`vision_ocr` 默认 auto 引擎在本机没 tesseract，会回退视觉模型 → 实际也失败（**推断，未实测**）
- 何时值得：先装 Ollama + 视觉模型（如 qwen2.5vl，数 GB），或隐私要求压过识图需求时

### B. 保留免费兜底，只对非敏感输入
- 不改开关（freeFallback=true / localOnlyVision=false），靠纪律 + 敏感会话临时开「设置 → Vision Router → 常规 → 仅本地视觉」（`README.zh.md:235`；切了等于当场跑 A 的语义，但不动配置）
- **会失去什么：不失去能力。** 代价是零机器强制：插件没有「按图片敏感度自动分流」的开关（`index.js:220-343` 配置 schema 里没找到此类字段）
- 风险：手滑对敏感截图调视觉工具，图片就去 OVH，而且**事后查不到**——插件日志只有启动/更新记录，没有每笔 provider 调用 → 审计能力为 0，只有网络层抓包才有

### C. 维持现状，仅加审计
- 硬伤：没有请求级日志，「审计」没有数据源。可做的最小审计是网络层（`netsh trace`/防火墙出站日志），成本高、每次看图都要事后翻
- **会失去什么：无（能力不变）；但「有审计」这个承诺当前不成立**（未验证 → 实为做不到，除非加网络监控）

### 推荐
**默认 B，敏感场景临时切 A（UI 开关或 A 的 patch）。** 理由：本机没有任何本地视觉端点，A 等于把识图砍掉 100%；C 的「审计」没有数据源，是假安全感。先做零成本的一件：规则里写清「哪类截图不调云端视觉工具」；等真有本地模型再把 A 转常驻。

### 回滚写法（A ↔ 现状 双向）
把 `cordis.patch.yml:92-97` 的段改成：删掉 `localOnlyVision`/`freeFallback` 两行（默认即 false/true），或显式写回 `localOnlyVision: false` / `freeFallback: true`。
验证（未做，改后必做）：触发一次 profile 重组（改 patch 注释即可）→ 真机调一次 `vision_describe`：A 档应报无可用端点/失败，现状档应正常返回。

### 借鉴卡（Part 1）
- 来源：`dsh-vision-router` 3.1.1（本机 profile `node_modules` 安装副本；上游 GitHub 见 README 徽章）
- 许可证：MIT（包内 `LICENSE` 首行 "MIT License"）
- 机制还是代码：只借「运行时隐私策略、不破坏性改配置」这一机制（`README.zh.md:235`、`index.js:249-255` 注释），不 fork 代码
- 我们不照搬的原因：已经装了它，重写无增量；MIT 能抄但抄来仍要自己做出网判断，多一份要维护的客户端

## Part 2 · permission：改 workspace-write + ask 的影响评估（不改配置）

### 官方语义（权威实现，不靠记忆）
- 预设 = 沙箱 + 审批两个独立 knob 的捆绑：`docs/subsystems/permission-presets.zh.md`「预设表」
- `approval: never` = **每个 ask 都确定性 rejected、不分发任何应答者**；`ask` = 交应答者链，链为空则 `unavailable`（失败封闭）：`docs/subsystems/approval.zh.md`「按会话策略」
- `workspace-write` 只允许写「工作区根 + 显式额外目录 + 后端临时区」：`docs/subsystems/sandbox.zh.md`「模式与强制执行」
- **Windows 上额外目录不可用**：Windows ACL runner 遇到 `additionalWritableRoots` 直接抛 `SandboxUnsupportedPolicyError` —— `packages/sandbox/sandbox-local/src/index.ts:370-371`（字段定义 `packages/sandbox/sandbox-policy/README.zh.md:49`）
- 来源方式：官方仓库 `D:\AI\dsh-data\tmp\dsh-docs-sparse` 用 `git show HEAD:<path>` 读原文（工作树为空，未 checkout）

### 本机现状
- 默认档被改成全通：`cordis.patch.yml:32-45`（danger-full-access + never，`defaultPreset: danger-full-access`）→ 沙箱层**完全不生效**，唯一软件边界是 hooks + auto-approve 的 deny/ask
- 实测 77/77 个本仓会话事件均为 `sandbox/mode=danger-full-access`、`approval/policy=never`、`permission/preset=danger-full-access`

### 真实频率（口径：本仓 77 个 `~/.dsh/sessions/--…~521B~5EFA--/*/session.v4.jsonl.zstd` 全解码，多帧 zstd，共 3695 次 tool/call）
- 工具分布：run_code 2002 / pwsh 582 / read 423 / edit 393 / grep 124 / write 48
- `edit`+`write` 441 次：**目标在 cwd 内仅 13（3%）**，仓外 428（97%：dsh-bundles 387、dsh-data 33、vault 4、Temp 4）
- run_code 含写且指向仓外：165 次（正则启发，**下界**）；pwsh 含写动作 61 次（10.5%）其中路径明确指向仓外的 26 次 → pwsh 取 26–61 区间
- **打断估算**：需人工放行 ≈ 428+165+26 = 619（下界）～654（用 61）次 / 3695 = **16.8%–17.7%，约每 6 次工具调用一次**；按会话 ≈ 8–8.5 次
- auto-approve 能兜多少：项目 11 条规则（`.dsh/auto-approve.json:3-81`；5 allow + 3 ask + 3 deny）+ 内置 7 条全 deny（`dsh-auto-approve/index.js:79-147`）。对 583 条真实 pwsh 命令，allow 命中 **248 条（42.5%）**：目录列举 133 / git 只读 39 / node --check 33 / 自检 32 / npm run check 11。但 **allow 只管审批层、管不了沙箱拒绝**：428 次仓外写没有任何 write/edit 的 allow 规则能覆盖 → 仍要逐次提权
- 本运行自动审批统计：`auto_approve_status` checks 303 / allow 35 / ask 0 / deny 0 / pass 268（内存统计，重启清零）

### 影响评估
- 硬阻断：97% 的文件写会被沙箱直接拒（不是弹提示），改插件源码、改 profile、写 dsh-data 全部失败
- 恢复路径只有「提权重试 → 弹审批 → 人点」（write/edit/run_code 的 `sandbox_permissions` 语义就是 one-shot retry asks），即上表 619–654 次
- 结论：**cwd=本工作区的前提下不可行**。真要这档，正确做法是把会话 cwd 设成要写的仓（如 `D:\AI\dsh-bundles` 单开会话），而不是加额外写根——Windows 这条路直接抛错
- 未验证：审批弹窗在这台机器上到底会不会出现，目前没有证据（本仓 `security-modes.md:42` 已标注）

### 回滚写法（要改回时只动这一行）
```yaml
- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    presets:
      read-only: { sandbox: read-only, approval: ask }
      workspace-write: { sandbox: workspace-write, approval: ask }
      danger-full-access: { sandbox: danger-full-access, approval: never }
    defaultPreset: danger-full-access   # 试点改 workspace-write；回滚就改回 danger-full-access
```
- 注意：`defaultPreset` 只影响**新会话**；已在跑的会话要用 UI 切（未验证当前会话能否切）

### 借鉴卡（Part 2）
- 来源：官方 DSH `@deepseek-ai/dsh-permission-presets` / `dsh-sandbox` / `dsh-user-approval`
- 许可证：MIT（官方仓库 `LICENSE` 首行 "MIT License"）
- 机制还是代码：借「预设是两个 knob 的捆绑 + 判定顺序（never 在应答者之前）」这套机制语义，不动官方代码
- 我们不照搬的原因：官方默认档（workspace-write+ask）在这台 Windows 上被 runner 限制死，照搬默认 = 把开发流程停掉

## Part 3 · 三个 git 库的私有远程（不安装任何东西）

### 现状实测（`git remote -v` 均无输出；`git rev-list --count HEAD` 取提交数）
| 仓 | remote | 提交 | .git | 工作区 |
|---|---|---|---|---|
| `D:\AI\dsh-bundles` | 无 | 103 | 2.1MB | 10 个未提交 |
| `D:\AI-date\obsidian\vault` | 无 | 16 | 0.1MB | 干净 |
| `D:\AI\dsh-data\eval` | 无 | 7 | 0.1MB | 干净 |

### 备选与代价
| 方案 | 隐私 | 钱 | 维护 | 适合 |
|---|---|---|---|---|
| 自建 bare（另一块盘/移动硬盘/NAS） | 不出本机 | 0 元（复用现有盘） | 手动 push + 定期异地拷贝 | 三仓都适合，尤其 vault |
| GitHub private | 出境（美国） | 0 元，私有仓不限量（免费版条款以官网为准，**未逐条核**） | 最低（远程自动拉） | bundles、eval |
| Gitee private | 境内 | 0 元，免费版单仓 500MB / 单文件 50MB / 总 5G（help.gitee.com 配额说明，搜索摘要） | 低 | eval（22MB 工作区） |
| 本地 NAS | 不出内网 | 硬件成本 | 自担 RAID/断电 | 多机访问的中心点 |
- 三仓 `.git` 合计约 2.3MB，任何方案都装得下；差别只在「隐私 vs 异地 vs 维护」

### 推荐（分级，不采购、不安装）
1. vault（个人画像/三观，最敏感）→ 自建 bare，只在本机/移动盘
2. bundles（插件源码，最干净）→ 自建 bare 为主；要异地再叠 GitHub private
3. eval → 自建 bare（工作区 22MB，历史仅 0.1MB）
- 先做只需一条命令（**本轮未执行**）：`git init --bare <另一块盘>/bundles.git` + `git remote add backup <路径>`；不需要网络、不需要账号

### 退出/回滚
- `git remote remove backup` 即还原；不推送就不产生任何外部副本

### 借鉴卡（Part 3）
- 来源：`basic-memory`（本机 clone：`D:\AI\dsh-data\tmp\repos\basic-memory`）
- 许可证：AGPL-3.0（`LICENSE` 首行 "GNU AFFERO GENERAL PUBLIC LICENSE"；`pyproject.toml` 写 `license = { text = "AGPL-3.0-or-later" }`）
- 机制还是代码：只借「先查索引/同步是否就绪，再判断空结果是不是真的空」的机制（`src/basic_memory/mcp/index_readiness.py:21-38`：`project_index_required` 区分 NEVER_INDEXED 与真空），**零代码复制**
- 我们不照搬的原因：AGPL 传染性；本机要的只是「备份是否就绪」一句判断，不需要整套同步引擎。**纠偏**：任务书说的 `sync_status` 工具在这个 clone 里找不到（全仓 `*.py` 只有 tests 提到），实际机制名是 `project_index_status/project_index_required`

## 对照卡 · mem0 / Letta（只对照，不扩本机预算）
- 来源：mem0（clone 只有 `.git`，工作树缺失 → 只算线索）、Letta（未 clone）
- 许可证：**未验证**（mem0 clone 损坏；Letta 无本地副本）
- 机制还是代码：只看「分层记忆 + 注入预算」的设计思路，不引入其代码/服务
- 我们不照搬的原因：本机注入预算已按 `memory-layering.md` 判定；扩预算 = 破坏 context rot 的实测结论，无度量支撑不改

## 未验证清单
- A 档下 vision 工具的具体报错文本（需真机调一次）
- 审批弹窗在本机是否真的会出现（`security-modes.md:42` 已标）
- Windows ACL runner 在本机的实际 enforcement（官方文档说 partial：读不受限 / 硬链接 / AppContainer 边界）
- Gitee / GitHub 免费版条款细节（仅搜索摘要，未逐条核官网）
