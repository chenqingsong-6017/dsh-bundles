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
        maxChars: 8000      # 默认地图预算
        maxFiles: 4000      # 单次扫描文件上限
```

## 验证记录（2026-10-25，本机 desktop profile）

| 项 | 结果 |
|---|---|
| 符号抽取单测 | JS/TS、Python、Go、Rust 四语言 + 行号 + 种类 + 不支持扩展名，7 个用例全过 ✅ |
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
- 不做增量索引：结果缓存 5 秒，超出就重扫（本地小仓库无感）。
