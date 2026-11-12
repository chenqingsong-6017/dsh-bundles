/**
 * 记忆块渲染：注入视图（全文/索引）、列表视图与信任标记。
 */
import { COLD_IDLE_DAYS, COMPACT_PEEK_CHARS, COMPOSITE_IMPORTANCE_WEIGHT, COMPOSITE_RECENCY_WEIGHT, CORE_INJECT_SHARE, DATE_ONLY, HOT_SCORE_IMPORTANCE_WEIGHT, HOT_SCORE_RECENCY_WEIGHT, HOT_SCORE_USAGE_WEIGHT, INDEX_INJECT_FLOOR_SHARE, INDEX_SUMMARY_CHARS, KIND_PROCEDURE, KIND_REFERENCE, MAX_RELEVANT, MAX_RICH_INDEX, MEMORY_HEADER, RELEVANCE_FLOOR, RELEVANT_COMPOSITE_MARGIN, RELEVANT_SHARE, SCOPE_BOOST } from './constants.js'
import { applicableAt, effectiveImportance, isTrueAt, localDateOf, recencyOf } from './entry.js'
import { TRUST_LEGEND } from './schema.js'
import { gateDecision, relevanceCoverage, scoreEntries } from './score.js'

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

// v4.2：reference / procedure 在注入行上带可辨识前缀，一眼看出「这是去哪找 / 这是流程」。
const KIND_MARK = { [KIND_REFERENCE]: '↗ ', [KIND_PROCEDURE]: '⚙ ' }

const kindMark = (entry) => KIND_MARK[entry?.kind] ?? ''

const lineFull = (entry) => `- ${trustMark(entry)}${kindMark(entry)}${entry.pinned ? '📌 ' : ''}${textOf(entry)}`

const entryDate = (entry) => {
  const raw = typeof entry.updatedAt === 'string' && entry.updatedAt !== '' ? entry.updatedAt : entry.addedAt
  const stamp = typeof raw === 'string' ? raw.slice(0, 10) : ''
  return /^\d{4}-\d{2}-\d{2}$/.test(stamp) ? stamp : ''
}

const entryTag = (entry) => (Array.isArray(entry.tags) && entry.tags.length > 0 ? entry.tags[0] : entry.tag ?? '')

const lineRelevant = (entry) => {
  const tag = entryTag(entry) ? ` [${entryTag(entry)}]` : ''
  const date = entryDate(entry)
  return `- (${entry.id})${trustMark(entry)}${tag}${date ? ` ${date}` : ''} ${kindMark(entry)}${textOf(entry)}`
}

const lineIndexCompact = (entry) => {
  // v4.15②：索引层改紧凑行后，大量条目没有 scope → 用 tag 补位（用 [tag] 区分，别把标签伪装成 scope）。
  const scope = typeof entry?.scope === 'string' && entry.scope !== '' ? entry.scope : ''
  const tag = scope === '' ? ((Array.isArray(entry?.tags) ? entry.tags[0] : entry?.tag) ?? '') : ''
  // v2.7：只留 <scope> 标签等于没注入——模型看不出这条讲什么，也就不会去搜。压到 14 字主题仍可辨识。
  const flat = String(entry.text ?? '').replace(/\s+/g, ' ').trim()
  const peek = flat.length > COMPACT_PEEK_CHARS ? `${flat.slice(0, COMPACT_PEEK_CHARS)}…` : flat
  const label = scope !== '' ? ` <${scope}>` : tag !== '' ? ` [${tag}]` : ''
  return `- (${entry.id})${trustMark(entry)}${label} ${kindMark(entry)}${peek}`
}

