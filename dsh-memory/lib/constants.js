/**
 * dsh-memory 调参与存储常量。
 *
 * 所有阈值/上限/开关集中在这里；改行为先看这里，别在函数里散落魔数。
 */

// v3.21：8000 → 12000。取经五家开源实现后确认：mem0 / memobase 存储根本不设上限，容量只在注入侧卡；
// Letta 也是「不设总条数预算，靠注入预算 + 摘要压缩」。我们此前「存储 8000 + 注入 1200/1500」双层都卡，
// 实测后果是「记忆加不进去」（7892/8000 只剩 108 字符）。注入预算才是真正影响 token 成本的那层，存储层放宽。
export const DEFAULT_MAX_BYTES = 12000

export const BACKUP_KEEP = 10

// v4.1（P2）：存储后端。'sqlite' = 单文件 memory.db（node:sqlite，内置 SQLite，零依赖）；
// 'json' = 旧 memory.json 全量写（保留为**回滚开关**：配置 storage: json 即回到旧行为，数据不丢）。
export const STORE_BACKENDS = new Set(['sqlite', 'json'])

export const DB_FILE = 'memory.db'

export const DB_SCHEMA_VERSION = 1

export const DB_MIGRATION_LOCK = 'memory.db.migrating'

// 中文/符号词表由应用层 tokenize 生成后空格分隔喂给 FTS5；tokenchars 保住 dsh-memory / index.js / v4.0.1 不被拆碎。
// 绝不能让 FTS5 默认分词器直接吃中文原文：连续中文会被当成一个巨大 token（蓝图 §4 / GitHub 调研实证）。
export const FTS_TOKENIZE = "unicode61 tokenchars '-_.'"

// v4.1：检索路径开关。'index' = FTS5 候选集 + 统计表（默认）；'scan' = 旧的全量遍历（P2.2 差分不过/出问题时的回退开关）。
export const RETRIEVAL_MODES = new Set(['index', 'scan'])

export const DEFAULT_MAX_INJECT_CHARS = 1200

export const MAX_TEXT_CHARS = 600

// v4.0.1：单条正文超长时给**可操作**的出路，而不是只抛一句「太长」。
// 依据工作区 .dsh/rules/memory-layering.md：长篇正文进 vault 卡，记忆里只留「判据 + 检索钩子 + vault://指针」。
// 实测（2026-11-01 扫描 #13）：600 字硬门与「超过 200 字就写文档」的约定不同口径，被拒的人不知道下一步该干什么。
export const TEXT_TOO_LONG_HINT =
  '出路：① 把正文写进 Obsidian vault 卡（D:\\AI-date\\obsidian\\vault\\00-Inbox\\ai-drafts\\，frontmatter 带 id/status/review），' +
  '记忆里只留一行「判据 + 检索钩子 + vault://相对路径#节号」指针；② 拆成多条更短的事实；③ 用 memory_update 精简。'

// v4.0.1：存储撞墙时自动归档的年龄门槛。原来是 30 天，与真实使用不匹配——
// 实测库里 >30 天的条目长期是 0 条，于是 makeRoom 永远找不到候选、正常写入被硬拒（扫描 #11）。
// 7 天是「已经放了一周、且一次都没被检索命中」的条目：仍可 memory_restore 恢复，归档不删数据。
export const ROOM_MIN_AGE_DAYS = 7

// ── v4.2（集百家所长）：kind 语义、可推导过滤、见顶精简 ──
// reference：外部信息在哪找（Anthropic 四类笔记之一）。位置会变，180 天后标「待重验」。
// procedure：验证过的工作流（Google ADK 四层模型的 Procedural）。门槛是「真跑成功 ≥2 次」，
//   不是「用户说记住」——来自 Voyager 的 skill 入库规则（_research/memory-classic-ideas.md:10）。
// 未知 kind 仍允许（存量库已有 state/handoff/progress 等自定义 kind），按 fact 口径处理，不拒绝。
export const KIND_REFERENCE = 'reference'

export const KIND_PROCEDURE = 'procedure'

export const REFERENCE_STALE_DAYS = 180

export const PROCEDURE_MIN_VERIFIED = 2

