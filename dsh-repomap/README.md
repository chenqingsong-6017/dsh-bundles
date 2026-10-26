# dsh-repomap —— 代码库地图 + 符号纲要 + 符号定位

DSH bundle（Host 侧插件）：给任意工作区生成"按引用热度排序的文件地图"，让 agent 先看结构、再决定读哪个文件。

**学谁（GitHub 上的成熟做法）**：
- **Aider 的 repo map**：tree-sitter 解析符号 → 按引用关系（PageRank）排序 → 按 token 预算裁剪出最相关的一段。
- **Serena 的符号工具**：不读整文件，先按符号浏览/定位（`find symbol` / `symbol overview`）。

**本插件怎么"取长补短"**：
- DSH 插件是纯 JS、无常驻构建，塞 tree-sitter + 预编译 wasm 代价太大 → 用**按语言的正则抽取**代替 AST。精度不如 tree-sitter，但零依赖、启动快，覆盖 JS/TS/Python/Go/Rust/JVM/C 系/Ruby/PHP。
- 排序不做完整 PageRank，用"符号跨文件被引用次数"加权（Aider 图排序的廉价近似）。
- **按需调用，不注入每轮提示**：地图很吃 token，让 agent 需要时自己调。
- 预算单位用**字符**（`maxChars`）而不是 token：DSH 没有统一 tokenizer，字符稳定可验。

- **安装位置**：`D:\AI\dsh-bundles\dsh-repomap`
- **生效范围**：desktop profile，所有会话/工作目录（默认根 = 会话工作目录）

## 工具

| 工具 | 作用 |
|---|---|
| `repo_map` | 按热度排序的文件地图，带每文件顶层符号，受 `maxChars` 预算约束（默认 8000）。输出只给人看的顺序与符号，**不暴露内部评分**（评分仍在返回数据里供程序使用） |
| `repo_outline` | 单文件符号纲要（行号 + 种类），替代"为了看结构读整个文件" |
| `repo_find_symbol` | 全库找某符号的定义位置（文件:行） |

## 配置

```yaml
- insert:
    - id: repomap
      name: '@local/dsh-repomap'
      config:
        maxChars: 8000        # 默认地图预算
        maxFiles: 4000        # 单次扫描文件上限
        maxCacheEntries: 8    # 内存扫描缓存条目上限（LRU 淘汰）
```

## 扫描缓存

`repo_map` / `repo_find_symbol` 共用一个**内存级扫描缓存**（纯内存、不落盘，进程重启即失效）：

- 缓存 key = **工作目录 + 文件指纹**；指纹由每个候选源文件的「相对路径 + mtimeMs + size」算哈希。
- 任一文件的 mtime/size 变、文件新增或删除、工作目录不同 → key 变 → 自动重扫，不会返回陈旧结果。
- 命中时只重新遍历目录 + `stat`（不读文件内容、不重抽符号），所以重复调用明显变快。
- `maxCacheEntries` 控制缓存条目上限（默认 8），超出按 LRU 淘汰；某次扫描里有文件读失败时不缓存，避免留下残缺快照。
- `repo_outline` 走单独的单文件缓存（key = 绝对路径 + mtimeMs + size），条目上限同样是 `maxCacheEntries`。

## 验证记录（2026-10-26，扫描缓存，本机 desktop profile）

`node` 直接加载插件、用真实工具 `repo_map.execute()` 调用；冷扫描取 3 轮中位数，缓存命中取 15 次中位数（临时脚本放 `$env:TEMP`，跑完删除，未留在仓库）：

| 场景 | 首次扫描（冷缓存） | 缓存命中 | 加速比 |
|---|---|---|---|
| `D:\AI\dsh-bundles`（41 个源文件） | 24.6 ms | 5.2 ms | 4.7× |
| `D:\AI\workbuddy`（1,445 个源文件） | 1354 ms | 111 ms | 12.2× |
| 合成工作区：600 个 JS 文件（每个 20 个符号） | 85.4 ms | 8.2 ms | 10.4× |

- 首轮从磁盘冷读 + JIT 预热会明显更慢（`D:\AI\workbuddy` 首轮约 21 s），表中取的是稳定后的中位数。
- 命中结果与冷扫描输出的 JSON 完全一致（不返回陈旧结果）。
- 缓存失效：400 个文件的合成工作区，改 1 个文件后 `repo_map` 重扫 54.0 ms（≈ 冷扫描），`repo_find_symbol` 立即可见新符号；随后再次命中 5.6 ms。
- 单元测试：`node D:\AI\dsh-bundles\_selftest\tests\repomap.test.mjs` → **15 项通过，退出码 0**（原 6 项符号抽取 + 新增 9 项：缓存命中、mtime/size 失效、新增/删除文件失效、工作目录隔离、LRU 淘汰、工具层真实调用刷新、`repo_outline` 单文件缓存失效）。

## 验证记录（2026-10-25，本机 desktop profile）

| 项 | 结果 |
|---|---|
| 符号抽取单测 | JS/TS、Python、Go、Rust 四语言 + 行号 + 种类 + 不支持扩展名，6 个用例全过 ✅ |
| 小目录 | `D:\AI\dsh-bundles`（4 个插件）：扫描 4 个源文件、排序合理、482 字符 ✅ |
| 真实规模 | `playwright-core\lib`：29 个源文件、跳过 3 个超大、预算 900 字符收 8 个 ✅ |
| 符号纲要 | `repo_outline dsh-memory/index.js` → 10 个符号带行号 ✅ |
| 符号定位 | `repo_find_symbol renderMemory` → `dsh-memory/index.js:47 (function)` ✅ |

过程中修掉两个问题：
1. 首次调用报 `"value.skippedLarge" is not a declared property` —— 工具输出 schema 是严格校验的（`additionalProperties:false`），返回值多一个字段就直接拒绝；
2. 地图里满屏 `__export` / `__copyProps` / `__toESM`（打包器 interop 辅助函数）——加了 noise denylist 后排序才有意义。

## 已知边界

- 正则抽取是启发式：宏、装饰器生成的名字、动态定义、压缩代码会漏；
- 不读 `.gitignore`，用常见目录黑名单（node_modules/.git/dist/build/target/…）代替；
- 超过 512 KiB 的单文件跳过，扫描上限 `maxFiles`（默认 4000）；
- 排序是"引用次数"近似，不是真正的 PageRank（跨文件引用图未建）；
- 不做真正意义上的增量索引：靠内存级扫描缓存避免重复解析；缓存 key 的指纹是「相对路径 + mtimeMs + size」，如果内容变了但 size 与 mtime 被人工还原成原值，理论上会漏判（日常编辑不会出现）；
- 缓存最多保留 `maxCacheEntries` 份扫描结果（每份含符号与词频表），超大仓库 × 8 会占一些内存；嫌大可把 `maxCacheEntries` 调小。
