/**
 * dsh-memory —— 跨会话的持久记忆（用户级事实）。
 *
 * 学谁：Hermes Agent 的 `MEMORY.md` / `USER.md`，Claude Code 的用户级 CLAUDE.md。
 * 做法：把记忆渲染成一段文本，通过官方 `systemPrompt.context()` 注册进**每个会话**
 * 的系统提示；agent 用五个工具维护（list / add / update / remove / search）。
 *
 * 几个刻意的取舍：
 *   - **不做会话内冻结快照**：Hermes 冻结是为了缓存稳定，但 DSH 每次 assemble 本来就会
 *     重新取 context；记忆只在显式 add/update/remove 时变化，频率极低，缓存代价可忽略。
 *     好处是"刚记住的，下一步就生效"。
 *   - **存储预算与注入预算分开**（v1.1）：存储可到 `maxBytes`（默认 8000 字符），
 *     但每轮注入只花 `maxInjectChars`（默认 1200 字符）。`pinned` 的硬规则永远优先全文注入，
 *     其余按"越新越优先"分配全文；装不下的降级成一行索引（id + tag + 摘要），
 *     agent 需要时用 `memory_search` 取全文。这样记忆能长，而每轮 prompt 成本封顶。
 *   - **超预算就拒绝写入**，不自动淘汰：让 agent 明确知道要删哪条，避免悄悄丢用户信息。
 *   - **只存文本**：不写会话日志、不新增事件类型（DSH 的硬约束）。
 *   - 数据落 `config.storeDir`（本机 D:\AI\dsh-data\memory），不落 C 盘。
 *
 * 已知边界：
 *   - 全局一份（不按项目分），这是"用户级记忆"的定位；
 *   - 记忆注入发生在请求装配时，同一轮里刚写的内容对**下一条**模型请求生效；
 *   - 没有自动整理/去重之外的合并（去重只跳过完全相同的文本）；
 *   - `memory_search` 是子串 + 分词计分的轻量检索，不是语义检索（记忆体量小，够用）。
 */

import { appendFileSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

export const name = 'dsh-memory'
export const inject = ['tools', 'systemPrompt', 'workingDirectory']

// v3.21：8000 → 12000。取经五家开源实现后确认：mem0 / memobase 存储根本不设上限，容量只在注入侧卡；
// Letta 也是「不设总条数预算，靠注入预算 + 摘要压缩」。我们此前「存储 8000 + 注入 1200/1500」双层都卡，
// 实测后果是「记忆加不进去」（7892/8000 只剩 108 字符）。注入预算才是真正影响 token 成本的那层，存储层放宽。
const DEFAULT_MAX_BYTES = 12000
const BACKUP_KEEP = 10
// v4.1（P2）：存储后端。'sqlite' = 单文件 memory.db（node:sqlite，内置 SQLite，零依赖）；
// 'json' = 旧 memory.json 全量写（保留为**回滚开关**：配置 storage: json 即回到旧行为，数据不丢）。
const STORE_BACKENDS = new Set(['sqlite', 'json'])
const DB_FILE = 'memory.db'
const DB_SCHEMA_VERSION = 1
const DB_MIGRATION_LOCK = 'memory.db.migrating'
// 中文/符号词表由应用层 tokenize 生成后空格分隔喂给 FTS5；tokenchars 保住 dsh-memory / index.js / v4.0.1 不被拆碎。
// 绝不能让 FTS5 默认分词器直接吃中文原文：连续中文会被当成一个巨大 token（蓝图 §4 / GitHub 调研实证）。
const FTS_TOKENIZE = "unicode61 tokenchars '-_.'"
// v4.1：检索路径开关。'index' = FTS5 候选集 + 统计表（默认）；'scan' = 旧的全量遍历（P2.2 差分不过/出问题时的回退开关）。
const RETRIEVAL_MODES = new Set(['index', 'scan'])
const DEFAULT_MAX_INJECT_CHARS = 1200
const MAX_TEXT_CHARS = 600
// v4.0.1：单条正文超长时给**可操作**的出路，而不是只抛一句「太长」。
// 依据工作区 .dsh/rules/memory-layering.md：长篇正文进 vault 卡，记忆里只留「判据 + 检索钩子 + vault://指针」。
// 实测（2026-11-01 扫描 #13）：600 字硬门与「超过 200 字就写文档」的约定不同口径，被拒的人不知道下一步该干什么。
const TEXT_TOO_LONG_HINT =
  '出路：① 把正文写进 Obsidian vault 卡（D:\\AI-date\\obsidian\\vault\\00-Inbox\\ai-drafts\\，frontmatter 带 id/status/review），' +
  '记忆里只留一行「判据 + 检索钩子 + vault://相对路径#节号」指针；② 拆成多条更短的事实；③ 用 memory_update 精简。'
// v4.0.1：存储撞墙时自动归档的年龄门槛。原来是 30 天，与真实使用不匹配——
// 实测库里 >30 天的条目长期是 0 条，于是 makeRoom 永远找不到候选、正常写入被硬拒（扫描 #11）。
// 7 天是「已经放了一周、且一次都没被检索命中」的条目：仍可 memory_restore 恢复，归档不删数据。
const ROOM_MIN_AGE_DAYS = 7
// v3.9：别名也是存储，不能无限灌（B15）。
const MAX_ALIASES = 8
const MAX_ALIAS_CHARS = 60
const CONTEXT_ORDER = 900
const INDEX_SUMMARY_CHARS = 44
// v3.13：0.3 → 0.4。相关层（给全文的那层）预算占比。0.3 时两条全文经常装不下第二条：
// 实测「这个评测套件发到 GitHub 上了吗」covTop=m78 0.61，但 m71（更长的全文）先占满 450 字符额度，
// m78 被预算挡在门外。0.4 后短问法/换皮都不掉，长句 13/15 → 14/15。
const RELEVANT_SHARE = 0.4
const MAX_RELEVANT = 2
const RELEVANT_CONFIDENCE = 1.5
const MAX_QUERY_CHARS = 400
const SCOPE_BOOST = 1.4
// v2.3 检索：相关性覆盖率下限（命中内容单元的信息量 ÷ 查询内容单元的信息量，与语料规模无关）
// + 三因子加权（Generative Agents 思路）。
// v3.8：0.15 → 0.16。v3.12：0.16 → 0.20 —— 中文单元从 bigram 换成词以后，查询的「分母」变小
//   （一句话的单元数少了），覆盖率整体上移：旧阈值下短问法负例会漏进 3 条。
//   v3.12 实测（74 正例 / 35 负例）：负例最高「电脑为什么会蓝屏」0.3296（由单单元护栏挡住），
//   次高「MySQL 索引优化怎么做」0.1918，正例在 0.20 这条线上正好保住全部分数（见 README v3.12）。
const RELEVANCE_FLOOR = 0.20
// v3.11：第二档放行条件。覆盖率单指标在正例长尾（0.07–0.16）跟负例（最高 0.147）是重叠的 ——
// 只靠一条阈值必然二选一：要么漏掉 21% 的真命中，要么放进负例。
// 于是加第二个独立信号：**覆盖率最高的那条记忆，跟排序层 top1 是不是同一条**。
// 两个不同口径的检索都指向它，才允许在低覆盖率下放行。
// v3.12：0.07 → 0.12。同上：词级口径下偏低覆盖率更少见，0.12 才能只放「两个信号一致」的真命中。
const RELEVANCE_FLOOR_AGREE = 0.12
// v3.12：单单元匹配的两档更高下限（见 gateDecision 的护栏注释）。
//   短查询（≤2 个内容单元）：0.40；长查询（≥3 个）：0.25。
const RELEVANCE_SINGLE_WORD_FLOOR_SHORT = 0.40
const RELEVANCE_SINGLE_WORD_FLOOR_LONG = 0.25
// v3.19：过期条目的排序惩罚（不是过滤 —— 过期信息仍要能搜到，只是不该排在前面）。
const STALE_PENALTY = 0.55
/** 只写日期的字段（staleAfter / invalidAt）→ 本地日历日零点的毫秒时间戳；非法返回 NaN。 */
function localDayStart(stamp) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(stamp))
  if (parts === null) return NaN
  return new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), 0, 0, 0, 0).getTime()
}
/** 待复核判据：staleAfter 走本地日历日字符串比较，与 invalidAt 同一口径（本地日）。 */
export function isStaleEntry(entry, today = localDateOf()) {
  return typeof entry?.staleAfter === 'string' && DATE_ONLY.test(entry.staleAfter) && entry.staleAfter < today
}

/**
 * v3.20：一条记忆算不算「归档」——被取代（supersededBy）或显式 deprecated。
 * 从 v3.3 起 activeEntries 就是这个口径，这里提成模块级函数，给「归档分文件冷存」复用，
 * 避免两处判断漂移（历史教训：只判 supersededBy 时 deprecated 条目仍算生效，预算虚高）。
 */
export function isArchivedEntry(entry) {
  return (
    (typeof entry?.supersededBy === 'string' && entry.supersededBy !== '') ||
    entry?.status === 'deprecated' ||
    isInvalidEntry(entry)
  )
}

/**
 * v4.0：一条记忆是否「已失效」——invalidAt 到了。
 * 对齐 Graphiti 双时间戳里真正有用的那一半（valid_from/invalid_to），但不引入任何实体/边：
 * 一条事实「从某天起不再成立」照样能表达，旧条目留档不删（可反查历史）。
 *
 * v4.0.1 口径统一（扫描 #12）：只写 `YYYY-MM-DD` 时按**本地日历日零点**解释，不再按 `T00:00:00Z`。
 * 原来两种口径并存：staleAfter 走本地日（localDateOf 字符串比较）、invalidAt 走 UTC 日；
 * 北京时间 00:00–08:00 期间「当日失效」的条目仍会被注入和检索到（UTC 零点 = 本地 8 点）。
 * 现在两者都以本地日历为准，语义差异只剩一条、且是刻意的：
 *   - invalidAt：**当地日期当天零点起**不再成立（"从哪天起失效"）；
 *   - staleAfter：**到该日期当天为止**仍有效，次日本地零点起才算待重验（"哪天该复核"）。
 * 测试用「本地 00:30」这种构造钉住，不依赖跑测试的钟点。
 */
export function isInvalidEntry(entry, now = Date.now()) {
  const raw = typeof entry?.invalidAt === 'string' ? entry.invalidAt.trim() : ''
  if (raw === '') return false
  const stamp = DATE_ONLY.test(raw) ? localDayStart(raw) : Date.parse(raw)
  return Number.isFinite(stamp) && stamp <= now
}
const COMPOSITE_IMPORTANCE_WEIGHT = 0.5
const COMPOSITE_RECENCY_WEIGHT = 0.3
const RELEVANT_COMPOSITE_MARGIN = 1.15
const RECENCY_DECAY_PER_HOUR = 0.995
const CANDIDATE_LIMIT = 50
// v2.7：跨域压缩保留主题摘要（原来只剩 <scope> 标签，等于没注入）；写入时给相似邻居提示（A-MEM 的零模型版）
const COMPACT_PEEK_CHARS = 14
const SIMILAR_HINT_FLOOR = 0.62
const MAX_SIMILAR_HINT = 2
// v4.0（考虑以后）：写入冲突硬门。相似度 ≥ 此值 + **双方 scope 都非空且相同** + 双方都生效 → 拒绝写入，
// 逼调用方三选一：supersede（推翻旧条）/ allowDuplicate（明确要并存）/ status=draft（先存疑）。
// 依据 2026-11-01 调研：mem0/Letta/Graphiti 唯一有共识的是「变更留痕 + 冲突要显式处理」，不是加图。
// v4.0.1 修误报（_reports/plugin-falsepositive-scan-2026-11-01.md #10）：
//   ① 0.88 → 0.92：同结构、结论不同的两条日常汇报实测相似度 0.818，0.88 会把「像但不同」也拒掉；
//   ② 冲突必须**双方都有 scope**：任一侧没写 scope 就不参与判定。原来「任一侧空 = 不限」等于把
//      无 scope 的老条目变成万能冲突源，新条目几乎全被拉进判定（实测 6/71 条无 scope）。
const CONFLICT_FLOOR = 0.92
// v4.0：实体标签（纯字符串，无实体表、无边、不抽 LLM）。mem0 v3 同款——
// 当下最便宜，且是将来真要做关系层时唯一现成的锚点。现在不打，几千条之后没法回头补。
const MAX_ENTITIES = 12
const MAX_ENTITY_CHARS = 40
// v4.0：来源条目上限（sources 是「可反查原文」的最小载体：文件:行号 / 会话 id / URL）。
const MAX_SOURCES = 8
// v4.0：持久化 schema 版本。迁移只写脚本、不手改数据；老条目自动补默认值，永不重写历史。
const SCHEMA_VERSION = 2
// v4.0：scope 收敛为「global 或小驼峰 slug」。历史上 8 种取值混用、10 条没有 scope；
// 工作区还在加，再长下去治理不动，所以趁 60 条时先立格式。
const SCOPE_SLUG = /^[a-z][a-z0-9-]{0,31}$/
const DEFAULT_SCOPE_ROOTS = {
  'plugin-dev': ['D:\\AI\\dsh-bundles'],
  'data-infra': ['D:\\AI\\dsh-data'],
  'dsh-date': ['D:\\AI-date\\dsh-date'],
}

// 顺序 = 信号强度：具体知识型在前，泛化命令式在后。
// 否则「结论是必须走 API」会被泛化的「必须」抢先命中，reason 就失真了。
const CANDIDATE_RULES = [
  { pattern: /记住|记一下|记下/, reason: '显式要求记住' },
  // v2.9：知识型陈述——真正值得沉淀的东西。原来的四条命令式规则只认「记住/以后/别再」，
  // 这类「实测/结论」型知识全被漏掉，候选池长期 0 条。
  { pattern: /已实测|实测过|验证过|已验证|踩过坑|踩坑|复现了/, reason: '实测结论' },
  { pattern: /结论是|结论：|根因|原因是|发现它|确认了/, reason: '结论/归因' },
  { pattern: /以后|下次|今后/, reason: '未来行为约定' },
  { pattern: /别再|不要再|不要用|不要/, reason: '禁止项' },
  { pattern: /一律|永远|必须|务必|规矩|约定/, reason: '硬规则措辞' },
]

const normalizePath = (value) => String(value ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

const IMPORTANCE_BASE = { rule: 8, preference: 6, fact: 4, note: 2 }

/**
 * 工作区级条件注入（v3.0）。
 * 痛点：7 条 pinned 里 m10/m11/m12 三条礼仪规则（178 字）只在两个工作区适用，
 * 却每轮全文注入到所有工作区，占掉超支预算的 74%。scope 粒度不够——它们和本工作区同属 dsh-date。
 * 做法：条目可带 workspaces（绝对路径前缀），当前 cwd 不匹配就整条不注入（仍能被 memory_search 搜到）。
 * 没设 workspaces 的条目行为完全不变（向后兼容）。
 */
export function applicableAt(entry, cwd) {
  const list = Array.isArray(entry?.workspaces) ? entry.workspaces.filter((item) => typeof item === 'string' && item.trim() !== '') : []
  if (list.length === 0) return true
  if (typeof cwd !== 'string' || cwd.trim() === '') return false
  const here = normalizePath(cwd)
  return list.some((item) => {
    const root = normalizePath(item)
    return here === root || here.startsWith(root + '\\')
  })
}
// v2.9 学习进化：被引用够多就该升级（巩固），长期无人用就该降权（遗忘）
const CONSOLIDATE_MIN_USES = 3
const MAX_CANDIDATES_PER_TURN = 2
const CANDIDATE_TTL_DAYS = 7

/**
 * 按 kind 推导 staleAfter（v2.8）。
 * 依据：OpenAI 2026 记忆架构升级里，事实回忆 82.8%、偏好遵循 71.3%，而「跨时间准确性」只有 75.1%
 * ——时间失效是全行业最弱的一环，靠人工记得填 staleAfter 不现实。
 * 取舍：rule / preference 是长期约定，不设（设了反而天天报警）；fact 90 天；note 30 天。
 * 只对新写入生效，存量条目不动（避免一次性给 63 条补上今天的日期）。
 */
export function deriveStaleAfter(kind, base = new Date()) {
  const days = kind === 'fact' ? 90 : kind === 'note' ? 30 : 0
  if (days === 0) return ''
  return localDateOf(new Date(base.getTime() + days * 86400000))
}

/**
 * v3.9：日期一律走本地日历。
 * 原来 toISOString().slice(0,10) 取的是 UTC 日期，于是同一条事实「90 天后过期」
 * 会取决于当天几点写：本地 0:30 写得到前一天，9:00 写得到当天（B12）。
 */
export function localDateOf(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** 记忆重要度 1-10：显式字段优先，否则按 kind / pinned / 使用次数规则推导（Generative Agents 的 importance 零模型替代）。 */
export function importanceOf(entry) {
  if (Number.isInteger(entry?.importance) && entry.importance >= 1 && entry.importance <= 10) return entry.importance
  const kind = typeof entry?.kind === 'string' ? entry.kind : ''
  let base = IMPORTANCE_BASE[kind] ?? 4
  if (Array.isArray(entry?.tags) && entry.tags.includes('rule')) base = Math.max(base, 8)
  if (entry?.pinned === true) base += 2
  const used = Number.isFinite(entry?.usedCount) ? entry.usedCount : 0
  base += Math.min(2, 1.5 * Math.log1p(used))
  return Math.max(1, Math.min(10, Math.round(base)))
}

/**
 * 有效重要度（v2.9 遗忘曲线）：在 importanceOf 上叠加「多久没被命中」的衰减。
 * 依据：本库实测 26/63 从未被引用——长期无人用的条目不该继续占注入高位。
 * 取舍：pinned / rule 永不衰减（硬约定）；其余按 7 / 30 / 90 天分档降到 0.9 / 0.7 / 0.5。
 * 只影响注入排序，**不改存储值、不删除任何条目**，随时可回滚。
 */
export function effectiveImportance(entry, now = Date.now()) {
  const base = importanceOf(entry)
  if (entry?.pinned === true) return base
  if (entry?.kind === 'rule') return base
  const ref = typeof entry?.lastUsedAt === 'string' && entry.lastUsedAt !== '' ? entry.lastUsedAt : entry?.addedAt
  const stamp = typeof ref === 'string' ? Date.parse(ref) : NaN
  if (!Number.isFinite(stamp)) return base
  const days = (now - stamp) / 86400000
  if (days <= 7) return base
  if (days <= 30) return base * 0.9
  if (days <= 90) return base * 0.7
  return base * 0.5
}

const idfOf = (total, hit) => Math.log(1 + (total - hit + 0.5) / (hit + 0.5))

/**
 * 查询词的 idf 总和：v2.3–v3.7 的「相关覆盖率」分母（含 unigram，片段会三重计数）。
 * v3.8 起门槛不再用它（改用 relevanceCoverage 的内容单元口径），保留给旧测试与对照分析。
 */
export function queryIdfSum(entries, query) {
  const docs = (Array.isArray(entries) ? entries : []).map((entry) =>
    tokenize(`${entry.text} ${Array.isArray(entry.tags) ? entry.tags.join(' ') : entry.tag ?? ''}`),
  )
  const total = docs.length
  if (total === 0) return 0
  let sum = 0
  for (const term of tokenize(query).keys()) {
    const hit = docs.filter((doc) => doc.has(term)).length
    sum += idfOf(total, hit)
  }
  return sum
}

/** 新鲜度 0-1：距上次命中/更新的小时数做 0.995^h 衰减（半衰 ≈ 5.8 天）。 */
export function recencyOf(entry, now = Date.now()) {
  const stamp =
    typeof entry?.lastUsedAt === 'string' && entry.lastUsedAt !== ''
      ? entry.lastUsedAt
      : typeof entry?.updatedAt === 'string' && entry.updatedAt !== ''
        ? entry.updatedAt
        : entry?.addedAt
  const time = Date.parse(String(stamp ?? ''))
  if (!Number.isFinite(time)) return 0.5
  const hours = Math.max(0, (now - time) / 3600000)
  return RECENCY_DECAY_PER_HOUR ** hours
}

/** 按 cwd 前缀映射到 scope 域；对不上返回空串（不做硬过滤，只是不加分）。 */
export function detectScope(cwd, roots) {
  const target = normalizePath(cwd)
  if (target === '') return ''
  const table = roots !== undefined && roots !== null && typeof roots === 'object' ? roots : DEFAULT_SCOPE_ROOTS
  for (const [scope, prefixes] of Object.entries(table)) {
    for (const prefix of Array.isArray(prefixes) ? prefixes : []) {
      const base = normalizePath(prefix)
      if (base !== '' && (target === base || target.startsWith(`${base}\\`))) return scope
    }
  }
  return ''
}

export function bigramSet(value) {
  const set = new Set()
  const clean = String(value ?? '').toLowerCase()
  for (const run of clean.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let index = 0; index + 2 <= run.length; index += 1) set.add(run.slice(index, index + 2))
  }
  for (const word of clean.match(/[a-z0-9][a-z0-9_\-.]{2,}/g) ?? []) set.add(word)
  return set
}

export function textSimilarity(left, right) {
  const a = bigramSet(left)
  const b = bigramSet(right)
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared += 1
  const union = a.size + b.size - shared
  return union === 0 ? 0 : shared / union
}

/**
 * v3.27：先整块剥掉 DSH 注入进 user 消息的运行时块。
 *
 * 起因（2026-10-31 实测）：关掉「规则文件沉淀」后仍冒出候选 c19，内容正是 core.md 的
 * 「新增插件必须同时配测试」——它是被 <path-rules> 注入进 user 消息后，又被用户消息沉淀抓到的。
 * v3.1 只剥了 <memory>，漏了其余注入块。这里是「沉淀前」的清洗，污染门（extractCandidates 内）
 * 只作最后一道防线。
 */
const HARNESS_BLOCK_TAGS = ['memory', 'path-rules', 'available_skills', 'system-reminder']

export function stripHarnessBlocks(text) {
  let out = String(text ?? '')
  for (const tag of HARNESS_BLOCK_TAGS) {
    out = out.replace(new RegExp('<' + tag + '(?:\\s[^>]*)?>[\\s\\S]*?</' + tag + '>', 'gi'), ' ')
  }
  return out.trim()
}

/** 从用户消息里按规则抽「值得沉淀」的候选事实；纯规则、零模型调用。 */
export function extractCandidates(text) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (raw === '') return []
  // v2.9：先按句切分再逐句判定。原实现把整段消息塞进候选池，那不是原子事实；
  // 且一条消息最多出 MAX_CANDIDATES_PER_TURN 条，防止刷屏。
  const clauses = raw.split(/[。；;！!\n]/).map((item) => item.trim()).filter((item) => item !== '')
  const source = clauses.length > 0 ? clauses : [raw]
  const out = []
  for (const clause of source) {
    if (out.length >= MAX_CANDIDATES_PER_TURN) break
    if (clause.length < 8 || clause.length > 160) continue
    if (/[?？]$/.test(clause)) continue
    // v3.1 污染门：注入块自身的标记/提示语一律不收。剥离失败时这是最后一道防线。
    if (
      clause.includes('📌') ||
      clause.includes('<memory>') ||
      clause.includes('</memory>') ||
      clause.includes('<path-rules>') ||
      clause.includes('</path-rules>') ||
      clause.includes('<available_skills>') ||
      clause.includes('<system-reminder>') ||
      clause.includes('不要逐条复述') ||
      clause.includes('用 memory_search 按 id')
    ) {
      continue
    }
    const hit = CANDIDATE_RULES.find((rule) => rule.pattern.test(clause))
    if (hit === undefined) continue
    const kind = /别再|不要再|不要用|一律|永远|必须|务必|规矩|约定/.test(clause) ? 'rule' : 'fact'
    out.push({ text: clause.slice(0, MAX_TEXT_CHARS), kind, reason: hit.reason })
  }
  return out
}

/**
 * v3.17 规则文件沉淀：从 AGENTS.md / .dsh/rules 抽「硬规则」进候选池。
 * 起因（2026-10-30 实测）：搜「cua 工具被过滤成几个」「插件必须配什么测试」时记忆库空手 ——
 * 这两条规则只存在于规则文件里，从没进过记忆库。写入覆盖是记忆系统第一位的问题，
 * 而当时的候选沉淀只抓用户消息，抓不到 agent 读到的规则。
 *
 * 只抽「硬规则行」（必须/一律/永远/禁止/不要/不得/务必/只能），跳过代码块、标题、表格、引用。
 * 进**候选池**不直接入库 —— 影子模式不变，仍要人点头。
 */
const RULE_MARKERS = /必须|一律|永远|禁止|不要|不得|务必|只能|别再|绝对/
export function extractRuleCandidates(text, taken = new Set()) {
  const raw = String(text ?? '')
  if (raw.trim() === '') return []
  const out = []
  let inFence = false
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (trimmed === '') continue
    if (trimmed.startsWith('#')) continue
    if (trimmed.startsWith('|')) continue
    if (trimmed.startsWith('>')) continue
    const body = trimmed
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+[.、)]\s+/, '')
      .replace(/\*\*/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (body.length < 8 || body.length > 160) continue
    if (!RULE_MARKERS.test(body)) continue
    if (/[?？]$/.test(body)) continue
    // 以冒号结尾的是「引出下文」的引导句，不是规则本身（实测：「看资料时按这个顺序，不要一上来只搜 DSH 插件：」）。
    if (/[：:]$/.test(body)) continue
    if (taken.has(body)) continue
    out.push({ text: body.slice(0, MAX_TEXT_CHARS), kind: 'rule', reason: '规则文件' })
  }
  return out
}

/** 规则文件清单：工作区根 AGENTS.md / CLAUDE.md、.dsh/rules/*.md、全局 ~/.dsh/AGENTS.md。 */
export function collectRuleFiles(cwd) {
  const files = []
  if (typeof cwd === 'string' && cwd !== '') {
    files.push(path.join(cwd, 'AGENTS.md'))
    files.push(path.join(cwd, 'CLAUDE.md'))
    const rulesDir = path.join(cwd, '.dsh', 'rules')
    try {
      for (const name of readdirSync(rulesDir)) {
        if (name.endsWith('.md')) files.push(path.join(rulesDir, name))
      }
    } catch (error) {
      // 没有 .dsh/rules 目录是常态
    }
  }
  files.push(path.join(os.homedir(), '.dsh', 'AGENTS.md'))
  return files.filter((candidate) => {
    try {
      return statSync(candidate).isFile()
    } catch (error) {
      return false
    }
  })
}

const MEMORY_HEADER =
  '以下是跨会话记住的用户/项目事实（越靠后越新）。把它们当背景，不要逐条复述；与用户本轮明确指令冲突时，以本轮指令为准。'

/** 统一错误契约：所有抛出的错误都带 code（UPPER_SNAKE），调用方据此分支，不必解析中文文案。 */
function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}
const text = (value) => ({ type: 'text', text: value })

function storeLocation(overrideDir) {
  const override = typeof overrideDir === 'string' ? overrideDir.trim() : ''
  const base =
    override !== ''
      ? path.resolve(override)
      : process.env.DSH_PROFILE_DIR
        ? path.join(process.env.DSH_PROFILE_DIR, 'dsh-memory')
        : path.join(os.homedir(), '.dsh', 'dsh-memory')
  return { dir: base, file: path.join(base, 'memory.json') }
}
/* ───────── v4.1（P2）：存储快照读取（诊断/基准/测试用，只读） ─────────
 * 单一入口：有 memory.db 读 SQLite，没有就按旧 JSON 口径读 memory.json + archive.json。
 * 只读保证：不建表、不迁移、不写任何文件。基准脚本 _ops/memory-bench.mjs 用它保持与真机同源。 */
let MODULE_SQLITE_API
function moduleSqliteApi() {
  if (MODULE_SQLITE_API !== undefined) return MODULE_SQLITE_API
  try {
    MODULE_SQLITE_API = createRequire(import.meta.url)('node:sqlite')
  } catch (error) {
    MODULE_SQLITE_API = null
  }
  return MODULE_SQLITE_API
}

/** 快照也要读别名旁路（插件加载后会把旁路合并进条目；快照不合并就会与真机口径不同）。 */
function mergeAliasesFromSidecar(entries, dir) {
  let sidecar = {}
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, 'aliases.json'), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && parsed.aliases !== null && typeof parsed.aliases === 'object') sidecar = parsed.aliases
  } catch (error) {
    // 没有旁路文件从空开始
  }
  for (const entry of entries) {
    const list = sidecar[entry.id]
    if (!Array.isArray(list) || list.length === 0) continue
    if (Array.isArray(entry.aliases) && entry.aliases.length > 0) continue
    entry.aliases = list
  }
  return entries
}

export function readStoreSnapshot(storeDirOverride) {
  const location = storeLocation(storeDirOverride)
  const dbPath = path.join(location.dir, DB_FILE)
  if (existsSync(dbPath)) {
    const api = moduleSqliteApi()
    if (api === null) throw fail('MEMORY_SQLITE_UNAVAILABLE', 'node:sqlite 不可用，读不了 memory.db：' + dbPath)
    const database = new api.DatabaseSync(dbPath)
    try {
      const meta = new Map()
      try {
        for (const row of database.prepare('SELECT key, value FROM meta').all()) meta.set(row.key, row.value)
      } catch (error) {
        // 空库/未初始化：按默认值
      }
      let rows = []
      try {
        rows = database.prepare('SELECT payload FROM entries ORDER BY seq').all()
      } catch (error) {
        rows = []
      }
      const entries = []
      for (const row of rows) {
        let parsed = null
        try {
          parsed = JSON.parse(row.payload)
        } catch (error) {
          parsed = null
        }
        if (parsed === null || typeof parsed !== 'object' || typeof parsed.id !== 'string' || typeof parsed.text !== 'string') continue
        entries.push(normalizeEntry(parsed))
      }
      const nextIdRaw = Number(meta.get('next_id') ?? 1)
      const versionRaw = Number(meta.get('data_version') ?? SCHEMA_VERSION)
      mergeAliasesFromSidecar(entries, location.dir)
      return {
        backend: 'sqlite',
        dir: location.dir,
        storeFile: dbPath,
        version: versionRaw > 0 ? versionRaw : SCHEMA_VERSION,
        nextId: nextIdRaw > 0 ? nextIdRaw : 1,
        entries,
      }
    } finally {
      try {
        database.close()
      } catch (error) {}
    }
  }
  let parsed = null
  try {
    parsed = JSON.parse(readFileSync(location.file, 'utf8'))
  } catch (error) {
    parsed = null
  }
  const active = Array.isArray(parsed?.entries) ? parsed.entries : []
  const archived = []
  try {
    const archivedRaw = JSON.parse(readFileSync(path.join(location.dir, 'archive.json'), 'utf8'))
    const list = Array.isArray(archivedRaw) ? archivedRaw : Array.isArray(archivedRaw?.entries) ? archivedRaw.entries : []
    const now = new Date().toISOString()
    for (const raw of list) {
      if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.text !== 'string') continue
      const entry = normalizeEntry(raw)
      archived.push(
        isArchivedEntry(entry)
          ? entry
          : { ...entry, status: 'deprecated', archivedAt: entry.archivedAt ?? now, archiveReason: entry.archiveReason ?? 'migrated: archive.json' },
      )
    }
  } catch (error) {
    // 归档缺失/损坏按空处理（与 loadArchive 同口径）
  }
  const activeIds = new Set()
  const entries = []
  for (const raw of active) {
    if (raw === null || typeof raw !== 'object') continue
    const entry = normalizeEntry(raw)
    activeIds.add(entry.id)
    entries.push(entry)
  }
  for (const entry of archived) if (!activeIds.has(entry.id)) entries.push(entry)
  const maxIdNumber = entries.reduce((max, entry) => {
    const match = /^m?(\d+)$/.exec(String(entry.id))
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)
  const storedNextId = Number.isInteger(parsed?.nextId) && parsed.nextId > 0 ? parsed.nextId : 0
  const version = Number.isInteger(parsed?.version) && parsed.version > 0 ? parsed.version : 1
  mergeAliasesFromSidecar(entries, location.dir)
  return {
    backend: 'json',
    dir: location.dir,
    storeFile: location.file,
    version,
    nextId: Math.max(storedNextId, maxIdNumber + 1),
    entries,
  }
}

