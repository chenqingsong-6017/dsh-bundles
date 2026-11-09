/**
 * 分词与文本相似度。
 *
 * 中文按词（词表 + 规则切分）、英文按词干子单元；tokenize 结果同时喂检索与 FTS5。
 */
import { readFileSync } from 'node:fs'

import { EXPANSION_WEIGHT, HARNESS_BLOCK_TAGS, SEGMENT_CACHE_LIMIT, ZH_WORD_MAX } from './constants.js'
import { text } from './util.js'

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

export function stripHarnessBlocks(text) {
  let out = String(text ?? '')
  for (const tag of HARNESS_BLOCK_TAGS) {
    out = out.replace(new RegExp('<' + tag + '(?:\\s[^>]*)?>[\\s\\S]*?</' + tag + '>', 'gi'), ' ')
  }
  return out.trim()
}

/* ───────────────────────── v3.12 中文分词 ─────────────────────────
 *
 * v3.11 及之前中文按 **bigram** 切（本地部署 → 本地/地部/部署），跨词边界会拼出假词：
 * 「基**本地**址」里的「本地」被当成命中，把不相关记忆顶过门槛（A6，实测覆盖率 0.2375 > 0.16）。
 * v3.12 换成**词**：词典正向最大匹配优先，词典外的片段退回 bigram 兜底。
 *   - 词典在 lib/zh-words.txt（跟插件一起版本化，一行一词，只收真词）；
 *   - 排序层（tokenize）与门槛层（contentUnitsOf）**共用同一个切分函数** ——
 *     v3.10 之前两者口径不同源，出现过「门槛过、排序层没候选」的错位；
 *   - 3 字词额外保留**词典内的**子词（验证门 → 验证门 + 验证），只问半截时不至于漏召回；
 *     子词也必须在词典里才算，避免「证门」这种拼接产物混进单元表。
 * 刻意**不用** Intl.Segmenter：ICU 78 把「文档/插件/重启/覆盖率/台账/卸载」都拆成单字
 * （实测见 README v3.12），跨环境还会随 ICU 版本变，测试不可复现。
 */
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
  [...'的了是在不有和就都也我你他她它这那什么怎么吗呢吧啊哦个上下中之与及或等很更最太再还被把给让从到对为以所而且但如因为所以一二三四五六七八九十每各某多少没要会可才又已经并'],
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
