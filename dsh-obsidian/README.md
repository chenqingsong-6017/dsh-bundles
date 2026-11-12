# dsh-obsidian

> Obsidian 库的**索引**（P1 只读）+ **受控写**（P2）+ **页面契约检查**（P3）。扫成索引给 AI 检索；写只进白名单、默认不覆盖；契约违规一眼看到。

## 为什么需要它

vault 是人的成品层（画像 / 3观 / 日志 / 调研索引）。没有索引时，AI 想找「哪张卡讲过 X」只能 glob + read 逐个翻；库一大就会变成几十次读盘。
本插件把 vault 扫成 `D:\AI\dsh-data\obsidian\index.json`，提供四个只读工具 + 一个受控写工具。

## 工具

| 工具 | 作用 | 关键点 |
|---|---|---|
| `obsidian_status` | 库健康度 + 记忆指针漂移 | 断链数、解析失败、索引是否过期、`memoryPointers` 断指针 |
| `obsidian_index` | 重建索引 | 临时文件 + rename 原子替换，返回耗时与字节数 |
| `obsidian_search` | 按标题 / 别名 / 标签 / 正文打分检索 | 可按 `type` / `domain` / `tag` 过滤；索引过期时内存重建 |
| `obsidian_note` | 按 vault 相对路径读单篇 | frontmatter + 正文 + 出链；路径越界直接拒 |
| `obsidian_write` | 受控写（P2） | 白名单内、create 不覆盖、hash/mtime 不符即放弃 |
| `obsidian_lint` | 页面契约检查（P3） | 缺字段 / 命名混 / 缺一句话 / id 重复 / 指针指向非 active |

## 写入边界（P2）

1. **白名单**：默认只允许写 `00-Inbox/ai-drafts/`；`10-Life/` 等正文区一律拒写。
2. **受保护目录硬拒**：`.obsidian/`、`90-Shared/91-Templates/` 即使配进白名单也不许写。
3. **默认不覆盖**：`create` 模式遇到已存在文件直接失败（`file_exists`），改内容必须用 `append` 或 `section`。
4. **section 只替换一段**：按标题定位，只改该标题下的正文，同级的其他段原样保留。
5. **冲突即放弃**：给了 `expectedHash` 或 `expectedMtime` 时，实际不符就返回 `conflict`，绝不猜谁的版本对。
6. **原子写**：tmp + rename，写一半崩了不会留半篇。

失败返回 `code`：`denied` / `escape` / `file_exists` / `conflict` / `section_not_found` / `no_file` / `too_large` / `write_disabled`。

## 页面契约检查（P3）

`obsidian_lint` 只查五条能从「找得到 / 信得过 / 改得动」倒推出来的规则，不多做：

| 检查 | 代码 | 为什么 |
|---|---|---|
| 必填字段缺失 | `missing_field` | 缺 `type` / `domain` / `status`，机器分不了类 |
| 内容页占导航名 | `index_named_content` | `_index.md` 却装结论，人和 AI 都会误判 |
| type=index 却叫别的名 | `content_named_index` | 子目录导航页必须叫 `_index.md`（根级 `Home.md` / `AGENTS.md` 豁免） |
| 缺结论头 | `missing_one_liner` | H1 后必须有「一句话」，否则读入口就要爬全文（`journal` 免检）；`> 一句话：` / `> **一句话**：` / `> __一句话__：` / 半角冒号都算过，代码块里的不算 |
| id 重复 | `duplicate_id` | 改名不断链的前提是 id 唯一 |
| 指针指向非 active | `pointer_to_inactive` | 指向草稿 = 指向「未定」，会误导引用 |

**真机首跑**：21 篇 / 0 错误 / 0 警告 / 12ms。首跑曾报 6 条，其中 5 条是规则误报（journal 被要求写结论、Home.md 被当命名违规），按「规则服从目的」改规则，没有为了过检而改库。

## 目录摘要（sidecar）索引（v0.5.0）

`_ops/vault-abstract.mjs` 会给每个目录生成 `.abstract.md`（L0，≤60 字）与 `.overview.md`（目录详表）。
索引**只收录 `.abstract.md`**：

- 条目标 `type='sidecar'`、`title` = L0 全文 → `obsidian_search` 能按目录摘要命中（`type: 'sidecar'` 可单独过滤）；
- **不进页面契约检查**（它没有 frontmatter / id / 一句话，按页面规则检查只会报假错）；
- **不算出链**（`links=[]`，避免断链噪声）；
- `.overview.md` **不收录**（体积大、内容与正文重复），要读时用 `obsidian_note` 直读文件；
- 其他点号文件（`.obsidian/` 内等）仍不收录。