// v3.20：补 archivedAt / archiveReason —— v3.19 的自动归档会写它们，但 normalizeEntry 不认识，
// 结果「load→persist」一轮就把归档时间和原因洗掉（归档历史只剩 status=deprecated 一个标记）。
const OPTIONAL_STRING_FIELDS = [
  'tag',
  'scope',
  'kind',
  'migratedFrom',
  'validFrom',
  'invalidAt',
  'supersededBy',
  'archivedAt',
  'archiveReason',
]
const OPTIONAL_NUMBER_FIELDS = ['usedCount']

// v2.6 信任字段（学 OKF v0.2 / simple-agent-memory）：把「确认的事实」「未证实的猜测」「过期待重验」分开。
// 缺省（旧数据没有这些字段）= 不标注，行为与 v2.5 完全一致，保证向后兼容。
const MEMORY_STATUS = new Set(['draft', 'stable', 'deprecated'])
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const TRUST_LEGEND =
  '标记含义：❓未证实 = 猜测/未经复核；⏰待重验 = 依赖会变的事实已过复核期；✓已验证 = 有人复核过。'

/**
 * 规范化一条记忆：v1 只有 id/text/tag/pinned，v2 增加 scope/kind/tags/paths/supersededBy/usedCount 等。
 * 关键：**未知字段要保留**，否则 load→persist 一轮就把 v2 字段洗掉了。
 */
/** v3.9：别名清洗（trim / 丢空 / 去重 / 单条 60 字 / 最多 8 条）。normalizeEntry 与去重合并共用同一口径。 */
export function cleanAliases(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const aliases = []
  for (const raw of input) {
    if (typeof raw !== 'string') continue
    const alias = raw.trim().slice(0, MAX_ALIAS_CHARS)
    if (alias === '' || seen.has(alias)) continue
    seen.add(alias)
    aliases.push(alias)
    if (aliases.length >= MAX_ALIASES) break
  }
  return aliases
}

/**
 * v4.1（官方 ADR 的判据）：存储版本高于插件支持版本时**拒绝加载**，不是猜、也不是降级读。
 * 为什么不能照旧用：旧逻辑会按旧字段写回，把高版本的数据静默洗掉（v3.6 别名被旧版本洗掉就是这类事故的最小版）。
 * 错误带 code，调用方据此把「版本太新」和「文件损坏」区分开——前者绝不能改名隔离。
 */
function schemaTooNewError(from, target) {
  const error = new Error(
    '存储版本 ' + from + ' 高于插件支持的 ' + target + '：请升级 dsh-memory 插件，或把记忆库还原为匹配版本的备份。为避免旧逻辑覆盖新数据，本次拒绝加载。',
  )
  error.code = 'MEMORY_SCHEMA_TOO_NEW'
  error.fromVersion = from
  error.targetVersion = target
  return error
}

/**
 * v4.0（考虑以后）：store schema 迁移。只升不降，老条目形状由 normalizeEntry 补齐，**内容一律不动**。
 * 迁移只写脚本、不手改数据——这是「数据能活过插件重写」的最低保证。
 */
export function migrateState(input, target = SCHEMA_VERSION) {
  const from = Number.isInteger(input?.version) && input.version > 0 ? input.version : 1
  if (from > target) throw schemaTooNewError(from, target)
  if (from === target) return { state: input, from, to: from, changed: false }
  const entries = Array.isArray(input?.entries) ? input.entries.map((entry) => normalizeEntry(entry)) : []
  return { state: { ...input, version: target, entries }, from, to: target, changed: true }
}
/** 键排序的稳定 JSON（P2 迁移回读深比对用：只比内容，不比键序）。 */
export function canonicalJson(value) {
  if (Array.isArray(value)) {
    const parts = []
    for (const item of value) parts.push(canonicalJson(item))
    return '[' + parts.join(',') + ']'
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
    keys.sort()
    const parts = []
    for (const key of keys) parts.push(JSON.stringify(key) + ':' + canonicalJson(value[key]))
    return '{' + parts.join(',') + '}'
  }
  return JSON.stringify(value)
}

/** v4.0：实体标签清洗——去重、截断、限条数。纯字符串，不建实体表。 */
export function cleanEntities(value) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const label = raw.trim().slice(0, MAX_ENTITY_CHARS)
    if (label === '') continue
    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(label)
    if (out.length >= MAX_ENTITIES) break
  }
  return out
}

/**
 * v4.0：来源清洗。约定三种形态（不强制 schema，但渲染与导出按此排序）：
 *   file:line（如 index.js:429）· session:<id> · https://…（URL）
 * 认不出的原样保留——宁可不规范，也不丢证据。
 */
export function cleanSources(value) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const item = raw.trim()
    if (item === '' || seen.has(item)) continue
    seen.add(item)
    out.push(item.slice(0, 400))
    if (out.length >= MAX_SOURCES) break
  }
  return out
}

/** v4.0：scope 规范化——只允许 global 或小写 slug；非法值直接报错（早失败好过脏数据扩散）。 */
export function normalizeScope(value) {
  if (typeof value !== 'string') return ''
  const scope = value.trim().toLowerCase()
  if (scope === '') return ''
  if (scope === 'global') return 'global'
  if (!SCOPE_SLUG.test(scope)) {
    throw fail('MEMORY_SCOPE_INVALID', 'scope 只能是 global 或小写 slug（a-z 开头，可含数字与连字符），收到：' + String(value))
  }
  return scope
}

export function normalizeEntry(input) {
  const out = { id: input.id, text: input.text }
  for (const field of OPTIONAL_STRING_FIELDS) {
    const value = input[field]
    if (typeof value === 'string' && value !== '') out[field] = value
  }
  for (const field of OPTIONAL_NUMBER_FIELDS) {
    const value = input[field]
    if (Number.isFinite(value) && value >= 0) out[field] = value
  }
  if (Number.isFinite(input.importance)) {
    out.importance = Math.max(1, Math.min(10, Math.round(input.importance)))
  }
  if (Array.isArray(input.tags)) {
    const tags = input.tags.filter((tag) => typeof tag === 'string' && tag !== '')
    if (tags.length > 0) out.tags = tags
  }
  if (Array.isArray(input.aliases)) {
    // v3.9：去重 + 单条截断 + 条数上限。之前不去重也不截断，400 个别名能把库撑到 16 KB 而 usedChars 还报 15（B15）。
    const aliases = cleanAliases(input.aliases)
    if (aliases.length > 0) out.aliases = aliases
  }
  if (Array.isArray(input.paths)) {
    const paths = input.paths.filter((item) => typeof item === 'string' && item !== '')
    if (paths.length > 0) out.paths = paths
  }
  if (Array.isArray(input.workspaces)) {
    const workspaces = input.workspaces.filter((item) => typeof item === 'string' && item.trim() !== '')
    if (workspaces.length > 0) out.workspaces = workspaces
  }
  if (MEMORY_STATUS.has(input.status)) out.status = input.status
  if (typeof input.verifiedBy === 'string' && input.verifiedBy !== '') out.verifiedBy = input.verifiedBy
  if (typeof input.verifiedAt === 'string' && input.verifiedAt !== '') out.verifiedAt = input.verifiedAt
  if (typeof input.staleAfter === 'string' && DATE_ONLY.test(input.staleAfter)) out.staleAfter = input.staleAfter
  if (Array.isArray(input.sources)) {
    const sources = cleanSources(input.sources)
    if (sources.length > 0) out.sources = sources
  }
  if (Array.isArray(input.entities)) {
    const entities = cleanEntities(input.entities)
    if (entities.length > 0) out.entities = entities
  }
  if (input.pinned === true) out.pinned = true
  // v3.23：inject:false = 只检索、不注入（事实/历史类条目用）。缺省等于 true。
  if (input.inject === false) out.inject = false
  if (typeof input.lastUsedAt === 'string' && input.lastUsedAt !== '') out.lastUsedAt = input.lastUsedAt
  out.addedAt = typeof input.addedAt === 'string' ? input.addedAt : new Date().toISOString()
  out.updatedAt = typeof input.updatedAt === 'string' ? input.updatedAt : new Date().toISOString()
  return out
}

/**
 * 信任标记：❓未证实（status=draft）/ ⏰待重验（staleAfter 早于今天）/ ✓已验证（有 verifiedAt）。
 * 返回空串表示无标记，注入内容与旧版逐字一致。
 */
export function trustMark(entry, today = localDateOf()) {
  const marks = []
  if (entry?.status === 'draft') marks.push('❓未证实')
  if (typeof entry?.staleAfter === 'string' && DATE_ONLY.test(entry.staleAfter) && entry.staleAfter < today) marks.push('⏰待重验')
  if (typeof entry?.verifiedAt === 'string' && entry.verifiedAt !== '') marks.push('✓已验证')
  return marks.length > 0 ? marks.join(' ') + ' ' : ''
}

// v3.9：text 不是字符串时（手改 memory.json 写坏、或外部直接调 renderMemory）不能整块崩。
const textOf = (entry) => (typeof entry?.text === 'string' ? entry.text : String(entry?.text ?? ''))
const lineFull = (entry) => `- ${trustMark(entry)}${entry.pinned ? '📌 ' : ''}${textOf(entry)}`

const entryDate = (entry) => {
  const raw = typeof entry.updatedAt === 'string' && entry.updatedAt !== '' ? entry.updatedAt : entry.addedAt
  const stamp = typeof raw === 'string' ? raw.slice(0, 10) : ''
  return /^\d{4}-\d{2}-\d{2}$/.test(stamp) ? stamp : ''
}

const entryTag = (entry) => (Array.isArray(entry.tags) && entry.tags.length > 0 ? entry.tags[0] : entry.tag ?? '')

const lineRelevant = (entry) => {
  const tag = entryTag(entry) ? ` [${entryTag(entry)}]` : ''
  const date = entryDate(entry)
  return `- (${entry.id})${trustMark(entry)}${tag}${date ? ` ${date}` : ''} ${textOf(entry)}`
}

const lineIndexCompact = (entry) => {
  const scope = typeof entry.scope === 'string' && entry.scope !== '' ? entry.scope : (Array.isArray(entry.tags) ? entry.tags[0] : entry.tag) ?? ''
  // v2.7：只留 <scope> 标签等于没注入——模型看不出这条讲什么，也就不会去搜。压到 14 字主题仍可辨识。
  const flat = String(entry.text ?? '').replace(/\s+/g, ' ').trim()
  const peek = flat.length > COMPACT_PEEK_CHARS ? `${flat.slice(0, COMPACT_PEEK_CHARS)}…` : flat
  return `- (${entry.id})${trustMark(entry)}${scope ? ` <${scope}>` : ''} ${peek}`
}

const lineIndex = (entry) => {
  const flat = textOf(entry).replace(/\s+/g, ' ').trim()
  const summary = flat.length > INDEX_SUMMARY_CHARS ? `${flat.slice(0, INDEX_SUMMARY_CHARS)}…` : flat
  const tag = entryTag(entry) ? ` [${entryTag(entry)}]` : ''
  const date = entryDate(entry)
  return `- (${entry.id})${trustMark(entry)}${tag}${date ? ` ${date}` : ''} ${summary}`
}

/**
 * 渲染成注入系统提示的块；空记忆返回空串（等于不注入）。
 *
 * 不传 options（或 maxInjectChars 非正数）时是**全量渲染**，保持 v1.0 的行为；
 * 传了 maxInjectChars 就按优先级分层：pinned 优先，其余从新到旧，装不下的降级为索引行。
 */
export function renderMemory(allEntries, options) {
  if (!Array.isArray(allEntries) || allEntries.length === 0) return ''
  // v3.0：工作区条件——workspaces 不匹配当前 cwd 的条目整条不注入（预算不浪费在别处才用得上的规则上）。
  const cwd = typeof options?.cwd === 'string' ? options.cwd : ''
  // 已失效（被 superseded）或标记 deprecated 的条目只留档，不进提示。
  const entries = allEntries.filter(
    (entry) =>
      (typeof entry?.supersededBy !== 'string' || entry.supersededBy === '') &&
      entry?.status !== 'deprecated' &&
      // v3.23：inject:false 的条目只参与 memory_search，不占每轮注入预算。
      // 依据 Anthropic 官方 context engineering：前置只留硬规则，事实/历史类走 just-in-time 检索。
      entry?.inject !== false &&
      // v4.0：invalidAt 已到的条目只留档，不进提示（与 memory_search 的口径一致）。
      !isInvalidEntry(entry) &&
      applicableAt(entry, cwd),
  )

  const maxInjectChars =
    Number.isInteger(options?.maxInjectChars) && options.maxInjectChars > 0 ? options.maxInjectChars : 0

  if (!maxInjectChars) {
    const stats = options?.stats
    if (stats !== undefined && stats !== null && typeof stats === 'object') stats.full = entries.map((entry) => entry.id)
    const lines = entries.map(lineFull)
    const legend = entries.some((entry) => trustMark(entry) !== '') ? [TRUST_LEGEND] : []
    return ['<memory>', MEMORY_HEADER, ...legend, ...lines, '</memory>'].join('\n')
  }

  // 预算里先扣掉包装和头部；有信任标记时再把 legend 那一行也扣掉（否则会轻微超预算）
  const hasMarks = entries.some((entry) => trustMark(entry) !== '')
  let used = '<memory>'.length + MEMORY_HEADER.length + '</memory>'.length + 3 + (hasMarks ? TRUST_LEGEND.length + 1 : 0)
  const full = []
  const indexed = []
  const dropped = []
  // v3.6 有效性硬门控：staleAfter 已过的条目降级为「只进索引、不给全文」。
  // 依据 2026-10 的 Obsolete-Facts 论文：过时证据进了上下文反而拉低准确率（45%→32%）。
  const todayStr = localDateOf()
  const isExpired = (entry) =>
    typeof entry?.staleAfter === 'string' && DATE_ONLY.test(entry.staleAfter) && entry.staleAfter < todayStr

  // 第一优先级：pinned 全文（硬规则永远在场；真装不下也要进诊断行，不静默消失）
  for (const entry of entries.filter((item) => item.pinned)) {
    const cost = lineFull(entry).length + 1
    if (used + cost > maxInjectChars) {
      dropped.push(entry)
      continue
    }
    full.push(entry)
    used += cost
  }

  // 第二优先级：本轮相关（有 query 时）。相关条目给**全文**——多花 3 倍字符，但省掉一次工具调用，
  // 正好覆盖「相关却没进索引」的那批（v1.1 实测有 10 条完全不可见）。
  const relevant = []
  // v3.8 诊断：把本轮的覆盖率塞进 stats，出问题时一眼能看出是「没匹配上」还是「匹配上但没过门」。
  let relevanceSeen = 0
  const queryText = typeof options?.query === 'string' ? options.query.trim() : ''
  const currentScope = typeof options?.scope === 'string' ? options.scope : ''
  if (queryText !== '') {
    const scored = scoreEntries(entries.filter((item) => !item.pinned), queryText)
      .map((item) => ({
        entry: item.entry,
        raw: currentScope !== '' && item.entry.scope === currentScope ? item.score * SCOPE_BOOST : item.score,
      }))
      .filter((item) => item.raw > 0.0001)
      .sort((a, b) => b.raw - a.raw)
    const floor = Number.isFinite(options?.relevanceFloor) ? options.relevanceFloor : RELEVANCE_FLOOR
    const topRaw = scored.length > 0 ? scored[0].raw : 0
    // 覆盖率门：弱匹配宁可一条都不给全文（治负例误注入）。语料无关，阈值不随库大小漂。
    // ⚠ 分子分母都不用带 alias 加权 / 同义扩展的分数：
    //   否则「帮我写个 Python 快排」这类无关问题会被同义词抬过门槛 —— 2026-10-29 实测负例误注入 0%→75%。
    // v3.8：改数「内容单元」（relevanceCoverage），治片段三重计数与虚词算分 ——
    //   旧算法下一个「推荐」就能把一个无关问题送过 0.15（实测 0.169），见 relevanceCoverage 的注释。
    const coverageReport = relevanceCoverage(entries.filter((item) => !item.pinned), queryText)
    const { coverage } = coverageReport
    relevanceSeen = coverage
    // v3.11：两个信号一致时放宽到 0.07，但要求**至少命中 2 个内容单元**。
    // 实测（72 正例 / 35 负例）：单信号 0.16 过 56/72；放宽到 0.07 只加「双信号一致」能到 64/72 但会放过
    // 「电脑为什么会蓝屏」这类单字假命中；再加「命中≥2 单元」正好 60/72 且负例 0 —— 拿 4 个真命中、不进口子。
    const coverageTopId = coverageReport.topId
    const agreeWithRanking = coverageTopId !== null && scored.length > 0 && scored[0].entry.id === coverageTopId
    const rankTopId = scored.length > 0 ? scored[0].entry.id : null
    const rankDocMatched = rankTopId !== null ? coverageReport.docMatched?.get(rankTopId) : null
    const rankEvidence = {
      units: rankDocMatched ? rankDocMatched.units.length : 0,
      matchedDf: rankDocMatched ? rankDocMatched.matchedDf : [],
      coverage: rankTopId !== null ? coverageReport.byId?.get(rankTopId) ?? 0 : 0,
    }
    const gate = gateDecision({
      coverage,
      matchedUnits: coverageReport.matchedUnits,
      matchedDf: coverageReport.matchedDf,
      unitCount: coverageReport.unitCount,
      agreeWithRanking,
      rankEvidence,
      floor,
    })
    // v3.10：scored 为空（query 里没有任何能进 tokenize 的词）时不能往下走，
    // 否则 ranked[0].composite 直接抛错 —— 宁可这一轮不给全文。
    if (gate.pass && scored.length > 0) {
      const now = Date.now()
      const ranked = scored
        .map((item) => ({
          entry: item.entry,
          // 三因子合成（GA 思路）：相关性归一 + importance + recency；相关性仍是主导项。
          composite:
            item.raw / topRaw +
            COMPOSITE_IMPORTANCE_WEIGHT * (effectiveImportance(item.entry, now) / 10) +
            COMPOSITE_RECENCY_WEIGHT * recencyOf(item.entry, now),
        }))
        .sort((a, b) => b.composite - a.composite)
      const topComposite = ranked[0].composite
      const cap = Math.min(Math.floor(maxInjectChars * RELEVANT_SHARE), maxInjectChars - used)
      let spent = 0
      // v3.13：覆盖率 top 不再需要单独占位，也**不再用 break 跳过**后面的人 ——
      // v3.11 的注释写着「覆盖率最高的那条天然有资格拿全文」，但旧实现靠循环里的 break 豁免：
      // 只要排在它前面有 byId>0、复合分又够低的条目，就提前 break 掉，覆盖率 top 反而进不来
      // （实测长句「这个评测套件发到 GitHub 上了吗」：covTop=m78 0.65，相关层却只有 m71）。
      // 改成 continue 后，覆盖率 top 一定能走到，而且不会挤占正常排序所占的位置（试过「先占位」，短问法/换皮各掉 5 条）。
      for (const item of ranked) {
        if (relevant.length >= MAX_RELEVANT) break
        if (isExpired(item.entry)) continue
        // v3.9（A2）：门槛由「top 条目」判，但相关层是按 scoreEntries 排序选的，两者不同源 ——
        // 实测 query「python快排」过门 0.39，注入的却是跟 query 零内容单元重合的条目（只靠单字「快」）。
        // 这里要求被注入的条目自身至少有一个内容单元命中。
        if (!((coverageReport.byId?.get(item.entry.id) ?? 0) > 0)) continue
        // v3.11：复合分差太多的不再补（避免第二条把第一条挤成噪音）。
        // v3.13：覆盖率 top 例外 —— 它是「这两条真的相关」的最强证据，不因复合分低被跳过；
        // 但仍受 MAX_RELEVANT 与预算约束。
        const isCoverageTop = item.entry.id === coverageTopId
        if (!isCoverageTop && relevant.length > 0 && item.composite * RELEVANT_COMPOSITE_MARGIN < topComposite) continue
        const cost = lineRelevant(item.entry).length + 1
        if (spent + cost > cap) break
        relevant.push(item.entry)
        spent += cost
        used += cost
      }
    }
  }
  const inRelevant = new Set(relevant.map((entry) => entry.id))

  // 第三优先级：其余出「一行索引」。本域（或 global）给完整摘要，跨域只留 id + 域标签
  // （Cursor 四态里 globs 的降级版本：跨域事实「知道存在、要看再搜」，别把别域细节当本域规则）。
  const rest = entries.filter((item) => !item.pinned && !inRelevant.has(item.id))
  const isCrossScope = (entry) =>
    currentScope !== '' &&
    typeof entry.scope === 'string' &&
    entry.scope !== '' &&
    entry.scope !== currentScope &&
    entry.scope !== 'global'
  const compact = []
  // v3.6：索引层不再「新→旧」，改按 importance（含遗忘曲线衰减）+ recency 排序。
  // 理由：预算装不下所有条目时，先被挤出去的应该是「旧且不重要」的，而不是「旧的」。
  const nowForRank = Date.now()
  const indexRank = (entry) =>
    0.6 * (effectiveImportance(entry, nowForRank) / 10) + 0.4 * recencyOf(entry, nowForRank)
  const orderIndex = new Map(rest.map((entry, position) => [entry.id, position]))
  const ordered = [...rest].sort((a, b) => {
    const diff = indexRank(b) - indexRank(a)
    if (Math.abs(diff) > 0.05) return diff
    // 同档时按写入顺序倒排（数组越靠后越新）——没有时间戳的老条目也有确定顺序。
    return (orderIndex.get(b.id) ?? 0) - (orderIndex.get(a.id) ?? 0)
  })
  for (const entry of ordered) {
    if (isCrossScope(entry)) continue
    const cost = lineIndex(entry).length + 1
    if (used + cost > maxInjectChars) {
      dropped.push(entry)
      continue
    }
    indexed.push(entry)
    used += cost
  }
  for (const entry of ordered) {
    if (!isCrossScope(entry)) continue
    const cost = lineIndexCompact(entry).length + 1
    if (used + cost > maxInjectChars) {
      dropped.push(entry)
      continue
    }
    compact.push(entry)
    used += cost
  }

  // 诊断：被挤出预算的条目必须留痕（列出 id，不列正文），否则又是「悄悄丢」。
  const MAX_DIAGNOSTIC_IDS = 24
  // v3.9：诊断行长度随「被挤出条目数」增长，原来完全不参与预算裁剪 —— 预算 200 时实测块长 472（超 272）。
  // 现在 id 列表可缩（24 → 12 → 6 → 3 → 0），0 表示只报条数。
  const buildBlock = (diagLimit = MAX_DIAGNOSTIC_IDS) => {
    const ids = dropped.slice(0, Math.max(0, diagLimit)).map((entry) => entry.id)
    let groupText = ''
    if (diagLimit > 0 && dropped.length > ids.length) {
      const groups = new Map()
      for (const entry of dropped) {
        const key = entry.scope ?? (Array.isArray(entry.tags) && entry.tags[0]) ?? entry.tag ?? 'other'
        groups.set(key, (groups.get(key) ?? 0) + 1)
      }
      const summary = [...groups.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => `${key} ${count}`).join(' / ')
      groupText = ` …（按 scope：${summary}）`
    }
    const diagnostic =
      dropped.length > 0
        ? diagLimit > 0
          ? `⚠ 另有 ${dropped.length} 条未注入：${ids.join(' ')}${groupText}（用 memory_search 按 id 或关键词取全文）`
          : `⚠ 另有 ${dropped.length} 条未注入（用 memory_search 按 id 或关键词取全文）`
        : ''
    const footer = `（全文 ${full.length}${relevant.length > 0 ? ` · 相关 ${relevant.length}` : ''} · 索引 ${indexed.length}${compact.length > 0 ? ` · 跨域 ${compact.length}` : ''}${dropped.length > 0 ? ` · 未注入 ${dropped.length}` : ''}；跨域或更早的记忆用 memory_search 按 id / 关键词取）`
    const block = [
      '<memory>',
      MEMORY_HEADER,
      ...(hasMarks ? [TRUST_LEGEND] : []),
      ...full.map(lineFull),
      ...relevant.map(lineRelevant),
      ...indexed.map(lineIndex),
      ...compact.map(lineIndexCompact),
      ...(diagnostic ? [diagnostic] : []),
      footer,
      '</memory>',
    ].join('\n')
    return { block, footer }
  }

  // v3.6 预算自洽：头部只做了**预留**，页脚与诊断行是**动态**的，之前没算进 used ——
  // 实测 1631 字符 / 预算 1500，「略超」其实一直超 131。做法：先按优先级分配，
  // 再拿真实长度回削最低优先级（跨域 → 索引尾部），削到装得下为止。
  let diagLimit = MAX_DIAGNOSTIC_IDS
  let built = buildBlock(diagLimit)
  for (let guard = 0; guard < entries.length + 40 && built.block.length > maxInjectChars; guard += 1) {
    const sink = compact.length > 0 ? compact : indexed
    if (sink.length > 0) {
      dropped.push(sink.pop())
      built = buildBlock(diagLimit)
      continue
    }
    // 索引/跨域削空后，再缩诊断行；全削干还超（头部 + pinned + 页脚），只能认了。
    if (diagLimit > 0) {
      diagLimit = diagLimit > 12 ? 12 : diagLimit > 6 ? 6 : diagLimit > 3 ? 3 : 0
      built = buildBlock(diagLimit)
      continue
    }
    // v3.13：相关层（全文）以前不参与回削 —— RELEVANT_SHARE 提到 0.4 后，600 字符的小预算会超 5 字符
    // （不变量实测 budget=600 / q=技能是怎么生成的）。相关层是仅次于 pinned 的高价值内容，
    // 但预算红线优先：削掉最后一条相关，让它落回索引行。
    if (relevant.length > 0) {
      const droppedEntry = relevant.pop()
      if (!indexed.includes(droppedEntry)) indexed.push(droppedEntry)
      built = buildBlock(diagLimit)
      continue
    }
    break
  }

  const statsOut = options?.stats
  if (statsOut !== undefined && statsOut !== null && typeof statsOut === 'object') {
    statsOut.full = full.map((entry) => entry.id)
    statsOut.relevant = relevant.map((entry) => entry.id)
    statsOut.indexed = indexed.map((entry) => entry.id)
    statsOut.relevanceCoverage = Number(relevanceSeen.toFixed(4))
    statsOut.compact = compact.map((entry) => entry.id)
    statsOut.dropped = dropped.map((entry) => entry.id)
    // v3.24：注入收益度量（学 Google ADK 的 _prompt_chars_saved）——
    // 光报「注入了多少」不够，还要能答「降级成索引行替我们省了多少」。
    const sizeOf = (list, render) => list.reduce((n, entry) => n + render(entry).length + 1, 0)
    statsOut.fullChars = sizeOf(full, lineFull)
    statsOut.indexedChars = sizeOf(indexed, lineIndex)
    statsOut.droppedFullChars = sizeOf(dropped, lineFull)
  }

  return built.block
}

/* ───────────────────────── v3.12 中文分词 ─────────────────────────
 *
 * v3.11 及之前中文按 **bigram** 切（本地部署 → 本地/地部/部署），跨词边界会拼出假词：
 * 「基**本地**址」里的「本地」被当成命中，把不相关记忆顶过门槛（A6，实测覆盖率 0.2375 > 0.16）。
 * v3.12 换成**词**：词典正向最大匹配优先，词典外的片段退回 bigram 兜底。
 *   - 词典在 zh-words.txt（跟插件一起版本化，一行一词，只收真词）；
 *   - 排序层（tokenize）与门槛层（contentUnitsOf）**共用同一个切分函数** ——
 *     v3.10 之前两者口径不同源，出现过「门槛过、排序层没候选」的错位；
 *   - 3 字词额外保留**词典内的**子词（验证门 → 验证门 + 验证），只问半截时不至于漏召回；
 *     子词也必须在词典里才算，避免「证门」这种拼接产物混进单元表。
 * 刻意**不用** Intl.Segmenter：ICU 78 把「文档/插件/重启/覆盖率/台账/卸载」都拆成单字
 * （实测见 README v3.12），跨环境还会随 ICU 版本变，测试不可复现。
 */
const ZH_WORD_MAX = 3
const ZH_WORDS = (() => {
  const set = new Set()
  try {
    const text = readFileSync(new URL('./zh-words.txt', import.meta.url), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const word = line.trim()
      if (word === '' || word.startsWith('#')) continue
      if (word.length < 2 || word.length > ZH_WORD_MAX) continue
      if (!/^[\u4e00-\u9fff]+$/.test(word)) continue
      set.add(word)
    }
  } catch {
    // 词典读不到就退化成整段 bigram（v3.11 行为），不抛错、不影响记忆读写。
  }
  return set
})()

/** 返回 run[i] 处最长词典词的长度（没有则 0）。 */
function zhWordLengthAt(run, start) {
  const longest = Math.min(ZH_WORD_MAX, run.length - start)
  for (let length = longest; length >= 2; length -= 1) {
    if (ZH_WORDS.has(run.slice(start, start + length))) return length
  }
  return 0
}

/**
 * 切一个中文 run。返回的单元是「词」（词典内的多字词 + 词典内子词）或「bigram 兜底」。
 * 跨词边界的 bigram **不会**产生 —— 这正是 A6 的解法。
 */
function segmentZhRun(run) {
  const units = []
  let index = 0
  while (index < run.length) {
    const length = zhWordLengthAt(run, index)
    if (length > 0) {
      const word = run.slice(index, index + length)
      units.push(word)
      // 3 字词额外保留**词内** bigram（验证门 → 验证/证门）：问「验证」半截时还能命中。
      // 词内 bigram 不跨词边界，所以不会把「基本地址」拼成「本地」—— A6 仍然治住。
      if (length === 3) {
        units.push(word.slice(0, 2))
        units.push(word.slice(1))
      }
      index += length
      continue
    }
    // 未登录片段：一直吃到下一个词典词的开头，片段内按 bigram 切（保证未登录词还能字面命中）。
    let end = index + 1
    while (end < run.length && zhWordLengthAt(run, end) === 0) end += 1
    const gap = run.slice(index, end)
    if (gap.length === 1) units.push(gap)
    else for (let offset = 0; offset + 2 <= gap.length; offset += 1) units.push(gap.slice(offset, offset + 2))
    index = end
  }
  return units
}

// 分词结果按输入字符串缓存：同一批记忆条目每轮会被重复切很多次（渲染 + 排序 + 门槛各一遍）。
// 缓存上限到了就整体清空 —— 宁可偶尔重算，也不让长会话把内存吃满。
const SEGMENT_CACHE_LIMIT = 4000
const TOKEN_CACHE = new Map()
const UNIT_CACHE = new Map()
function cacheGet(cache, key, compute) {
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  if (cache.size >= SEGMENT_CACHE_LIMIT) cache.clear()
  const value = compute()
  cache.set(key, value)
  return value
}

/**
 * 拉丁词拆子词（v3.13）：URL / 文件路径 / 连字符标识符里的分隔段也算词。
 * 起因：记忆里写「https://github.com/...」，用户问「发到 GitHub 上了吗」—— 整词是 github.com、
 * 查询是 github，词面永远对不上（实测这条长句因此排错）。拆开后 github / dsh / eval 都能命中。
 * 只拆 ≥2 字符的段，避免 a / v1 这种碎片把分母灌满。
 */