const lineIndex = (entry) => {
  const flat = textOf(entry).replace(/\s+/g, ' ').trim()
  const summary = flat.length > INDEX_SUMMARY_CHARS ? `${flat.slice(0, INDEX_SUMMARY_CHARS)}…` : flat
  const tag = entryTag(entry) ? ` [${entryTag(entry)}]` : ''
  const date = entryDate(entry)
  return `- (${entry.id})${trustMark(entry)}${tag}${date ? ` ${date}` : ''} ${kindMark(entry)}${summary}`
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
      isTrueAt(entry) &&
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

  // 第一优先级：pinned 全文（硬规则永远在场）。
  // v4.15②：加**配额**。2026-11-12 真机实测：19 条 pinned 占 2154 字符 = 预算 89.5%，
  //   索引层 0 字符、33 条记忆对模型完全不可见、另有 2 条 pinned 被静默丢弃。
  // 取经 Letta（core memory 分 block、每桶独立上限，letta@0.9.1 constants.py:326-328）与 quota 混注：
  //   核心层 ≤ CORE_INJECT_SHARE；溢出的 pinned **降到索引行**（不丢），仍可被 memory_search 找回。
  // 排序口径：rule 优先 → 重要度 → 使用次数 → 新近；真装不下时先降级最不关键的那条。
  const pinnedAll = entries.filter((item) => item.pinned)
  const pinnedOrder = [...pinnedAll].sort((a, b) => {
    const ruleDiff = (b.kind === 'rule' ? 1 : 0) - (a.kind === 'rule' ? 1 : 0)
    if (ruleDiff !== 0) return ruleDiff
    const impDiff = effectiveImportance(b) - effectiveImportance(a)
    if (Math.abs(impDiff) > 0.001) return impDiff
    const useDiff = Number(b.usedCount ?? 0) - Number(a.usedCount ?? 0)
    if (useDiff !== 0) return useDiff
    return recencyOf(b) - recencyOf(a)
  })
  const coreBudget = Math.floor(maxInjectChars * CORE_INJECT_SHARE)
  // v4.15②：索引层保底（22%）。相关层不能把这块吃光——否则「每轮只看见 pinned + 2 条相关」又把库藏起来。
  const indexFloor = Math.floor(maxInjectChars * INDEX_INJECT_FLOOR_SHARE)
  const pinnedDowngraded = []
  for (const entry of pinnedOrder) {
    const cost = lineFull(entry).length + 1
    if (used + cost > coreBudget) {
      pinnedDowngraded.push(entry)
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
      const cap = Math.min(Math.floor(maxInjectChars * RELEVANT_SHARE), Math.max(0, maxInjectChars - used - indexFloor))
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
  // v4.15②：被配额降级的 pinned 落进索引层（不是丢弃）；再按冷热排序。
  const rest = [
    ...pinnedDowngraded,
    ...entries.filter((item) => !item.pinned && !inRelevant.has(item.id)),
  ]
  const isCrossScope = (entry) =>
    currentScope !== '' &&
    typeof entry.scope === 'string' &&
    entry.scope !== '' &&
    entry.scope !== currentScope &&
    entry.scope !== 'global'
  const compact = []
  // v4.15②：索引层排序 = 冷热分（使用次数 0.5 + 重要度 0.3 + 新近 0.2）。
  // 旧口径只有 importance+recency，导致 m4（used=108）、m131（used=72）这类最常被检索的条目在注入层永无位置。
  // 冷层（从未命中且 ≥COLD_IDLE_DAYS 天没动）不进索引层：它们只该被 memory_search 按需拉，不占每轮预算。
  const nowForRank = Date.now()
  const lastTouchOf = (entry) => {
    const raw =
      typeof entry?.lastUsedAt === 'string' && entry.lastUsedAt !== ''
        ? entry.lastUsedAt
        : entry?.updatedAt ?? entry?.addedAt
    const ms = Date.parse(String(raw ?? ''))
    return Number.isFinite(ms) ? ms : NaN
  }
  const usageNorm = (entry) => Math.min(1, Math.log1p(Math.max(0, Number(entry?.usedCount ?? 0) || 0)) / Math.log1p(50))
  const hotScoreOf = (entry) =>
    HOT_SCORE_USAGE_WEIGHT * usageNorm(entry) +
    HOT_SCORE_IMPORTANCE_WEIGHT * (effectiveImportance(entry, nowForRank) / 10) +
    HOT_SCORE_RECENCY_WEIGHT * recencyOf(entry, nowForRank)
  const isColdEntry = (entry) => {
    if (entry?.pinned === true || entry?.kind === 'rule') return false
    if (Number(entry?.usedCount ?? 0) > 0) return false
    const ts = lastTouchOf(entry)
    return Number.isFinite(ts) && (nowForRank - ts) / 86400000 >= COLD_IDLE_DAYS
  }
  const coldSuppressed = []
  const hotRest = []
  for (const entry of rest) {
    if (isColdEntry(entry)) coldSuppressed.push(entry)
    else hotRest.push(entry)
  }
  const orderIndex = new Map(hotRest.map((entry, position) => [entry.id, position]))
  const ordered = [...hotRest].sort((a, b) => {
    const diff = hotScoreOf(b) - hotScoreOf(a)
    if (Math.abs(diff) > 0.02) return diff
    // 同档时按写入顺序倒排（数组越靠后越新）——没有时间戳的老条目也有确定顺序。
    return (orderIndex.get(b.id) ?? 0) - (orderIndex.get(a.id) ?? 0)
  })
  // v4.15②：索引层两级渲染 —— 本域热点用**完整索引行**（id + 标签 + 日期 + 44 字摘要），
  // 其余（跨域，或本域里排到后面的）用**紧凑行**（id + 标签/域 + 14 字主题）。
  // 依据：2026-11-12 真机实测，19 条 pinned 占 2311 字符后索引层拿到 0 条、33 条记忆对模型不可见；
  // 紧凑行约 33 字符、完整行约 65 字符，按「前 MAX_RICH_INDEX 条给摘要、其余给主题」混排，
  // 同样预算下可见条目从 0 提到 26（完整 14 + 紧凑 12），同时保住本域条目的可读性。
  // 上限放在 lib/constants.js（阈值集中，别在函数里散落魔数）；8 是 §7 的验收线。
  for (const entry of ordered) {
    const rich = !isCrossScope(entry) && indexed.length < MAX_RICH_INDEX
    const line = rich ? lineIndex(entry) : lineIndexCompact(entry)
    const cost = line.length + 1
    if (used + cost > maxInjectChars) {
      dropped.push(entry)
      continue
    }
    if (rich) indexed.push(entry)
    else compact.push(entry)
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
    const footer = `（全文 ${full.length}${relevant.length > 0 ? ` · 相关 ${relevant.length}` : ''} · 索引 ${indexed.length}${compact.length > 0 ? ` · 紧凑 ${compact.length}` : ''}${dropped.length > 0 ? ` · 未注入 ${dropped.length}` : ''}${pinnedDowngraded.length > 0 ? ` · 📌降级 ${pinnedDowngraded.length}` : ''}${coldSuppressed.length > 0 ? ` · 冷层 ${coldSuppressed.length}（只可检索）` : ''}；跨域或更早的记忆用 memory_search 按 id / 关键词取）`
    // v4.14（2026-11-12）：注入分层——模仿 claude-mem ContextBuilder 的分段渲染。
    // 只加分隔行、不改预算分配与排序；Previously/Timeline 需会话事件流（P2 observer），不硬造。
    const block = [
      '<memory>',
      MEMORY_HEADER,
      ...(hasMarks ? [TRUST_LEGEND] : []),
      ...(full.length + relevant.length > 0 ? ['— 常驻（硬规则/本轮相关） —'] : []),
      ...full.map(lineFull),
      ...relevant.map(lineRelevant),
      ...(indexed.length + compact.length > 0 ? ['— 索引（按需 memory_search） —'] : []),
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
    // v4.15②：冷热分层的可观测——降级了多少 pinned、冷层甩掉多少条。
    statsOut.pinnedDowngraded = pinnedDowngraded.map((entry) => entry.id)
    statsOut.coldSuppressed = coldSuppressed.map((entry) => entry.id)
    // v3.24：注入收益度量（学 Google ADK 的 _prompt_chars_saved）——
    // 光报「注入了多少」不够，还要能答「降级成索引行替我们省了多少」。
    const sizeOf = (list, render) => list.reduce((n, entry) => n + render(entry).length + 1, 0)
    statsOut.fullChars = sizeOf(full, lineFull)
    statsOut.indexedChars = sizeOf(indexed, lineIndex) + sizeOf(compact, lineIndexCompact)
    statsOut.droppedFullChars = sizeOf(dropped, lineFull)
    // 2026-11-12（P0-1）：只报 indexedChars 看不出「索引层替我们省了多少」——补「索引批若全量展开」的字符数。
    // 判据：indexedIfFullChars >= indexedChars；差值 = 本轮索引层省下的字符。
    statsOut.indexedIfFullChars = sizeOf(indexed, lineFull) + sizeOf(compact, lineFull)
  }

  return built.block
}