**为什么加这一层**：sidecar 生成后若检索侧看不见，「记忆只存 L0 指针、按需拉 L2」就是空话——2026-11-12 审计实测 17/17 未收录，改后才闭合。

## 索引数据布局

```
D:\AI\dsh-data\obsidian\
└── index.json     # 一次全量快照：vault / builtAt / newestMtime / counts / links / parseErrors / notes[]
```

`notes[]` 每条的字段：`path / name / title / type / domain / status / review / tier / confidence / id / tags / aliases / mtime / size / links[] / text`（`text` 压成单行、上限 8000 字符，只给检索用）。目录摘要条目（v0.5.0）`type='sidecar'`、`title/text` 都是 L0 全文、`links=[]`。

## 配置（cordis.patch.yml 或 profile 层）

```yaml
config:
  vaultDir: D:\AI-date\obsidian\vault
  storeDir: D:\AI\dsh-data\obsidian
  memoryPath: D:\AI\dsh-data\memory\memory.json   # 指针漂移检查入口（同目录有 memory.db 时优先读 db）
  buildOnStart: true                               # 启动时顺带建一次索引（只读扫库，失败不影响启动）
  writeEnabled: true                               # false = 回到纯只读模式
  writeAllowlist:                                  # 只有这些前缀可写
    - 00-Inbox/ai-drafts/
```

## 记忆指针约定

想让记忆条目不膨胀，正文写进 vault，记忆里只留一行指针：

```
细节见 vault://10-Life/13-Life-Plan.md
```

`obsidian_status` 会扫记忆库里所有 `vault://` 指针，报 `total` 与 `broken`（断掉的指针 + 对应记忆 id）。这是仿 Basic Memory 的 `sync_status`：索引落后要能被看见，而不是等人踩空。

**数据源（v0.4.0）**：优先读同目录的 `memory.db`（SQLite，v4.1 起的权威存储；`memory.json` 已冻结），没有 db / 打不开才回退 `memory.json`。报告里的 `source`（`sqlite` / `json`）、`storeFile`、`entryCount` 三个诊断字段直接说明这份数字从哪来——防止「检查在跑、数字是旧快照」。

### 断链分 kind（2026-11-02 起）

`broken[]` 每条是 `{ pointer, memoryIds, kind }`，`kind` 只有两种：

| kind | 含义 | 该干什么 |
|---|---|---|
| `file-missing` | 指针里的文件路径落到真实文件失败 | 建卡，或删/改这条记忆 |
| `anchor-missing` | 文件在，但 `#锚点` 在该文件里找不到对应标题 | 改指针锚点（多数是标题改过名） |

报告里另有 `anchorChecked`（实际校验了锚点的条数）、`anchorSkipped`（读不到正文 / 超 512KB 没校验）、`fileMissing` / `anchorMissing` 两个计数；`pointer` 与 `memoryIds` 字段保持不变（向后兼容）。

### 锚点怎么算「对上了」

指针里的 `#锚点` 有三种合法写法，按顺序匹配（`matchHeadingAnchor`，纯函数、测试覆盖）：

1. **slug 全等**：锚点按 GitHub slug 规则（小写 / 去标点符号 / 空格→`-`）等于某个标题的 slug。`#硬规则`、`#更新插件的执行链`、带逗号的 `#先查官方有没有，再自研` 都走这条。
2. **数字节号**：锚点形如 `2` / `3.2` / `10`，命中标题前导节号。真实库里 `#2`、`#3.2`、`#4.1` 等 20 条走这条。
3. **前导片段**：锚点是标题在标点 / 空白 / 连字符处断开后的前导片段。`skill-forge` 之于「skill-forge 的接线位置」、`先查官方有没有` 之于「先查官方有没有，再自研」。

**与裸 `startsWith` 的区别**（这条必须写清，否则第 3 步会变成万能放行）：锚点必须从标题**第一个字**开始，且必须断在标点 / 空白 / 连字符处。`skill-fo`（半截词）、`forge`（不在前导）、`记忆清理`（不是「3.2 记忆清理红线」的前导）都不算命中。

**为什么不用严格 GitHub 规则**：2026-11-02 实测真实 `memory.json` 的 25 条唯一指针，严格 GitHub 整标题 slug 规则只过 4 条、误报 21 条——库里 20 条用数字节号、1 条用英文短锚，那是**我们的指针约定**，不是 GitHub 的语义。所以 ②③ 单列、写进测试，并在代码注释里点名「这不是 GitHub 行为」。

**解析的已知边界**：`parseMemoryPointers` 的指针 token 在标点处结束，所以 `#先查官方有没有，再自研` 实际解析成 `#先查官方有没有`——它仍靠第 3 条命中，行为正确；`obsidian_status` 里显示的是截断后的锚点。