function latinSubUnits(word) {
  if (!/[._\-]/.test(word)) return [word]
  const parts = word.split(/[._\-]+/).filter((part) => part.length >= 2)
  return parts.length > 0 ? [word, ...parts] : [word]
}

/**
 * 分词（排序层用）：英文/数字按整词（含路径/URL 子词），中文按词。
 * 注意：返回的 Map 由缓存共享，**调用方不得修改**。
 */
/**
 * 英文停用词（v3.15）。来自 LoCoMo 对照实验：朴素 BM25 + 停用词过滤 recall@1 33.1%，
 * 我们 28.3% —— 差距全在 a/is/the/of 这类词上（中文侧早就有虚词规则，英文侧一直漏）。
 * 只过滤长 ≥1 的整词；latinSubUnits 拆出的 URL/路径子词不受影响。
 */
const EN_STOP = new Set('a an the and or but if then than that this these those i you he she it we they me him her us them my your his its our their am is are was were be been being do does did have has had will would can could should may might must not no yes of in on at to for with from by as so such what when where who which how why there here up down out over again very just also too only own same some any all both each few more most other'.split(' '))

export function tokenize(input) {
  const key = String(input ?? '').toLowerCase()
  return cacheGet(TOKEN_CACHE, key, () => {
    const terms = new Map()
    const bump = (term) => terms.set(term, (terms.get(term) ?? 0) + 1)
    for (const word of key.match(/[a-z0-9][a-z0-9_\-.]{1,}/g) ?? []) {
      if (EN_STOP.has(word)) continue
      for (const unit of latinSubUnits(word)) bump(unit)
    }
    for (const run of key.match(/[\u4e00-\u9fff]+/g) ?? []) {
      for (const unit of segmentZhRun(run)) bump(unit)
    }
    // 全是停用词的查询（"how are you"）不能变成空集，否则什么都检索不到 —— 退化为不过滤。
    if (terms.size === 0) {
      for (const word of key.match(/[a-z0-9][a-z0-9_\-.]{1,}/g) ?? []) for (const unit of latinSubUnits(word)) bump(unit)
    }
    return terms
  })
}

/**
 * 别名候选：从文本里挑 2–4 个「内容词」当**提示**，让人/agent 围绕它们补同义、缩写、中英对照。
 * 注意：它只给候选，不自动写别名 —— 自动写的同义词会污染相关性门槛（v3.5 的教训）。
 */
const ALIAS_STOP = new Set([
  '今天', '现在', '这个', '那个', '我们', '你们', '他们', '可以', '需要', '一个', '什么', '怎么',
  '如果', '因为', '所以', '但是', '而且', '还是', '就是', '不是', '没有', '已经', '一直', '这些',
  '那些', '时候', '地方', '问题', '东西', '事情', '使用', '进行', '通过', '以及', '等等', '一下',
  '一点', '比较', '非常', '真的', '其实', '然后', '之后', '之前', '起来', '出来', '过来', '同时',
])

export function suggestAliases(text, limit = 4) {
  const counts = tokenize(text)
  const scored = []
  for (const [term, count] of counts) {
    if (term.length < 2) continue
    if (ALIAS_STOP.has(term)) continue
    const isLatin = /^[a-z0-9]/.test(term)
    // v3.12：中文单元已经是「词」（2–3 字，词典内），不再是跨词拼接的 bigram，所以 2 字与 3 字都收；
    // 英文/代码词整词保留。
    if (!isLatin && (term.length < 2 || term.length > ZH_WORD_MAX)) continue
    scored.push({ term, score: (isLatin ? 2 : 1) + count })
  }
  scored.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term))
  const seen = new Set()
  const out = []
  for (const item of scored) {
    if (seen.has(item.term)) continue
    seen.add(item.term)
    out.push(item.term)
    if (out.length >= limit) break
  }
  return out
}

const BM25_K1 = 1.2
const BM25_B = 0.75
const BM25_TAG_WEIGHT = 2
/** aliases 是人工写的「跨词面桥」，命中权重应高于 tag（tag 是分类，alias 是等同词）。 */
const BM25_ALIAS_WEIGHT = 2.5
/** 同义词扩展的权重：低于原词，避免扩展词把噪声顶上来。 */
const EXPANSION_WEIGHT = 0.2

/* v4.1（P2.2 前置）：bm25Doc 结果按条目对象缓存。
 * 为什么：benchmark 实测 10000 条时「完整搜索」319ms，其中约 90% 是每轮重新 tokenize + 重建词表 Map；
 * df/idf/长度归一这些**公式**一行不动，只是把这部分重复劳动缓存起来。
 * 失效口径：用 text/tag/tags/aliases/entities 拼出签名，签名变了就重算（WeakMap 跟随条目对象生命周期）。
 * 注意：返回的 terms Map 由缓存共享，调用方（scoreEntries / 排序 / 注入渲染）都只读。 */
const BM25_DOC_CACHE = new WeakMap()
function bm25DocSignature(entry) {
  const tagText = Array.isArray(entry.tags) && entry.tags.length > 0 ? entry.tags.join(' ') : entry.tag ?? ''
  const aliasText = Array.isArray(entry.aliases) ? entry.aliases.join(' ') : ''
  const entityText = Array.isArray(entry.entities) ? entry.entities.join(' ') : ''
  return String(entry.text ?? '') + '\u0000' + tagText + '\u0000' + aliasText + '\u0000' + entityText
}
function buildBm25Doc(entry, signature) {
  const parts = signature.split('\u0000')
  const text = parts[0] ?? ''
  const tagText = parts[1] ?? ''
  const aliasText = parts[2] ?? ''
  const entityText = parts[3] ?? ''
  const terms = tokenize(`${text} ${tagText} ${aliasText} ${entityText}`)
  let length = 0
  for (const count of terms.values()) length += count
  return { entry, terms, length, tagText: tagText.toLowerCase(), aliasTerms: new Set(tokenize(aliasText).keys()) }
}
function bm25Doc(entry) {
  if (entry === null || typeof entry !== 'object') return buildBm25Doc(entry, '')
  const signature = bm25DocSignature(entry)
  const cached = BM25_DOC_CACHE.get(entry)
  if (cached !== undefined && cached.signature === signature) return cached.doc
  const doc = buildBm25Doc(entry, signature)
  BM25_DOC_CACHE.set(entry, { signature, doc })
  return doc
}

/**
 * 领域同义组：用户提问用一种说法，记忆里存的是另一种说法。
 * 命中任意成员 → 同组其余成员的低权重词加入查询（EXPANSION_WEIGHT）。
 * 只收「高精度」同义，宁可少收，别把噪声词灌进来。
 */
const SYNONYM_GROUPS = [
  ['生效', '重载', 'reload', '跑起来', '应用改动', '装完'],
  ['验证门', '门禁', 'dsh-proof', '收工前', '拦'],
  ['记忆', 'memory', '记忆库'],
  ['坏了', '故障', '崩了', '救', '修复'],
  ['归档', 'archive', '冷存', '备份区'],
  ['评测', 'bench', '跑分', '基准'],
  ['工作区', 'workspace', '项目目录'],
  ['虚拟机', 'virtualbox', 'vbox', 'vm'],
  ['抖音', 'douyin', '短视频'],
  ['桌面图标', 'dock', '图标被接管'],
  ['管理员权限', '提权', 'elevate', 'uac'],
  ['注册表', 'registry', 'hklm', 'hkcu'],
  ['快捷方式', 'lnk', 'shortcut', '快捷图标'],
  ['礼仪', '君臣', '称呼', '自称'],
]

/**
 * 查询扩展：返回「扩展词 → 权重」。单字不扩展（太泛，会灌噪声）。
 * 只做词面层面的桥接，不调模型。
 */
export function expandQuery(query) {
  const text = String(query ?? '').toLowerCase()
  const extra = new Map()
  for (const group of SYNONYM_GROUPS) {
    if (!group.some((word) => text.includes(word.toLowerCase()))) continue
    for (const word of group) {
      for (const term of tokenize(word).keys()) {
        if (term.length < 2) continue
        if ((extra.get(term) ?? 0) < EXPANSION_WEIGHT) extra.set(term, EXPANSION_WEIGHT)
      }
    }
  }
  return extra
}

/**
 * BM25 检索：IDF 压常见词、长度归一压长条目，中文用 unigram+bigram。
 * 加权：aliases 命中 ×2.5（人工写的跨词面桥）> tag 命中 ×2 > 原词 ×1 > 同义扩展词 ×0.5。
 */
export function scoreEntries(entries, query) {
  const docs = (Array.isArray(entries) ? entries : []).map(bm25Doc)
  if (docs.length === 0) return []
  const queryTerms = tokenize(query)
  const expansion = expandQuery(query)
  if (queryTerms.size === 0 && expansion.size === 0) return docs.map((doc) => ({ entry: doc.entry, score: 0 }))
  const weights = new Map()
  for (const term of queryTerms.keys()) weights.set(term, 1)
  for (const [term, weight] of expansion) if (!weights.has(term)) weights.set(term, weight)
  let totalLength = 0
  for (const doc of docs) totalLength += doc.length
  const avgLength = totalLength / docs.length || 1
  const df = new Map()
  for (const term of weights.keys()) df.set(term, docs.filter((doc) => doc.terms.has(term)).length)
  const today = localDateOf()
  return docs.map((doc) => {
    let score = 0
    for (const [term, weight] of weights) {
      const frequency = doc.terms.get(term) ?? 0
      if (frequency === 0) continue
      const hit = df.get(term) ?? 0
      const idf = Math.log(1 + (docs.length - hit + 0.5) / (hit + 0.5))
      const tagBoost = doc.tagText.includes(term) ? BM25_TAG_WEIGHT : 1
      const aliasBoost = doc.aliasTerms.has(term) ? BM25_ALIAS_WEIGHT : 1
      score += weight * tagBoost * aliasBoost * idf * ((frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / avgLength)))
    }
    // v3.19 时效降权：过了 staleAfter 的条目仍然可检索（不丢信息），但排序压到后面。
    // 依据 arXiv 2610.36308 —— 过时版本干扰是记忆检索的主要错误源（证据预算越大反而越差）。
    if (isStaleEntry(doc.entry, today)) score *= STALE_PENALTY
    return { entry: doc.entry, score }
  })
}

/**
 * 严格打分：只用原查询词，**不加** alias 权重、**不做**同义扩展。
 * v3.8 起**相关性门槛不再用它**（改用 relevanceCoverage 的内容单元口径）；保留给排序对照与单测。
 * 用途：判「这句话跟这条记忆到底相不相关」——扩展词可以帮排序，但绝不能帮它越过相关性门槛，
 * 否则负例（无关问题）会因为同义词被误判相关并注入全文。
 */
export function scoreEntriesStrict(entries, query) {
  // 文档侧只取 text + tag，**不取 aliases**：aliases 是查询桥，不是原文内容。
  // 早期版本把它们算进文档，导致「怎么生成」这种别名里的「怎么」把「MySQL 索引优化怎么做」判成相关。
  const docs = (Array.isArray(entries) ? entries : []).map((entry) => {
    const tagText = Array.isArray(entry.tags) && entry.tags.length > 0 ? entry.tags.join(' ') : entry.tag ?? ''
    const terms = tokenize(`${entry.text} ${tagText}`)
    let length = 0
    for (const count of terms.values()) length += count
    return { entry, terms, length }
  })
  if (docs.length === 0) return []
  const terms = tokenize(query)
  if (terms.size === 0) return docs.map((doc) => ({ entry: doc.entry, score: 0 }))
  let totalLength = 0
  for (const doc of docs) totalLength += doc.length
  const avgLength = totalLength / docs.length || 1
  const df = new Map()
  for (const term of terms.keys()) df.set(term, docs.filter((doc) => doc.terms.has(term)).length)
  return docs.map((doc) => {
    let score = 0
    for (const term of terms.keys()) {
      const frequency = doc.terms.get(term) ?? 0
      if (frequency === 0) continue
      const hit = df.get(term) ?? 0
      const idf = Math.log(1 + (docs.length - hit + 0.5) / (hit + 0.5))
      score += idf * ((frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / avgLength)))
    }
    return { entry: doc.entry, score }
  })
}

/**
 * v3.8 内容单元：判断「这句话跟这条记忆有没有共同主题」时，只数真正的信息词。
 *
 * 两条修正，都是 2026-10-29 实测踩出来的：
 *
 * 1) **片段不再三重计数**。以前 tokenize 会给中文同时出 unigram 和 bigram，命中「推荐」这一处，
 *    分子里算 推 + 荐 + 推荐 三次。一条含「已推荐未批准」的交接记忆，让「推荐一部好看的电影」
 *    的覆盖率从 0.036 直接抬到 0.169，越过 0.15 门槛、注入 1475 字符。
 *
 * 2) **虚词不算分**。的/一/是/我 这类字跟主题无关，两个虚词拼成的 bigram（「的是」「一个」）也无关；
 *    实测在同一个负例里，虚词贡献了分子 27% 的分数（一 1.52 + 的 1.15 / 合计 9.83）。
 *
 * 拉丁词/数字仍是整词（长度 ≥2），中文单字 run 只有在它不是虚词时才保留。
 *
 * v3.12：中文单元从 bigram 换成**词**（segmentZhRun）。虚词规则不变，只是判断单位变成词：
 * 一个字都是虚词的单字丢、每个字都是虚词的词丢。A6（「基本地址」跨边界拼出「本地」）随之消失。
 */
const CJK_STOP_CHARS = new Set(
  [...'的了是在不有和就都也我你他她它这那什么怎么吗呢吧啊哦个上下中之与及或等很更最太再还被把给让从到对为以所而且但如因为所以一二三四五六七八九十每各某多没要会可才又已经并'],
)

export function contentUnitsOf(input) {
  const key = String(input ?? '').toLowerCase()
  // 返回的数组由缓存共享，调用方不得修改。
  return cacheGet(UNIT_CACHE, key, () => {
    const units = []
    // v3.10（A5）：去掉拉丁词尾的 . _ -（原来 `chrome.` 和 `chrome` 是两个不同的词，实测导致漏召回）。
    // 注意仍是 {1,}：单字符拉丁（C 盘 / D 盘里的 c、d）刻意不算内容单元 —— 它们跟排序层 tokenize 的口径不一致，
    // 硬塞进来会出现「门槛过、排序层没候选」的错位（A9 试过，会直接抛错，已回退）。
    for (const word of key.match(/[a-z0-9][a-z0-9_\-.]{1,}/g) ?? []) {
      const trimmed = word.replace(/[._-]+$/, '')
      if (trimmed !== '') for (const unit of latinSubUnits(trimmed)) units.push(unit)
    }
    // v3.12：中文按**词**（与排序层 tokenize 同一个 segmentZhRun），不再是 bigram。
    for (const run of key.match(/[\u4e00-\u9fff]+/g) ?? []) {
      for (const unit of segmentZhRun(run)) {
        // 虚词不算分：单字虚词丢；多字单元要**每个字**都是虚词才丢 ——
        // 保住「会议」这类只含一个虚词字的真词，丢掉「什么」「不要」这类纯虚词词。
        // 注意「不是」两个字都是虚词 → 会被丢，这是有意的（它不承载主题信息）。
        if ([...unit].every((char) => CJK_STOP_CHARS.has(char))) continue
        units.push(unit)
      }
    }
    return units
  })
}

/**
 * 相关性覆盖率 = 最相关那条记忆覆盖了多少查询的「信息量」。
 *
 * 分母：查询全部内容单元的 idf 之和（含语料里没出现的词，按最大 idf 计）—— 一句话里
 *   只有一小部分词能对上时，覆盖率自然低，跟语料规模无关。
 * 分子：单条记忆命中的那些内容单元的 idf 之和，带 BM25 的 tf 饱和与长度归一
 *   （否则短条目靠长度优势虚高：一句话的记忆只要含一个稀罕词就能独占鳌头）。
 *
 * 判据是 v2.3 的 RELEVANCE_FLOOR；v3.8 换的是算法，不是阈值。
 */
const CLAUSE_SPLIT = /[，。！？；、,.!?;\n\r]+/

/**
 * v3.10（A3）：真实用户消息是长句，整句算覆盖率会被大量铺垫词稀释 ——
 * 实测 15 条长自然句只有 5 条（33.3%）进得了相关层，而短问法基准是 73.9–100%。
 * 做法：按标点切成分句，取「最相关那一句」的覆盖率（多句各自算，取最大）。
 * 短问法只有一句，行为完全不变。
 */
export function queryClauses(query) {
  const text = String(query ?? '').trim()
  if (text === '') return []
  const parts = text.split(CLAUSE_SPLIT).map((part) => part.trim()).filter((part) => contentUnitsOf(part).length > 0)
  if (parts.length <= 1) return text === '' ? [] : [text]
  return parts
}

/**
 * v3.11 门槛判定（纯函数，便于单测）。
 * 主条件：覆盖率 ≥ floor（0.16，单指标）。
 * 放宽条件：**双信号一致**（覆盖率 top1 == 排序层 top1）+ 至少命中 2 个内容单元 + 覆盖率 ≥ 0.07。
 * 依据：72 正例 / 35 负例实测，单指标 56/72 且 0 负例；放宽到「只要求一致」64/72 但会放过
 * 「电脑为什么会蓝屏」这类单字假命中；再加「≥2 单元」正好 60/72 且负例 0 —— 白赚 4 个真命中。
 */
export function gateDecision({ coverage, matchedUnits, matchedDf, unitCount, agreeWithRanking, rankEvidence, floor = RELEVANCE_FLOOR }) {
  const units = Array.isArray(matchedUnits) ? matchedUnits.length : 0
  // v3.12：单单元匹配的「证据不足」护栏。
  // 词级切分让分母变小，单个词的命中就能把覆盖率顶到 0.3 以上 —— 实测负例
  // 「电脑为什么会蓝屏」只命中「电脑」一次（该词在整库只出现 1 条）就到 0.3482，
  // 而「已推荐未批准」那条让「推荐一部好看的电影」只命中「推荐」也到 0.33。
  // 规则：**只命中 1 个单元**、该单元在语料里 df ≤ 1、且覆盖率不到 0.40 → 不放行。
  // 依据：35 条负例里单单元命中的最高覆盖率 0.3482；74 条正例里靠单单元过门的（Hermes 0.435、
  // 两个工作区 0.4013）都在 0.40 以上。
  // 分两档：查询越短，单单元命中越像巧合，要求越高。
  //   短查询（≤2 单元）：0.40 —— 实测正例「技能是怎么生成的」单命中 0.4379 能过，
  //     负例「电脑为什么会蓝屏」单命中 0.3296 被挡住；
  //   长查询（≥3 单元）：0.25 —— 合成负例「推荐一部好看的电影」对上「已推荐未批准」是 0.2321，
  //     被挡住；长句正例里单命中的真实命中都在 0.25 以上（只有 1 条 0.2046 的会掉，见 README v3.12）。
  const queryUnits = Number.isInteger(unitCount) ? unitCount : 99
  const singleWordFloor = queryUnits <= 2 ? RELEVANCE_SINGLE_WORD_FLOOR_SHORT : RELEVANCE_SINGLE_WORD_FLOOR_LONG
  // v3.13：护栏判的是**实际要注入的那条**（排序层 top1）的证据，不是覆盖率 top 的证据。
  // 起因：长句「做新插件之前…」的覆盖率 top 是无关条目（单命中「重复」），而排序 top 正是期望记忆（命中 2 个单元）——
  // 按覆盖率 top 判会把整条查询挡掉。没传 rankEvidence 时退回覆盖率 top（纯函数单测仍按旧口径可测）。
  const rankUnits = Number.isInteger(rankEvidence?.units) ? rankEvidence.units : units
  const rankDf = Array.isArray(rankEvidence?.matchedDf) ? rankEvidence.matchedDf : matchedDf
  // 覆盖率用整体 coverage（与主条件同一个数），只有「命中单元数/df」取排序 top 的 ——
  // 别用 byId：它是另一套归一（实测 Hermes 那条 coverage 0.2757 而 byId 0.1538，会把真命中挡掉）。
  const rankCoverage = coverage
  // v3.13：单单元护栏按「要注入的那条」判，不按覆盖率 top
  if (rankUnits === 1 && Array.isArray(rankDf) && rankDf[0] <= 1 && rankCoverage < singleWordFloor) {
    return { pass: false, relaxed: false }
  }
  if (coverage >= floor) return { pass: true, relaxed: false }
  const relaxed = agreeWithRanking === true && units >= 2 && coverage >= RELEVANCE_FLOOR_AGREE
  return { pass: relaxed, relaxed }
}

/* v4.1（P2.2 前置）：覆盖率层的条目词表同样缓存（口径与 relevanceCoverage 原实现完全一致：text + tag，不含 aliases）。 */
const CONTENT_DOC_CACHE = new WeakMap()
function contentDocSignature(entry) {
  const tagText = Array.isArray(entry.tags) && entry.tags.length > 0 ? entry.tags.join(' ') : entry.tag ?? ''
  return String(entry.text ?? '') + '\u0000' + tagText
}
function buildContentDoc(entry, signature) {
  const parts = signature.split('\u0000')
  const text = parts[0] ?? ''
  const tagText = parts[1] ?? ''
  const terms = new Map()
  let length = 0
  for (const unit of contentUnitsOf(`${text} ${tagText}`)) {
    terms.set(unit, (terms.get(unit) ?? 0) + 1)
    length += 1
  }
  return { entry, terms, length }
}
function contentDoc(entry) {
  if (entry === null || typeof entry !== 'object') return buildContentDoc(entry, '')
  const signature = contentDocSignature(entry)
  const cached = CONTENT_DOC_CACHE.get(entry)
  if (cached !== undefined && cached.signature === signature) return cached.doc
  const doc = buildContentDoc(entry, signature)
  CONTENT_DOC_CACHE.set(entry, { signature, doc })
  return doc
}

export function relevanceCoverage(entries, query) {
  const list = Array.isArray(entries) ? entries : []
  const clauses = queryClauses(query)
  if (clauses.length > 1) {
    // 分句取最大：每句单独算，谁最相关用谁（并合并 byId，供相关层同尺判断）。
    let best = { coverage: 0, topId: null, matchedUnits: [], matchedDf: [], docMatched: new Map(), byId: new Map() }
    const merged = new Map()
    for (const clause of clauses) {
      const part = relevanceCoverage(list, clause)
      for (const [id, value] of part.byId) merged.set(id, Math.max(merged.get(id) ?? 0, value))
      if (part.coverage > best.coverage) best = { ...part, byId: merged }
    }
    return { ...best, byId: merged }
  }
  const docs = list.map((entry) => contentDoc(entry))
  const queryUnits = [...new Set(contentUnitsOf(query))]
  if (docs.length === 0 || queryUnits.length === 0) return { coverage: 0, topId: null, matchedUnits: [], matchedDf: [], docMatched: new Map() }
  let totalLength = 0
  for (const doc of docs) totalLength += doc.length
  const avgLength = totalLength / docs.length || 1
  const df = new Map()
  let denominator = 0
  for (const unit of queryUnits) {
    const hit = docs.filter((doc) => doc.terms.has(unit)).length
    df.set(unit, hit)
    denominator += idfOf(docs.length, hit)
  }
  let best = 0
  let topId = null
  let matchedUnits = []
  let matchedDf = []
  // v3.13：每条文档各自命中了哪些单元（供护栏按「要注入的那条」判证据，而不是只按覆盖率 top）。
  const docMatched = new Map()
  for (const doc of docs) {
    let score = 0
    const matched = []
    for (const unit of queryUnits) {
      const frequency = doc.terms.get(unit) ?? 0
      if (frequency === 0) continue
      matched.push(unit)
      score +=
        idfOf(docs.length, df.get(unit)) *
        ((frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / avgLength)))
    }
    if (matched.length > 0) docMatched.set(doc.entry.id, { units: matched, matchedDf: matched.map((unit) => df.get(unit) ?? 0) })
    if (score > best) {
      best = score
      topId = doc.entry.id
      matchedUnits = matched
      // v3.12：把命中单元的 df 一起带出去，供 gateDecision 判「单单元证据够不够」。
      matchedDf = matched.map((unit) => df.get(unit) ?? 0)
    }
  }
  // v3.9：分子带 BM25 的 tf 饱和与长度归一，短条目 + 高频词会让比值超过 1（实测 1.42–1.95）。
  // 「覆盖率」语义上不可能超过 100%，这里封顶；对判定没有影响（>1 本来就已经过门）。
  const ratio = denominator > 0 ? best / denominator : 0
  // byId：每条记忆自己的覆盖率，供相关层「同尺」判断（v3.9 / A2）。
  const byId = new Map()
  for (const doc of docs) {
    let own = 0
    for (const unit of queryUnits) {
      const frequency = doc.terms.get(unit) ?? 0
      if (frequency === 0) continue
      own +=
        Math.min(1, (frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / avgLength))) *
        idfOf(docs.length, df.get(unit))
    }
    byId.set(doc.entry.id, denominator > 0 ? Math.min(1, own / denominator) : 0)
  }
  return { coverage: Math.min(1, ratio), topId, matchedUnits, matchedDf, unitCount: queryUnits.length, docMatched, byId }
}

/** 单条打分（兼容旧签名）；传 options.entries 就能用上跨条目的 IDF。 */
export function scoreMemory(entry, query, options) {
  const corpus = Array.isArray(options?.entries) && options.entries.length > 0 ? options.entries : null
  const all = corpus === null ? [entry] : corpus.includes(entry) ? corpus : [...corpus, entry]
  const found = scoreEntries(all, query).find((item) => item.entry === entry)
  return found === undefined ? 0 : found.score
}

/**
 * 条目对外 schema —— **单一真相源**。
 * list / add / update / merge 全部引用它，避免出现「一处加了字段、另一处漏加 → invalid output」。
 * v2.6.1：补 lastUsedAt / validFrom / supersededBy / paths（存量漏项，真实库有 lastUsedAt 时 memory_list 直接报错）。
 */
export const memoryEntrySchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    text: { type: 'string' },
    tag: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    scope: { type: 'string' },
    kind: { type: 'string' },
    importance: { type: 'integer' },
    migratedFrom: { type: 'string' },
    validFrom: { type: 'string' },
    supersededBy: { type: 'string' },
    usedCount: { type: 'integer' },
    pinned: { type: 'boolean' },
    // v3.23：输出 schema 必须同步声明，否则 memory_list 会整条 rejecting（v3.20 踩过同一个坑）。
    inject: { type: 'boolean' },
    lastUsedAt: { type: 'string' },
    addedAt: { type: 'string' },
    updatedAt: { type: 'string' },
    status: { type: 'string' },
    // v3.20 修 v3.19 的漏声明：自动归档会写这两个字段，schema 不声明的话工具层会整条拒绝
    // （实测：库里只要有一条自动归档的记忆，memory_list 直接报 invalid output）。
    archivedAt: { type: 'string' },
    archiveReason: { type: 'string' },
    staleAfter: { type: 'string' },
    verifiedBy: { type: 'string' },
    verifiedAt: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
    paths: { type: 'array', items: { type: 'string' } },
    workspaces: { type: 'array', items: { type: 'string' } },
    aliases: { type: 'array', items: { type: 'string' } },
    // v4.0：实体标签（纯字符串）与失效时刻（对齐双时间戳里可用的那一半）。
    entities: { type: 'array', items: { type: 'string' } },
    invalidAt: { type: 'string' },
  },
  required: ['id', 'text', 'addedAt', 'updatedAt'],
  additionalProperties: false,
}

/**
 * v3.16 卡片导出：把一条记忆渲染成 Obsidian 兼容的 Markdown 卡片。
 * 学自 dsh-viya-memory（MIT）的核心长板——记忆应该是人能看见、手改的文件，
 * 而不是只有 agent 才读得到的 JSON。JSON 仍是权威存储（检索 / 预算 / 基准一律不动），
 * 这里只做单向镜像，不参与检索与注入。
 */
