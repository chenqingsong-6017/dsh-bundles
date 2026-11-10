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
 *   - **存储预算与注入预算分开**（v1.1）：存储可到 `maxBytes`（默认 12000 字符），
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

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { CONFLICT_FLOOR, CONSOLIDATE_MIN_USES, CONTEXT_ORDER, DATE_ONLY, DEFAULT_MAX_BYTES, DEFAULT_MAX_INJECT_CHARS, DEFAULT_SCOPE_ROOTS, KIND_PROCEDURE, MAX_CANDIDATES_PER_TURN, MAX_SIMILAR_HINT, MAX_TEXT_CHARS, PROCEDURE_MIN_VERIFIED, ROOM_MIN_AGE_DAYS, SCHEMA_VERSION, SIMILAR_HINT_FLOOR, TEXT_TOO_LONG_HINT, PROFILE_SLOTS, PROFILE_SLOT_LABELS } from './lib/constants.js'
import { deriveStaleAfter, effectiveImportance, entityCoccur, entityIndex, importanceOf, isArchivedEntry, isInvalidEntry, isNotYetValid, isStaleEntry, isTrueAt, profileView, localDateOf, parseTimestamp } from './lib/entry.js'
import { stripHarnessBlocks, suggestAliases, textSimilarity } from './lib/text.js'
import { collectRuleFiles, derivableHit, extractCandidates, extractRuleCandidates } from './lib/candidates.js'
import { fail, text } from './lib/util.js'
import { createStore } from './lib/store.js'
import { MEMORY_STATUS, cardMarkdown, cleanAliases, cleanEntities, cleanSources, memoryEntrySchema, normalizeEntry, normalizeScope, slugOf } from './lib/schema.js'
import { trustMark } from './lib/render.js'
import { gateDecision, relevanceCoverage, scoreEntries } from './lib/score.js'

export const name = 'dsh-memory'
export const inject = ['tools', 'systemPrompt', 'workingDirectory']