// v4.2（Anthropic A4 / 论文 write-path filtering）：写入前判「这条能不能从规则源推出来」。
// 能推出来 → 不记（规则每轮已注入，再记一遍只占预算）。保守阈值 + 逃生口 force:true。
export const DERIVABLE_FLOOR = 0.86

export const DERIVABLE_MIN_CHARS = 16

// v3.9：别名也是存储，不能无限灌（B15）。
export const MAX_ALIASES = 8

export const MAX_ALIAS_CHARS = 60

export const CONTEXT_ORDER = 900

export const INDEX_SUMMARY_CHARS = 44

// v3.13：0.3 → 0.4。相关层（给全文的那层）预算占比。0.3 时两条全文经常装不下第二条：
// 实测「这个评测套件发到 GitHub 上了吗」covTop=m78 0.61，但 m71（更长的全文）先占满 450 字符额度，
// m78 被预算挡在门外。0.4 后短问法/换皮都不掉，长句 13/15 → 14/15。
export const RELEVANT_SHARE = 0.4

export const MAX_RELEVANT = 2

const RELEVANT_CONFIDENCE = 1.5

export const MAX_QUERY_CHARS = 400

export const SCOPE_BOOST = 1.4

// v2.3 检索：相关性覆盖率下限（命中内容单元的信息量 ÷ 查询内容单元的信息量，与语料规模无关）
// + 三因子加权（Generative Agents 思路）。
// v3.8：0.15 → 0.16。v3.12：0.16 → 0.20 —— 中文单元从 bigram 换成词以后，查询的「分母」变小
//   （一句话的单元数少了），覆盖率整体上移：旧阈值下短问法负例会漏进 3 条。
//   v3.12 实测（74 正例 / 35 负例）：负例最高「电脑为什么会蓝屏」0.3296（由单单元护栏挡住），
//   次高「MySQL 索引优化怎么做」0.1918，正例在 0.20 这条线上正好保住全部分数（见 README v3.12）。
export const RELEVANCE_FLOOR = 0.20

// v3.11：第二档放行条件。覆盖率单指标在正例长尾（0.07–0.16）跟负例（最高 0.147）是重叠的 ——
// 只靠一条阈值必然二选一：要么漏掉 21% 的真命中，要么放进负例。
// 于是加第二个独立信号：**覆盖率最高的那条记忆，跟排序层 top1 是不是同一条**。
// 两个不同口径的检索都指向它，才允许在低覆盖率下放行。
// v3.12：0.07 → 0.12。同上：词级口径下偏低覆盖率更少见，0.12 才能只放「两个信号一致」的真命中。
export const RELEVANCE_FLOOR_AGREE = 0.12

// v3.12：单单元匹配的两档更高下限（见 gateDecision 的护栏注释）。
//   短查询（≤2 个内容单元）：0.40；长查询（≥3 个）：0.25。
export const RELEVANCE_SINGLE_WORD_FLOOR_SHORT = 0.40

export const RELEVANCE_SINGLE_WORD_FLOOR_LONG = 0.25

// v3.19：过期条目的排序惩罚（不是过滤 —— 过期信息仍要能搜到，只是不该排在前面）。
export const STALE_PENALTY = 0.55

export const COMPOSITE_IMPORTANCE_WEIGHT = 0.5

export const COMPOSITE_RECENCY_WEIGHT = 0.3

export const RELEVANT_COMPOSITE_MARGIN = 1.15

export const RECENCY_DECAY_PER_HOUR = 0.995

export const CANDIDATE_LIMIT = 50

// v2.7：跨域压缩保留主题摘要（原来只剩 <scope> 标签，等于没注入）；写入时给相似邻居提示（A-MEM 的零模型版）
export const COMPACT_PEEK_CHARS = 14

export const SIMILAR_HINT_FLOOR = 0.62

export const MAX_SIMILAR_HINT = 2