/** v4.0：YAML 标量安全引号——路径含反斜杠、URL 含冒号，裸写会被解析坏。 */
function yamlScalar(value) {
  return '"' + String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

export function cardMarkdown(entry, today = localDateOf()) {
  const lines = ['---']
  lines.push('id: ' + entry.id)
  if (typeof entry.kind === 'string' && entry.kind !== '') lines.push('kind: ' + entry.kind)
  if (typeof entry.tag === 'string' && entry.tag !== '') lines.push('tag: ' + entry.tag)
  if (Array.isArray(entry.tags) && entry.tags.length > 0) lines.push('tags: [' + entry.tags.join(', ') + ']')
  if (typeof entry.scope === 'string' && entry.scope !== '') lines.push('scope: ' + entry.scope)
  if (entry.pinned) lines.push('pinned: true')
  if (Number.isInteger(entry.importance)) lines.push('importance: ' + entry.importance)
  if (typeof entry.status === 'string' && entry.status !== '') lines.push('status: ' + entry.status)
  if (typeof entry.staleAfter === 'string' && entry.staleAfter !== '') {
    lines.push('staleAfter: ' + entry.staleAfter)
    if (entry.staleAfter < today) lines.push('recheck: true')
  }
  if (typeof entry.verifiedAt === 'string' && entry.verifiedAt !== '') lines.push('verifiedAt: ' + entry.verifiedAt)
  if (typeof entry.supersededBy === 'string' && entry.supersededBy !== '') lines.push('supersededBy: ' + entry.supersededBy)
  if (Number.isInteger(entry.usedCount) && entry.usedCount > 0) lines.push('usedCount: ' + entry.usedCount)
  if (typeof entry.addedAt === 'string' && entry.addedAt !== '') lines.push('created: ' + entry.addedAt.slice(0, 10))
  if (typeof entry.updatedAt === 'string' && entry.updatedAt !== '') lines.push('updated: ' + entry.updatedAt.slice(0, 10))
  if (Array.isArray(entry.aliases) && entry.aliases.length > 0) lines.push('aliases: [' + entry.aliases.join(', ') + ']')
  // v4.0：把「以后」需要的字段一起导出去（sources/entities/invalidAt/workspaces）——
  // 导出物是脱离 DSH 也能读的资产，字段不全等于将来迁移时丢信息。
  if (typeof entry.invalidAt === 'string' && entry.invalidAt !== '') lines.push('invalidAt: ' + entry.invalidAt)
  if (Array.isArray(entry.entities) && entry.entities.length > 0) {
    lines.push('entities:')
    for (const entity of entry.entities) lines.push('  - ' + yamlScalar(entity))
  }
  if (Array.isArray(entry.workspaces) && entry.workspaces.length > 0) {
    lines.push('workspaces:')
    for (const workspace of entry.workspaces) lines.push('  - ' + yamlScalar(workspace))
  }
  if (Array.isArray(entry.sources) && entry.sources.length > 0) {
    lines.push('sources:')
    for (const source of entry.sources) lines.push('  - ' + yamlScalar(source))
  }
  lines.push('---', '', String(entry.text ?? ''), '')
  return lines.join('\n')
}

/** 文件名 slug：保留中英文数字，其余压成连字符；太长截断。 */
export function slugOf(input, fallback = 'card') {
  const slug = String(input ?? '')
    .trim()
    .replace(/[^\u4e00-\u9fffA-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
  return slug === '' ? fallback : slug.replace(/-+$/g, '') || fallback
}

export function apply(ctx, config) {
  const maxBytes =
    Number.isInteger(config?.maxBytes) && config.maxBytes > 0 ? Math.min(config.maxBytes, 64 * 1024) : DEFAULT_MAX_BYTES
  let maxInjectChars =
    Number.isInteger(config?.maxInjectChars) && config.maxInjectChars > 0
      ? Math.min(config.maxInjectChars, 32 * 1024)
      : DEFAULT_MAX_INJECT_CHARS
  // v3.24：参数交叉校验（学 Google ADK 的成对校验）——注入预算不该超过存储预算。
  // 配反了不抛错（fail-safe），钳到 maxBytes 并把原因写进诊断，让人看得见。
  let configWarning = ''
  if (maxInjectChars > maxBytes) {
    configWarning =
      'maxInjectChars(' + maxInjectChars + ') 大于 maxBytes(' + maxBytes + ')：已钳到 ' + maxBytes + '。注入预算不该超过存储预算。'
    maxInjectChars = maxBytes
  }
  const { dir: storeDir, file: storeFile } = storeLocation(config?.storeDir)
  // v3.20：归档条目分文件冷存 —— 主库只留生效记忆，归档落 archive.json（与 aliases.json 同级的旁路文件）。
  // 起因：归档条目永远占着 memory.json，且 memory_list 每次都把 93 条一起吐出来（实测 37 KB），
  // 而它们既不计预算、也不参与注入 —— 唯一的作用是留历史。分文件后主库干净、列表默认不吐归档。
  const archiveFile = path.join(storeDir, 'archive.json')
  // v3.21：append-only 历史（学 mem0 的 history 表：ADD/UPDATE/DELETE 全记）。
  // 起因：2026-10-30 一次性物理删了 48 条归档，事后没有任何地方能查「删了什么、什么时候删的」。
  // 做法：每次 persist 成功后按基线做一次 diff，把 add/update/remove 追加成 JSONL；写失败绝不连累主操作。
  const historyFile = path.join(storeDir, 'history.jsonl')
  const HISTORY_MAX_BYTES = 2 * 1024 * 1024
  const HISTORY_TEXT_CAP = 400
  const historyCap = (value) => (typeof value === 'string' ? value.slice(0, HISTORY_TEXT_CAP) : undefined)
  /** id → { sig, text }：上一次落盘时的指纹，用来算本次 diff。 */
  let historyBaseline = new Map()
  const historySig = (entry) => `${entry.text ?? ''}|${entry.status ?? ''}|${entry.supersededBy ?? ''}`
  const resetHistoryBaseline = () => {
    historyBaseline = new Map(state.entries.map((entry) => [entry.id, { sig: historySig(entry), text: entry.text }]))
  }
  function recordHistoryDiff() {
    try {
      const next = new Map()
      const events = []
      const ts = new Date().toISOString()
      for (const entry of state.entries) {
        const sig = historySig(entry)
        next.set(entry.id, { sig, text: entry.text })
        const before = historyBaseline.get(entry.id)
        if (before === undefined) {
          events.push({ ts, event: 'add', id: entry.id, text: historyCap(entry.text), ...(entry.status ? { status: entry.status } : {}) })
        } else if (before.sig !== sig) {
          events.push({ ts, event: 'update', id: entry.id, before: historyCap(before.text), after: historyCap(entry.text), ...(entry.status ? { status: entry.status } : {}) })
        }
      }
      for (const [id, before] of historyBaseline) {
        if (!next.has(id)) events.push({ ts, event: 'remove', id, text: historyCap(before.text) })
      }
      if (events.length === 0) return
      mkdirSync(storeDir, { recursive: true })
      try {
        if (statSync(historyFile).size > HISTORY_MAX_BYTES) renameSync(historyFile, `${historyFile}.1`)
      } catch (error) {
        // 没有历史文件 / 轮转失败：继续追加即可
      }
      appendFileSync(historyFile, events.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8')
      historyBaseline = next
    } catch (error) {
      // 历史只是旁路审计，写失败不能连累主操作（fail-safe）
    }
  }
  // v3.6：别名放**旁路文件**，不跟条目混存。
  // 起因：运行中的旧版本在做 load→normalizeEntry 时不认识 aliases，一次 memory_update 落盘就把 32 条别名全洗掉了。
  // 旁路文件对旧版本完全不可见，天然免疫这种「未知字段被丢弃」的破坏。
  const aliasesFile = path.join(storeDir, 'aliases.json')
  let aliasesSidecar = {}

  function loadAliases() {
    let raw = ''
    try {
      raw = readFileSync(aliasesFile, 'utf8')
    } catch (error) {
      return // 没有旁路文件：从空开始
    }
    try {
      const parsed = JSON.parse(raw)
      const map = parsed && typeof parsed === 'object' && parsed.aliases && typeof parsed.aliases === 'object' ? parsed.aliases : null
      if (map === null) return
      const clean = {}
      for (const [id, list] of Object.entries(map)) {
        if (!Array.isArray(list)) continue
        const items = list.map((item) => (typeof item === 'string' ? item.trim() : '')).filter((item) => item !== '')
        if (items.length > 0) clean[id] = items
      }
      aliasesSidecar = clean
    } catch (error) {
      // v3.10（B08）：坏 JSON 不能静默当空 —— 否则下一次 saveAliases 就把原文覆盖没了。先另存一份留证。
      try {
        copyFileSync(aliasesFile, `${aliasesFile}.corrupt-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`)
      } catch (inner) {
        // 留证失败也不阻断启动
      }
    }
  }

  function saveAliases() {
    try {
      mkdirSync(storeDir, { recursive: true })
      const body = JSON.stringify(
        {
          version: 1,
          note: '别名旁路文件：改这里不会动 memory.json；插件启动时按 id 合并进条目，用于检索的跨词面桥接。',
          aliases: aliasesSidecar,
        },
        null,
        2,
      )
      // v3.10（B17 同款）：唯一临时名 + 重试 rename，不再「失败就直接覆盖」（非原子，崩了留半截）。
      tmpCounter += 1
      const temp = `${aliasesFile}.tmp-${process.pid}-${tmpCounter}`
      writeFileSync(temp, body, 'utf8')
      let renamed = false
      for (let attempt = 0; attempt < 3 && !renamed; attempt += 1) {
        try {
          renameSync(temp, aliasesFile)
          renamed = true
        } catch (error) {
          // 重试
        }
      }
      if (!renamed) {
        try {
          unlinkSync(temp)
        } catch (error) {
          // 留着下次覆盖
        }
        return false
      }
      return true
    } catch (error) {
      return false
    }
  }

  /** 把旁路别名合并进内存里的条目（条自带的 aliases 优先，旁路只补缺失）。 */
  function applyAliases() {
    for (const entry of state.entries) {
      const fromSidecar = aliasesSidecar[entry.id]
      if (!Array.isArray(fromSidecar) || fromSidecar.length === 0) continue
      if (Array.isArray(entry.aliases) && entry.aliases.length > 0) continue
      entry.aliases = fromSidecar
    }
  }

  /** 落盘后把内存里的 aliases 同步回旁路文件（唯一真相源 = 条目；旁路只是防丢副本）。 */
  function syncAliases() {
    const next = {}
    for (const entry of state.entries) {
      if (Array.isArray(entry.aliases) && entry.aliases.length > 0) next[entry.id] = entry.aliases
    }
    aliasesSidecar = next
    saveAliases()
  }
  const tools = ctx.tools
  const scopeRoots =
    config?.scopeRoots !== undefined && config.scopeRoots !== null && typeof config.scopeRoots === 'object'
      ? config.scopeRoots
      : DEFAULT_SCOPE_ROOTS
  const captureCandidates = config?.captureCandidates !== false
  // v3.26：规则文件沉淀（从 AGENTS.md / .dsh/rules 抽硬规则自动入库）可单独关闭。
  // 工作区规则已由规则文件每轮注入时，再沉淀只会重复占预算 → 本 profile 关掉。
  const captureRuleFiles = config?.captureRuleFiles !== false
  // v3.10（A11）：relevanceFloor <= 0 等于把相关性门槛关掉（会把无关记忆当相关注入），忽略这种配置。
  const relevanceFloor = Number.isFinite(config?.relevanceFloor) && config.relevanceFloor > 0 ? config.relevanceFloor : undefined
  const candidateFile = path.join(storeDir, 'candidates.json')

  // v4.0：新库直接以当前 schema 版本开局；老库在 load() 里由 migrateState 升级。
  let state = { version: SCHEMA_VERSION, nextId: 1, entries: [] }
  let candidates = { version: 1, nextId: 1, items: [] }
  // 数据安全：解析失败不覆盖，改名留证并进入只读保护态（P0-1）。
  let storeHealth = 'ok'
  // v4.0：本次加载是否发生了 schema 迁移（from→to），给诊断用。
  let schemaUpgraded = null
  let corruptCopy = ''
  // v3.9：加载时因字段不合法被丢弃的条目，原文件已另存到这里（只提示，不改数据）。
  let droppedCopyPath = ''

  const backupDay = () => {
    const date = new Date()
    return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
  }

  function pruneBackups() {
    try {
      if (!existsSync(storeDir)) return
      const prefix = `${path.basename(storeFile)}.bak-`
      // v3.9：只轮转「每日备份」bak-YYYYMMDD。原来按前缀一刀切，
      // 手工回滚点（bak-before-aliases / bak-before-merge3）也会被当成备份删掉（B07，实测可复现）。
      const dailyOnly = /.bak-\d{8}$/
      const names = readdirSync(storeDir).filter((name) => name.startsWith(prefix) && dailyOnly.test(name))
      if (names.length <= BACKUP_KEEP) return
      const listed = names.map((name) => {
        try {
          return { name, mtime: statSync(path.join(storeDir, name)).mtimeMs }
        } catch (error) {
          return { name, mtime: 0 }
        }
      })
      listed.sort((a, b) => b.mtime - a.mtime)
      for (const item of listed.slice(BACKUP_KEEP)) {
        try {
          unlinkSync(path.join(storeDir, item.name))
        } catch (error) {
          // 删不掉就算了，别影响主流程
        }
      }
    } catch (error) {
      // 备份清理失败不影响记忆读写
    }
  }

  function ensureDailyBackup() {
    if (!existsSync(storeFile)) return
    try {
      const target = `${storeFile}.bak-${backupDay()}`
      if (existsSync(target)) return
      copyFileSync(storeFile, target)
      pruneBackups()
    } catch (error) {
      // 备份失败不阻断写入，但 doctor 会报
    }
  }

  // ================= v4.1（P2）：SQLite 存储后端 =================
  // 设计（完整方案见 _reports/dsh-memory-p2-sqlite-plan-2026-11-02.md）：
  //   1) SQLite 只做**持久化**：entries 表存 payload（全字段 JSON）+ seq（写入顺序，排序/注入口径依赖它）
  //      + tokens/units（检索词表，由应用层 tokenize/contentUnitsOf 生成，供 FTS5 与 df 重建）；工具层代码不变。
  //   2) memory.json / archive.json 保留不动；首次以 storage: sqlite 启动时自动迁移（先备份、再回读 deepEqual，失败拒绝启动）。
  //   3) 回滚开关：config.storage = json（旧 JSON 后端代码完整保留）。
  const requireModule = createRequire(import.meta.url)
  // 代码默认仍是 json（向后兼容：旧数据目录/旧测试/回滚场景零改动）；生产由插件自带 cordis.patch.yml 显式设 storage: sqlite。
  const backend = STORE_BACKENDS.has(config?.storage) ? config.storage : 'json'
  const retrievalMode = RETRIEVAL_MODES.has(config?.retrieval) ? config.retrieval : 'index'
  const dbFile = path.join(storeDir, DB_FILE)
  let db = null
  let dbApi = null
  const dbMetaCache = new Map()
  /** 索引镜像：id -> { tokens, units, sortLen, unitLen }（增量维护 df 与自愈重建用；10k 条约 3-5MB）。 */
  const indexMirror = new Map()
  /** id -> 写入顺序 seq（SQLite 主键顺序；加载时按「生效在前、归档在后」重排，与 JSON 后端 memory.json+archive.json 的读取顺序一致）。 */
  const seqOf = new Map()
  let indexHealthy = false
  let persistedPayloads = new Map()
  let dbWriteSeq = '0'
  let lastDbSignature = ''

  function loadSqliteApi() {
    if (dbApi !== null) return dbApi
    try {
      dbApi = requireModule('node:sqlite')
      return dbApi
    } catch (error) {
      return null
    }
  }

  const sqliteUnavailable = () =>
    fail(
      'MEMORY_SQLITE_UNAVAILABLE',
      '运行时不支持 node:sqlite（需要 Node >= 23.4；本机 DSH 内置 Node 24 满足）。为不让两套后端行为漂移，拒绝启动。' +
        '回滚方式：cordis.patch.yml 的 dsh-memory.config 里加 storage: json（旧 JSON 后端仍保留，数据不丢）。',
    )

  const dbQuote = (value) => "'" + String(value).replace(/'/g, "''") + "'"

  function createDbSchema(target) {
    target.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    target.exec("CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL, seq INTEGER NOT NULL, tokens TEXT NOT NULL, units TEXT NOT NULL, sort_len INTEGER NOT NULL, unit_len INTEGER NOT NULL)")
    target.exec('CREATE INDEX IF NOT EXISTS entries_seq ON entries(seq)')
    target.exec('CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(id UNINDEXED, tokens, tokenize = "' + FTS_TOKENIZE + '")')
    target.exec('CREATE VIRTUAL TABLE IF NOT EXISTS entries_unit_fts USING fts5(id UNINDEXED, units, tokenize = "' + FTS_TOKENIZE + '")')
    target.exec('CREATE TABLE IF NOT EXISTS term_df (term TEXT PRIMARY KEY, df INTEGER NOT NULL)')
    target.exec('CREATE TABLE IF NOT EXISTS unit_df (unit TEXT PRIMARY KEY, df INTEGER NOT NULL)')
  }

  function metaGetOn(target, key) {
    try {
      const row = target.prepare('SELECT value FROM meta WHERE key = ?').get(key)
      return row === undefined ? null : row.value
    } catch (error) {
      return null
    }
  }
  function metaSetOn(target, key, value) {
    target.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value))
  }
  const metaGet = (key) => {
    if (dbMetaCache.has(key)) return dbMetaCache.get(key)
    const value = db === null ? null : metaGetOn(db, key)
    dbMetaCache.set(key, value)
    return value
  }
  const metaSet = (key, value) => {
    dbMetaCache.set(key, String(value))
    metaSetOn(db, key, value)
  }

  /** 检索词表口径：与 bm25Doc 完全一致（text + tag/tags + aliases + entities）。 */
  function indexTermsOf(entry) {
    const tagText = Array.isArray(entry.tags) && entry.tags.length > 0 ? entry.tags.join(' ') : entry.tag ?? ''
    const aliasText = Array.isArray(entry.aliases) ? entry.aliases.join(' ') : ''
    const entityText = Array.isArray(entry.entities) ? entry.entities.join(' ') : ''
    return tokenize(String(entry.text ?? '') + ' ' + tagText + ' ' + aliasText + ' ' + entityText)
  }
  /** 覆盖率层词表口径：与 contentDoc 完全一致（text + tag/tags，不含 aliases/entities）。 */
  function indexUnitsOf(entry) {
    const tagText = Array.isArray(entry.tags) && entry.tags.length > 0 ? entry.tags.join(' ') : entry.tag ?? ''
    const counts = new Map()
    for (const unit of contentUnitsOf(String(entry.text ?? '') + ' ' + tagText)) counts.set(unit, (counts.get(unit) ?? 0) + 1)
    return counts
  }
  function countsLength(counts) {
    let total = 0
    for (const value of counts.values()) total += value
    return total
  }
  function countsToText(counts) {
    const terms = []
    for (const term of counts.keys()) terms.push(term)
    terms.sort()
    return terms.join(' ')
  }

  /** 增量维护 df / FTS / 统计计数；oldMirror 为改前镜像（新增传 undefined）。必须在事务内调用。 */
  function applyIndexEntry(entry, oldMirror) {
    const id = entry.id
    const terms = indexTermsOf(entry)
    const units = indexUnitsOf(entry)
    const tokensText = countsToText(terms)
    const unitsText = countsToText(units)
    const sortLen = countsLength(terms)
    const unitLen = countsLength(units)
    const deltas = new Map()
    if (oldMirror !== undefined) {
      for (const term of oldMirror.tokens.split(' ')) if (term !== '') deltas.set(term, (deltas.get(term) ?? 0) - 1)
      for (const unit of oldMirror.units.split(' ')) if (unit !== '') deltas.set('u:' + unit, (deltas.get('u:' + unit) ?? 0) - 1)
    } else {
      metaSet('sort_doc_count', Number(metaGet('sort_doc_count') ?? 0) + 1)
      metaSet('unit_doc_count', Number(metaGet('unit_doc_count') ?? 0) + 1)
    }
    for (const term of tokensText.split(' ')) if (term !== '') deltas.set(term, (deltas.get(term) ?? 0) + 1)
    for (const unit of unitsText.split(' ')) if (unit !== '') deltas.set('u:' + unit, (deltas.get('u:' + unit) ?? 0) + 1)
    for (const [key, delta] of deltas) {
      if (delta === 0) continue
      const isUnit = key.startsWith('u:')
      const term = isUnit ? key.slice(2) : key
      const table = isUnit ? 'unit_df' : 'term_df'
      const column = isUnit ? 'unit' : 'term'
      db.prepare('INSERT INTO ' + table + '(' + column + ', df) VALUES(?, MAX(0, ?)) ON CONFLICT(' + column + ') DO UPDATE SET df = MAX(0, df + ?)').run(term, delta, delta)
    }
    db.prepare('DELETE FROM entries_fts WHERE id = ?').run(id)
    db.prepare('INSERT INTO entries_fts(id, tokens) VALUES(?, ?)').run(id, tokensText)
    db.prepare('DELETE FROM entries_unit_fts WHERE id = ?').run(id)
    db.prepare('INSERT INTO entries_unit_fts(id, units) VALUES(?, ?)').run(id, unitsText)
    const oldSortLen = oldMirror === undefined ? 0 : oldMirror.sortLen
    const oldUnitLen = oldMirror === undefined ? 0 : oldMirror.unitLen
    metaSet('sort_len_sum', Number(metaGet('sort_len_sum') ?? 0) - oldSortLen + sortLen)
    metaSet('unit_len_sum', Number(metaGet('unit_len_sum') ?? 0) - oldUnitLen + unitLen)
    indexMirror.set(id, { tokens: tokensText, units: unitsText, sortLen, unitLen })
  }

  function removeIndexEntry(id) {
    const oldMirror = indexMirror.get(id)
    db.prepare('DELETE FROM entries_fts WHERE id = ?').run(id)
    db.prepare('DELETE FROM entries_unit_fts WHERE id = ?').run(id)
    if (oldMirror === undefined) return
    const deltas = new Map()
    for (const term of oldMirror.tokens.split(' ')) if (term !== '') deltas.set(term, (deltas.get(term) ?? 0) - 1)
    for (const unit of oldMirror.units.split(' ')) if (unit !== '') deltas.set('u:' + unit, (deltas.get('u:' + unit) ?? 0) - 1)
    for (const [key, delta] of deltas) {
      const isUnit = key.startsWith('u:')
      const term = isUnit ? key.slice(2) : key
      const table = isUnit ? 'unit_df' : 'term_df'
      const column = isUnit ? 'unit' : 'term'
      db.prepare('UPDATE ' + table + ' SET df = MAX(0, df + ?) WHERE ' + column + ' = ?').run(delta, term)
    }
    metaSet('sort_len_sum', Number(metaGet('sort_len_sum') ?? 0) - oldMirror.sortLen)
    metaSet('unit_len_sum', Number(metaGet('unit_len_sum') ?? 0) - oldMirror.unitLen)
    metaSet('sort_doc_count', Number(metaGet('sort_doc_count') ?? 0) - 1)
    metaSet('unit_doc_count', Number(metaGet('unit_doc_count') ?? 0) - 1)
    indexMirror.delete(id)
  }

  /** 全量重建 FTS + df（迁移/自愈/差分测试用）。*/
  function rebuildIndex() {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('DELETE FROM entries_fts')
      db.exec('DELETE FROM entries_unit_fts')
      db.exec('DELETE FROM term_df')
      db.exec('DELETE FROM unit_df')
      indexMirror.clear()
      const rows = db.prepare('SELECT id, payload FROM entries ORDER BY seq').all()
      const termCounts = new Map()
      const unitCounts = new Map()
      let sortLenSum = 0
      let unitLenSum = 0
      for (const row of rows) {
        let entry = null
        try { entry = JSON.parse(row.payload) } catch (error) { entry = null }
        if (entry === null || entry === undefined) continue
        const terms = indexTermsOf(entry)
        const units = indexUnitsOf(entry)
        const tokensText = countsToText(terms)
        const unitsText = countsToText(units)
        const sortLen = countsLength(terms)
        const unitLen = countsLength(units)
        for (const term of terms.keys()) termCounts.set(term, (termCounts.get(term) ?? 0) + 1)
        for (const unit of units.keys()) unitCounts.set(unit, (unitCounts.get(unit) ?? 0) + 1)
        db.prepare('INSERT INTO entries_fts(id, tokens) VALUES(?, ?)').run(row.id, tokensText)
        db.prepare('INSERT INTO entries_unit_fts(id, units) VALUES(?, ?)').run(row.id, unitsText)
        indexMirror.set(row.id, { tokens: tokensText, units: unitsText, sortLen, unitLen })
        sortLenSum += sortLen
        unitLenSum += unitLen
      }
      for (const [term, count] of termCounts) db.prepare('INSERT INTO term_df(term, df) VALUES(?, ?)').run(term, count)
      for (const [unit, count] of unitCounts) db.prepare('INSERT INTO unit_df(unit, df) VALUES(?, ?)').run(unit, count)
      metaSet('sort_doc_count', rows.length)
      metaSet('unit_doc_count', rows.length)
      metaSet('sort_len_sum', sortLenSum)
      metaSet('unit_len_sum', unitLenSum)
      db.exec('COMMIT')
      indexHealthy = true
    } catch (error) {
      try { db.exec('ROLLBACK') } catch (inner) {}
      indexHealthy = false
      throw error
    }
  }

  function pruneBackupsSqlite() {
    try {
      const prefix = DB_FILE + '.bak-'
      const dailyOnly = /[.]bak-\d{8}$/
      const names = readdirSync(storeDir).filter((name) => name.startsWith(prefix) && dailyOnly.test(name))
      if (names.length <= BACKUP_KEEP) return
      const listed = names.map((name) => {
        try { return { name, mtime: statSync(path.join(storeDir, name)).mtimeMs } } catch (error) { return { name, mtime: 0 } }
      })
      listed.sort((a, b) => b.mtime - a.mtime)
      for (const item of listed.slice(BACKUP_KEEP)) {
        try { unlinkSync(path.join(storeDir, item.name)) } catch (error) {}
      }
    } catch (error) {}
  }

  function ensureDailyBackupSqlite() {
    if (db === null) return
    try {
      const target = dbFile + '.bak-' + backupDay()
      if (existsSync(target)) return
      db.exec('VACUUM INTO ' + dbQuote(target))
      pruneBackupsSqlite()
    } catch (error) {
      // 备份失败不阻断写入（与 JSON 后端同口径）
    }
  }

  /** 迁移前备份 JSON 三件套 + sha256 清单。返回备份目录。 */
  function backupJsonBeforeMigration() {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const backupDir = path.join(storeDir, 'backups', 'pre-sqlite-' + stamp)
    mkdirSync(backupDir, { recursive: true })
    const manifest = { createdAt: new Date().toISOString(), source: storeFile, files: [] }
    for (const name of ['memory.json', 'archive.json', 'aliases.json', 'candidates.json']) {
      const from = path.join(storeDir, name)
      if (!existsSync(from)) continue
      const to = path.join(backupDir, name)
      copyFileSync(from, to)
      const bytes = readFileSync(to)
      manifest.files.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    return backupDir
  }

  /** 迁移/加载时把别名旁路文件合并进条目（旁路只补缺失；与 applyAliases 同口径）。 */
  function mergeAliasesSidecar(entries) {
    let sidecar = {}
    try {
      const parsed = JSON.parse(readFileSync(aliasesFile, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && parsed.aliases !== null && typeof parsed.aliases === 'object') sidecar = parsed.aliases
    } catch (error) {
      // 没有旁路文件从空开始
    }
    for (const entry of entries) {
      const fromSidecar = sidecar[entry.id]
      if (!Array.isArray(fromSidecar) || fromSidecar.length === 0) continue
      if (Array.isArray(entry.aliases) && entry.aliases.length > 0) continue
      entry.aliases = fromSidecar
    }
    return entries
  }

  function readJsonStoreForMigration() {
    let parsed = null
    try {
      parsed = JSON.parse(readFileSync(storeFile, 'utf8'))
    } catch (error) {
      throw fail('MEMORY_MIGRATION_FAILED', '迁移失败：memory.json 读取/解析失败（' + (error?.message ?? '') + '）。原文件未动；可用 storage: json 继续用旧后端。')
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
      throw fail('MEMORY_MIGRATION_FAILED', '迁移失败：memory.json 形状不是 {entries: []}。原文件未动；可用 storage: json 继续用旧后端。')
    }
    const active = []
    for (const raw of parsed.entries) {
      if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.text !== 'string') continue
      active.push(normalizeEntry(raw))
    }
    const archived = []
    try {
      const archivedRaw = JSON.parse(readFileSync(archiveFile, 'utf8'))
      const list = Array.isArray(archivedRaw) ? archivedRaw : Array.isArray(archivedRaw?.entries) ? archivedRaw.entries : []
      const now = new Date().toISOString()
      for (const raw of list) {
        if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.text !== 'string') continue
        const entry = normalizeEntry(raw)
        archived.push(
          isArchivedEntry(entry)
            ? entry
            : { ...entry, status: 'deprecated', archivedAt: entry.archivedAt ?? now, archiveReason: entry.archiveReason ?? 'migrated: archive.json' },
        )
      }
    } catch (error) {
      // 归档文件缺失/损坏按空处理（与旧 loadArchive 的 fail-safe 同口径）
    }
    const activeIds = new Set(active.map((entry) => entry.id))
    const entries = [...active, ...archived.filter((entry) => !activeIds.has(entry.id))]
    const maxIdNumber = entries.reduce((max, entry) => {
      const match = /^m?(\d+)$/.exec(String(entry.id))
      return match ? Math.max(max, Number(match[1])) : max
    }, 0)
    const storedNextId = Number.isInteger(parsed.nextId) && parsed.nextId > 0 ? parsed.nextId : 0
    const version = Number.isInteger(parsed.version) && parsed.version > 0 ? parsed.version : 1
    if (version > SCHEMA_VERSION) throw schemaTooNewError(version, SCHEMA_VERSION)
    mergeAliasesSidecar(entries)
    return { version, nextId: Math.max(storedNextId, maxIdNumber + 1), entries }
  }

  /** JSON → SQLite 一次性迁移：备份 → 写临时 DB → 回读深比对 → 原子改名；失败删临时文件并拒绝启动。 */
  function migrateJsonToSqlite(api) {
    const lockFile = path.join(storeDir, DB_MIGRATION_LOCK)
    if (existsSync(lockFile)) {
      throw fail('MEMORY_MIGRATION_LOCKED', '检测到未完成的 SQLite 迁移锁（' + lockFile + '）。若确认上次迁移已中断，删除该锁文件后重试。')
    }
    try {
      writeFileSync(lockFile, String(process.pid), { flag: 'wx' })
    } catch (error) {
      throw fail('MEMORY_MIGRATION_LOCKED', '检测到未完成的 SQLite 迁移锁（' + lockFile + '）。若确认上次迁移已中断，删除该锁文件后重试。')
    }
    const tmpFile = dbFile + '.migrating-' + process.pid
    try {
      const source = readJsonStoreForMigration()
      const backupDir = backupJsonBeforeMigration()
      let migrationDb = null
      try {
        try { if (existsSync(tmpFile)) unlinkSync(tmpFile) } catch (error) {}
        migrationDb = new api.DatabaseSync(tmpFile)
        migrationDb.exec('PRAGMA journal_mode = WAL')
        createDbSchema(migrationDb)
        migrationDb.exec('BEGIN IMMEDIATE')
        try {
          const insert = migrationDb.prepare('INSERT INTO entries(id, payload, updated_at, seq, tokens, units, sort_len, unit_len) VALUES(?,?,?,?,?,?,?,?)')
          let seq = 0
          for (const entry of source.entries) {
            const terms = indexTermsOf(entry)
            const units = indexUnitsOf(entry)
            insert.run(entry.id, JSON.stringify(entry), String(entry.updatedAt ?? ''), seq, countsToText(terms), countsToText(units), countsLength(terms), countsLength(units))
            seq += 1
          }
          metaSetOn(migrationDb, 'schema_version', DB_SCHEMA_VERSION)
          metaSetOn(migrationDb, 'data_version', source.version)
          metaSetOn(migrationDb, 'next_id', source.nextId)
          metaSetOn(migrationDb, 'next_seq', source.entries.length)
          metaSetOn(migrationDb, 'write_seq', 1)
          metaSetOn(migrationDb, 'migrated_from', 'json')
          metaSetOn(migrationDb, 'migrated_at', new Date().toISOString())
          migrationDb.exec('COMMIT')
        } catch (error) {
          try { migrationDb.exec('ROLLBACK') } catch (inner) {}
          throw error
        }
        // 回读深比对：DB 里每条 entry 必须与源逐字段一致（内容不动）。
        const readBack = migrationDb.prepare('SELECT payload FROM entries ORDER BY seq').all()
        const parsedBack = []
        for (const row of readBack) parsedBack.push(JSON.parse(row.payload))
        const sourceCanonical = canonicalJson(source.entries)
        const backCanonical = canonicalJson(parsedBack)
        if (sourceCanonical !== backCanonical) {
          throw fail('MEMORY_MIGRATION_FAILED', '迁移回读比对不一致（源 ' + source.entries.length + ' 条 vs DB ' + parsedBack.length + ' 条）：已删除临时数据库，原 JSON 未动。')
        }
      } finally {
        try { if (migrationDb !== null) migrationDb.close() } catch (error) {}
      }
      try { unlinkSync(dbFile) } catch (error) {}
      renameSync(tmpFile, dbFile)
      return backupDir
    } catch (error) {
      try { if (existsSync(tmpFile)) unlinkSync(tmpFile) } catch (inner) {}
      if (error?.code === 'MEMORY_MIGRATION_FAILED' || error?.code === 'MEMORY_MIGRATION_LOCKED') throw error
      throw fail('MEMORY_MIGRATION_FAILED', '迁移失败：' + (error?.message ?? 'unknown') + '。原 JSON 未动；可用 storage: json 继续用旧后端。')
    } finally {
      try { unlinkSync(lockFile) } catch (error) {}
    }
  }

  function createEmptySqlite(api) {
    const emptyDb = new api.DatabaseSync(dbFile)
    try {
      emptyDb.exec('PRAGMA journal_mode = WAL')
      createDbSchema(emptyDb)
      metaSetOn(emptyDb, 'schema_version', DB_SCHEMA_VERSION)
      metaSetOn(emptyDb, 'data_version', SCHEMA_VERSION)
      metaSetOn(emptyDb, 'next_id', 1)
      metaSetOn(emptyDb, 'next_seq', 0)
      metaSetOn(emptyDb, 'write_seq', 1)
    } finally {
      try { emptyDb.close() } catch (error) {}
    }
  }

  function loadSqliteState() {
    const api = loadSqliteApi()
    if (api === null) throw sqliteUnavailable()
    mkdirSync(storeDir, { recursive: true })
    if (!existsSync(dbFile)) {
      if (existsSync(storeFile)) migrateJsonToSqlite(api)
      else createEmptySqlite(api)
    }
    // 打开 + PRAGMA + quick_check 全在一次 try 里：SQLite 是惰性打开的，坏文件往往到第一条语句才暴露。
    try {
      db = new api.DatabaseSync(dbFile)
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA busy_timeout = 2000')
      db.exec('PRAGMA synchronous = NORMAL')
      const quick = db.prepare('PRAGMA quick_check').all()
      const first = quick.length > 0 ? Object.values(quick[0])[0] : 'ok'
      if (first !== 'ok') throw new Error('quick_check: ' + String(first))
    } catch (error) {
      try { if (db !== null) db.close() } catch (inner) {}
      db = null
      storeHealth = 'corrupt'
      corruptCopy = dbFile
      return
    }
    if (db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'meta') === undefined) createDbSchema(db)
    const dbSchema = Number(metaGet('schema_version') ?? 0)
    if (dbSchema === 0) {
      metaSet('schema_version', DB_SCHEMA_VERSION)
      dbSchemaCacheReset()
    }
    if (dbSchema > DB_SCHEMA_VERSION) {
      const refusal = new Error('dsh-memory 拒绝启动：SQLite 存储 schema ' + dbSchema + ' 高于插件支持的 ' + DB_SCHEMA_VERSION + '。请升级插件或从备份恢复；为避免旧逻辑覆盖新数据，本次拒绝加载。')
      refusal.code = 'MEMORY_SCHEMA_TOO_NEW'
      throw refusal
    }
    const dataVersion = Number(metaGet('data_version') ?? 0) || 1
    if (dataVersion > SCHEMA_VERSION) throw schemaTooNewError(dataVersion, SCHEMA_VERSION)
    const rawRows = db.prepare('SELECT id, payload, tokens, units, sort_len, unit_len, seq FROM entries').all()
    seqOf.clear()
    const parsedRows = []
    for (const row of rawRows) {
      let parsed = null
      try { parsed = JSON.parse(row.payload) } catch (error) { parsed = null }
      if (parsed === null || typeof parsed !== 'object' || typeof parsed.id !== 'string' || typeof parsed.text !== 'string') continue
      const entry = normalizeEntry(parsed)
      parsedRows.push({ entry, seq: Number(row.seq ?? 0), row })
      seqOf.set(entry.id, Number(row.seq ?? 0))
    }
    // 顺序对齐 JSON 后端：memory.json 里的生效条目在前，archive.json 里的归档条目在后（各自保持写入顺序）。
    parsedRows.sort((a, b) => {
      const archivedA = isArchivedEntry(a.entry) ? 1 : 0
      const archivedB = isArchivedEntry(b.entry) ? 1 : 0
      if (archivedA !== archivedB) return archivedA - archivedB
      return a.seq - b.seq
    })
    const rows = parsedRows.map((item) => item.row)
    const entries = parsedRows.map((item) => item.entry)
    const maxIdNumber = entries.reduce((max, entry) => {
      const match = /^m?(\d+)$/.exec(String(entry.id))
      return match ? Math.max(max, Number(match[1])) : max
    }, 0)
    state = {
      nextId: Math.max(Number(metaGet('next_id') ?? 1) || 0, maxIdNumber + 1),
      version: dataVersion,
      entries,
    }
    persistedPayloads = new Map()
    for (const entry of entries) persistedPayloads.set(entry.id, JSON.stringify(entry))
    indexMirror.clear()
    for (const row of rows) {
      if (row.id === undefined) continue
      indexMirror.set(row.id, { tokens: String(row.tokens ?? ''), units: String(row.units ?? ''), sortLen: Number(row.sort_len ?? 0), unitLen: Number(row.unit_len ?? 0) })
    }
    dbWriteSeq = String(metaGet('write_seq') ?? '0')
    lastDbSignature = dbWriteSeq
    ensureSqliteIndex()
  }

  /** 索引自检：FTS/统计表与条目数不一致就重建（迁移中断、外部改库、旧库缺别名都能自愈）。 */
  function ensureSqliteIndex() {
    if (db === null) return
    try {
      const rowCount = Number(db.prepare('SELECT count(*) AS n FROM entries').get().n)
      const ftsRow = db.prepare('SELECT count(*) AS n FROM entries_fts').get()
      const ftsCount = ftsRow === undefined ? 0 : Number(ftsRow.n)
      const statCount = Number(metaGet('sort_doc_count') ?? 0)
      if (ftsCount !== rowCount || statCount !== rowCount || indexMirror.size !== rowCount) rebuildIndex()
      else indexHealthy = true
    } catch (error) {
      indexHealthy = false
    }
  }

  /** 别名旁路在加载后合入内存：若与 DB payload 不一致，立刻写回（索引随 persist 增量更新）。 */
  function syncSqliteAliases() {
    if (db === null) return
    let changed = false
    for (const entry of state.entries) {
      if (persistedPayloads.get(entry.id) !== JSON.stringify(entry)) {
        changed = true
        break
      }
    }
    if (!changed) return
    try {
      persistSqlite()
    } catch (error) {
      // 写失败留给下一次写入重试，不阻断启动
    }
  }

  /** 别的进程写过就刷新内存态（等价于 JSON 后端的 mergeWithDisk，靠 meta.write_seq 判断）。 */
  function refreshSqliteState() {
    if (db === null) return
    // 这里必须绕开 metaGet 缓存：write_seq/next_id 是别的进程刚写的，缓存里是旧值。
    const seq = String(metaGetOn(db, 'write_seq') ?? '0')
    if (seq === lastDbSignature) return
    const rows = db.prepare('SELECT id, payload, tokens, units, sort_len, unit_len, seq FROM entries').all()
    const byId = new Map()
    for (const row of rows) {
      let parsed = null
      try { parsed = JSON.parse(row.payload) } catch (error) { parsed = null }
      if (parsed === null || typeof parsed !== 'object' || typeof parsed.id !== 'string') continue
      seqOf.set(row.id, Number(row.seq ?? 0))
      byId.set(row.id, { entry: normalizeEntry(parsed), tokens: String(row.tokens ?? ''), units: String(row.units ?? ''), sortLen: Number(row.sort_len ?? 0), unitLen: Number(row.unit_len ?? 0) })
    }
    const next = []
    const seen = new Set()
    for (const entry of state.entries) {
      const disk = byId.get(entry.id)
      if (disk === undefined) {
        if (persistedPayloads.has(entry.id)) continue
        next.push(entry)
        seen.add(entry.id)
        continue
      }
      seen.add(entry.id)
      const mine = Date.parse(entry.updatedAt ?? '') || 0
      const theirs = Date.parse(disk.entry.updatedAt ?? '') || 0
      const winner = mine >= theirs ? entry : disk.entry
      next.push(winner)
      if (winner === disk.entry) persistedPayloads.set(entry.id, JSON.stringify(disk.entry))
      if (winner === disk.entry) indexMirror.set(entry.id, { tokens: disk.tokens, units: disk.units, sortLen: disk.sortLen, unitLen: disk.unitLen })
    }
    for (const [id, disk] of byId) {
      if (seen.has(id)) continue
      next.push(disk.entry)
      persistedPayloads.set(id, JSON.stringify(disk.entry))
      indexMirror.set(id, { tokens: disk.tokens, units: disk.units, sortLen: disk.sortLen, unitLen: disk.unitLen })
    }
    // 与加载顺序同口径：生效在前、归档在后；组内按 seq。
    next.sort((a, b) => {
      const archivedA = isArchivedEntry(a) ? 1 : 0
      const archivedB = isArchivedEntry(b) ? 1 : 0
      if (archivedA !== archivedB) return archivedA - archivedB
      return (seqOf.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (seqOf.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    })
    state.entries = next
    const maxIdNumber = state.entries.reduce((max, entry) => {
      const match = /^m?(\d+)$/.exec(String(entry.id))
      return match ? Math.max(max, Number(match[1])) : max
    }, 0)
    state.nextId = Math.max(Number(metaGetOn(db, 'next_id') ?? state.nextId), maxIdNumber + 1)
    state.version = Math.max(state.version, Number(metaGetOn(db, 'data_version') ?? state.version))
    dbMetaCache.set('next_id', String(state.nextId))
    dbMetaCache.set('write_seq', seq)
    dbMetaCache.set('data_version', String(state.version))
    lastDbSignature = seq
  }

  function persistSqlite() {
    if (storeHealth === 'corrupt') return false
    if (db === null) return false
    try {
      ensureDailyBackupSqlite()
      refreshSqliteState()
      const payloads = new Map()
      for (const entry of state.entries) payloads.set(entry.id, JSON.stringify(entry))
      const upserts = []
      for (const [id, payload] of payloads) if (persistedPayloads.get(id) !== payload) upserts.push([id, payload])
      const deletes = []
      for (const id of persistedPayloads.keys()) if (!payloads.has(id)) deletes.push(id)
      db.exec('BEGIN IMMEDIATE')
      try {
        const insert = db.prepare('INSERT INTO entries(id, payload, updated_at, seq, tokens, units, sort_len, unit_len) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at, tokens = excluded.tokens, units = excluded.units, sort_len = excluded.sort_len, unit_len = excluded.unit_len')
        let nextSeq = Number(metaGet('next_seq') ?? state.entries.length)
        for (const [id, payload] of upserts) {
          const entry = state.entries.find((item) => item.id === id)
          if (entry === undefined) continue
          const oldMirror = indexMirror.get(id)
          const terms = indexTermsOf(entry)
          const units = indexUnitsOf(entry)
          const tokensText = countsToText(terms)
          const unitsText = countsToText(units)
          const sortLen = countsLength(terms)
          const unitLen = countsLength(units)
          const seqRow = db.prepare('SELECT seq FROM entries WHERE id = ?').get(id)
          const seq = seqRow === undefined ? nextSeq++ : Number(seqRow.seq)
          insert.run(id, payload, String(entry.updatedAt ?? ''), seq, tokensText, unitsText, sortLen, unitLen)
          seqOf.set(id, seq)
          applyIndexEntry(entry, oldMirror)
          persistedPayloads.set(id, payload)
        }
        for (const id of deletes) {
          db.prepare('DELETE FROM entries WHERE id = ?').run(id)
          removeIndexEntry(id)
          seqOf.delete(id)
          persistedPayloads.delete(id)
        }
        metaSet('next_seq', nextSeq)
        metaSet('next_id', state.nextId)
        metaSet('data_version', state.version)
        const writeSeq = Number(metaGet('write_seq') ?? 0) + 1
        metaSet('write_seq', writeSeq)
        db.exec('COMMIT')
        lastDbSignature = String(writeSeq)
      } catch (error) {
        try { db.exec('ROLLBACK') } catch (inner) {}
        throw error
      }
      syncAliases()
      recordHistoryDiff()
      return true
    } catch (error) {
      if (error instanceof Error && (error.message.startsWith('SQLite 存储写入失败') || error.message.includes('SQLITE_BUSY'))) throw error
      storeHealth = 'readonly'
      throw fail('MEMORY_STORE_WRITE_FAILED', 'SQLite 存储写入失败（' + (error?.message ?? 'unknown') + '）。本次写入没有生效，别当成已保存；可用 storage: json 回滚后重试。')
    }
  }

  function dbSchemaCacheReset() {
    dbMetaCache.clear()
  }

  // ---------- v4.1（P2.2）：FTS5 候选集 + 统计 ----------
  // 为什么不是「FTS5 的 bm25」：排序公式（BM25 K1/B + tag×2 + alias×2.5 + 扩展×0.2 + STALE_PENALTY）在应用层，
  // 换成 FTS5 内置 bm25 = 换公式（红线 1）。所以 FTS5 只做两件事：候选集召回 + df 查表；分数仍按原公式算。
  function ftsCandidateIds(terms) {
    if (db === null) return null
    const phrases = []
    for (const term of terms) {
      const clean = String(term ?? '')
      if (clean === '') continue
      phrases.push('"' + clean.replace(/"/g, '""') + '"')
    }
    if (phrases.length === 0) return null
    try {
      const rows = db.prepare('SELECT id FROM entries_fts WHERE tokens MATCH ?').all(phrases.join(' OR '))
      const ids = new Set()
      for (const row of rows) ids.add(row.id)
      return ids
    } catch (error) {
      indexHealthy = false
      return null
    }
  }

  function indexDf(term) {
    try {
      const row = db.prepare('SELECT df FROM term_df WHERE term = ?').get(term)
      return row === undefined ? 0 : Number(row.df)
    } catch (error) {
      indexHealthy = false
      return 0
    }
  }

  /** memory_search 语料的统计量 = 全量 df/计数 − invalidAt 已失效条目的贡献（与 scoreEntries 收到的 docs 集合逐位对齐）。 */
  function searchCorpusStats() {
    const invalidDocs = []
    for (const entry of state.entries) if (isInvalidEntry(entry)) invalidDocs.push(bm25Doc(entry))
    const totalCount = Number(metaGet('sort_doc_count') ?? 0)
    const totalLen = Number(metaGet('sort_len_sum') ?? 0)
    let invalidLen = 0
    for (const doc of invalidDocs) invalidLen += doc.length
    const docCount = Math.max(0, totalCount - invalidDocs.length)
    const avgLen = docCount > 0 ? (totalLen - invalidLen) / docCount : 1
    const dfCache = new Map()
    return {
      docCount,
      avgLen,
      df(term) {
        const cached = dfCache.get(term)
        if (cached !== undefined) return cached
        let value = indexDf(term)
        for (const doc of invalidDocs) if (doc.terms.has(term)) value -= 1
        const result = Math.max(0, value)
        dfCache.set(term, result)
        return result
      },
    }
  }

  /** 与 scoreEntries 公式逐位相同的候选打分（只对 FTS5 候选集算；差分测试要求与全量扫描 top-k/score 逐位一致）。 */
  function scoreEntriesIndexed(searchable, query) {
    if (db === null || !indexHealthy) return null
    const queryTerms = tokenize(query)
    const expansion = expandQuery(query)
    if (queryTerms.size === 0 && expansion.size === 0) {
      const zeros = []
      for (const entry of searchable) zeros.push({ entry, score: 0 })
      return zeros
    }
    const weights = new Map()
    for (const term of queryTerms.keys()) weights.set(term, 1)
    for (const [term, weight] of expansion) if (!weights.has(term)) weights.set(term, weight)
    const candidateIds = ftsCandidateIds([...weights.keys()])
    if (candidateIds === null) return null
    const searchableById = new Map()
    for (const entry of searchable) searchableById.set(entry.id, entry)
    const stats = searchCorpusStats()
    const today = localDateOf()
    const scored = []
    for (const id of candidateIds) {
      const entry = searchableById.get(id)
      if (entry === undefined) continue
      const doc = bm25Doc(entry)
      let score = 0
      for (const [term, weight] of weights) {
        const frequency = doc.terms.get(term) ?? 0
        if (frequency === 0) continue
        const hit = stats.df(term)
        const idf = Math.log(1 + (stats.docCount - hit + 0.5) / (hit + 0.5))
        const tagBoost = doc.tagText.includes(term) ? BM25_TAG_WEIGHT : 1
        const aliasBoost = doc.aliasTerms.has(term) ? BM25_ALIAS_WEIGHT : 1
        score += weight * tagBoost * aliasBoost * idf * ((frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / stats.avgLen)))
      }
      if (isStaleEntry(entry, today)) score *= STALE_PENALTY
      if (score > 0.0001) scored.push({ entry, score })
    }
    return scored
  }
  const requireWritable = () => {
    if (storeHealth !== 'corrupt') return
    throw fail('MEMORY_STORE_CORRUPT', 
      `记忆库损坏保护中：原文件已另存为 ${corruptCopy || storeFile}。人工确认修复（把合法 JSON 改名回 ${storeFile}）并重载插件前，拒绝写入。`,
    )
  }

  /**
   * v3.18 自动入库（高置信度通道）：规则文件来的硬规则直接以 draft 身份进库。
   * 依据 arXiv 2610.27377《What to Store, When to Recall, What to Forget in Experience Memory for Coding Agents》——
   * 写入策略要在「该记」和「该忘」之间做预算权衡，而不是一律推给人审。
   * 三条同时成立才收：来源=规则文件 / kind=rule / 与现有记忆相似度 < 0.7。
   * 预算不够时先归档「最低价值」条目（status=deprecated + archivedAt，可逆，不物理删）。
   */
  // v3.25：加 minAgeDays —— 普通写入腾地方时只归档「至少 N 天没动过」的条目，
  // 避免刚写进来的记忆立刻被后续写入挤掉。规则入库通道保持 minAgeDays=0（原行为）。
  function lowestValueCandidate(minAgeDays = 0) {
    const cutoff = minAgeDays > 0 ? Date.now() - minAgeDays * 86400000 : 0
    const pool = activeEntries().filter(
      (entry) =>
        entry.pinned !== true &&
        (entry.usedCount ?? 0) === 0 &&
        entry.kind !== 'rule' &&
        entry.status !== 'draft' &&
        (cutoff === 0 || Date.parse(String(entry.updatedAt ?? entry.addedAt ?? '')) < cutoff),
    )
    if (pool.length === 0) return null
    return pool
      .map((entry) => ({ entry, imp: effectiveImportance(entry) }))
      .sort((a, b) => a.imp - b.imp)[0].entry
  }

  function makeRoom(size, opts) {
    const reason = typeof opts?.reason === 'string' ? opts.reason : 'auto-archive: 为规则自动入库腾预算'
    const minAgeDays = Number.isFinite(opts?.minAgeDays) ? opts.minAgeDays : 0
    const archived = []
    let guard = 0
    while (usedChars() + size > maxBytes && guard < 20) {
      guard += 1
      const victim = lowestValueCandidate(minAgeDays)
      if (victim === null) return { ok: false, archived }
      victim.status = 'deprecated'
      victim.archivedAt = new Date().toISOString()
      victim.archiveReason = reason
      archived.push(victim.id)
    }
    return { ok: usedChars() + size <= maxBytes, archived }
  }

  function autoPromoteRule(candidate, scope) {
    const raw = String(candidate?.text ?? '').trim()
    if (raw === '') return null
    if (state.entries.some((entry) => entry.text === raw)) return null
    if (activeEntries().some((entry) => textSimilarity(entry.text, raw) >= SIMILAR_HINT_FLOOR)) return null
    const room = makeRoom(raw.length)
    if (!room.ok) return null
    const now = new Date().toISOString()
    const entry = normalizeEntry({
      id: `m${state.nextId}`,
      text: raw,
      kind: 'rule',
      status: 'draft',
      ...(typeof scope === 'string' && scope !== '' ? { scope } : {}),
      addedAt: now,
      updatedAt: now,
      sources: [candidate.reason ?? 'rule-file'],
    })
    state.nextId += 1
    state.entries.push(entry)
    persist()
    return { entry, archived: room.archived }
  }

  function loadCandidates() {
    try {
      const parsed = JSON.parse(readFileSync(candidateFile, 'utf8'))
      const items = Array.isArray(parsed?.items) ? parsed.items : []
      candidates = {
        version: 1,
        nextId: Number.isInteger(parsed?.nextId) && parsed.nextId > 0 ? parsed.nextId : items.length + 1,
        items: items.filter((item) => item && typeof item.text === 'string' && typeof item.id === 'string'),
      }
    } catch (error) {
      // 没有候选池：从空开始
    }
  }

  function persistCandidates() {
    try {
      mkdirSync(storeDir, { recursive: true })
      const body = JSON.stringify(candidates, null, 2)
      const temp = `${candidateFile}.tmp`
      writeFileSync(temp, body, 'utf8')
      try {
        renameSync(temp, candidateFile)
      } catch (error) {
        writeFileSync(candidateFile, body, 'utf8')
      }
      return true
    } catch (error) {
      return false
    }
  }

  let lastSignature = ''
  let tmpCounter = 0

  /** 磁盘上 memory.json + archive.json 的指纹（mtime + size）：用来判断「别的进程写过了没有」。 */
  function storeSignature() {
    const part = (file) => {
      try {
        const info = statSync(file)
        return `${info.mtimeMs}:${info.size}`
      } catch (error) {
        return '-'
      }
    }
    return `${part(storeFile)}|${part(archiveFile)}`
  }

  /**
   * v3.20：读归档文件。不存在返回 []；**坏了也返回 [] 不抛** —— 归档坏掉绝不能连累主库启动。
   * 读出来的每一条都强制按归档处理（补 status=deprecated），防止文件被手工改过导致「档案复活」。
   */
  function readArchiveEntries() {
    let raw = ''
    try {
      raw = readFileSync(archiveFile, 'utf8')
    } catch (error) {
      return []
    }
    try {
      const parsed = JSON.parse(raw)
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : []
      const now = new Date().toISOString()
      return list
        .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.text === 'string')
        .map(normalizeEntry)
        .map((entry) =>
          isArchivedEntry(entry)
            ? entry
            : { ...entry, status: 'deprecated', archivedAt: entry.archivedAt ?? now, archiveReason: entry.archiveReason ?? 'migrated: archive.json' },
        )
    } catch (error) {
      return []
    }
  }

  /** v3.20：把归档文件里的条目并回内存态（主库同 id 的条目优先，归档只补缺）。 */
  function loadArchive() {
    // v4.1：SQLite 后端主表里已含归档条目（archived 语义由 status/supersededBy/invalidAt 判定），无需再并一次。
    if (backend === 'sqlite') return
    const archived = readArchiveEntries()
    if (archived.length === 0) return
    const seen = new Set(state.entries.map((entry) => entry.id))
    let added = 0
    for (const entry of archived) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      state.entries.push(entry)
      added += 1
    }
    if (added === 0) return
    const maxIdNumber = state.entries.reduce((max, entry) => {
      const match = /^m?(\d+)$/.exec(String(entry.id))
      return match ? Math.max(max, Number(match[1])) : max
    }, 0)
    state.nextId = Math.max(state.nextId, maxIdNumber + 1)
    lastSignature = storeSignature()
  }

  /** v3.20：原子写一个小文件（temp 唯一名 + fsync + rename 重试）。persist 用它写 archive.json。 */
  function writeAtomic(targetFile, body) {
    tmpCounter += 1
    const temp = `${targetFile}.tmp-${process.pid}-${tmpCounter}`
    writeFileSync(temp, body, 'utf8')
    try {
      const fd = openSync(temp, 'r')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } catch (error) {
      // 个别文件系统不支持 fsync：退化成不 fsync，但不因此失败
    }
    let renamed = false
    let lastError = null
    for (let attempt = 0; attempt < 3 && !renamed; attempt += 1) {
      try {
        renameSync(temp, targetFile)
        renamed = true
      } catch (error) {
        lastError = error
      }
    }
    if (!renamed) {
      try {
        unlinkSync(temp)
      } catch (error) {
        // 临时文件清不掉就留着，下次覆盖
      }
      throw fail('MEMORY_ARCHIVE_WRITE_FAILED', `归档写入失败（${lastError?.message ?? 'rename failed'}）：${path.basename(targetFile)}`)
    }
  }

  /** 读磁盘上的库；文件不存在返回 null；JSON/形状不对则抛错（由调用方决定是隔离还是忽略）。 */
  function readDiskState() {
    let raw = ''
    try {
      raw = readFileSync(storeFile, 'utf8')
    } catch (error) {
      return null
    }
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
      throw fail('MEMORY_STORE_SHAPE_INVALID', 'store shape is not {entries: []}')
    }
    const rawEntries = parsed.entries
    const kept = rawEntries
      .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.text === 'string')
      .map(normalizeEntry)
    // v3.9：形状不合法的条目被丢弃时先留证，别让下一次 persist 把它彻底抹掉（B09）。
    if (kept.length !== rawEntries.length) {
      try {
        const droppedCopy = `${storeFile}.dropped-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
        copyFileSync(storeFile, droppedCopy)
        droppedCopyPath = droppedCopy
      } catch (error) {
        // 留证失败不阻断
      }
    }
    // v3.9：nextId 不能只靠 entries.length —— 删过条目后它会落后、造成重复 id（B11）。
    const maxIdNumber = kept.reduce((max, entry) => {
      const match = /^m?(\d+)$/.exec(String(entry.id))
      return match ? Math.max(max, Number(match[1])) : max
    }, 0)
    const storedNextId = Number.isInteger(parsed?.nextId) && parsed.nextId > 0 ? parsed.nextId : 0
    // v4.1：磁盘上是更高版本 = 旧逻辑不认识的新数据，读进来再写回就会静默洗字段。
    // 这里带 code 抛出，由调用方决定 fail-loud；mergeWithDisk 会原样上抛而不是吞掉。
    const diskVersion = Number.isInteger(parsed?.version) && parsed.version > 0 ? parsed.version : 1
    if (diskVersion > SCHEMA_VERSION) throw schemaTooNewError(diskVersion, SCHEMA_VERSION)
    return {
      entries: kept,
      version: diskVersion,
      nextId: Math.max(storedNextId, maxIdNumber + 1),
    }
  }

  /**
   * v3.10（B02）：写前比对磁盘指纹，变了就把对方的条目合进来，再整库落盘。
   * 原来每个进程各自 load、各自整库覆盖写 —— 后写者会把别人刚写的条目静默抹掉（实测两条只剩一条、还抢同一个 id）。
   * 合并规则：按 id 取并集，updatedAt 新者胜；平手用本地（本次写入的意图）。
   * 已知边界：并发「删除」没有墓碑，可能被另一进程的写复活（比丢新增轻，先这样）。
   */
  function mergeWithDisk() {
    let disk
    try {
      disk = readDiskState()
    } catch (error) {
      // 版本比插件新：不是「坏文件」，旧逻辑绝不能覆盖它 → 原样上抛，让本次写入变成可读失败。
      if (error?.code === 'MEMORY_SCHEMA_TOO_NEW') throw error
      return // 磁盘上那份坏了：不合并，保住内存里的（损坏保护由 load 负责）
    }
    if (disk === null) return
    const signature = storeSignature()
    if (signature === lastSignature) return
    const byId = new Map()
    for (const entry of disk.entries) byId.set(entry.id, entry)
    for (const entry of state.entries) {
      const existing = byId.get(entry.id)
      if (existing === undefined) {
        byId.set(entry.id, entry)
        continue
      }
      const mine = Date.parse(entry.updatedAt ?? '') || 0
      const theirs = Date.parse(existing.updatedAt ?? '') || 0
      byId.set(entry.id, mine >= theirs ? entry : existing)
    }
    // v3.20：别的进程可能往 archive.json 追加了归档条目（指纹包含它），这里一并并进来。
    for (const entry of readArchiveEntries()) {
      if (!byId.has(entry.id)) byId.set(entry.id, entry)
    }
    state.entries = [...byId.values()]
    const maxIdNumber = state.entries.reduce((max, entry) => {
      const match = /^m?(\d+)$/.exec(String(entry.id))
      return match ? Math.max(max, Number(match[1])) : max
    }, 0)
    state.nextId = Math.max(state.nextId, maxIdNumber + 1)
    state.version = Math.max(state.version, disk.version)
    lastSignature = signature
  }

  /**
   * v3.10（B02）：写工具在**分配 id / 查找条目之前**先跟磁盘对齐一次。
   * 否则两个进程各自按自己的 nextId 发号，会分到同一个 id（实测 A、B 都是 m1）。
   */
  function refreshBeforeWrite() {
    // v4.1：SQLite 后端靠 WAL + write_seq 合并，不用 JSON 的锁文件/mergeWithDisk。
    if (backend === 'sqlite') {
      if (db !== null) refreshSqliteState()
      return
    }
    const release = acquireLock()
    try {
      mergeWithDisk()
    } finally {
      release()
    }
  }

  const LOCK_WAIT_MS = 400
  const LOCK_STALE_MS = 5000
  function sleepSync(ms) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
    } catch (error) {
      const until = Date.now() + ms
      while (Date.now() < until) {
        // 忙等兜底（环境不支持 Atomics.wait 时）
      }
    }
  }

  /** 跨进程互斥：memory.json.lock 用 wx 原子创建；陈旧锁（进程崩了）超过 5 秒直接抢。 */
  function acquireLock() {
    const lockFile = `${storeFile}.lock`
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
      try {
        writeFileSync(lockFile, String(process.pid), { flag: 'wx' })
        return () => {
          try {
            unlinkSync(lockFile)
          } catch (error) {
            // 锁已经被别人清了也不影响
          }
        }
      } catch (error) {
        try {
          const info = statSync(lockFile)
          if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
            try {
              unlinkSync(lockFile)
            } catch (inner) {
              // 撞车了就让下一轮重试
            }
            continue
          }
        } catch (inner) {
          continue
        }
        if (Date.now() > deadline) {
          throw fail('MEMORY_STORE_LOCKED', '另一个 DSH 进程正在写记忆（memory.json.lock 被占），等它写完重试一次即可。')
        }
        sleepSync(25)
      }
    }
  }

  function persist() {
    if (backend === 'sqlite') return persistSqlite()
    if (storeHealth === 'corrupt') return false
    ensureDailyBackup()
    // v3.10（B02）：跨进程互斥 + 写前合并。见 acquireLock / mergeWithDisk 的注释。
    const releaseLock = acquireLock()
    try {
      mergeWithDisk()
      mkdirSync(storeDir, { recursive: true })
      // v3.20：归档分文件冷存。主库只写生效条目；归档条目落 archive.json。
      // 顺序：**先写归档、再写主库** —— 归档写失败就整体失败（主库原样不动），
      // 不会出现「主库已经把条目摘掉、归档却没写成功」的丢数据窗口。
      const activeForWrite = state.entries.filter((entry) => !isArchivedEntry(entry))
      const archivedForWrite = state.entries.filter((entry) => isArchivedEntry(entry))
      writeAtomic(archiveFile, JSON.stringify({ version: 1, entries: archivedForWrite }, null, 2))
      const body = JSON.stringify({ ...state, entries: activeForWrite }, null, 2)
      // 学 write-file-atomic：临时文件名必须**每进程唯一**（pid + 序号）。
      // 原来固定用 `memory.json.tmp`，两个进程同时写会共用同一个临时文件互相踩 —— 比整库覆盖更隐蔽。
      tmpCounter += 1
      const temp = `${storeFile}.tmp-${process.pid}-${tmpCounter}`
      writeFileSync(temp, body, 'utf8')
      // 学 write-file-atomic 的 fsync 默认行为：先把内容压到盘再 rename，断电不至于留下半截。
      try {
        const fd = openSync(temp, 'r')
        try {
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
      } catch (error) {
        // 个别文件系统不支持 fsync：退化成不 fsync，但不因此失败
      }
      // v3.9：两处修正
      // 1) 删掉「rename 失败就直接覆盖目标文件」的兜底 —— 那是非原子写，崩在中间会留下半截 JSON（B17）。
      // 2) rename 失败重试几次，仍失败就**抛错**：原来只 return false，六个写工具全当成功，
      //    模型以为记住了、重载却是空的（B01，实测 add 返回 m1 而磁盘无文件）。
      let renamed = false
      let lastError = null
      for (let attempt = 0; attempt < 3 && !renamed; attempt += 1) {
        try {
          renameSync(temp, storeFile)
          renamed = true
        } catch (error) {
          lastError = error
        }
      }
      if (!renamed) {
        try {
          unlinkSync(temp)
        } catch (error) {
          // 临时文件清不掉就留着，下次覆盖
        }
        storeHealth = 'readonly'
        throw fail('MEMORY_STORE_WRITE_FAILED', 
          `记忆落盘失败（${lastError?.message ?? 'rename failed'}）。本次写入没有生效，别当成已保存；先用 memory_list 确认，修好磁盘/权限后重载插件。`,
        )
      }
      lastSignature = storeSignature()
      syncAliases()
      // v3.21：落盘成功后记一次 diff（add/update/remove），形成 append-only 审计链。
      recordHistoryDiff()
      return true
    } catch (error) {
      if (error instanceof Error && (error.message.startsWith('记忆落盘失败') || error.message.includes('memory.json.lock'))) throw error
      storeHealth = 'readonly'
      throw fail('MEMORY_STORE_WRITE_FAILED', `记忆落盘失败（${error?.message ?? 'unknown'}）。本次写入没有生效，别当成已保存。`)
    } finally {
      releaseLock()
    }
  }

  function load() {
    if (backend === 'sqlite') return loadSqliteState()
    let raw = ''
    try {
      raw = readFileSync(storeFile, 'utf8')
    } catch (error) {
      return // 没有存档：从空开始
    }
    try {
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
        throw fail('MEMORY_STORE_SHAPE_INVALID', 'store shape is not {entries: []}')
      }
      const entries = parsed.entries
      const kept = entries
        .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.text === 'string')
        .map(normalizeEntry)
      // v3.9：形状不合法的条目被丢弃时先留证，别让下一次 persist 把它彻底抹掉（B09）。
      if (kept.length !== entries.length) {
        try {
          const droppedCopy = `${storeFile}.dropped-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
          copyFileSync(storeFile, droppedCopy)
          droppedCopyPath = droppedCopy
        } catch (error) {
          // 留证失败不阻断加载
        }
      }
      // v3.9：nextId 不能只靠 entries.length —— 删过条目后它会落后、造成重复 id（B11）。
      const maxIdNumber = kept.reduce((max, entry) => {
        const match = /^m?(\d+)$/.exec(String(entry.id))
        return match ? Math.max(max, Number(match[1])) : max
      }, 0)
      const storedNextId = Number.isInteger(parsed?.nextId) && parsed.nextId > 0 ? parsed.nextId : 0
      state = {
        nextId: Math.max(storedNextId, maxIdNumber + 1),
        version: Number.isInteger(parsed?.version) && parsed.version > 0 ? parsed.version : 1,
        entries: kept,
      }
      // v4.0：加载即迁移（只升不降）。迁移本身不落盘，跟着下一次 persist 一起写，
      // 避免「读的时候顺手改文件」这种危险副作用。
      const migrated = migrateState(state)
      if (migrated.changed) {
        state = migrated.state
        schemaUpgraded = { from: migrated.from, to: migrated.to }
      }
      // v3.10（B02）：记下这次的磁盘指纹，persist 据此判断「别的进程写过了没有」。
      lastSignature = storeSignature()
    } catch (error) {
      // 版本比插件新：既不能当「损坏」改名隔离（那会把更高版本的数据当垃圾挪走），
      // 也不能半死继续跑（旧逻辑下一次 persist 就会用它覆盖新数据）。
      // 抛出去 → apply 失败 → 插件拒绝启动，错误信息里带版本与出路。
      if (error?.code === 'MEMORY_SCHEMA_TOO_NEW') {
        const refusal = new Error('dsh-memory 拒绝启动：' + error.message + '（存储文件：' + storeFile + '）')
        refusal.code = 'MEMORY_SCHEMA_TOO_NEW'
        refusal.fromVersion = error.fromVersion
        refusal.targetVersion = error.targetVersion
        throw refusal
      }
      // 损坏：把原文件改名留证，进入只读保护态；绝不静默覆盖。
      storeHealth = 'corrupt'
      try {
        corruptCopy = `${storeFile}.corrupt-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
        renameSync(storeFile, corruptCopy)
      } catch (renameError) {
        corruptCopy = storeFile
      }
    }
  }

  load()
  loadArchive()
  // v3.21：历史 diff 的基线要取「刚加载完」的状态，否则第一次写会把所有存量都记成 add。
  resetHistoryBaseline()
  loadAliases()
  applyAliases()
  if (backend === 'sqlite' && db !== null) {
    ensureSqliteIndex()
    syncSqliteAliases()
  }
  loadCandidates()

  // v2.9：候选池 TTL——过期未确认的自动标记 expired（保留记录，不删）。
  // 否则候选池只增不减，pending 数永远虚高，「有 N 条待确认」的提醒会变成噪声。
  const expireCandidates = () => {
    const nowMs = Date.now()
    let changed = false
    for (const item of candidates.items) {
      if (item.status === 'pending' && typeof item.expiresAt === 'string' && Date.parse(item.expiresAt) < nowMs) {
        item.status = 'expired'
        changed = true
      }
    }
    if (changed) persistCandidates()
  }
  expireCandidates()

  // v3.3（口径修复）：生效 = 未被 superseded **且** 不是 deprecated。
  // 原来只判 supersededBy，导致 deprecated 条目仍算进 activeEntries → usedChars 预算虚高、
  // memory_review 的 total 比实际注入多 3 条、memory_audit 的 active 也偏大。
  // renderMemory 一直是两者都过滤的，这里对齐它。
  const isActive = (entry) => !isArchivedEntry(entry)
  const activeEntries = () => state.entries.filter(isActive)
  const usedChars = () => activeEntries().reduce((sum, entry) => sum + entry.text.length, 0)
  const publicEntry = (entry) => ({ ...entry })
  const renderOnce = (query, stats, scope, cwd) =>
    renderMemory(state.entries, {
      maxInjectChars,
      query,
      ...(typeof scope === 'string' && scope !== '' ? { scope } : {}),
      ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
      ...(relevanceFloor !== undefined ? { relevanceFloor } : {}),
      ...(stats ? { stats } : {}),
    })

  // ---- 使用计数（给冷热/淘汰提供依据）----
  let usageDirty = false
  let lastUsageFlush = 0
  // v3.10（B14）：缓存最近一次装配系统提示时的 cwd。memory_list / audit / review 拿不到会话上下文，
  // 原来用空 cwd 渲染 → 带 workspaces 的条目永远被算成「没注入」，报的字数也偏小。
  let lastKnownCwd = ''
  let lastCountedQuery = ''
  const countUsage = (ids) => {
    if (!Array.isArray(ids) || ids.length === 0) return
    const stamp = new Date().toISOString()
    for (const id of ids) {
      const entry = state.entries.find((item) => item.id === id)
      if (entry === undefined) continue
      entry.usedCount = (entry.usedCount ?? 0) + 1
      entry.lastUsedAt = stamp
      usageDirty = true
    }
  }
  const flushUsage = () => {
    if (!usageDirty) return
    try {
      persist()
      usageDirty = false
      lastUsageFlush = Date.now()
    } catch (error) {
      // v3.9：persist 现在会抛错（写失败要报错）。用量计数只是记账，不能因此打断系统提示装配。
      usageDirty = false
      lastUsageFlush = Date.now()
    }
  }

  // 从运行期上下文取「本条用户消息」当检索查询：官方 AGENTS.md 也走 context.agent.session。
  // text() 必须同步且廉价，所以这里只做内存计算；拿不到会话就退化成「无 query」的纯索引模式。
  const currentQuery = (context) => {
    try {
      const session = context?.agent?.session
      if (session === undefined || typeof session.deriveMessages !== 'function') return ''
      const messages = session.deriveMessages()
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (message?.role !== 'user' || !Array.isArray(message.content)) continue
        const joined = message.content
          .filter((part) => part?.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('\n')
          .trim()
        if (joined !== '') return joined.slice(0, MAX_QUERY_CHARS)
      }
      return ''
    } catch (error) {
      return ''
    }
  }

  const currentScopeOf = (context) => {
    try {
      const session = context?.agent?.session
      if (session === undefined) return ''
      const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : ctx.workingDirectory
      const workingDirectory = service !== undefined && service !== null ? service : ctx.workingDirectory
      const cwd = typeof workingDirectory?.get === 'function' ? workingDirectory.get(session) : ''
      return detectScope(cwd, scopeRoots)
    } catch (error) {
      return ''
    }
  }

  // v3.0：workspaces 条件注入要当前工作目录（scope 粒度不够——同一 scope 下仍有不同工作区）。
  const currentCwdOf = (context) => {
    try {
      const session = context?.agent?.session
      if (session === undefined) return ''
      const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : ctx.workingDirectory
      const workingDirectory = service !== undefined && service !== null ? service : ctx.workingDirectory
      return typeof workingDirectory?.get === 'function' ? workingDirectory.get(session) : ''
    } catch (error) {
      return ''
    }
  }

  const pendingCandidates = () => candidates.items.filter((item) => item.status === 'pending')
  const addCandidate = (text, scope, kind, reason, sessionId) => {
    const value = String(text ?? '').trim()
    if (value === '') return false
    // 已经记过的、或与现有生效记忆高度重合的，不再候选
    for (const entry of activeEntries()) {
      if (entry.text === value || textSimilarity(entry.text, value) >= 0.7) return false
    }
    for (const item of pendingCandidates()) {
      if (item.text === value || textSimilarity(item.text, value) >= 0.7) return false
    }
    if (pendingCandidates().length >= CANDIDATE_LIMIT) return false
    candidates.items.push({
      id: `c${candidates.nextId}`,
      text: value.slice(0, MAX_TEXT_CHARS),
      ...(scope !== '' ? { scope } : {}),
      kind,
      reason,
      status: 'pending',
      ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + CANDIDATE_TTL_DAYS * 86400000).toISOString(),
    })
    candidates.nextId += 1
    persistCandidates()
    return true
  }

  const injectedBlock = (context) => {
    const query = currentQuery(context)
    const scope = currentScopeOf(context)
    const stats = {}
    const cwd = currentCwdOf(context)
    if (typeof cwd === 'string' && cwd !== '') lastKnownCwd = cwd
    let block = ''
    try {
      block = renderOnce(query, stats, scope, cwd)
    } catch (error) {
      // v3.9：渲染异常绝不能连累系统提示装配 —— 一条脏数据不该让每个会话都起不来。
      return ''
    }
    // 同一个 query 只计一次（text() 每个 step 都会被调用）；按分钟节流落盘。
    if (query !== '' && query !== lastCountedQuery) {
      lastCountedQuery = query
      countUsage(stats.relevant)
      if (usageDirty && Date.now() - lastUsageFlush > 60000) flushUsage()
    }
    const pending = pendingCandidates().length
    if (pending === 0) return block
    const reminder = `💡 候选记忆 ${pending} 条待确认（memory_candidates 查看）`
    if (block === '') return ['<memory>', '（记忆库为空）', reminder, '</memory>'].join('\n')
    return block.replace('</memory>', `${reminder}\n</memory>`)
  }
  const listOutput = (options) => {
    // v3.20：默认只返回生效条目。归档条目走 archive.json，要看需显式 includeArchived:true。
    // 起因：归档既不计预算也不参与注入，却让 memory_list 每次多吐 30+ KB（实测 93 条 / 37 KB）。
    const includeArchived = options?.includeArchived === true
    // v3.24：把 stats 传下去，才能报「索引行花了多少、出局的全量本要花多少」。
    const listStats = {}
    const block = renderOnce('', listStats, undefined, lastKnownCwd)
    const entries = activeEntries()
    const listed = includeArchived ? state.entries : entries
    return {
      total: state.entries.length,
      active: entries.length,
      includeArchived,
      superseded: state.entries.filter(
        (entry) => typeof entry.supersededBy === 'string' && entry.supersededBy !== '',
      ).length,
      archived: state.entries.length - entries.length,
      // v3.25（考虑以后）：容量预警——撞墙前先让人看见，而不是等 memory_add 报错。
      health:
        storeHealth !== 'ok'
          ? storeHealth
          : usedChars() / maxBytes >= 0.95
            ? 'full'
            : usedChars() / maxBytes >= 0.85
              ? 'near-full'
              : 'ok',
      ...(corruptCopy !== '' ? { healthNote: corruptCopy } : {}),
      usedChars: usedChars(),
      maxBytes,
      maxInjectChars,
      injectedChars: block.length,
      // v2.8：maxInjectChars 只管正文行，头部/索引/诊断另有固定开销，所以总长会略超——
      // 与其让人猜，不如直接把「是否超」标出来。
      injectedOverBudget: block.length > maxInjectChars,
      // v3.24：降级收益——索引行花了多少、被出局的条目若全量展开要花多少。
      injectStats: {
        fullChars: listStats.fullChars ?? 0,
        indexedChars: listStats.indexedChars ?? 0,
        droppedFullChars: listStats.droppedFullChars ?? 0,
        indexedCount: Array.isArray(listStats.indexed) ? listStats.indexed.length : 0,
        droppedCount: Array.isArray(listStats.dropped) ? listStats.dropped.length : 0,
      },
      ...(configWarning !== '' ? { configWarning } : {}),
      entries: listed.map(publicEntry),
      block,
    }
  }

  // ---- 注入：每个会话装配系统提示时读取当前记忆（分层，成本封顶） ----
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'dsh-memory',
      order: CONTEXT_ORDER,
      text: (context) => injectedBlock(context),
    }),
  )

  // ---- 工具 ----
  const listSchema = {
    type: 'object',
    properties: {
      total: { type: 'integer' },
      active: { type: 'integer' },
      includeArchived: { type: 'boolean' },
      superseded: { type: 'integer' },
      archived: { type: 'integer' },
      health: { type: 'string' },
      healthNote: { type: 'string' },
      configWarning: { type: 'string' },
      injectStats: {
        type: 'object',
        properties: {
          fullChars: { type: 'integer' },
          indexedChars: { type: 'integer' },
          droppedFullChars: { type: 'integer' },
          indexedCount: { type: 'integer' },
          droppedCount: { type: 'integer' },
        },
      },
      usedChars: { type: 'integer' },
      maxBytes: { type: 'integer' },
      maxInjectChars: { type: 'integer' },
      injectedChars: { type: 'integer' },
      injectedOverBudget: { type: 'boolean' },
      entries: { type: 'array', items: memoryEntrySchema },
      block: { type: 'string' },
    },
    required: ['total', 'active', 'includeArchived', 'superseded', 'health', 'usedChars', 'maxBytes', 'maxInjectChars', 'injectedChars', 'entries', 'block'],
    additionalProperties: false,
  }

  const entrySchema = memoryEntrySchema

  const renderList = (_args, value) => {
    const entries = Array.isArray(value?.entries) ? value.entries : []
    const healthWarn =
      value?.health === 'corrupt'
        ? `\n⚠ 记忆库损坏保护中（原文件已另存：${value?.healthNote ?? '未知'}），写入已禁用，修好后重载插件。`
        : value?.health === 'full'
          ? '\n⚠ 存储 ≥95%：下次写入会先归档「30 天没动过、从未被检索命中」的条目腾地方（可 memory_restore 恢复）。建议先 memory_audit 看重复项。'
          : value?.health === 'near-full'
            ? '\n（存储已达 85%：写入会先归档低价值条目腾地方，归档可 memory_restore 恢复。）'
            : ''
    const archivedCount = value?.archived ?? 0
    const hiddenHint =
      archivedCount > 0 && value?.includeArchived !== true
        ? `\n（另有 ${archivedCount} 条归档未列出：它们不计预算、不参与注入，存在 archive.json；要看加 includeArchived:true）`
        : ''
    const head = `记忆 ${value?.active ?? 0} 条生效 / ${archivedCount} 条归档（合计 ${value?.total ?? 0}），存储 ${value?.usedChars ?? 0}/${value?.maxBytes ?? 0} 字符，本轮注入 ${value?.injectedChars ?? 0}/${value?.maxInjectChars ?? 0} 字符${value?.injectedOverBudget ? ' ⚠超预算' : ''}${hiddenHint}${healthWarn}`
    if (entries.length === 0) return [text(`${head}\n（还没有任何记忆。用 memory_add 写入第一条。）`)]
    const lines = entries.map(
      (entry) =>
        `- ${entry.id}${trustMark(entry)}${entry.pinned ? ' 📌' : ''}${(entry.tags?.[0] ?? entry.tag) ? ` [${entry.tags?.[0] ?? entry.tag}]` : ''}${entry.scope ? ` <${entry.scope}>` : ''}${entry.kind ? ` (${entry.kind})` : ''}${entry.supersededBy ? ` [失效→${entry.supersededBy}]` : ''}${entry.status === 'deprecated' ? ' [已废弃]' : ''}${entry.usedCount ? ` 用${entry.usedCount}次` : ''} ${entry.text}`,
    )
    return [text(`${head}\n${lines.join('\n')}`)]
  }

  const applyEntryFlags = (entry, args) => {
    if (args?.pinned === true) entry.pinned = true
    else if (args?.pinned === false) delete entry.pinned
    // v3.23：inject:false 只检索不注入；传 true 显式恢复注入。
    if (args?.inject === false) entry.inject = false
    else if (args?.inject === true) delete entry.inject
  }

  ctx.effect(() =>
    tools.register({
      name: 'memory_list',
      description:
        'List the persistent memories injected into every session, with ids, tags, pinned flags and the exact injected block. Use it before adding or pruning. Archived entries (superseded/deprecated, stored in archive.json) are excluded by default; pass includeArchived:true to see them.',
      parameters: {
        type: 'object',
        properties: {
          includeArchived: {
            type: 'boolean',
            description: 'true also lists archived entries (superseded/deprecated). Default false — they do not count toward the budget and are never injected.',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: listSchema,
        render: renderList,
      },
      async execute(args) {
        return listOutput(args)
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'memory_search',
      description:
        'Search the persistent memories by keyword and get the full text of matching entries. Use it when the injected <memory> block shows compact index lines instead of full text.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords; space-separated terms are AND-weighted, a whole-string hit scores higher.' },
          limit: { type: 'integer', description: 'Max matches to return (1-20, default 5).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            total: { type: 'integer' },
            matched: { type: 'integer' },
            confidence: { type: 'string' },
            coverage: { type: 'number' },
            byId: { type: 'array', items: { type: 'string' } },
            matches: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  tag: { type: 'string' },
                  tags: { type: 'array', items: { type: 'string' } },
                  scope: { type: 'string' },
                  kind: { type: 'string' },
                  importance: { type: 'integer' },
                  pinned: { type: 'boolean' },
                  inject: { type: 'boolean' },
                  status: { type: 'string' },
                  staleAfter: { type: 'string' },
                  stale: { type: 'boolean' },
                  verifiedAt: { type: 'string' },
                  sources: { type: 'array', items: { type: 'string' } },
                  score: { type: 'number' },
                },
                required: ['id', 'text', 'score'],
                additionalProperties: false,
              },
            },
          },
          required: ['query', 'total', 'matched', 'matches'],
          additionalProperties: false,
        },
        render(_args, value) {
          const matches = Array.isArray(value?.matches) ? value.matches : []
          if (matches.length === 0) {
            return [text(`没有匹配「${value?.query ?? ''}」的记忆（共 ${value?.total ?? 0} 条）。`)]
          }
          const lines = matches.map((item) =>
            `- ${item.id}${trustMark(item)}${item.pinned ? ' 📌' : ''}${(item.tags?.[0] ?? item.tag) ? ` [${item.tags?.[0] ?? item.tag}]` : ''}${item.scope ? ` <${item.scope}>` : ''} ${item.text}`)
          const byId = Array.isArray(value?.byId) && value.byId.length > 0 ? `（按 id 直取 ${value.byId.join('、')}）` : ''
          const weak = value?.confidence === 'low' ? `\n⚠ 相关性低于注入门槛（覆盖率 ${value?.coverage ?? 0}），这些可能只是词面巧合；若都不对，换个关键词再搜。` : ''
          return [text(`匹配 ${value?.matched ?? 0} / ${value?.total ?? 0} 条${byId}：\n${lines.join('\n')}${weak}`)]
        },
      },
      async execute(args) {
        const query = typeof args?.query === 'string' ? args.query.trim() : ''
        if (query === '') throw fail('MEMORY_ARG_MISSING', 'memory_search 需要 query。')
        const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 20) : 5
        // v2.7：query 里出现 m\d+ 就按 id 直取。注入块一直写着「用 memory_search 按 id 取全文」，
        // 但 BM25 不认 id——实测搜 m33 命中 0/63。文档与实现不一致，这里补上。
        // v4.0：invalidAt 已到的条目不再参与检索（留档不删，memory_list includeArchived 仍可见）。
        const searchable = state.entries.filter((entry) => !isInvalidEntry(entry))
        const idHits = [...new Set(query.match(/m\d+/g) ?? [])]
          .map((id) => searchable.find((entry) => entry.id === id))
          .filter((entry) => entry !== undefined)
        // v4.1（P2.2）：默认走 FTS5 候选集 + df 统计（公式不变）；索引不可用/差分不过时回退全量扫描。
        let scoredRaw = null
        if (backend === 'sqlite' && retrievalMode === 'index') {
          try {
            scoredRaw = scoreEntriesIndexed(searchable, query)
          } catch (error) {
            scoredRaw = null
          }
        }
        if (scoredRaw === null) scoredRaw = scoreEntries(searchable, query)
        const scored = scoredRaw
          .filter((item) => item.score > 0.0001 && !idHits.some((entry) => entry.id === item.entry.id))
          .sort(
            (a, b) =>
              b.score - a.score ||
              String(b.entry.updatedAt).localeCompare(String(a.entry.updatedAt)),
          )
        if (idHits.length > 0) scored.unshift(...idHits.map((entry) => ({ entry, score: 1e6 })))
        const top = scored.slice(0, limit)
        countUsage(top.map((item) => item.entry.id))
        // v4.1（P2.2）：用量计数只是记账，不再「每次搜索都整库落盘」——
        // 10k 条时那一次 persist（JSON.stringify 全量 + 读回合并）会把单次搜索从 <20ms 拖到 100ms+。
        // 与注入路径同口径：距上次落盘 > 60s 才 flush；中间的任何写操作也会顺带把用量写回。
        if (usageDirty && Date.now() - lastUsageFlush > 60000) flushUsage()
        // v3.15：搜索侧补「证据充分性」信号（学 arXiv 2610.22668：相关 ≠ 充分证据）。
        // 之前只滤 score>0.0001，问「MySQL 索引优化」也会吐 8 条 —— 有结果不等于有答案。
        // 不砍结果（砍了会把「库里没有」误报成「有但不相关」），只给结论加一个可判读的信号。
        const coverageReport = relevanceCoverage(searchable, query)
        const agreeWithRanking = coverageReport.topId != null && scored.length > 0 && scored[0].entry.id === coverageReport.topId
        const gate = gateDecision({
          coverage: coverageReport.coverage,
          matchedUnits: coverageReport.matchedUnits,
          matchedDf: coverageReport.matchedDf,
          unitCount: coverageReport.unitCount,
          agreeWithRanking,
        })
        const confidence = idHits.length > 0 || gate.pass ? 'ok' : 'low'
        const coverage = Math.round(coverageReport.coverage * 1000) / 1000
        return {
          query,
          total: searchable.length,
          matched: scored.length,
          confidence,
          coverage,
          ...(idHits.length > 0 ? { byId: idHits.map((entry) => entry.id) } : {}),
          matches: scored.slice(0, limit).map((item) => ({
            id: item.entry.id,
            text: item.entry.text,
            ...(item.entry.tag ? { tag: item.entry.tag } : {}),
            ...(Array.isArray(item.entry.tags) && item.entry.tags.length > 0 ? { tags: item.entry.tags } : {}),
            ...(item.entry.scope ? { scope: item.entry.scope } : {}),
            ...(item.entry.kind ? { kind: item.entry.kind } : {}),
            ...(Number.isInteger(item.entry.importance) ? { importance: item.entry.importance } : {}),
            ...(item.entry.pinned ? { pinned: true } : {}),
            ...(typeof item.entry.status === 'string' ? { status: item.entry.status } : {}),
            ...(typeof item.entry.staleAfter === 'string' ? { staleAfter: item.entry.staleAfter } : {}),
            ...(isStaleEntry(item.entry) ? { stale: true } : {}),
            ...(typeof item.entry.verifiedAt === 'string' ? { verifiedAt: item.entry.verifiedAt } : {}),
            ...(Array.isArray(item.entry.sources) ? { sources: item.entry.sources } : {}),
            score: Math.round(item.score * 1000) / 1000,
          })),
        }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'memory_add',
      description:
        'Persist one durable fact across sessions (user preferences, environment quirks, project conventions). Keep each entry short and self-contained; it costs prompt space. It takes effect from the next model request.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: `The fact to remember (<= ${MAX_TEXT_CHARS} chars).` },
          tag: { type: 'string', description: 'Optional short tag, e.g. "preference", "env", "project".' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags; used for retrieval weighting.' },
          aliases: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional synonyms/aliases the user might use instead of the stored wording (e.g. 生效, reload). They are retrieval-only bridges and are scored higher than tags.',
          },
          scope: {
            type: 'string',
            description: 'Optional scope: global | plugin-dev | data-infra | dsh-date | machine. Unmatched scopes get no boost, never filtered out.',
          },
          kind: { type: 'string', description: 'Optional kind: rule | preference | fact | note.' },
          importance: { type: 'integer', minimum: 1, maximum: 10, description: 'Optional importance 1-10; derived from kind/pinned/usage when omitted.' },
          pinned: {
            type: 'boolean',
            description: 'Pin it so it is always injected in full, even when the injection budget is tight. Use it for hard rules.',
          },
          status: {
            type: 'string',
            enum: ['draft', 'stable', 'deprecated'],
            description: 'Trust state. draft = unconfirmed guess (injected with a "未证实" marker), stable = confirmed, deprecated = superseded history (kept but never injected).',
          },
          staleAfter: {
            type: 'string',
            description: 'YYYY-MM-DD. Set it when the fact depends on something that changes (a version, an API behavior); after that date the entry is injected with a "待重验" marker.',
          },
          sources: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Evidence backing the fact. Prefer the structured forms: "file:line", "session:<id>", or a URL. Never invent them.',
          },
          entities: {
            type: 'array',
            items: { type: 'string' },
            description:
              'v4.0: entity labels this fact is about (people, projects, files, concepts), e.g. ["dsh-memory","Obsidian"]. Plain strings — no entity table, no automatic extraction. They are the cheap anchor for future relationship queries.',
          },
          invalidAt: {
            type: 'string',
            description:
              'v4.0: YYYY-MM-DD (or ISO time) from which this fact stops being true. The entry is kept for history but no longer injected or returned by memory_search.',
          },
          supersede: {
            type: 'boolean',
            description:
              'v4.0: when this write collides with a highly similar active entry (same scope), pass true to replace it — the old entry is marked invalid + superseded, never deleted.',
          },
          allowDuplicate: {
            type: 'boolean',
            description:
              'v4.0: bypass the conflict gate when two similar entries are genuinely both wanted (e.g. they belong to different contexts).',
          },
          workspaces: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute workspace path prefixes this entry applies to (v3.0). When set, the entry is only injected in matching working directories; elsewhere it stays searchable but costs no prompt space.',
          },
          inject: {
            type: 'boolean',
            description: 'v3.23: set false for facts/history that should be retrievable by memory_search but must NOT occupy the per-turn injection budget. Hard rules should stay injected (default).',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            entry: entrySchema,
            deduped: { type: 'boolean' },
            usedChars: { type: 'integer' },
            maxBytes: { type: 'integer' },
            aliasHint: {
              type: 'object',
              properties: {
                suggestion: { type: 'array', items: { type: 'string' } },
                tip: { type: 'string' },
              },
              required: ['suggestion', 'tip'],
              additionalProperties: false,
            },
            similar: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  similarity: { type: 'number' },
                  text: { type: 'string' },
                },
                required: ['id', 'similarity', 'text'],
                additionalProperties: false,
              },
            },
          },
          required: ['entry', 'deduped', 'usedChars', 'maxBytes'],
          additionalProperties: false,
        },
        render(_args, value) {
          const entry = value?.entry
          const head = value?.deduped ? `已存在相同记忆：${entry?.id}` : `已记住：${entry?.id}${entry?.pinned ? '（已置顶）' : ''}`
          const similar = Array.isArray(value?.similar) ? value.similar : []
          const hint =
            similar.length > 0
              ? `\n⚠ 与已有记忆高度相似，考虑 memory_update 合并，或用 supersede 推翻旧条：\n${similar
                  .map((item) => `  - ${item.id}（相似 ${Math.round(item.similarity * 100) / 100}）${item.text.slice(0, 60)}`)
                  .join('\n')}`
              : ''
          const aliasHint = value?.aliasHint
          const aliasLine =
            aliasHint && Array.isArray(aliasHint.suggestion) && aliasHint.suggestion.length > 0
              ? `\n💡 没写别名：${aliasHint.suggestion.join('、')}（围绕这些词补 3–5 个同义/缩写/中英对照，用 memory_update {id:"${entry?.id}", aliases:[...]}；别名是「用户换种说法时」的召回桥）`
              : ''
          return [text(`${head}\n${entry?.text ?? ''}\n（占用 ${value?.usedChars ?? 0}/${value?.maxBytes ?? 0} 字符，下一条模型请求起生效）${hint}${aliasLine}`)]
        },
      },
      async execute(args) {
        requireWritable()
        refreshBeforeWrite()
        const raw = typeof args?.text === 'string' ? args.text.trim() : ''
        if (raw === '') throw fail('MEMORY_ARG_MISSING', 'memory_add 需要 text。')
        if (raw.length > MAX_TEXT_CHARS) {
          throw fail('MEMORY_TEXT_TOO_LONG', `单条记忆最多 ${MAX_TEXT_CHARS} 字符，当前 ${raw.length}。${TEXT_TOO_LONG_HINT}`)
        }
        if (args?.status !== undefined && !MEMORY_STATUS.has(args.status)) {
          throw fail('MEMORY_ARG_INVALID', 'status 只能是 draft | stable | deprecated，收到：' + String(args.status))
        }
        if (args?.staleAfter !== undefined && args.staleAfter !== '' && !DATE_ONLY.test(String(args.staleAfter))) {
          throw fail('MEMORY_DATE_INVALID', 'staleAfter 需要 YYYY-MM-DD 格式。')
        }
        if (args?.invalidAt !== undefined && args.invalidAt !== '') {
          const rawInvalid = String(args.invalidAt)
          if (!DATE_ONLY.test(rawInvalid) && Number.isNaN(Date.parse(rawInvalid))) {
            throw fail('MEMORY_DATE_INVALID', 'invalidAt 需要 YYYY-MM-DD 或 ISO 时间（空串表示清除）。')
          }
        }
        // v4.0：scope 收敛（global 或小写 slug）。早失败好过再攒出 8 种混用取值。
        const incomingScope = normalizeScope(args?.scope)
        // v3.9 两处修正：
        // 1) 只跟**生效**条目去重。原来会命中已 superseded 的条目，返回「已存在」、正文却永不注入（B03）。
        // 2) 命中时把这次新给的字段合并进去。原来只回写 pinned/status/staleAfter/sources，
        //    aliases/tags/scope/kind/importance/workspaces 全被吞掉（B04）——而 aliasHint 教的正是「再 add 一次补别名」。
        const duplicate = state.entries.find((entry) => isActive(entry) && entry.text === raw)
        // v4.0：显式 supersede 不能被「文本完全一致」的去重捷径吞掉 —— 调用方的意图是「换掉旧条」，
        // 必须真的走推翻路径（旧条标失效 + 新条入库），而不是返回旧条说「已存在」。
        if (duplicate && args?.supersede !== true) {
          let changed = false
          const unionInto = (field, incoming) => {
            if (!Array.isArray(incoming)) return
            const values = incoming.filter((item) => typeof item === 'string' && item.trim() !== '')
            if (values.length === 0) return
            const before = Array.isArray(duplicate[field]) ? duplicate[field] : []
            const next = field === 'aliases' ? cleanAliases([...before, ...values]) : [...new Set([...before, ...values])]
            if (next.length === 0) return
            duplicate[field] = next
            changed = true
          }
          unionInto('aliases', args?.aliases)
          unionInto('tags', args?.tags)
          unionInto('workspaces', args?.workspaces)
          unionInto('paths', args?.paths)
          unionInto('sources', args?.sources)
          unionInto('entities', args?.entities)
          if (incomingScope !== '' && duplicate.scope !== incomingScope) {
            duplicate.scope = incomingScope
            changed = true
          }
          if (typeof args?.kind === 'string' && args.kind.trim() !== '' && duplicate.kind !== args.kind.trim()) {
            duplicate.kind = args.kind.trim()
            changed = true
          }
          if (Number.isFinite(args?.importance)) {
            const value = Math.max(1, Math.min(10, Math.round(args.importance)))
            if (duplicate.importance !== value) {
              duplicate.importance = value
              changed = true
            }
          }
          if (args?.pinned === true && !duplicate.pinned) {
            duplicate.pinned = true
            changed = true
          }
          if (typeof args?.status === 'string' && duplicate.status !== args.status) {
            duplicate.status = args.status
            changed = true
          }
          if (typeof args?.staleAfter === 'string' && args.staleAfter !== '' && duplicate.staleAfter !== args.staleAfter) {
            duplicate.staleAfter = args.staleAfter
            changed = true
          }
          if (changed) {
            duplicate.updatedAt = new Date().toISOString()
            persist()
          }
          return { entry: publicEntry(duplicate), deduped: true, usedChars: usedChars(), maxBytes }
        }
        // v3.25（考虑以后）：存储撞墙时先尝试归档，而不是直接拒绝写入。
        // 只归档「≥ ROOM_MIN_AGE_DAYS 天没更新、从未被检索命中、非 pinned / 非规则」的条目 ——
        // 可逆（memory_restore 能恢复，history 有记录）。归档不出足够空间才报错，并在错误里点名候选。
        // v4.0.1：30 天 → 7 天。依据扫描 #11：阈值 30 天时库内 >30 天条目长期 0 条，
        // makeRoom 永远找不到候选 → 正常写入被硬拒，且「腾地方」这条路径等于不存在。
        // 7 天既保护刚写进来的记忆不被挤掉，又保证真有候选可归档；错误里的候选名单用同一门槛，
        // 避免「点名了却归档不了」的两套口径（原候选名单不看年龄，本身就是不一致的）。
        if (usedChars() + raw.length > maxBytes) {
          const room = makeRoom(raw.length, { reason: 'auto-archive: 为新记忆腾预算', minAgeDays: ROOM_MIN_AGE_DAYS })
          if (!room.ok) {
            const cutoff = Date.now() - ROOM_MIN_AGE_DAYS * 86400000
            const candidates = activeEntries()
              .filter(
                (entry) =>
                  entry.pinned !== true &&
                  (entry.usedCount ?? 0) === 0 &&
                  entry.kind !== 'rule' &&
                  entry.status !== 'draft' &&
                  Date.parse(String(entry.updatedAt ?? entry.addedAt ?? '')) < cutoff,
              )
              .map((entry) => entry.id)
              .slice(0, 10)
            throw fail('MEMORY_BUDGET_EXCEEDED', 
              `记忆已占用 ${usedChars()} / ${maxBytes} 字符，归档腾地方后仍不够（需 ${raw.length} 字符）。` +
                (candidates.length > 0
                  ? `可归档候选（≥${ROOM_MIN_AGE_DAYS} 天未动、从未用过、非规则）：${candidates.join(' ')}。用 memory_remove 精确删，或 memory_update 精简长条目。`
                  : `已没有「≥${ROOM_MIN_AGE_DAYS} 天未动且从未使用过」的可归档条目了（刚写的、规则、draft、pinned 都不动），只能 memory_remove 或 memory_update 精简。`)
            )
          }
        }
        const now = new Date().toISOString()
        const derivedStale =
          typeof args?.staleAfter === 'string' && args.staleAfter !== ''
            ? ''
            : deriveStaleAfter(typeof args?.kind === 'string' ? args.kind.trim() : '')
        const entry = normalizeEntry({
          id: `m${state.nextId}`,
          text: raw,
          ...(typeof args?.tag === 'string' && args.tag.trim() !== '' ? { tag: args.tag.trim() } : {}),
          ...(Array.isArray(args?.tags) ? { tags: args.tags } : {}),
          ...(Array.isArray(args?.aliases) ? { aliases: args.aliases } : {}),
          ...(typeof args?.scope === 'string' ? { scope: args.scope.trim() } : {}),
          ...(typeof args?.kind === 'string' ? { kind: args.kind.trim() } : {}),
          ...(Number.isFinite(args?.importance) ? { importance: args.importance } : {}),
          ...(args?.pinned === true ? { pinned: true } : {}),
          // v3.23 修：add 路径原本没接 inject，schema 声明了但落盘时被丢掉。
          ...(args?.inject === false ? { inject: false } : {}),
          ...(typeof args?.status === 'string' ? { status: args.status } : {}),
          ...(typeof args?.staleAfter === 'string' && args.staleAfter !== '' ? { staleAfter: args.staleAfter } : {}),
          ...(derivedStale !== '' ? { staleAfter: derivedStale } : {}),
          ...(Array.isArray(args?.sources) ? { sources: args.sources } : {}),
          ...(Array.isArray(args?.entities) ? { entities: args.entities } : {}),
          ...(typeof args?.invalidAt === 'string' && args.invalidAt !== '' ? { invalidAt: args.invalidAt } : {}),
          ...(Array.isArray(args?.workspaces) ? { workspaces: args.workspaces } : {}),
          addedAt: now,
          updatedAt: now,
        })
        // v2.7（A-MEM 邻居演化的零模型版）：写入前找出高度相似的在库条目，把判断权交回模型。
        // 只提示、不自动合并——dsh-memory 一贯原则是「给候选不自动改」。
        const neighbours = activeEntries()
          .filter((item) => item.text !== raw)
          .map((item) => ({ entry: item, similarity: textSimilarity(item.text, raw) }))
          .sort((a, b) => b.similarity - a.similarity)
        const similar = neighbours.filter((item) => item.similarity >= SIMILAR_HINT_FLOOR).slice(0, MAX_SIMILAR_HINT)
        // v4.0：写入冲突**硬**检测。调研（mem0/Letta/Graphiti）唯一有共识的一条是「冲突必须显式处理」，
        // 而不是像旧版那样只提示一句、模型可以当没看见。同 scope + 高度相似 + 双方都生效 → 直接拒绝，
        // 逼出三个明确选项；draft 与 allowDuplicate 是合法逃生口。
        // v4.0.1：**双方都必须有 scope** 才参与判定（任一侧空 = 不判定，不是「不限」）。
        // 否则库里无 scope 的老条目会对所有新写入生效，稍像就拒（扫描 #10）。
        const scopeOf = (item) => (typeof item?.scope === 'string' ? item.scope.trim().toLowerCase() : '')
        const conflict = neighbours.find(
          (item) =>
            item.similarity >= CONFLICT_FLOOR &&
            item.entry.status !== 'draft' &&
            incomingScope !== '' &&
            scopeOf(item.entry) !== '' &&
            incomingScope === scopeOf(item.entry),
        )
        // 文本完全一致 + 显式 supersede：把那条当作冲突对象处理（否则 neighbours 会把它过滤掉）。
        const resolvedConflict =
          conflict ?? (args?.supersede === true && duplicate ? { entry: duplicate, similarity: 1 } : undefined)
        if (resolvedConflict && args?.supersede !== true && args?.allowDuplicate !== true && args?.status !== 'draft') {
          throw fail('MEMORY_CONFLICT', 
            '写入冲突：与 ' +
              resolvedConflict.entry.id +
              ' 相似度 ' +
              Math.round(resolvedConflict.similarity * 100) +
              '%，内容高度重复。三选一：\n' +
              '  1) memory_add 加 supersede: true —— 推翻旧条（旧条标失效、留档不删）\n' +
              '  2) memory_add 加 allowDuplicate: true —— 明确要两条并存（分属不同上下文）\n' +
              '  3) memory_add 加 status: "draft" —— 先存成待证实\n' +
              '旧条：' +
              resolvedConflict.entry.id +
              ' ' +
              String(resolvedConflict.entry.text).slice(0, 80),
          )
        }
        state.nextId += 1
        state.entries.push(entry)
        // v4.0：supersede 把被推翻的旧条标记失效（留档不删，可 memory_restore / memory_history 反查）。
        if (args?.supersede === true && resolvedConflict) {
          const stamp = new Date().toISOString()
          resolvedConflict.entry.supersededBy = entry.id
          resolvedConflict.entry.invalidAt = stamp
          resolvedConflict.entry.status = 'deprecated'
          resolvedConflict.entry.updatedAt = stamp
        }
        persist()
        return {
          entry: publicEntry(entry),
          deduped: false,
          usedChars: usedChars(),
          maxBytes,
          ...(similar.length > 0
            ? {
                similar: similar.map((item) => ({
                  id: item.entry.id,
                  similarity: Math.round(item.similarity * 1000) / 1000,
                  text: item.entry.text,
                })),
              }
            : {}),
          ...(Array.isArray(entry.aliases) && entry.aliases.length > 0
            ? {}
            : {
                aliasHint: {
                  suggestion: suggestAliases(entry.text),
                  tip: '别名是检索的跨词面桥：用户换一种说法时靠它召回。建议用 memory_update {id, aliases:[同义/缩写/中英对照 3-5 个]} 补上。',
                },
              }),
        }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'memory_update',
      description: 'Replace the text, the tag, or the pinned flag of one existing memory entry.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Entry id from memory_list, e.g. "m1".' },
          text: { type: 'string', description: `New text (<= ${MAX_TEXT_CHARS} chars).` },
          tag: { type: 'string', description: 'Optional new tag; omit to keep the current one.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional new tags; omit to keep the current ones.' },
          aliases: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional new aliases (synonyms) for retrieval; omit to keep the current ones, empty array clears them.',
          },
          scope: { type: 'string', description: 'Optional new scope (global | plugin-dev | data-infra | dsh-date | machine).' },
          kind: { type: 'string', description: 'Optional new kind (rule | preference | fact | note).' },
          importance: { type: 'integer', minimum: 1, maximum: 10, description: 'Optional new importance 1-10.' },
          pinned: { type: 'boolean', description: 'true pins it to always-injected, false unpins.' },
          status: {
            type: 'string',
            enum: ['draft', 'stable', 'deprecated'],
            description: 'New trust state: draft (unconfirmed), stable (confirmed), deprecated (kept as history, never injected).',
          },
          staleAfter: { type: 'string', description: 'YYYY-MM-DD re-check date; empty string clears it.' },
          sources: { type: 'array', items: { type: 'string' }, description: 'New evidence list; empty array clears it.' },
          entities: {
            type: 'array',
            items: { type: 'string' },
            description: 'v4.0: new entity labels (plain strings); empty array clears them.',
          },
          invalidAt: {
            type: 'string',
            description: 'v4.0: YYYY-MM-DD (or ISO) from which the fact stops being true; empty string clears it.',
          },
          workspaces: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute workspace path prefixes (v3.0); empty array clears it so the entry applies everywhere again.',
          },
          verified: {
            type: 'boolean',
            description: 'true = mark as just re-checked (records verifiedAt now); false = clear the verification.',
          },
          inject: {
            type: 'boolean',
            description: 'v3.23: false = searchable but never injected (facts/history); true = restore injection.',
          },
          supersede: {
            type: 'boolean',
            description: 'true keeps history: create a new entry with the new text and mark the old one superseded (not injected anymore).',
          },
        },
        required: ['id', 'text'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { entry: entrySchema, usedChars: { type: 'integer' }, superseded: { type: 'string' } },
          required: ['entry', 'usedChars'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [text(`已更新 ${value?.entry?.id}：\n${value?.entry?.text ?? ''}\n（占用 ${value?.usedChars ?? 0} 字符）`)]
        },
      },
      async execute(args) {
        requireWritable()
        refreshBeforeWrite()
        const id = typeof args?.id === 'string' ? args.id.trim() : ''
        const next = typeof args?.text === 'string' ? args.text.trim() : ''
        if (id === '') throw fail('MEMORY_ARG_MISSING', 'memory_update 需要 id。')
        if (next === '') throw fail('MEMORY_ARG_MISSING', 'memory_update 需要新的 text；要删除请用 memory_remove。')
        if (next.length > MAX_TEXT_CHARS) throw fail('MEMORY_TEXT_TOO_LONG', `单条记忆最多 ${MAX_TEXT_CHARS} 字符，当前 ${next.length}。${TEXT_TOO_LONG_HINT}`)
        const entry = state.entries.find((item) => item.id === id)
        if (!entry) throw fail('MEMORY_ID_NOT_FOUND', `没有这条记忆：${id}。先用 memory_list 查看。`)
        const projected = usedChars() - entry.text.length + next.length
        if (projected > maxBytes) {
          throw fail('MEMORY_BUDGET_EXCEEDED', `更新后会到 ${projected} / ${maxBytes} 字符，超预算。请精简或先删掉别的条目。`)
        }
        if (args?.supersede === true) {
          // 时序失效（Graphiti 式）：新条目生效，旧条目留档不删、不再注入。
          const now = new Date().toISOString()
          const replacement = normalizeEntry({
            id: `m${state.nextId}`,
            text: next,
            ...(entry.tag ? { tag: entry.tag } : {}),
            ...(Array.isArray(entry.tags) ? { tags: entry.tags } : {}),
            ...(typeof entry.scope === 'string' ? { scope: entry.scope } : {}),
            ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}),
            ...(Array.isArray(entry.paths) ? { paths: entry.paths } : {}),
            ...(Array.isArray(entry.workspaces) ? { workspaces: entry.workspaces } : {}),
            ...(entry.pinned ? { pinned: true } : {}),
            ...(typeof entry.migratedFrom === 'string' ? { migratedFrom: entry.migratedFrom } : {}),
            ...(Array.isArray(entry.sources) ? { sources: entry.sources } : {}),
            ...(Array.isArray(entry.entities) ? { entities: entry.entities } : {}),
            ...(Array.isArray(entry.aliases) ? { aliases: entry.aliases } : {}),
            // v3.9：原来只抄了 tag/tags/scope/kind/paths/workspaces/pinned/sources/aliases，
            // importance 和 staleAfter 被丢掉 —— supersede 一次，重要度从 10 掉到按 kind 推导的 4（B05）。
            ...(Number.isFinite(entry.importance) ? { importance: entry.importance } : {}),
            ...(typeof entry.staleAfter === 'string' ? { staleAfter: entry.staleAfter } : {}),
            ...(typeof entry.validFrom === 'string' ? { validFrom: entry.validFrom } : {}),
            addedAt: now,
            updatedAt: now,
          })
          state.nextId += 1
          entry.supersededBy = replacement.id
          entry.status = 'deprecated'
          entry.updatedAt = now
          state.entries.push(replacement)
          persist()
          return { entry: publicEntry(replacement), usedChars: usedChars(), superseded: entry.id }
        }
        entry.text = next
        if (typeof args?.tag === 'string' && args.tag.trim() !== '') entry.tag = args.tag.trim()
        if (Array.isArray(args?.tags)) {
          const tags = args.tags.filter((tag) => typeof tag === 'string' && tag !== '')
          if (tags.length > 0) entry.tags = tags
          else delete entry.tags
        }
        if (Array.isArray(args?.aliases)) {
          const aliases = args.aliases.map((alias) => (typeof alias === 'string' ? alias.trim() : '')).filter((alias) => alias !== '')
          if (aliases.length > 0) entry.aliases = aliases
          else delete entry.aliases
        }
        if (typeof args?.scope === 'string' && args.scope.trim() !== '') entry.scope = normalizeScope(args.scope)
        if (typeof args?.kind === 'string' && args.kind.trim() !== '') entry.kind = args.kind.trim()
        if (Array.isArray(args?.workspaces)) {
          const workspaces = args.workspaces.filter((item) => typeof item === 'string' && item.trim() !== '')
          if (workspaces.length > 0) entry.workspaces = workspaces
          else delete entry.workspaces
        }
        if (Number.isFinite(args?.importance)) entry.importance = Math.max(1, Math.min(10, Math.round(args.importance)))
        if (typeof args?.status === 'string' && !MEMORY_STATUS.has(args.status)) {
          throw fail('MEMORY_ARG_INVALID', 'status 只能是 draft | stable | deprecated，收到：' + String(args.status))
        }
        if (typeof args?.staleAfter === 'string' && args.staleAfter !== '' && !DATE_ONLY.test(args.staleAfter)) {
          throw fail('MEMORY_DATE_INVALID', 'staleAfter 需要 YYYY-MM-DD（空串表示清除）。')
        }
        applyEntryFlags(entry, args)
        if (typeof args?.status === 'string') entry.status = args.status
        if (typeof args?.staleAfter === 'string') {
          if (args.staleAfter === '') delete entry.staleAfter
          else entry.staleAfter = args.staleAfter
        }
        if (Array.isArray(args?.sources)) {
          const sources = cleanSources(args.sources)
          if (sources.length > 0) entry.sources = sources
          else delete entry.sources
        }
        // v4.0：实体标签与失效时刻（两条都是「今天不存、将来补不回来」的信息）。
        if (Array.isArray(args?.entities)) {
          const entities = cleanEntities(args.entities)
          if (entities.length > 0) entry.entities = entities
          else delete entry.entities
        }
        if (typeof args?.invalidAt === 'string') {
          if (args.invalidAt === '') delete entry.invalidAt
          else {
            const rawInvalid = args.invalidAt.trim()
            if (!DATE_ONLY.test(rawInvalid) && Number.isNaN(Date.parse(rawInvalid))) {
              throw fail('MEMORY_DATE_INVALID', 'invalidAt 需要 YYYY-MM-DD 或 ISO 时间（空串表示清除）。')
            }
            entry.invalidAt = rawInvalid
          }
        }
        if (args?.verified === true) {
          entry.verifiedBy = 'agent'
          entry.verifiedAt = new Date().toISOString()
          // v3.9：提示文案说「复核后用 verified:true 清除 ⏰」，但原来只加 ✓、不清 staleAfter，
          // 于是一条记忆同时挂「⏰待重验 ✓已验证」，按提示操作也清不掉（B13）。
          const refreshed = deriveStaleAfter(typeof entry.kind === 'string' ? entry.kind : '')
          if (refreshed !== '') entry.staleAfter = refreshed
          else delete entry.staleAfter
        } else if (args?.verified === false) {
          delete entry.verifiedBy
          delete entry.verifiedAt
        }
        entry.updatedAt = new Date().toISOString()
        persist()
        return { entry: publicEntry(entry), usedChars: usedChars() }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'memory_remove',
      description: 'Delete one memory entry by id. Use it to prune stale or wrong facts.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Entry id from memory_list.' } },
        required: ['id'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { id: { type: 'string' }, removed: { type: 'boolean' }, total: { type: 'integer' } },
          required: ['id', 'removed', 'total'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [
            text(
              value?.removed
                ? `已删除 ${value?.id}（剩余 ${value?.total ?? 0} 条，下一条模型请求起生效）`
                : `没有这条记忆：${value?.id}`,
            ),
          ]
        },
      },
      async execute(args) {
        requireWritable()
        refreshBeforeWrite()
        const id = typeof args?.id === 'string' ? args.id.trim() : ''
        if (id === '') throw fail('MEMORY_ARG_MISSING', 'memory_remove 需要 id。')
        const before = state.entries.length
        state.entries = state.entries.filter((entry) => entry.id !== id)
        const removed = state.entries.length !== before
        if (removed) persist()
        return { id, removed, total: state.entries.length }
      },
    }),
  )

  // v3.20：归档可逆 —— 被预算保护挤掉的条目（deprecated、未被取代）可以恢复成生效记忆。
  // 被 superseded 的不许直接恢复（会同时存在两个版本），提示用 memory_add 重写。
  ctx.effect(() =>
    tools.register({
      name: 'memory_restore',
      description:
        'Restore one archived entry back to active (only entries archived by budget protection, i.e. deprecated but NOT superseded). Fails when the budget is full. Use memory_list({includeArchived:true}) to find ids.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Archived entry id, e.g. "m105".' } },
        required: ['id'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            restored: { type: 'boolean' },
            reason: { type: 'string' },
            usedChars: { type: 'integer' },
            total: { type: 'integer' },
          },
          required: ['id', 'restored', 'usedChars', 'total'],
          additionalProperties: false,
        },
        render(_args, value) {
          if (value?.restored) return [text(`已恢复 ${value?.id}（占用 ${value?.usedChars ?? 0} 字符，下一条模型请求起重新注入）`)]
          if (value?.reason === 'not-archived') return [text(`${value?.id} 本来就是生效记忆，不用恢复`)]
          return [text(`没有这条记忆：${value?.id}`)]
        },
      },
      async execute(args) {
        requireWritable()
        refreshBeforeWrite()
        const id = typeof args?.id === 'string' ? args.id.trim() : ''
        if (id === '') throw fail('MEMORY_ARG_MISSING', 'memory_restore 需要 id。')
        const entry = state.entries.find((item) => item.id === id)
        if (!entry) {
          return { id, restored: false, reason: 'missing', usedChars: usedChars(), total: state.entries.length }
        }
        if (!isArchivedEntry(entry)) {
          return { id, restored: false, reason: 'not-archived', usedChars: usedChars(), total: state.entries.length }
        }
        if (typeof entry.supersededBy === 'string' && entry.supersededBy !== '') {
          throw fail('MEMORY_SUPERSEDED', `${id} 已被 ${entry.supersededBy} 取代，不能直接恢复（会同时存在两个版本）。要保留内容请用 memory_add 重写一条。`)
        }
        if (usedChars() + entry.text.length > maxBytes) {
          throw fail('MEMORY_BUDGET_EXCEEDED', 
            `恢复后会到 ${usedChars() + entry.text.length} / ${maxBytes} 字符，超预算。先用 memory_remove 删掉别的，或调大 maxBytes。`,
          )
        }
        delete entry.status
        delete entry.archivedAt
        delete entry.archiveReason
        entry.updatedAt = new Date().toISOString()
        persist()
        return { id, restored: true, usedChars: usedChars(), total: state.entries.length }
      },
    }),
  )

  // v3.21：历史查询（只读）。数据来自 persist 时按基线 diff 出来的 history.jsonl，一条事件一行。
  ctx.effect(() =>
    tools.register({
      name: 'memory_history',
      description:
        'Read the append-only change log (history.jsonl): add / update / remove events with timestamps and truncated text. Use it to answer "what was deleted/changed and when".',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Only events about this memory id, e.g. "m95".' },
          event: { type: 'string', description: 'Only this event type: add | update | remove.' },
          limit: { type: 'integer', description: 'Max events to return (1-100, default 20, newest last).' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            total: { type: 'integer' },
            matched: { type: 'integer' },
            entries: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  ts: { type: 'string' },
                  event: { type: 'string' },
                  id: { type: 'string' },
                  text: { type: 'string' },
                  before: { type: 'string' },
                  after: { type: 'string' },
                  status: { type: 'string' },
                },
                required: ['ts', 'event', 'id'],
                additionalProperties: false,
              },
            },
          },
          required: ['total', 'matched', 'entries'],
          additionalProperties: false,
        },
        render(_args, value) {
          const lines = (value?.entries ?? []).map((item) => {
            const delta = item.event === 'update' ? ` 「${item.before ?? ''}」→「${item.after ?? ''}」` : item.text ? ` 「${item.text}」` : ''
            return `- ${item.ts} ${item.event} ${item.id}${delta}`
          })
          const head = `变更历史：${value?.total ?? 0} 条事件 / 命中 ${value?.matched ?? 0} 条（最多显示 ${value?.entries?.length ?? 0} 条）`
          return [text([head, ...lines].join('\n'))]
        },
      },
      async execute(args) {
        const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 100) : 20
        const wantId = typeof args?.id === 'string' ? args.id.trim() : ''
        const wantEvent = typeof args?.event === 'string' ? args.event.trim() : ''
        let raw = ''
        try {
          raw = readFileSync(historyFile, 'utf8')
        } catch (error) {
          return { total: 0, matched: 0, entries: [] }
        }
        const all = []
        for (const line of raw.split('\n')) {
          if (line.trim() === '') continue
          try {
            const item = JSON.parse(line)
            if (item && typeof item.ts === 'string' && typeof item.event === 'string' && typeof item.id === 'string') all.push(item)
          } catch (error) {
            // 坏行跳过：历史是旁路，不因为一行坏了整份不可读
          }
        }
        const matched = all.filter((item) => (wantId === '' || item.id === wantId) && (wantEvent === '' || item.event === wantEvent))
        return { total: all.length, matched: matched.length, entries: matched.slice(-limit) }
      },
    }),
  )

  // v3.21：批量清归档（物理删，必须 confirm）。补上「手工一条条删 48 次」缺的受控入口。
  ctx.effect(() =>
    tools.register({
      name: 'memory_purge',
      description:
        'Permanently delete archived entries (superseded/deprecated). Requires confirm:true. Refuses to touch active memories. Filter with ids or olderThanDays. Prefer memory_list({includeArchived:true}) first.',
      parameters: {
        type: 'object',
        properties: {
          confirm: { type: 'boolean', description: 'Must be true — this is a permanent delete, not an archive.' },
          ids: { type: 'array', items: { type: 'string' }, description: 'Only these archived ids (default: all archived entries).' },
          olderThanDays: { type: 'integer', description: 'Only archived entries whose archivedAt/updatedAt is older than N days.' },
        },
        required: ['confirm'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            purged: { type: 'integer' },
            remaining: { type: 'integer' },
            usedChars: { type: 'integer' },
            ids: { type: 'array', items: { type: 'string' } },
            reason: { type: 'string' },
          },
          required: ['purged', 'remaining', 'usedChars', 'ids'],
          additionalProperties: false,
        },
        render(_args, value) {
          if (value?.reason === 'no-archived') return [text('没有归档条目可删（memory_list 默认也不列它们）。')]
          const ids = value?.ids ?? []
          const preview = ids.slice(0, 10).join(', ') + (ids.length > 10 ? ` …共 ${ids.length} 条` : '')
          return [text(`已永久删除 ${value?.purged ?? 0} 条归档（${preview}），剩余 ${value?.remaining ?? 0} 条记忆，占用 ${value?.usedChars ?? 0} 字符。`)]
        },
      },
      async execute(args) {
        requireWritable()
        refreshBeforeWrite()
        const wantIds = Array.isArray(args?.ids) ? args.ids.filter((item) => typeof item === 'string' && item.trim() !== '') : []
        const olderThanDays = Number.isInteger(args?.olderThanDays) && args.olderThanDays > 0 ? args.olderThanDays : 0
        const nowMs = Date.now()
        const targets = state.entries.filter((entry) => {
          if (!isArchivedEntry(entry)) return false
          if (wantIds.length > 0 && !wantIds.includes(entry.id)) return false
          if (olderThanDays > 0) {
            const stamp = Date.parse(entry.archivedAt ?? entry.updatedAt ?? '')
            if (!Number.isFinite(stamp) || nowMs - stamp < olderThanDays * 86400000) return false
          }
          return true
        })
        if (targets.length === 0) {
          return { purged: 0, remaining: state.entries.length, usedChars: usedChars(), ids: [], reason: 'no-archived' }
        }
        if (args?.confirm !== true) {
          throw fail('MEMORY_CONFIRM_REQUIRED', 
            `memory_purge 会**永久删除** ${targets.length} 条归档条目（不是归档，删了不可恢复）。确认后用 ${targets.length} 条 id 或 confirm:true 重试；先 memory_list({includeArchived:true}) 看一眼。`,
          )
        }
        const removedIds = targets.map((entry) => entry.id)
        const removedSet = new Set(removedIds)
        state.entries = state.entries.filter((entry) => !removedSet.has(entry.id))
        persist()
        return { purged: removedIds.length, remaining: state.entries.length, usedChars: usedChars(), ids: removedIds.slice(0, 100) }
      },
    }),
  )

  // ---- 维护：合并（历史留档） + 审计（只读） ----
  ctx.effect(() =>
    tools.register({
      name: 'memory_merge',
      description:
        'Merge two or more active memories into one atomic entry. Originals are kept as superseded history and stop being injected.',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: 'At least two active entry ids.' },
          text: { type: 'string', description: 'Merged text; omit to join the originals with 「；」.' },
          tag: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          scope: { type: 'string' },
          kind: { type: 'string' },
          pinned: { type: 'boolean' },
        },
        required: ['ids'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            entry: entrySchema,
            merged: { type: 'array', items: { type: 'string' } },
            usedChars: { type: 'integer' },
          },
          required: ['entry', 'merged', 'usedChars'],
          additionalProperties: false,
        },
        render(_args, value) {
          const entry = value?.entry
          return [text(`已合并 ${(value?.merged ?? []).join(', ')} → ${entry?.id}\n${entry?.text ?? ''}\n（占用 ${value?.usedChars ?? 0} 字符，旧条目留档不再注入）`)]
        },
      },
      async execute(args) {
        requireWritable()
        refreshBeforeWrite()
        // v3.9：先把重复 id 去掉再判「至少两个」。原来 [m1, m1] 能通过校验，把同一条合并两次（B16）。
        const ids = [...new Set(Array.isArray(args?.ids) ? args.ids.filter((id) => typeof id === 'string' && id !== '') : [])]
        if (ids.length < 2) throw fail('MEMORY_ARG_INVALID', 'memory_merge 需要至少两个不同的 id。')
        const sources = ids.map((id) => state.entries.find((item) => item.id === id && isActive(item)))
        if (sources.some((entry) => entry === undefined)) throw fail('MEMORY_ID_NOT_FOUND', '有 id 不存在或已失效，先用 memory_list 确认。')
        const first = sources[0]
        const mergedText =
          typeof args?.text === 'string' && args.text.trim() !== ''
            ? args.text.trim()
            : sources.map((entry) => entry.text.trim()).join('；')
        if (mergedText.length > MAX_TEXT_CHARS) {
          throw fail('MEMORY_TEXT_TOO_LONG', `合并后最多 ${MAX_TEXT_CHARS} 字符（当前 ${mergedText.length}）。${TEXT_TOO_LONG_HINT}`)
        }
        const freed = sources.reduce((sum, entry) => sum + entry.text.length, 0)
        if (usedChars() - freed + mergedText.length > maxBytes) {
          throw fail('MEMORY_BUDGET_EXCEEDED', `合并后超预算（上限 ${maxBytes} 字符）。请先精简或删掉别的条目。`)
        }
        const now = new Date().toISOString()
        // 别名继承：合并时把各来源的别名并起来，否则每合并一次「桥」就淡一次（v3.6 发现的稀疏化根因）。
        const unionAliases = cleanAliases(sources.flatMap((item) => (Array.isArray(item.aliases) ? item.aliases : [])))
        // v3.9：workspaces / paths / tags / sources 也必须继承。原来只抄 first，项目私有规则一合并就变全局注入（B06）。
        const unionOf = (field) => [...new Set(sources.flatMap((item) => (Array.isArray(item[field]) ? item[field] : [])))]
        const unionWorkspaces = unionOf('workspaces')
        const unionPaths = unionOf('paths')
        const unionSources = unionOf('sources')
        const unionTags = Array.isArray(args?.tags) ? [...new Set([...unionOf('tags'), ...args.tags])] : unionOf('tags')
        // scope 只在来源一致时继承；不一致时不擅自放大成 global。
        const scopeValues = [...new Set(sources.map((item) => (typeof item.scope === 'string' ? item.scope.trim() : '')).filter((value) => value !== ''))]
        const inheritedScope =
          typeof args?.scope === 'string' && args.scope.trim() !== ''
            ? args.scope.trim()
            : scopeValues.length === 1
              ? scopeValues[0]
              : ''
        // 重要度取最大；过期日取最早（更保守的那一个）。
        const importanceValues = sources.map((item) => item.importance).filter((value) => Number.isFinite(value))
        const staleValues = sources.map((item) => item.staleAfter).filter((value) => typeof value === 'string' && DATE_ONLY.test(value)).sort()
        const merged = normalizeEntry({
          id: `m${state.nextId}`,
          text: mergedText,
          ...(unionAliases.length > 0 ? { aliases: unionAliases } : {}),
          ...(typeof args?.tag === 'string' && args.tag.trim() !== '' ? { tag: args.tag.trim() } : first.tag ? { tag: first.tag } : {}),
          ...(unionTags.length > 0 ? { tags: unionTags } : {}),
          ...(inheritedScope !== '' ? { scope: inheritedScope } : {}),
          ...(typeof args?.kind === 'string' && args.kind.trim() !== '' ? { kind: args.kind.trim() } : typeof first.kind === 'string' ? { kind: first.kind } : {}),
          ...(unionWorkspaces.length > 0 ? { workspaces: unionWorkspaces } : {}),
          ...(unionPaths.length > 0 ? { paths: unionPaths } : {}),
          ...(unionSources.length > 0 ? { sources: unionSources } : {}),
          ...(importanceValues.length > 0 ? { importance: Math.max(...importanceValues) } : {}),
          ...(staleValues.length > 0 ? { staleAfter: staleValues[0] } : {}),
          ...(args?.pinned === true || first.pinned === true ? { pinned: true } : {}),
          addedAt: now,
          updatedAt: now,
        })
        state.nextId += 1
        for (const source of sources) {
          source.supersededBy = merged.id
          source.updatedAt = now
        }
        state.entries.push(merged)
        persist()
        return { entry: publicEntry(merged), merged: ids, usedChars: usedChars() }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'memory_audit',
      description:
        'Read-only audit of the memory store: duplicate candidates, stale never-used entries, usage stats, scope distribution and budget. Use it before pruning.',
      parameters: {
        type: 'object',
        properties: {
          similarity: { type: 'number', description: 'Duplicate threshold 0-1 (default 0.6).' },
          staleDays: { type: 'integer', description: 'Stale = never used and untouched for N days (default 30).' },
          limit: { type: 'integer', description: 'Max rows per list (1-20, default 8).' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            total: { type: 'integer' },
            active: { type: 'integer' },
            archived: { type: 'integer' },
            superseded: { type: 'integer' },
            draft: { type: 'integer' },
            recheck: { type: 'integer' },
            byScope: {
              type: 'array',
              items: {
                type: 'object',
                properties: { scope: { type: 'string' }, count: { type: 'integer' } },
                required: ['scope', 'count'],
                additionalProperties: false,
              },
            },
            duplicates: {
              type: 'array',
              items: {
                type: 'object',
                properties: { ids: { type: 'array', items: { type: 'string' } }, similarity: { type: 'number' } },
                required: ['ids', 'similarity'],
                additionalProperties: false,
              },
            },
            stale: {
              type: 'array',
              items: {
                type: 'object',
                properties: { id: { type: 'string' }, days: { type: 'integer' }, scope: { type: 'string' } },
                required: ['id', 'days'],
                additionalProperties: false,
              },
            },
            mostUsed: {
              type: 'array',
              items: {
                type: 'object',
                properties: { id: { type: 'string' }, usedCount: { type: 'integer' } },
                required: ['id', 'usedCount'],
                additionalProperties: false,
              },
            },
            budget: {
              type: 'object',
              properties: {
                usedChars: { type: 'integer' },
                maxBytes: { type: 'integer' },
                injectedChars: { type: 'integer' },
              },
              required: ['usedChars', 'maxBytes', 'injectedChars'],
              additionalProperties: false,
            },
            aliases: {
              type: 'object',
              properties: {
                withAliases: { type: 'integer' },
                missing: { type: 'integer' },
                missingIds: { type: 'array', items: { type: 'string' } },
              },
              required: ['withAliases', 'missing', 'missingIds'],
              additionalProperties: false,
            },
            // v4.0（考虑以后）：触发线指标。升级动作靠数据触发，不靠感觉。
            growth: {
              type: 'object',
              properties: {
                entries: { type: 'integer' },
                avgChars: { type: 'integer' },
                injectRatio: { type: 'number' },
                entitiesCovered: { type: 'integer' },
                sourcesCovered: { type: 'integer' },
                invalid: { type: 'integer' },
                stage: { type: 'string' },
                nextTrigger: { type: 'string' },
              },
              required: ['entries', 'avgChars', 'injectRatio', 'entitiesCovered', 'sourcesCovered', 'invalid', 'stage', 'nextTrigger'],
              additionalProperties: false,
            },
            schemaVersion: { type: 'integer' },
          },
          required: ['total', 'active', 'superseded', 'archived', 'draft', 'recheck', 'byScope', 'aliases', 'duplicates', 'stale', 'mostUsed', 'budget', 'growth', 'schemaVersion'],
          additionalProperties: false,
        },
        render(_args, value) {
          const duplicates = Array.isArray(value?.duplicates) ? value.duplicates : []
          const stale = Array.isArray(value?.stale) ? value.stale : []
          const mostUsed = Array.isArray(value?.mostUsed) ? value.mostUsed : []
          const byScope = Array.isArray(value?.byScope) ? value.byScope : []
          const lines = [
            `记忆审计：${value?.total ?? 0} 条（生效 ${value?.active ?? 0} / 失效 ${value?.superseded ?? 0}），占用 ${value?.budget?.usedChars ?? 0}/${value?.budget?.maxBytes ?? 0} 字符，本轮注入 ${value?.budget?.injectedChars ?? 0}`,
            `scope 分布：${byScope.map((item) => `${item.scope} ${item.count}`).join(' / ') || '（空）'}`,
            `重复候选 ${duplicates.length} 组：${duplicates.map((item) => `${item.ids.join('~')}(${item.similarity})`).join(' ') || '无'}`,
            `过期候选 ${stale.length} 条：${stale.map((item) => `${item.id}(${item.days}天)`).join(' ') || '无'}`,
            `信任状态：未证实 ${value?.draft ?? 0} 条 / 过期待重验 ${value?.recheck ?? 0} 条`,
            `别名覆盖：${value?.aliases?.withAliases ?? 0} 条有 / ${value?.aliases?.missing ?? 0} 条缺${(value?.aliases?.missingIds ?? []).length > 0 ? ' —— ' + value.aliases.missingIds.join(' ') : ''}（缺别名的条目在换皮问法下召回不到，用 memory_update 补）`,
            `（未证实条目在注入时带 ❓，过期待重验带 ⏰；复核后用 memory_update verified:true 清除标记）`,
            `最常用：${mostUsed.map((item) => `${item.id}×${item.usedCount}`).join(' ') || '（还没有使用记录）'}`,
            (() => {
              const growth = value?.growth
              if (!growth) return ''
              return `规模 ${growth.entries} 条 / 平均 ${growth.avgChars} 字 / 注入占比 ${Math.round((growth.injectRatio ?? 0) * 100)}% / 实体覆盖 ${growth.entitiesCovered} 条 / 来源覆盖 ${growth.sourcesCovered} 条 / 已失效 ${growth.invalid} 条 ⇒ 阶段 ${growth.stage}；下一条触发线：${growth.nextTrigger}`
            })(),
          ]
          return [text(lines.join('\n'))]
        },
      },
      async execute(args) {
        const threshold = typeof args?.similarity === 'number' && args.similarity > 0 && args.similarity <= 1 ? args.similarity : 0.6
        const staleDays = Number.isInteger(args?.staleDays) && args.staleDays > 0 ? args.staleDays : 30
        const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 20) : 8
        const active = activeEntries()
        const bigrams = (value) => {
          const set = new Set()
          const clean = String(value).toLowerCase()
          for (const run of clean.match(/[\u4e00-\u9fff]+/g) ?? []) {
            for (let index = 0; index + 2 <= run.length; index += 1) set.add(run.slice(index, index + 2))
          }
          for (const word of clean.match(/[a-z0-9][a-z0-9_\-.]{2,}/g) ?? []) set.add(word)
          return set
        }
        const shapes = active.map((entry) => ({ entry, grams: bigrams(entry.text) }))
        const duplicates = []
        for (let i = 0; i < shapes.length; i += 1) {
          for (let j = i + 1; j < shapes.length; j += 1) {
            let shared = 0
            for (const gram of shapes[i].grams) if (shapes[j].grams.has(gram)) shared += 1
            const union = shapes[i].grams.size + shapes[j].grams.size - shared
            const similarity = union === 0 ? 0 : shared / union
            if (similarity >= threshold) {
              duplicates.push({ ids: [shapes[i].entry.id, shapes[j].entry.id], similarity: Math.round(similarity * 100) / 100 })
            }
          }
        }
        duplicates.sort((a, b) => b.similarity - a.similarity)
        const nowMs = Date.now()
        const stale = active
          .filter((entry) => entry.pinned !== true && (entry.usedCount ?? 0) === 0)
          .map((entry) => ({
            id: entry.id,
            days: Math.max(0, Math.floor((nowMs - Date.parse(String(entry.updatedAt))) / 86400000)),
            ...(typeof entry.scope === 'string' ? { scope: entry.scope } : {}),
          }))
          .filter((item) => Number.isFinite(item.days) && item.days >= staleDays)
          .sort((a, b) => b.days - a.days)
        const scopeCounts = new Map()
        for (const entry of active) {
          const key = typeof entry.scope === 'string' && entry.scope !== '' ? entry.scope : 'unscoped'
          scopeCounts.set(key, (scopeCounts.get(key) ?? 0) + 1)
        }
        const byScope = [...scopeCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([scope, count]) => ({ scope, count }))
        const mostUsed = active
          .filter((entry) => (entry.usedCount ?? 0) > 0)
          .sort((a, b) => (b.usedCount ?? 0) - (a.usedCount ?? 0))
          .slice(0, limit)
          .map((entry) => ({ id: entry.id, usedCount: entry.usedCount ?? 0 }))
        return {
          total: state.entries.length,
          active: active.length,
          superseded: state.entries.filter(
            (entry) => typeof entry.supersededBy === 'string' && entry.supersededBy !== '',
          ).length,
          archived: state.entries.length - active.length,
          draft: active.filter((entry) => entry.status === 'draft').length,
          recheck: active.filter(
            (entry) => typeof entry.staleAfter === 'string' && entry.staleAfter < localDateOf(),
          ).length,
          byScope,
          // v3.7：别名缺口要可见。索引层排序/检索都在用别名，没别名 = 换皮问法召回不到，
          // 但不能因此拒绝写入（会把正常记忆写入卡死），所以只统计 + 在 memory_add 返回候选。
          aliases: (() => {
            const withAliases = active.filter((entry) => Array.isArray(entry.aliases) && entry.aliases.length > 0)
            const missing = active.filter((entry) => !(Array.isArray(entry.aliases) && entry.aliases.length > 0))
            return {
              withAliases: withAliases.length,
              missing: missing.length,
              missingIds: missing.slice(0, limit).map((entry) => entry.id),
            }
          })(),
          duplicates: duplicates.slice(0, limit),
          stale: stale.slice(0, limit),
          mostUsed,
          budget: { usedChars: usedChars(), maxBytes, injectedChars: renderOnce('', undefined, undefined, lastKnownCwd).length },
          // v4.0：规模判据（E 报告的 <300 / 300–3000 / >3000 三段）+ 触发线文案。
          growth: (() => {
            const entries = state.entries.length
            const avgChars = entries === 0 ? 0 : Math.round(usedChars() / entries)
            const injected = renderOnce('', undefined, undefined, lastKnownCwd).length
            const stage = entries > 3000 ? 'entity-layer' : entries > 1000 ? 'tiered-inject' : entries > 300 ? 'hybrid-search' : 'flat'
            const nextTrigger =
              entries <= 300
                ? '>300 条 → 上混合检索（语义/时间信号）'
                : entries <= 1000
                  ? '>1000 条 → 注入改三层（核心/近期/索引）'
                  : entries <= 3000
                    ? '>3000 条 → 评估实体层（以 entities 为锚）'
                    : '已过 3000 条：按 §4.5 触发线升级存储与检索'
            return {
              entries,
              avgChars,
              injectRatio: Math.round((injected / Math.max(1, maxInjectChars)) * 1000) / 1000,
              entitiesCovered: active.filter((entry) => Array.isArray(entry.entities) && entry.entities.length > 0).length,
              sourcesCovered: active.filter((entry) => Array.isArray(entry.sources) && entry.sources.length > 0).length,
              invalid: state.entries.filter((entry) => typeof entry.invalidAt === 'string' && entry.invalidAt !== '').length,
              stage,
              nextTrigger,
            }
          })(),
          schemaVersion: Number.isInteger(state.version) && state.version > 0 ? state.version : SCHEMA_VERSION,
        }
      },
    }),
  )

  // ---- 自动沉淀（影子模式）：回合结束时按规则抓候选，只写候选池，不直接入库 ----
      // ---- v2.8 记忆概览：给人看的视图，不是给模型看的 ----
  // 依据：OpenAI 2026 记忆升级的核心不是模型更聪明，而是把条目摊给用户审（「记忆概览页面」），
  // 其内部数据显示「跨时间准确性」仍是最弱一环。memory_audit 是给模型的，缺的是人能一眼扫完的视图。
  const buildReview = () => {
    const today = localDateOf()
    const entries = activeEntries()
    const overdue = entries.filter((entry) => typeof entry.staleAfter === 'string' && DATE_ONLY.test(entry.staleAfter) && entry.staleAfter < today)
    const unverified = entries.filter((entry) => entry.status === 'draft')
    const pinned = entries.filter((entry) => entry.pinned)
    const unused = entries.filter((entry) => entry.pinned !== true && (entry.usedCount ?? 0) === 0)
    const consolidate = entries.filter((entry) => entry.pinned !== true && (entry.usedCount ?? 0) >= CONSOLIDATE_MIN_USES)
    const decaying = entries.filter((entry) => effectiveImportance(entry) < importanceOf(entry) * 0.95)
    const scopeCount = new Map()
    for (const entry of entries) {
      const key = typeof entry.scope === 'string' && entry.scope !== '' ? entry.scope : '（未设）'
      scopeCount.set(key, (scopeCount.get(key) ?? 0) + 1)
    }
    const brief = (entry) => {
      const flat = String(entry.text ?? '').replace(/\s+/g, ' ').trim()
      return flat.length > 60 ? flat.slice(0, 60) + '…' : flat
    }
    const section = (title, list, hint) => [
      '## ' + title + '（' + list.length + ' 条）' + (hint ? ' —— ' + hint : ''),
      ...(list.length === 0
        ? ['（无）']
        : list.map((entry) => '- ' + entry.id + (entry.scope ? ' <' + entry.scope + '>' : '') + ' ' + brief(entry))),
      '',
    ]
    const block = renderOnce('', undefined, undefined, lastKnownCwd)
    const overBudget = block.length > maxInjectChars
    const md = [
      '# 记忆概览',
      '',
      '生成于 ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' · ' + entries.length + ' 条 · 正文 ' + usedChars() + '/' + maxBytes + ' 字符 · 本轮注入 ' + block.length + '/' + maxInjectChars + (overBudget ? '（超 ' + (block.length - maxInjectChars) + '）' : ''),
      '',
      ...section('⏰ 已过期待重验', overdue, 'memory_update 重验，或 supersede 推倒'),
      ...section('❓ 未证实', unverified, 'memory_update 加 verified:true 确认'),
      ...section('🕸 从未被引用', unused, '考虑 memory_remove 或 memory_merge'),
      ...section('📌 硬规则', pinned, '永远全文注入，改动需谨慎'),
      ...section('⭐ 该升级', consolidate, '被引用 ≥3 次：考虑 memory_update pinned:true 或调高 importance'),
      ...section('📉 衰减中', decaying, '长期未被引用，注入优先级已自动降低（存储值不变）'),
      '## 按 scope',
      ...[...scopeCount.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => '- ' + key + ' ' + count),
      '',
    ].join('\n')
    return { entries, overdue, unverified, unused, pinned, block, overBudget, md }
  }

  ctx.effect(() =>
    tools.register({
      name: 'memory_review',
      description: 'Human-readable review of the memory store (overdue / unverified / never-used / hard rules) written to review-latest.md. Use it when the user asks to clean up or audit memory.',
      parameters: {
        type: 'object',
        properties: {
          write: { type: 'boolean', description: 'Write review-latest.md into the memory directory (default true).' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            written: { type: 'boolean' },
            counts: {
              type: 'object',
              properties: {
                total: { type: 'integer' },
                overdue: { type: 'integer' },
                unverified: { type: 'integer' },
                unused: { type: 'integer' },
                pinned: { type: 'integer' },
              },
              required: ['total', 'overdue', 'unverified', 'unused', 'pinned'],
              additionalProperties: false,
            },
            markdown: { type: 'string' },
          },
          required: ['file', 'written', 'counts', 'markdown'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [text(String(value?.markdown ?? '') + '\n（已写入 ' + String(value?.file ?? '') + '：' + (value?.written ? '是' : '否') + '）')]
        },
      },
      async execute(args) {
        const review = buildReview()
        const file = path.join(storeDir, 'review-latest.md')
        let written = false
        if (args?.write !== false && storeHealth === 'ok') {
          try {
            writeFileSync(file, review.md, 'utf8')
            written = true
          } catch (error) {
            written = false
          }
        }
        return {
          file,
          written,
          counts: {
            total: review.entries.length,
            overdue: review.overdue.length,
            unverified: review.unverified.length,
            unused: review.unused.length,
            pinned: review.pinned.length,
          },
          markdown: review.md,
        }
      },
    }),
  )


  ctx.effect(() =>
    ctx.on('agent/turn-stopping', async (payload) => {
      if (!captureCandidates) return
      try {
        const agent = payload?.agent
        const session = agent?.session
        if (session === undefined || typeof session.deriveMessages !== 'function') return
        const messages = session.deriveMessages()
        const lastUser = [...messages]
          .reverse()
          .find((message) => message?.role === 'user' && Array.isArray(message.content))
        if (lastUser === undefined) return
        // v3.1/v3.27：DSH 会把 <memory> / <path-rules> / 技能目录 / 系统提醒等注入块并进 user 消息。
        // 不剥掉就会把「注入的规则」当「用户偏好」沉淀（实测抓出过记忆提示语与 core.md 规则）。
        const text = stripHarnessBlocks(
          lastUser.content
            .filter((part) => part?.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join(' '),
        )
        if (text === '') return
        const scope = currentScopeOf(payload)
        for (const candidate of extractCandidates(text)) {
          addCandidate(candidate.text, scope, candidate.kind, candidate.reason, agent?.id)
        }
        // v3.17：规则文件沉淀（补「写入覆盖」缺口 —— 今天两个实测失败都是「库里根本没记」）。
        // 只对还没进候选池、也不在记忆库里的硬规则行下手；每回合最多 MAX_CANDIDATES_PER_TURN 条。
        // 没有工作区上下文（测试 / 无 cwd 会话）时不扫规则文件 —— 否则会把全局 AGENTS.md 也灌进候选池。
        if (!captureRuleFiles) return
        try {
          if (lastKnownCwd === '') throw fail('MEMORY_CWD_UNAVAILABLE', 'no-cwd')
          const taken = new Set()
          for (const entry of state.entries) taken.add(entry.text)
          for (const item of candidates.items ?? []) taken.add(item.text)
          let added = 0
          for (const ruleFile of collectRuleFiles(lastKnownCwd)) {
            if (added >= MAX_CANDIDATES_PER_TURN) break
            const fileText = readFileSync(ruleFile, 'utf8')
            for (const candidate of extractRuleCandidates(fileText, taken)) {
              if (added >= MAX_CANDIDATES_PER_TURN) break
              // v3.18：高置信度候选（规则文件 + 硬规则）直接进库，其余仍进候选池等人审。
              const promoted = autoPromoteRule(candidate, scope)
              if (promoted === null) {
                addCandidate(candidate.text, scope, candidate.kind, candidate.reason, agent?.id)
              }
              taken.add(candidate.text)
              added += 1
            }
          }
        } catch (error) {
          // 规则沉淀失败不影响回合结束
        }
      } catch (error) {
        // 沉淀失败不影响回合结束
      }
    }),
  )

  // ---- v3.16 卡片导出：把记忆镜像成 Markdown（给 Obsidian / 任何编辑器看）----
  ctx.effect(() =>
    tools.register({
      name: 'memory_export',
      description:
        'Export every memory as an Obsidian-compatible Markdown card (YAML frontmatter + body) into a folder. The JSON store stays authoritative; this is a one-way mirror so a human can read and edit memories in Obsidian or any editor.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Target folder (absolute, or relative to the memory store). Defaults to <storeDir>/vault.' },
          includeArchived: { type: 'boolean', description: 'Also export superseded/archived entries. Default false.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            dir: { type: 'string' },
            written: { type: 'integer' },
            skipped: { type: 'integer' },
            // v4.0：round-trip 校验——导出物必须能被读回来，否则只是「看起来导出成功」。
            verified: { type: 'integer' },
            entries: {
              type: 'array',
              items: {
                type: 'object',
                properties: { id: { type: 'string' }, file: { type: 'string' } },
                required: ['id', 'file'],
                additionalProperties: false,
              },
            },
          },
          required: ['dir', 'written', 'skipped', 'verified', 'entries'],
          additionalProperties: false,
        },
        render(_args, value) {
          const list = Array.isArray(value?.entries) ? value.entries : []
          const lines = list.slice(0, 12).map((item) => '- ' + item.id + ' → ' + item.file)
          const more = list.length > 12 ? '\n… 另有 ' + (list.length - 12) + ' 个' : ''
          return [text('已导出 ' + (value?.written ?? 0) + ' 张卡片到 ' + (value?.dir ?? '') + '（跳过 ' + (value?.skipped ?? 0) + ' 条已失效；回读校验 ' + (value?.verified ?? 0) + '/5 通过）\n' + lines.join('\n') + more)]
        },
      },
      async execute(args) {
        const targetArg = typeof args?.dir === 'string' ? args.dir.trim() : ''
        const targetDir = path.resolve(targetArg !== '' ? targetArg : path.join(storeDir, 'vault'))
        mkdirSync(targetDir, { recursive: true })
        const includeArchived = args?.includeArchived === true
        const written = []
        let skipped = 0
        for (const entry of state.entries) {
          const archived = typeof entry.supersededBy === 'string' && entry.supersededBy !== ''
          if (archived && !includeArchived) {
            skipped += 1
            continue
          }
          const target = path.join(targetDir, entry.id + '-' + slugOf(entry.text) + '.md')
          writeFileSync(target, cardMarkdown(entry), 'utf8')
          written.push({ id: entry.id, file: target })
        }
        // v4.0：抽前 5 张卡回读，确认 frontmatter 里的 id 对得上（导出不可读 = 迁移时会丢）。
        let verified = 0
        for (const item of written.slice(0, 5)) {
          try {
            if (readFileSync(item.file, 'utf8').includes('id: ' + item.id + '\n')) verified += 1
          } catch (error) {
            // 读不回来就是校验失败，不抛错
          }
        }
        return { dir: targetDir, written: written.length, skipped, verified, entries: written.slice(0, 200) }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'memory_candidates',
      description:
        'Review rule-captured memory candidates (shadow mode, zero model calls): list pending, accept one into memory, reject one, or clear all pending.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'accept', 'reject', 'clear'], description: 'Default list.' },
          id: { type: 'string', description: 'Candidate id, e.g. c3 (required for accept/reject).' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            pending: { type: 'integer' },
            item: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                text: { type: 'string' },
                scope: { type: 'string' },
                kind: { type: 'string' },
                reason: { type: 'string' },
                createdAt: { type: 'string' },
              },
              required: ['id', 'text'],
              additionalProperties: false,
            },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  scope: { type: 'string' },
                  kind: { type: 'string' },
                  reason: { type: 'string' },
                  createdAt: { type: 'string' },
                },
                required: ['id', 'text'],
                additionalProperties: false,
              },
            },
          },
          required: ['action', 'pending'],
          additionalProperties: false,
        },
        render(_args, value) {
          const items = Array.isArray(value?.items) ? value.items : []
          if (value?.action === 'clear') return [text('已清空候选池。')]
          if (value?.item !== undefined) {
            const verb = value.action === 'accept' ? '已入库' : '已丢弃'
            return [text(`${verb}候选 ${value.item.id}：${value.item.text}\n（剩余待确认 ${value.pending} 条）`)]
          }
          if (items.length === 0) return [text('候选池为空（影子模式：回合结束时按规则抓「记住/以后/别再/一律」这类句子）。')]
          const lines = items.map((item) =>
            `- ${item.id}${item.scope ? ` <${item.scope}>` : ''} (${item.kind ?? 'fact'}) ${item.reason ?? ''} ${item.text}`,
          );
          return [text(`待确认候选 ${value?.pending ?? items.length} 条：\n${lines.join('\n')}`)]
        },
      },
      async execute(args) {
        requireWritable()
        refreshBeforeWrite()
        const action = typeof args?.action === 'string' ? args.action : 'list'
        const slim = (item) => ({
          id: item.id,
          text: item.text,
          ...(typeof item.scope === 'string' ? { scope: item.scope } : {}),
          ...(typeof item.kind === 'string' ? { kind: item.kind } : {}),
          ...(typeof item.reason === 'string' ? { reason: item.reason } : {}),
          ...(typeof item.createdAt === 'string' ? { createdAt: item.createdAt } : {}),
        })
        if (action === 'clear') {
          candidates.items = []
          persistCandidates()
          return { action, pending: 0 }
        }
        if (action === 'accept' || action === 'reject') {
          const id = typeof args?.id === 'string' ? args.id.trim() : ''
          const item = candidates.items.find((entry) => entry.id === id && entry.status === 'pending')
          if (item === undefined) throw fail('MEMORY_CANDIDATE_NOT_FOUND', `没有待确认的候选：${id}。先用 memory_candidates 查看。`)
          if (action === 'reject') {
            item.status = 'rejected'
            persistCandidates()
            return { action, pending: pendingCandidates().length, item: slim(item) }
          }
          if (usedChars() + item.text.length > maxBytes) {
            throw fail('MEMORY_BUDGET_EXCEEDED', `记忆已占用 ${usedChars()} / ${maxBytes} 字符，先清理过时条目再接受。`)
          }
          const now = new Date().toISOString()
          const entry = normalizeEntry({
            id: `m${state.nextId}`,
            text: item.text,
            ...(typeof item.scope === 'string' ? { scope: item.scope } : {}),
            ...(typeof item.kind === 'string' ? { kind: item.kind } : {}),
            tags: ['candidate'],
            addedAt: now,
            updatedAt: now,
          })
          state.nextId += 1
          state.entries.push(entry)
          item.status = 'accepted'
          persist()
          persistCandidates()
          return { action, pending: pendingCandidates().length, item: slim(item) }
        }
        return { action: 'list', pending: pendingCandidates().length, items: pendingCandidates().map(slim) }
      },
    }),
  )

  // ---- memory_status：ready 是真实探测（损坏保护 / 只读降级 / 主库可解析 / 数据目录可写）----
  const probeStoreWritable = () => {
    try {
      if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true })
    } catch (error) {
      return { ok: false, reason: '记忆目录无法创建：' + (error?.message ?? 'unknown') }
    }
    // accessSync(W_OK) 在 Windows 上对目录太宽松，写一个探针文件再删掉才是真检查。
    const probe = path.join(storeDir, '.status-probe-' + process.pid)
    try {
      writeFileSync(probe, 'ok', 'utf8')
      unlinkSync(probe)
      return { ok: true, reason: '' }
    } catch (error) {
      try {
        unlinkSync(probe)
      } catch (inner) {
        // 探针文件删不掉就留着，下次覆盖
      }
      return { ok: false, reason: '记忆目录不可写：' + (error?.message ?? 'unknown') }
    }
  }

  ctx.effect(() =>
    tools.register({
      name: 'memory_status',
      description:
        'Read-only health of the persistent memory store: whether it can be read and written right now, where the files are, how much of the budget is used, plus any corruption/read-only protection or config warning. Use it when a memory tool fails or a write seems not to persist.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            ready: { type: 'boolean' },
            unavailableReason: { type: 'string' },
            code: { type: 'string' },
            storeDir: { type: 'string' },
            storeFile: { type: 'string' },
            storeExists: { type: 'boolean' },
            storeBytes: { type: 'integer' },
            storeWritable: { type: 'boolean' },
            health: { type: 'string' },
            corruptCopy: { type: 'string' },
            schemaVersion: { type: 'integer' },
            entries: { type: 'integer' },
            active: { type: 'integer' },
            archived: { type: 'integer' },
            usedChars: { type: 'integer' },
            maxBytes: { type: 'integer' },
            maxInjectChars: { type: 'integer' },
            configWarning: { type: 'string' },
          },
          required: [
            'ready',
            'storeDir',
            'storeFile',
            'storeExists',
            'storeWritable',
            'health',
            'entries',
            'active',
            'archived',
            'usedChars',
            'maxBytes',
            'maxInjectChars',
          ],
          additionalProperties: false,
        },
        render(_args, value) {
          if (value?.ready === false) return [text('不可用：' + (value?.unavailableReason || '未知原因'))]
          return [
            text(
              `记忆库可用：${value?.active ?? 0} 条生效 / ${value?.archived ?? 0} 条归档，存储 ${value?.usedChars ?? 0}/${value?.maxBytes ?? 0} 字符，本轮注入预算 ${value?.maxInjectChars ?? 0} 字符，库文件 ${value?.storeFile ?? '?'}`,
            ),
          ]
        },
      },
      async execute() {
        const problems = []
        let code = ''
        const note = (nextCode, reason) => {
          problems.push(reason)
          if (code === '') code = nextCode
        }

        if (storeHealth === 'corrupt') {
          note(
            'MEMORY_STORE_CORRUPT',
            '记忆库损坏保护中：原文件已另存为 ' +
              (corruptCopy || storeFile) +
              '，写入被禁用；人工把合法 JSON 改名回原路径并重载插件后才恢复',
          )
        }
        if (storeHealth === 'readonly') {
          note('MEMORY_STORE_READONLY', '记忆库上次落盘失败，已降级为只读；修好磁盘/权限后重载插件')
        }
        if (config?.storeDir !== undefined && (typeof config.storeDir !== 'string' || config.storeDir.trim() === '')) {
          note('MEMORY_CONFIG_INVALID', '配置 storeDir 无效（需要非空字符串），已回落到默认目录')
        }

        let storeExists = false
        let storeBytes = 0
        // v4.1：SQLite 后端下「存储文件」是 memory.db；memory.json 只作迁移源/回滚备份保留。
        const statusStoreFile = backend === 'sqlite' ? dbFile : storeFile
        try {
          storeExists = existsSync(statusStoreFile)
          if (storeExists) storeBytes = statSync(statusStoreFile).size
        } catch (error) {
          note('MEMORY_STORE_UNREADABLE', '读不到记忆库文件：' + (error?.message ?? 'unknown'))
        }
        if (storeExists && backend !== 'sqlite') {
          try {
            const parsed = JSON.parse(readFileSync(storeFile, 'utf8'))
            if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
              note('MEMORY_STORE_SHAPE_INVALID', '记忆库文件形状不是 {entries: []}')
            }
          } catch (error) {
            note('MEMORY_STORE_UNREADABLE', '记忆库文件读不出合法 JSON：' + (error?.message ?? 'unknown'))
          }
        }

        const writable = probeStoreWritable()
        if (!writable.ok) note('MEMORY_STORE_UNWRITABLE', writable.reason)

        const ready = problems.length === 0
        const active = activeEntries().length
        return {
          ready,
          unavailableReason: problems.join('；'),
          ...(ready ? {} : { code: code || 'MEMORY_STORE_UNREADABLE' }),
          storeDir,
          storeFile: statusStoreFile,
          storeExists,
          storeBytes,
          storeWritable: writable.ok,
          health: storeHealth,
          ...(corruptCopy !== '' ? { corruptCopy } : {}),
          schemaVersion: Number.isInteger(state.version) ? state.version : SCHEMA_VERSION,
          entries: state.entries.length,
          active,
          archived: state.entries.length - active,
          usedChars: usedChars(),
          maxBytes,
          maxInjectChars,
          ...(configWarning !== '' ? { configWarning } : {}),
        }
      },
    }),
  )
}
