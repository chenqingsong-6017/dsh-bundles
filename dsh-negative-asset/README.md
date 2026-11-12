# dsh-negative-asset · 负资产扫描（P0 只读）

扫出**项目/仓库级负资产**：空目录、0 字节文件、过期临时产物、内容重复的副本、分卷残留、复制痕迹命名。
每条候选都带 **signal（信号）+ reason（理由，含三查逐条结论）+ layer（三查分层）**，只报告不动手。

## 0. 为什么独立成插件（不塞进 dsh-butler-tidy）

- tidy 管系统级垃圾（临时目录 / 回收站 / 更新缓存）与单目录整理，判据是「路径类型 + 扩展名」；
- 本插件管**项目级负资产**，判据是**删除三查**（过时 / 以后无用 / 无价值）+ GC 可达性；
- tidy 的 apply 是不可逆删除语义，P0 负资产是**纯只读**——两套语义混在一个 4820 行的文件里会互相污染。

## 1. 工具（只有两个）

- **asset_scan**：只读扫描 → 候选 + 分层 + 预估释放字节。
- **asset_status**：诊断 → 数据目录 / 红线目录数 / 上次扫描时间·耗时·根目录 / 上限 / path-safety 来源 / git 可用性 / lastError。

**没有 asset_apply**，也没有任何删除、移动、改名能力（测试会断言源码里没有 unlink / rm / rmdir / rename / copy API）。

## 2. 判据：删除三查的机器化

| 查 | 机器判据 | 失败时 |
|---|---|---|
| ① 过时 | mtime 距今 >= minAgeDays（默认 30 天） | 降层 doubt，理由写「缺 过时」 |
| ② 以后无用 | 可达性（GC mark-sweep）：git 索引里有没有它（每个仓库只跑一次 git ls-files -z） | 被跟踪 → doubt；**git 不可用 / 不在仓库内 → unknown，绝不当成无引用 → doubt** |
| ③ 无价值 | 纯中间产物 / 可再生 / 重复保留份 / 空壳 / 0 字节 | 唯一副本风险 → 升到 ask，只列出不建议删 |

分层：

- **SAFE**：三条全中（只在 git 仓库内成立）。
- **doubt**：命中信号但缺一条，reason 逐条写「缺：…」。
- **ask**：唯一副本 / 可能不可再生（分卷无合并主文件、复制痕迹但原文件已不在），只列出。
- **protected**：红线 / 写法不安全 / reparse point，fail-closed 排除，计入 counts.protected，绝不进 items。

### 六种信号

| signal | 判定 | 价值判断 |
|---|---|---|
| empty-dir | 目录条目为 0 | 空壳无内容 |
| zero-byte | size = 0 | 无内容 |
| temp-artifact | 扩展名命中 .tmp/.bak/.old/.orig/.partial/.crdownload/.log | 中间产物可重建 |
| duplicate | 内容 sha256 相同，保留「路径更短 + mtime 更旧」一份，其余进候选 | 有保留份即冗余 |
| split-residue | partN / .part / .r00 / .z01 / .001 等分卷，且同目录有合并主文件或同组分卷 >= 2 | 有主文件 = 冗余；只有分卷 = ask |
| replica-name | - copy / copy / 副本 / (1) / 最终版 / final_v2 | 同目录原文件还在 = 冗余；不在 = ask |

## 3. 只读与红线（P0 硬约束）

- 扫描只做：readdir / lstat / 读文件算哈希 / git ls-files（带 GIT_OPTIONAL_LOCKS=0，不写 .git/index）。
- 红线清单与 dsh-butler-tidy 逐项一致（9 项），fail-closed：UNC、\\?\ 设备路径、junction/符号链接、解析不出真实路径，一律按 protected 处理。
- 单路径异常（读不到 / 权限 / 超时）只进 errors 并跳过，不猜、不崩。
- 上限：maxFiles 默认 20000、maxDepth 默认 6、走查 15s、哈希预算 256 MiB；超限 truncated=true 并说明。
- 扫描自己的数据目录会被排除，不会自扫自。

## 4. 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| roots | 配置里的 roots | **必填**（参数或配置）；两者都空 → 返回指引错误，绝不默认扫全盘 |
| maxFiles | 20000 | 1–200000 |
| maxDepth | 6 | 0–32 |
| minAgeDays | 30 | 0–3650 |
| maxRows | 60 | 1–500 |

## 5. 配置（profile 的 cordis.patch.yml 覆盖）

    - id: negative-asset
      name: "@local/dsh-negative-asset"
      config:
        storeDir: 'D:\AI\dsh-data\negative-asset'
        roots:
          - 'D:\AI\dsh-data\tmp'
        protectDirs:
          - 'E:\某个不许动的目录'

数据默认落 D:\AI\dsh-data\negative-asset（本机约定不落 C 盘）；只有 last-scan.json（上次扫描时间/耗时/根目录/计数）。

## 6. 真机验证记录（2026-11-12 · node v26.12.1 / git 2.55.0）

| 项 | 观测值 |
|---|---|
| 测试 | _selftest/tests/negative-asset.test.mjs · 20 组断言全过（含反例自检） |
| D:\AI\dsh-data\tmp | 4517 文件 / 1071 目录（深度 6 截断）；72 候选（71 duplicate + 1 empty-dir）；SAFE 0 / 存疑 72 / 请旨 0；protected 0；2328ms |
| 只读证明（tmp） | 扫描前 6853 文件 / 97,631,001 字节；扫描后完全相同 |
| 只读证明（本工作区仓） | 302 文件 / 13,816,788 字节 前后相同；12 候选 |
| 红线（C:\Windows、D:\AI\dsh-bundles） | protected=1、items=0、scannedFiles=0（整根拒扫） |
| git 可达性 | 仓库内过期未跟踪 .tmp = SAFE（14 字节）；仍被跟踪 = 存疑；.git/index mtime 前后一致（未写） |
| 非 git 目录 | SAFE=0（可达性 unknown 一律降层存疑）——这是需求规定的 fail-safe，不是缺陷 |

## 7. 已知边界（诚实清单）

- P0 不删任何东西；「预估可释放字节」= SAFE 项合计，仅供参考。
- 非 git 目录里 SAFE 恒为 0（可达性 unknown）；要 SAFE 候选就把扫描根放进 git 仓库。
- 不扫 .git/.hg/.svn；不跟随 junction / 符号链接（按 fail-closed 计入 protected）。
- 大文件（>128 MiB）不参与内容重复检测；哈希总预算 256 MiB，超了 truncated。
- 不解析语言级依赖 / 死代码（knip 那类按项目类型接解析器，成本远超收益，另案）。

## 8. 与 dsh-butler-tidy 的关系

lib/path-safety.js 是机械复制（红线 9 项、fail-closed、junction/UNC 防护逐字节保留），唯一差异是 storeLocation 的子目录名与返回字段（只留 dir / lastScan）。
未使用的 lockHint / isUnder 一并保留，方便与源文件做 diff 审计。
测试里有一条**跨插件回归**：两边 protectedDirs({}) 必须逐项一致，不一致即 FAIL。

## 9. 回滚

整体删插件目录即可（或 plugin_manager remove_bundle）；数据目录删 D:\AI\dsh-data\negative-asset；P0 不产生任何「需要回滚的删除」。

> **能力边界（与相邻插件的分工）以工作区权威源 `_contracts/plugin-boundaries.md` 为准**（2026-11-12 立；与 tidy 的语义差异见该文件 §2 与本文 §0）。