## 与 dsh-memory 的分工

- `memory.json` = AI 的权威记忆（每轮注入，有字符预算）。
- `vault` = 人的成品层 + AI 的结构化读源（本插件读，写只进 `00-Inbox/ai-drafts/`）。
- 两者**不做自动同步**：跑 `obsidian_status` 看指针断没断；迁移策略见 `dsh-创建/_research/obsidian-vault-plan-2026-11.md` §8。

## 验证记录

| 项 | 结果 |
|---|---|
| `node --check index.js` | 通过 |
| 单测 `_selftest/tests/obsidian.test.mjs` | 12 项通过（P1 8 项 + P2 受控写 2 项 + lint 2 项） |
| `obsidian_status.render` 显示记忆指针（2026-11-01 改） | ⚠️ 单测断言通过（总数/断链/点名词）；**真机未验证——插件未重启，实机输出仍是旧格式**，不得算已生效（见 `_research/postmortems/0003-render-fix-claimed-before-restart.md`） |
| 真机 P1（2026-11-01） | ✅ notes=21 / bases=4 / links=18 / brokenLinks=0 / parseErrors=0；重建 2ms、index.json 25.7KB |
| 页面契约检查（2026-11-01，真实 vault） | ✅ 21 篇 / **0 错误 0 警告** / 12ms；单测 12 项（含 journal 免检、根级豁免、模板跳过三条正例） |
| 记忆指针试点（2026-11-01，真实 memory.json） | ✅ 4 条记忆改为「判据 + `vault://` 指针」；扫出 `total:2` 个不同锚点、`broken:0`；记忆 10849 → 10644 字（90.4% → 88.7%） |
| 进程内验收（2026-11-01 重启后，真实 vault） | ✅ 7 项全过：指针 `total:2`/`broken:0`、新建 155 字节、二次写 `file_exists`、白名单 `denied`、模板 `denied`、lint 21 篇 0/0、search/note 回归 |
| 真机 P2（2026-11-01，源码直跑真实 vault） | ✅ 新建 71 字节成功（自动补 .md）/ 二次写 `file_exists` / `10-Life` 与模板目录 `denied` / append 85 字节 / 检索与读单篇回归正常；验证文件已删，索引重建回 21 篇 |
| 接口契约补丁（2026-11-01） | ✅ `obsidian_status` 增 `ready`/`unavailableReason`（判据＝vault 存在，复用 `vaultExists`），`required` 含 `ready`，`ready:false` 时 render 首行「不可用：<原因>」；`memoryPointers` 拼串逻辑未动。`index`/`search`/`note`/`lint`/`status` 的错误返回补 UPPER_SNAKE `code`（VAULT_MISSING / STATUS_ERROR / VAULT_UNREADABLE / INDEX_ERROR / EMPTY_QUERY / SEARCH_ERROR / EMPTY_PATH / PATH_ESCAPE / NOT_FOUND / UNSUPPORTED_TYPE / TOO_LARGE / NOTE_ERROR / LINT_ERROR）；`obsidian_write` 原有 lowercase 码（`file_exists` 等）保持不变。实测：vault 在 → `ready:true`、vault 不在 → `ready:false` + render「不可用：vault 不存在…」；`node --check` 通过、`obsidian.test.mjs` 12 项全过 |

## 验证记录（2026-11-02，误报扫描 #21 #22）

| 项 | 结果 |
|---|---|
| `isWriteAllowed` 大小写不敏感（v0.3.1） | ✅ 比较前统一 `toLowerCase()`：`00-inbox/`、`00-Inbox/AI-Drafts/`、`00-INBOX/...` 放行；`90-shared/91-templates/`、`.OBSIDIAN/` 仍命中「受保护目录」（不再只靠白名单兜底） |
| `sectionRange` 标题容忍尾随冒号/空格 | ✅ `观测：` / `观测:` / `## 观测： ` / `  观测  ` 均命中 `## 观测`；只有冒号仍返回 null |
| 证伪 | ✅ 先加用例跑旧代码：白名单大小写用例失败（`false !== true`）；改后全过 |
| 工具级单测 | ✅ `obsidian_write({path:'00-inbox/AI-Drafts/case.md'})` 写入成功；`90-SHARED/91-TEMPLATES/` 仍 `DENIED`；section 模式 `section:'观测：'` 替换成功 |
| `node --check index.js` | 通过 |
| 单测 `_selftest/tests/obsidian.test.mjs` | 12 项通过（新增断言并入现有分组） |
| `obsidian_note` render（2026-11-02 18:13 修） | 未回退；单测仍断言 render 含正文 / frontmatter / 出链 |