// v4.0（考虑以后）：写入冲突硬门。相似度 ≥ 此值 + **双方 scope 都非空且相同** + 双方都生效 → 拒绝写入，
// 逼调用方三选一：supersede（推翻旧条）/ allowDuplicate（明确要并存）/ status=draft（先存疑）。
// 依据 2026-11-01 调研：mem0/Letta/Graphiti 唯一有共识的是「变更留痕 + 冲突要显式处理」，不是加图。
// v4.0.1 修误报（_reports/plugin-falsepositive-scan-2026-11-01.md #10）：
//   ① 0.88 → 0.92：同结构、结论不同的两条日常汇报实测相似度 0.818，0.88 会把「像但不同」也拒掉；
//   ② 冲突必须**双方都有 scope**：任一侧没写 scope 就不参与判定。原来「任一侧空 = 不限」等于把
//      无 scope 的老条目变成万能冲突源，新条目几乎全被拉进判定（实测 6/71 条无 scope）。
export const CONFLICT_FLOOR = 0.92

// v4.0：实体标签（纯字符串，无实体表、无边、不抽 LLM）。mem0 v3 同款——
// 当下最便宜，且是将来真要做关系层时唯一现成的锚点。现在不打，几千条之后没法回头补。
export const MAX_ENTITIES = 12

export const MAX_ENTITY_CHARS = 40

// v4.0：来源条目上限（sources 是「可反查原文」的最小载体：文件:行号 / 会话 id / URL）。
export const MAX_SOURCES = 8

// v4.0：持久化 schema 版本。迁移只写脚本、不手改数据；老条目自动补默认值，永不重写历史。
export const SCHEMA_VERSION = 2

// v4.0：scope 收敛为「global 或小驼峰 slug」。历史上 8 种取值混用、10 条没有 scope；
// 工作区还在加，再长下去治理不动，所以趁 60 条时先立格式。
export const SCOPE_SLUG = /^[a-z][a-z0-9-]{0,31}$/

export const DEFAULT_SCOPE_ROOTS = {
  'plugin-dev': ['D:\\AI\\dsh-bundles'],
  'data-infra': ['D:\\AI\\dsh-data'],
  'dsh-date': ['D:\\AI-date\\dsh-date'],
}

// v4.2：reference（去哪找）5 分；procedure（验证过的流程）7 分——高于普通事实，低于硬规则。
export const IMPORTANCE_BASE = { rule: 8, procedure: 7, preference: 6, reference: 5, fact: 4, note: 2 }

// v2.9 学习进化：被引用够多就该升级（巩固），长期无人用就该降权（遗忘）
export const CONSOLIDATE_MIN_USES = 3

export const MAX_CANDIDATES_PER_TURN = 2

export const CANDIDATE_TTL_DAYS = 7

/**
 * v3.27：先整块剥掉 DSH 注入进 user 消息的运行时块。
 *
 * 起因（2026-10-31 实测）：关掉「规则文件沉淀」后仍冒出候选 c19，内容正是 core.md 的
 * 「新增插件必须同时配测试」——它是被 <path-rules> 注入进 user 消息后，又被用户消息沉淀抓到的。
 * v3.1 只剥了 <memory>，漏了其余注入块。这里是「沉淀前」的清洗，污染门（extractCandidates 内）
 * 只作最后一道防线。
 */
export const HARNESS_BLOCK_TAGS = ['memory', 'path-rules', 'available_skills', 'system-reminder']

export const MEMORY_HEADER =
  '以下是跨会话记住的用户/项目事实（越靠后越新）。把它们当背景，不要逐条复述；与用户本轮明确指令冲突时，以本轮指令为准。'

export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

// 中文词典词的最大长度（分词细节与词典加载见 lib/text.js）。
export const ZH_WORD_MAX = 3

// 分词结果按输入字符串缓存：同一批记忆条目每轮会被重复切很多次（渲染 + 排序 + 门槛各一遍）。
// 缓存上限到了就整体清空 —— 宁可偶尔重算，也不让长会话把内存吃满。
export const SEGMENT_CACHE_LIMIT = 4000

export const BM25_K1 = 1.2

export const BM25_B = 0.75

export const BM25_TAG_WEIGHT = 2

/** aliases 是人工写的「跨词面桥」，命中权重应高于 tag（tag 是分类，alias 是等同词）。 */
export const BM25_ALIAS_WEIGHT = 2.5

/** 同义词扩展的权重：低于原词，避免扩展词把噪声顶上来。 */
export const EXPANSION_WEIGHT = 0.2