export { isStaleEntry, isArchivedEntry, isInvalidEntry, isNotYetValid, isTrueAt, parseTimestamp, entityIndex, entityCoccur, profileView, applicableAt, curationDecision, deriveStaleAfter, localDateOf, importanceOf, effectiveImportance, eliminationSignal, recencyOf, detectScope } from './lib/entry.js'
export { bigramSet, textSimilarity, stripHarnessBlocks, tokenize, suggestAliases, expandQuery, contentUnitsOf, queryClauses } from './lib/text.js'
export { queryIdfSum, scoreEntries, scoreEntriesStrict, gateDecision, relevanceCoverage, scoreMemory } from './lib/score.js'
export { trustMark, renderMemory } from './lib/render.js'
export { cleanAliases, migrateState, canonicalJson, cleanEntities, cleanSources, normalizeScope, normalizeEntry, memoryEntrySchema, cardMarkdown, slugOf } from './lib/schema.js'
export { extractCandidates, extractRuleCandidates, collectRuleFiles, normalizeRuleLine, derivableHit } from './lib/candidates.js'
export { readStoreSnapshot } from './lib/store-snapshot.js'

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
  // v4.2：可推导写入过滤开关（默认 'skip'；'off' 整体关闭）。这是写策略，不碰检索路径。
  const deriveGate = config?.deriveGate === 'off' ? 'off' : 'skip'
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
  // v4.3.0：存储层搬到 lib/store.js 的工厂里，apply 只负责组装：建 store、注册工具、挂注入层。
  const store = createStore({ ctx, config, maxBytes, maxInjectChars, scopeRoots, relevanceFloor })
  const {
    storeDir,
    storeFile,
    state,
    candidates,
    backend,
    retrievalMode,
    dbFile,
    historyFile,
    load,
    persist,
    persistCandidates,
    loadCandidates,
    refreshBeforeWrite,
    refreshSqliteState,
    requireWritable,
    newEntryId,
    scoreEntriesIndexed,
    makeRoom,
    budgetExceededMessage,
    autoPromoteRule,
    isActive,
    activeEntries,
    usedChars,
    publicEntry,
    renderOnce,
    countUsage,
    flushUsage,
    currentScopeOf,
    pendingCandidates,
    addCandidate,
    injectedBlock,
  } = store

  const listOutput = (options) => {
    // v3.20：默认只返回生效条目。归档条目走 archive.json，要看需显式 includeArchived:true。
    // 起因：归档既不计预算也不参与注入，却让 memory_list 每次多吐 30+ KB（实测 93 条 / 37 KB）。
    const includeArchived = options?.includeArchived === true
    // v3.24：把 stats 传下去，才能报「索引行花了多少、出局的全量本要花多少」。
    const listStats = {}
    const block = renderOnce('', listStats, undefined, store.lastKnownCwd)
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
        store.storeHealth !== 'ok'
          ? store.storeHealth
          : usedChars() / maxBytes >= 0.95
            ? 'full'
            : usedChars() / maxBytes >= 0.85
              ? 'near-full'
              : 'ok',
      ...(store.corruptCopy !== '' ? { healthNote: store.corruptCopy } : {}),
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
          at_time: {
            type: 'string',
            description:
              'v4.6: point-in-time query (bi-temporal). YYYY-MM-DD or ISO time — return entries true at that moment (validFrom reached, invalidAt not reached). Omit for now.',
          },
          entity: {
            type: 'string',
            description:
              'v4.7: filter to entries whose entities include this label (graph view). When set, the result also carries coccurring — entities co-occurring with it, ranked by count.',
          },
          slot: {
            type: 'string',
            description:
              'v4.8: filter to a user-profile slot (one of ' + PROFILE_SLOTS.join('/') + '), or "all" for every slotted entry. When set, the result carries profile — the full profile view grouped by slot.',
          },
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
            coccurring: { type: 'array', items: { type: 'object', properties: { entity: { type: 'string' }, count: { type: 'integer' } } } },
            profile: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
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
                  validFrom: { type: 'string' },
                  invalidAt: { type: 'string' },
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
        // v4.2.2（H2④）：读路径也要看到别的进程的写。refreshSqliteState 自己按 meta.write_seq 判重，
        // 没变时只多一条单行查询（不重扫全表）；变了才合并对方条目并让统计键缓存失效。
        if (backend === 'sqlite' && store.db !== null) refreshSqliteState()
        const query = typeof args?.query === 'string' ? args.query.trim() : ''
        if (query === '') throw fail('MEMORY_ARG_MISSING', 'memory_search 需要 query。')
        const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 20) : 5
        // v2.7：query 里出现 m\d+ 就按 id 直取。注入块一直写着「用 memory_search 按 id 取全文」，
        // 但 BM25 不认 id——实测搜 m33 命中 0/63。文档与实现不一致，这里补上。
        // v4.0：invalidAt 已到的条目不再参与检索（留档不删，memory_list includeArchived 仍可见）。
        const atTimeRaw = typeof args?.at_time === 'string' && args.at_time !== '' ? args.at_time.trim() : ''
        const atTime = atTimeRaw === '' ? Date.now() : parseTimestamp(atTimeRaw)
        if (Number.isNaN(atTime)) throw fail('MEMORY_DATE_INVALID', 'at_time 需要 YYYY-MM-DD 或 ISO 时间。')
        const activeEntries = state.entries.filter((entry) => isTrueAt(entry, atTime))
        const entityFilter = typeof args?.entity === 'string' && args.entity !== '' ? args.entity.trim() : ''
        const slotFilter = typeof args?.slot === 'string' && args.slot !== '' ? args.slot.trim() : ''
        let searchable = entityFilter === '' ? activeEntries : activeEntries.filter((entry) => Array.isArray(entry.entities) && entry.entities.includes(entityFilter))
        if (slotFilter !== '') searchable = slotFilter === 'all' ? searchable.filter((entry) => typeof entry.slot === 'string' && entry.slot !== '') : searchable.filter((entry) => entry.slot === slotFilter)
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
        if (store.usageDirty && Date.now() - store.lastUsageFlush > 60000) flushUsage()
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
        const coccurring = entityFilter === '' ? undefined : [...entityCoccur(activeEntries, entityFilter).entries()].sort((a, b) => b[1] - a[1]).map(([entity, count]) => ({ entity, count }))
        const profile = slotFilter === '' ? undefined : profileView(activeEntries)
        return {
          query,
          total: searchable.length,
          matched: scored.length,
          confidence,
          coverage,
          ...(idHits.length > 0 ? { byId: idHits.map((entry) => entry.id) } : {}),
          ...(coccurring !== undefined ? { coccurring } : {}),
          ...(profile !== undefined ? { profile } : {}),
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
            ...(typeof item.entry.validFrom === 'string' ? { validFrom: item.entry.validFrom } : {}),
            ...(typeof item.entry.invalidAt === 'string' ? { invalidAt: item.entry.invalidAt } : {}),
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
          kind: {
            type: 'string',
            description:
              'Optional kind: rule | preference | fact | reference | procedure | note. reference = where external info lives (dashboard/issue tracker); procedure = a workflow verified by real reuse (needs verifiedCount >= 2). Unknown kinds are allowed and get fact-level defaults.',
          },
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
          validFrom: {
            type: 'string',
            description:
              'v4.6: YYYY-MM-DD (or ISO time) from which this fact becomes true. Before that date it is neither injected nor returned by memory_search (bi-temporal event-time start; pairs with invalidAt as the end).',
          },
          softDeadline: {
            type: 'string',
            description:
              'v4.5: YYYY-MM-DD target/deadline date. Reaching it does NOT invalidate the fact — it flips the entry to stale (re-check needed). Use for plans/goals ("by March 2026"); use invalidAt only for facts that stop being true.',
          },
          slot: {
            type: 'string',
            description:
              'v4.8: user-profile slot this fact belongs to. One of ' + PROFILE_SLOTS.join('/') + ' (identity/preference/habit/environment/taboo/goal/milestone). Used by memory_search slot query to build the profile view.',
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
          force: {
            type: 'boolean',
            description:
              'v4.2: bypass the derivable-write gate. The gate skips entries that are near-duplicates of AGENTS.md / .dsh/rules (already injected every turn); only pass force:true when the fact is genuinely new.',
          },
          verifiedCount: {
            type: 'integer',
            minimum: 0,
            description: 'v4.2: only for kind=procedure — how many times the workflow has been reused successfully (>= 2 required, Voyager-style gate).',
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
            // v4.2：可推导过滤命中时 entry 缺省（不写库），改为返回诊断三件套。
            skipped: { type: 'boolean' },
            deriveReason: { type: 'string' },
            deriveSource: { type: 'string' },
            deriveSimilarity: { type: 'number' },
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
          // v4.2：跳过时不写库，entry 缺省——所以不再把 entry 放进 required。
          required: ['deduped', 'usedChars', 'maxBytes'],
          additionalProperties: false,
        },
        render(_args, value) {
          if (value?.skipped === true) {
            return [
              text(
                `未入库（能从已有规则推出）：${value?.deriveReason ?? ''}\n` +
                  `规则源：${value?.deriveSource ?? '?'}（相似度 ${Math.round((value?.deriveSimilarity ?? 0) * 100) / 100}）\n` +
                  `这条规则每轮已由 path-rules 注入，再记一遍只占预算。确属新事实时用 force:true 重试；长篇正文请写 vault 卡再留 vault:// 指针。`,
              ),
            ]
          }
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
        if (args?.validFrom !== undefined && args.validFrom !== '') {
          const rawValid = String(args.validFrom)
          if (!DATE_ONLY.test(rawValid) && Number.isNaN(Date.parse(rawValid))) {
            throw fail('MEMORY_DATE_INVALID', 'validFrom 需要 YYYY-MM-DD 或 ISO 时间（空串表示清除）。')
          }
        }
        if (args?.softDeadline !== undefined && args.softDeadline !== '' && !DATE_ONLY.test(String(args.softDeadline))) {
          throw fail('MEMORY_DATE_INVALID', 'softDeadline 需要 YYYY-MM-DD 格式。')
        }
        if (args?.slot !== undefined && args.slot !== '') {
          const rawSlot = String(args.slot).trim()
          if (!PROFILE_SLOTS.includes(rawSlot)) throw fail('MEMORY_ARG_INVALID', 'slot 必须是 ' + PROFILE_SLOTS.join('/') + ' 之一。')
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
          // v4.2.1（M1）：去重捷径原本在 procedure 门槛（下面的 :4095）之前 return，且 :4041 直接改 kind ——
          // 「先 add{text, kind:'fact'}，再用同一文本 add{kind:'procedure'}」就能绕开门槛。
          // 这里对「去重后实际 kind」跑同一道闸，口径与 update 一致（改 procedure 必须显式给证据）。
          const dedupeKindRaw = typeof args?.kind === 'string' ? args.kind.trim() : ''
          const dedupeWasProcedure = duplicate.kind === KIND_PROCEDURE
          const dedupeKind = dedupeKindRaw !== '' ? dedupeKindRaw : dedupeWasProcedure ? KIND_PROCEDURE : ''
          const dedupeExplicitVerified = Number.isInteger(args?.verifiedCount) ? args.verifiedCount : 0
          const dedupeNextVerified = Number.isInteger(args?.verifiedCount)
            ? dedupeExplicitVerified
            : dedupeWasProcedure && Number.isInteger(duplicate.verifiedCount)
              ? duplicate.verifiedCount
              : 0
          if (Number.isInteger(args?.verifiedCount) && dedupeKind !== KIND_PROCEDURE) {
            throw fail(
              'MEMORY_VERIFIEDCOUNT_INVALID',
              'verifiedCount 只能写在 kind=procedure 的条目上（当前去重命中的条目 kind=' + (dedupeKind || '(空)') + '）：先把流程真跑 ≥2 次，再用 {kind:"procedure", verifiedCount:2} 一起写入。',
            )
          }
          if (dedupeKind === KIND_PROCEDURE && dedupeNextVerified < PROCEDURE_MIN_VERIFIED) {
            throw fail(
              'MEMORY_PROCEDURE_UNVERIFIED',
              'kind=procedure 只收「真跑成功 ≥' + PROCEDURE_MIN_VERIFIED + ' 次」的工作流：去重命中的条目还不是 procedure 且本次没给证据（verifiedCount=' + dedupeNextVerified + '）。' +
                ' 做法：先真跑两遍，再 memory_add {text, kind:"procedure", verifiedCount:' + PROCEDURE_MIN_VERIFIED + '}。',
            )
          }
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
          if (dedupeKindRaw !== '' && duplicate.kind !== dedupeKindRaw) {
            duplicate.kind = dedupeKindRaw
            changed = true
            // v4.2.1（M3）：kind 离开 procedure 时要清掉复用证据，否则「降级再升级」可沿用存量计数过闸。
            if (dedupeKindRaw !== KIND_PROCEDURE) {
              delete duplicate.verifiedCount
              delete duplicate.lastVerifiedAt
            }
          }
          // v4.2.1（M3）：只有 procedure 条目能持有 verifiedCount，且必须是本次显式给的证据。
          if (dedupeKind === KIND_PROCEDURE && Number.isInteger(args?.verifiedCount)) {
            if (duplicate.verifiedCount !== dedupeExplicitVerified) {
              duplicate.verifiedCount = dedupeExplicitVerified
              duplicate.lastVerifiedAt = new Date().toISOString()
              changed = true
            }
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
        // ── v4.2：写入路径过滤（Anthropic A4）与 procedure 入库门槛 ──
        // 顺序刻意：完全重复先走上面的 deduped 捷径；这里只拦「规则/AGENTS.md 的近重复副本」。
        if (deriveGate !== 'off' && args?.force !== true) {
          const hit = derivableHit(raw, store.lastKnownCwd)
          if (hit !== null) {
            return {
              deduped: false,
              usedChars: usedChars(),
              maxBytes,
              skipped: true,
              deriveReason: '与规则源近重复：' + hit.quote,
              deriveSource: hit.source,
              deriveSimilarity: Math.round(hit.similarity * 1000) / 1000,
            }
          }
        }
        const incomingKind = typeof args?.kind === 'string' ? args.kind.trim() : ''
        const incomingVerified = Number.isInteger(args?.verifiedCount) ? args.verifiedCount : 0
        // v4.2.1（M3）：verifiedCount 只属于 procedure。原来任意 kind 都能灌计数，
        // 「fact 先灌 verifiedCount=2 → 再 update 改 kind=procedure」就能绕开复用门槛。
        if (Number.isInteger(args?.verifiedCount) && incomingKind !== KIND_PROCEDURE) {
          throw fail(
            'MEMORY_VERIFIEDCOUNT_INVALID',
            'verifiedCount 只能写在 kind=procedure 的条目上（本次 kind=' + (incomingKind || '(空)') + '）：先把流程真跑 ≥2 次，再用 {kind:"procedure", verifiedCount:2} 一起写入。',
          )
        }
        if (incomingKind === KIND_PROCEDURE && incomingVerified < PROCEDURE_MIN_VERIFIED) {
          throw fail(
            'MEMORY_PROCEDURE_UNVERIFIED',
            'kind=procedure 只收「真跑成功 ≥' + PROCEDURE_MIN_VERIFIED + ' 次」的工作流（Voyager skill 入库规则 / Google ADK Procedural）：本次 verifiedCount=' + incomingVerified + '，未达门槛。' +
              ' 做法：先把流程真跑两遍确认可复现，再 memory_add {kind:"procedure", verifiedCount:' + PROCEDURE_MIN_VERIFIED + '}；之后每次复用成功用 memory_update {id, verifiedCount:N+1} 累计。',
          )
        }
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
            // v4.2（Anthropic A2）：不只拒绝，给出「合并哪几条 / drop 哪些 stale」的具体建议。
            throw fail('MEMORY_BUDGET_EXCEEDED', budgetExceededMessage(raw.length, room.archived))
          }
        }
        const now = new Date().toISOString()
        const derivedStale =
          typeof args?.staleAfter === 'string' && args.staleAfter !== ''
            ? ''
            : deriveStaleAfter(typeof args?.kind === 'string' ? args.kind.trim() : '')
        const entry = normalizeEntry({
          id: newEntryId(),
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
          ...(typeof args?.validFrom === 'string' && args.validFrom !== '' ? { validFrom: args.validFrom } : {}),
          ...(typeof args?.softDeadline === 'string' && args.softDeadline !== '' ? { softDeadline: args.softDeadline } : {}),
          ...(typeof args?.slot === 'string' && args.slot !== '' ? { slot: args.slot.trim() } : {}),
          ...(Array.isArray(args?.workspaces) ? { workspaces: args.workspaces } : {}),
          // v4.2：procedure 的复用证据（Voyager 门槛：≥2 次成功复运用）。
          ...(incomingKind === KIND_PROCEDURE ? { verifiedCount: incomingVerified, lastVerifiedAt: now } : {}),
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
      description: 'Replace the text, the tag, or the pinned flag of one existing memory entry — get its id from memory_list first. A call with no new text (and no verifiedCount-only update) is rejected with MEMORY_ARG_MISSING; to delete use memory_remove {id, confirm:true} instead.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Entry id from memory_list, e.g. "m1".' },
          text: { type: 'string', description: `New text (<= ${MAX_TEXT_CHARS} chars). Omit it only for a verifiedCount-only update.` },
          tag: { type: 'string', description: 'Optional new tag; omit to keep the current one.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional new tags; omit to keep the current ones.' },
          aliases: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional new aliases (synonyms) for retrieval; omit to keep the current ones, empty array clears them.',
          },
          scope: { type: 'string', description: 'Optional new scope (global | plugin-dev | data-infra | dsh-date | machine).' },
          kind: { type: 'string', description: 'Optional new kind (rule | preference | fact | reference | procedure | note).' },
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
          validFrom: {
            type: 'string',
            description: 'v4.6: YYYY-MM-DD (or ISO) from which the fact becomes true; empty string clears it.',
          },
          softDeadline: {
            type: 'string',
            description: 'v4.5: YYYY-MM-DD target/deadline; reaching it flips the entry stale (re-check), never invalidates it. empty string clears it.',
          },
          slot: {
            type: 'string',
            description: 'v4.8: user-profile slot; one of ' + PROFILE_SLOTS.join('/') + '; empty string clears it.',
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
          verifiedCount: {
            type: 'integer',
            minimum: 0,
            description: 'v4.2: reuse-success count for kind=procedure (>= 2 to store/keep as procedure); records lastVerifiedAt now.',
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
        required: ['id'],
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
        // v4.2：允许 verifiedCount-only 更新（procedure 每复用成功一次只累加证据，不必重发正文）。
        if (next === '' && !Number.isInteger(args?.verifiedCount)) {
          throw fail('MEMORY_ARG_MISSING', 'memory_update 需要新的 text；要删除请用 memory_remove {id, confirm:true}。')
        }
        if (next.length > MAX_TEXT_CHARS) throw fail('MEMORY_TEXT_TOO_LONG', `单条记忆最多 ${MAX_TEXT_CHARS} 字符，当前 ${next.length}。${TEXT_TOO_LONG_HINT}`)
        const entry = state.entries.find((item) => item.id === id)
        if (!entry) throw fail('MEMORY_ID_NOT_FOUND', `没有这条记忆：${id}。先用 memory_list 查看。`)
        if (args?.verifiedCount !== undefined && !(Number.isInteger(args.verifiedCount) && args.verifiedCount >= 0)) {
          throw fail('MEMORY_ARG_INVALID', 'verifiedCount 必须是 ≥0 的整数。')
        }
        // v4.2：procedure 的复用门槛对「改成 procedure / 已是 procedure」都生效——不能绕过门槛把普通条目升级成流程。
        // v4.2.1（M3）两处收紧：
        //   ① verifiedCount 只允许写在 procedure 条目上（原来任何 kind 都能灌，之后改 kind 就能过闸）；
        //   ② 把 kind 改成 procedure 时必须**本次显式**给 verifiedCount ≥2，不沿用条目存量值。
        const explicitKind = typeof args?.kind === 'string' && args.kind.trim() !== '' ? args.kind.trim() : ''
        const nextKind = explicitKind !== '' ? explicitKind : typeof entry.kind === 'string' ? entry.kind : ''
        const becomingProcedure = nextKind === KIND_PROCEDURE && entry.kind !== KIND_PROCEDURE
        const entryVerified = Number.isInteger(entry.verifiedCount) ? entry.verifiedCount : 0
        if (Number.isInteger(args?.verifiedCount) && nextKind !== KIND_PROCEDURE) {
          throw fail(
            'MEMORY_VERIFIEDCOUNT_INVALID',
            'verifiedCount 只能写在 kind=procedure 的条目上（当前 kind=' + (nextKind || '(空)') + '）：' +
              '要把普通条目升级成流程，必须一次性给 {kind:"procedure", verifiedCount:' + PROCEDURE_MIN_VERIFIED + '}（真跑成功 ≥' + PROCEDURE_MIN_VERIFIED + ' 次的证据）。',
          )
        }
        const nextVerified = Number.isInteger(args?.verifiedCount) ? args.verifiedCount : becomingProcedure ? 0 : entryVerified
        if (nextKind === KIND_PROCEDURE && nextVerified < PROCEDURE_MIN_VERIFIED) {
          throw fail(
            'MEMORY_PROCEDURE_UNVERIFIED',
            'procedure 需要 verifiedCount ≥ ' + PROCEDURE_MIN_VERIFIED + '（当前 ' + nextVerified + (becomingProcedure ? '；改成 procedure 必须本次显式给证据，不能沿用存量值' : '') + '）：先真跑成功 ≥2 次再入库/改 kind。',
          )
        }
        const projected = usedChars() - entry.text.length + (next !== '' ? next.length : 0)
        if (projected > maxBytes) {
          throw fail('MEMORY_BUDGET_EXCEEDED', `更新后会到 ${projected} / ${maxBytes} 字符，超预算。请精简或先删掉别的条目。`)
        }
        if (args?.supersede === true) {
          // v4.2.1（M2）：supersede 会「新条目生效 + 旧条作废」，没有正文就只会造出一条空记忆并废掉旧条。
          // verifiedCount-only 更新（next === ''）不允许 supersede。
          if (next === '') {
            throw fail(
              'MEMORY_ARG_MISSING',
              'supersede=true 需要新的 text：只有 verifiedCount 的更新不能推翻旧条（否则会造出空正文的新条目）。要先改正文再用 supersede。',
            )
          }
          // 时序失效（Graphiti 式）：新条目生效，旧条目留档不删、不再注入。
          const now = new Date().toISOString()
          const replacement = normalizeEntry({
            id: newEntryId(),
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
            ...(Number.isInteger(entry.verifiedCount) ? { verifiedCount: entry.verifiedCount } : {}),
            ...(typeof entry.lastVerifiedAt === 'string' ? { lastVerifiedAt: entry.lastVerifiedAt } : {}),
            addedAt: now,
            updatedAt: now,
          })
          entry.supersededBy = replacement.id
          entry.status = 'deprecated'
          entry.updatedAt = now
          state.entries.push(replacement)
          persist()
          return { entry: publicEntry(replacement), usedChars: usedChars(), superseded: entry.id }
        }
        if (next !== '') entry.text = next
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
        if (typeof args?.kind === 'string' && args.kind.trim() !== '') {
          entry.kind = args.kind.trim()
          // v4.2.1（M3）：kind 离开 procedure 就清掉复用证据——否则「降级 → 再改回 procedure」
          // 可以沿用存量 verifiedCount 过闸（审计 M3 的绕法就是靠存量值）。
          if (entry.kind !== KIND_PROCEDURE) {
            delete entry.verifiedCount
            delete entry.lastVerifiedAt
          }
        }
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
        if (typeof args?.validFrom === 'string') {
          if (args.validFrom === '') delete entry.validFrom
          else {
            const rawValid = args.validFrom.trim()
            if (!DATE_ONLY.test(rawValid) && Number.isNaN(Date.parse(rawValid))) {
              throw fail('MEMORY_DATE_INVALID', 'validFrom 需要 YYYY-MM-DD 或 ISO 时间（空串表示清除）。')
            }
            entry.validFrom = rawValid
          }
        }
        if (typeof args?.slot === 'string') {
          if (args.slot === '') delete entry.slot
          else {
            const rawSlot = args.slot.trim()
            if (!PROFILE_SLOTS.includes(rawSlot)) throw fail('MEMORY_ARG_INVALID', 'slot 必须是 ' + PROFILE_SLOTS.join('/') + ' 之一。')
            entry.slot = rawSlot
          }
        }
        if (typeof args?.softDeadline === 'string') {
          if (args.softDeadline === '') delete entry.softDeadline
          else {
            const rawSoft = args.softDeadline.trim()
            if (!DATE_ONLY.test(rawSoft)) {
              throw fail('MEMORY_DATE_INVALID', 'softDeadline 需要 YYYY-MM-DD 格式（空串表示清除）。')
            }
            entry.softDeadline = rawSoft
          }
        }
        // v4.2：复用成功一次就累加证据（procedure 的「验证过几次」不是用户说记住，而是真跑成功）。
        if (Number.isInteger(args?.verifiedCount)) {
          entry.verifiedCount = args.verifiedCount
          entry.lastVerifiedAt = new Date().toISOString()
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
      description:
        'Delete one memory entry by id. Requires confirm:true — without it this only returns a preview (id, chars, pinned) and deletes nothing, so check the delete criteria against memory_list first.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Entry id from memory_list.' },
          confirm: { type: 'boolean', description: 'Must be true to actually delete. Omitted/false returns a preview and deletes nothing.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            removed: { type: 'boolean' },
            total: { type: 'integer' },
            confirmRequired: { type: 'boolean' },
            preview: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                chars: { type: 'integer' },
                pinned: { type: 'boolean' },
                kind: { type: 'string' },
                usedCount: { type: 'integer' },
                text: { type: 'string' },
              },
              required: ['id', 'chars', 'pinned'],
              additionalProperties: false,
            },
            hint: { type: 'string' },
          },
          required: ['id', 'removed', 'total'],
          additionalProperties: false,
        },
        render(_args, value) {
          if (value?.removed) {
            return [text(`已删除 ${value?.id}（剩余 ${value?.total ?? 0} 条，下一条模型请求起生效）`)]
          }
          if (value?.confirmRequired === true) {
            const preview = value?.preview ?? {}
            return [
              text(
                [
                  `未删除 ${value?.id}：物理删除不可恢复，需要 confirm:true。`,
                  `将删除：${preview.id}（${preview.chars ?? 0} 字符，${preview.pinned ? 'pinned 置顶条目' : '非 pinned'}）${preview.kind ? '，kind=' + preview.kind : ''}`,
                  `正文：${preview.text ?? ''}`,
                  `先 memory_list 核对删除三查：① 是否已过时？② 以后还有用吗？③ 还有价值吗（history 只留 400 字前缀）？三条全中再用 memory_remove {id:"${value?.id}", confirm:true}。`,
                ].join('\n'),
              ),
            ]
          }
          return [text(`没有这条记忆：${value?.id}`)]
        },
      },
      async execute(args) {
        requireWritable()
        refreshBeforeWrite()
        const id = typeof args?.id === 'string' ? args.id.trim() : ''
        if (id === '') throw fail('MEMORY_ARG_MISSING', 'memory_remove 需要 id。')
        const entry = state.entries.find((item) => item.id === id)
        if (entry === undefined) return { id, removed: false, total: state.entries.length }
        // v4.2.2（B4）：未传 confirm:true → 不删，只把「将删什么」摊开（id / 字符数 / 是否 pinned），
        // 把删除三查交回调用方核对。原来直接 filter + persist，单条物理删比 memory_purge（要 confirm）还宽松。
        if (args?.confirm !== true) {
          return {
            id,
            removed: false,
            total: state.entries.length,
            confirmRequired: true,
            preview: {
              id: entry.id,
              chars: entry.text.length,
              pinned: entry.pinned === true,
              ...(typeof entry.kind === 'string' && entry.kind !== '' ? { kind: entry.kind } : {}),
              ...(Number.isInteger(entry.usedCount) ? { usedCount: entry.usedCount } : {}),
              text: entry.text.length > 120 ? entry.text.slice(0, 120) + '…' : entry.text,
            },
            hint: '未删除：物理删除不可恢复。先 memory_list 核对删除三查（过时 / 以后还有用 / 还有价值），确认后 memory_remove {id:"' + id + '", confirm:true}。',
          }
        }
        state.entries = state.entries.filter((item) => item.id !== id)
        persist()
        return { id, removed: true, total: state.entries.length }
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
            `恢复后会到 ${usedChars() + entry.text.length} / ${maxBytes} 字符，超预算。先用 memory_remove {id, confirm:true} 删掉别的，或调大 maxBytes。`,
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
        'Merge two or more active memories into one atomic entry — get their ids from memory_list first. Originals are kept as superseded history and stop being injected; the merge is atomic, so a failed merge changes nothing.',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: 'At least two active entry ids.' },
          text: { type: 'string', description: 'Merged text; omit to join the originals with 「；」.' },
          tag: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          scope: { type: 'string' },
          kind: { type: 'string', description: 'Merged kind (rule | preference | fact | reference | procedure | note); defaults to the first source kind.' },
          verifiedCount: {
            type: 'integer',
            minimum: 0,
            description: 'v4.2.1: reuse-success count when merging into kind=procedure (>= 2 required); only honored together with kind=procedure.',
          },
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
        // v4.2：procedure 合并同样要过复用门槛（不能把两条普通记忆「合并成」一条流程）。
        // v4.2.1（M3）：证据只认 kind=procedure 的来源（普通条目上不该有计数，也不该被继承），
        // 且与 update 同口径——显式 verifiedCount 优先；没有 procedure 来源时合并成 procedure 必须显式给证据。
        const mergedKind = typeof args?.kind === 'string' && args.kind.trim() !== '' ? args.kind.trim() : typeof first.kind === 'string' ? first.kind : ''
        const mergedSourceVerified = Math.max(
          0,
          ...sources.map((item) => (item.kind === KIND_PROCEDURE && Number.isInteger(item.verifiedCount) ? item.verifiedCount : 0)),
        )
        if (Number.isInteger(args?.verifiedCount) && mergedKind !== KIND_PROCEDURE) {
          throw fail(
            'MEMORY_VERIFIEDCOUNT_INVALID',
            'verifiedCount 只能与 kind=procedure 一起用（本次 mergedKind=' + (mergedKind || '(空)') + '）。',
          )
        }
        const mergedVerified = Number.isInteger(args?.verifiedCount) ? args.verifiedCount : mergedSourceVerified
        if (mergedKind === KIND_PROCEDURE && mergedVerified < PROCEDURE_MIN_VERIFIED) {
          throw fail(
            'MEMORY_PROCEDURE_UNVERIFIED',
            '合并成 procedure 需要「真跑成功 ≥' + PROCEDURE_MIN_VERIFIED + ' 次」的证据：来源里没有 procedure 条目（最高 verifiedCount=' + mergedVerified + '）。' +
              ' 做法：先真跑两遍，再用 memory_merge {ids, kind:"procedure", verifiedCount:' + PROCEDURE_MIN_VERIFIED + '} 显式给证据。',
          )
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
          id: newEntryId(),
          text: mergedText,
          ...(unionAliases.length > 0 ? { aliases: unionAliases } : {}),
          ...(typeof args?.tag === 'string' && args.tag.trim() !== '' ? { tag: args.tag.trim() } : first.tag ? { tag: first.tag } : {}),
          ...(unionTags.length > 0 ? { tags: unionTags } : {}),
          ...(inheritedScope !== '' ? { scope: inheritedScope } : {}),
          ...(mergedKind !== '' ? { kind: mergedKind } : {}),
          ...(mergedKind === KIND_PROCEDURE ? { verifiedCount: mergedVerified, lastVerifiedAt: new Date().toISOString() } : {}),
          ...(unionWorkspaces.length > 0 ? { workspaces: unionWorkspaces } : {}),
          ...(unionPaths.length > 0 ? { paths: unionPaths } : {}),
          ...(unionSources.length > 0 ? { sources: unionSources } : {}),
          ...(importanceValues.length > 0 ? { importance: Math.max(...importanceValues) } : {}),
          ...(staleValues.length > 0 ? { staleAfter: staleValues[0] } : {}),
          ...(args?.pinned === true || first.pinned === true ? { pinned: true } : {}),
          addedAt: now,
          updatedAt: now,
        })
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
          budget: { usedChars: usedChars(), maxBytes, injectedChars: renderOnce('', undefined, undefined, store.lastKnownCwd).length },
          // v4.0：规模判据（E 报告的 <300 / 300–3000 / >3000 三段）+ 触发线文案。
          growth: (() => {
            const entries = state.entries.length
            const avgChars = entries === 0 ? 0 : Math.round(usedChars() / entries)
            const injected = renderOnce('', undefined, undefined, store.lastKnownCwd).length
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
    const block = renderOnce('', undefined, undefined, store.lastKnownCwd)
    const overBudget = block.length > maxInjectChars
    const md = [
      '# 记忆概览',
      '',
      '生成于 ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' · ' + entries.length + ' 条 · 正文 ' + usedChars() + '/' + maxBytes + ' 字符 · 本轮注入 ' + block.length + '/' + maxInjectChars + (overBudget ? '（超 ' + (block.length - maxInjectChars) + '）' : ''),
      '',
      ...section('⏰ 已过期待重验', overdue, 'memory_update 重验，或 supersede 推倒'),
      ...section('❓ 未证实', unverified, 'memory_update 加 verified:true 确认'),
      ...section('🕸 从未被引用', unused, '考虑 memory_remove {id, confirm:true} 或 memory_merge'),
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
        if (args?.write !== false && store.storeHealth === 'ok') {
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
          if (store.lastKnownCwd === '') throw fail('MEMORY_CWD_UNAVAILABLE', 'no-cwd')
          const taken = new Set()
          for (const entry of state.entries) taken.add(entry.text)
          for (const item of candidates.items ?? []) taken.add(item.text)
          let added = 0
          for (const ruleFile of collectRuleFiles(store.lastKnownCwd)) {
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
            id: newEntryId(),
            text: item.text,
            ...(typeof item.scope === 'string' ? { scope: item.scope } : {}),
            ...(typeof item.kind === 'string' ? { kind: item.kind } : {}),
            tags: ['candidate'],
            addedAt: now,
            updatedAt: now,
          })
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
            codeFingerprint: { type: 'string' },
            maintenance: {
              type: 'object',
              properties: {
                lastRunAt: { type: 'string' },
                archived: { type: 'integer' },
                promoted: { type: 'integer' },
              },
              additionalProperties: false,
            },
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
          const maint = value?.maintenance
          const maintLine =
            maint && typeof maint.lastRunAt === 'string' && maint.lastRunAt !== ''
              ? `\n维护循环：上次 ${maint.lastRunAt.slice(0, 19).replace('T', ' ')} · 归档 ${maint.archived ?? 0} · 巩固 ${maint.promoted ?? 0}`
              : '\n维护循环：尚未运行（读路径触发，6h 节流）'
          return [
            text(
              `记忆库可用：${value?.active ?? 0} 条生效 / ${value?.archived ?? 0} 条归档，存储 ${value?.usedChars ?? 0}/${value?.maxBytes ?? 0} 字符，本轮注入预算 ${value?.maxInjectChars ?? 0} 字符，库文件 ${value?.storeFile ?? '?'}${maintLine}\n代码指纹 ${value?.codeFingerprint ?? '?'}`,
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

        if (store.storeHealth === 'corrupt') {
          note(
            'MEMORY_STORE_CORRUPT',
            '记忆库损坏保护中：原文件已另存为 ' +
              (store.corruptCopy || storeFile) +
              '，写入被禁用；人工把合法 JSON 改名回原路径并重载插件后才恢复',
          )
        }
        if (store.storeHealth === 'readonly') {
          note('MEMORY_STORE_READONLY', '记忆库上次落盘失败，已降级为只读；修好磁盘/权限后重载插件')
        }
        if (config?.storeDir !== undefined && (typeof config.storeDir !== 'string' || config.storeDir.trim() === '')) {
          note('MEMORY_CONFIG_INVALID', '配置 storeDir 无效（需要非空字符串），已回落到默认目录')
        }

        let storeExists = false
        let storeBytes = 0
        // v4.1：SQLite 后端下「存储文件」是 memory.db；memory.json 只作迁移源/回滚备份保留。
        const statusStoreFile = backend === 'sqlite' ? store.dbFile : storeFile
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
          health: store.storeHealth,
          ...(store.corruptCopy !== '' ? { corruptCopy: store.corruptCopy } : {}),
          schemaVersion: Number.isInteger(state.version) ? state.version : SCHEMA_VERSION,
          entries: state.entries.length,
          active,
          archived: state.entries.length - active,
          usedChars: usedChars(),
          maxBytes,
          maxInjectChars,
          ...(configWarning !== '' ? { configWarning } : {}),
          // v4.4：维护循环（curate 过期归档 / consolidate draft→stable）的上一次运行结果，供诊断「自动生命周期有没有在跑」。
          maintenance: store.maintenance,
          // 代码指纹：真机验证「HMR 是否已加载本版代码」的可观测点（2026-11-05 验收补强）。
          // 本文件任何行为改动后必须同步更新此指纹，否则进程内新旧代码无法区分。
          codeFingerprint: '4.8.0-profile',
        }
      },
    }),
  )
}