## 验证记录（2026-11-02，任务1-3：锚点校验 / 一句话误报 / m73）

| 项 | 结果 |
|---|---|
| 证伪（改前先跑旧代码） | ✅ 旧实现把「文件在、锚点不存在」的指针列进 `sample`（当 OK）：`#根本没有这个锚点` 未被报出；旧 lint 对 `> 一句话：` 卡报 `missing_one_liner` |
| 真实 vault lint | ✅ 28 篇 / **0 错误 0 警告**（改前 5 条误报，全是 `> 一句话：` 被当成缺结论头） |
| 真实 memory.json 指针 | ✅ 88 条记忆 / **25 条唯一指针 / 24 条带锚点 / broken 0**（改前只判文件存在，锚点不校验） |
| strict GitHub slug 实测 | 25 条只过 4 条、误报 21 条 → 因此加「数字节号」「前导片段」两条兼容规则（见上节） |
| m73 修正 | `vault://30-Build/plugin-dev-runbook.md#2` → `#先查官方有没有，再自研`；逐条 sha256 核对：88 条里**只有 m73 变了** |
| `node --check index.js` | 通过 |
| 单测 `_selftest/tests/obsidian.test.mjs` | 14 项通过（新增 2 组：锚点校验、一句话同义写法） |
| 新增用例能失败（负向对照） | ✅ 把锚点判定改成 `if (false)` → 用例红；把结论头退回字面量 `**一句话**` → 用例红；还原后全绿 |
| 真机调用 | ⚠️ 未做（本任务不重启、不改运行进程）；`obsidian_status`/`obsidian_lint` 的真机输出仍看进程里加载的那版，零重启通道见 AGENTS.md |

## 验证记录（2026-11-02，v0.4.0 记忆指针改读 memory.db）

| 项 | 结果 |
|---|---|
| 证伪（改前先跑旧代码） | ✅ 旧实现直读 `memory.json`（已冻结）：`memoryPointers` 没有 `source` 字段，数字来自旧快照 |
| 单测 `_selftest/tests/obsidian.test.mjs` | ✅ 16 项通过（新增 2 组：memory.db 优先 / 无 db 回退 json） |
| 新增用例能失败 | ✅ 断言 `source==='sqlite'`、`total`=db 去重数、`broken=0`；夹具的 memory.json 只留 1 条断指针，误读 json 必然红 |
| 真机（零重启：`_ops/apply-check.mjs --reload` → 等 6 秒 → 调 `obsidian_status`） | ✅ `memoryPointers.source='sqlite'` / `storeFile=…\memory.db` / `entryCount=110` / **total=67**、broken 0 |
| 独立脚本比对（`node:sqlite` 直查 `SELECT payload FROM entries ORDER BY seq`，同一指针正则去重） | ✅ entries=110、坏 payload=0、去重指针 **67**，与工具返回的 total 逐位一致 |
| `node --check index.js` + `node _selftest/gate/check.mjs`（在 dsh-bundles 下） | ✅ 语法门 18 入口 / 结构门 20 manifest / 测试门全量 34 个测试通过（35.1s） |

## 已知边界（诚实清单）

- **写只进白名单**：这是设计，不是遗漏。要让 AI 直接改正文，得先改白名单配置并想清冲突策略。
- **`readMemoryEntries` 是复制实现**：与 `_ops/metric-probes.mjs` 同语义、不是共享代码（跨仓 import 不现实）。两边口径由 `_selftest/tests/metric-probes.test.mjs` 的同夹具测试钉住；改一边必须同步另一边。
- **`memoryPointers.file` 仍是 `memory.json` 路径**：向后兼容字段；真实读取来源看 `source` / `storeFile`。
- **冲突检测靠调用方传 expectedHash**：不传就只保证「不覆盖已有文件」，不保证「你看到的是最新版」。
- **解析是 YAML-lite**：只支持标量 / 行内列表 / 缩进列表；嵌套属性（Obsidian 不支持）不处理。
- **链接解析按 basename 取第一个**：vault 里同名笔记会有歧义，`brokenLinks` 只统计「解析不到」，不报歧义。
- **检索是词项打分**：中文按子串命中、不切词；量级到几千篇时再考虑倒排索引（触发线见方案 §7）。
- **指针漂移只报不修**：`memoryPointers` 不会自动改记忆，断链要人决定删还是补。
- **删笔记不自动判过期**：`indexStale` 只看「最新 mtime 变大」，删文件不触发；删完用 `obsidian_index({ force: true })`，或拿 `live.notes` 对照索引数（本次真机就踩到：删文件后索引仍报 22）。
