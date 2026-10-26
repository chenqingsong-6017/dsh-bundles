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

import { writeFileSync, readFileSync, renameSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-memory'
export const inject = ['tools', 'systemPrompt']

const DEFAULT_MAX_BYTES = 8000
const DEFAULT_MAX_INJECT_CHARS = 1200
const MAX_TEXT_CHARS = 600
const CONTEXT_ORDER = 900
const INDEX_SUMMARY_CHARS = 48
const MAX_LISTED_INDEX = 10
const MEMORY_HEADER =
  '以下是跨会话记住的用户/项目事实（越靠后越新）。把它们当背景，不要逐条复述；与用户本轮明确指令冲突时，以本轮指令为准。'

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

const lineFull = (entry) => `- ${entry.pinned ? '📌 ' : ''}${entry.text}`

const lineIndex = (entry) => {
  const flat = entry.text.replace(/\s+/g, ' ').trim()
  const summary = flat.length > INDEX_SUMMARY_CHARS ? `${flat.slice(0, INDEX_SUMMARY_CHARS)}…` : flat
  const tag = entry.tag ? ` [${entry.tag}]` : ''
  return `- (${entry.id})${tag} ${summary}`
}

/**
 * 渲染成注入系统提示的块；空记忆返回空串（等于不注入）。
 *
 * 不传 options（或 maxInjectChars 非正数）时是**全量渲染**，保持 v1.0 的行为；
 * 传了 maxInjectChars 就按优先级分层：pinned 优先，其余从新到旧，装不下的降级为索引行。
 */
export function renderMemory(entries, options) {
  if (!Array.isArray(entries) || entries.length === 0) return ''

  const maxInjectChars =
    Number.isInteger(options?.maxInjectChars) && options.maxInjectChars > 0 ? options.maxInjectChars : 0

  if (!maxInjectChars) {
    return ['<memory>', MEMORY_HEADER, ...entries.map(lineFull), '</memory>'].join('\n')
  }

  // 预算里先扣掉包装和头部
  let used = '<memory>'.length + MEMORY_HEADER.length + '</memory>'.length + 3
  const slots = entries.map((entry) => ({ entry, full: false }))

  // 第一优先级：pinned（受总预算约束，装不下的仍降级，避免 pin 太多把预算吃穿）
  for (const slot of slots.filter((item) => item.entry.pinned)) {
    const cost = lineFull(slot.entry).length + 1
    if (used + cost > maxInjectChars) break
    slot.full = true
    used += cost
  }

  // 第二优先级：其余条目从新到旧，连续取到装不下为止
  const olderFirst = slots.filter((item) => !item.entry.pinned).reverse()
  for (const slot of olderFirst) {
    const cost = lineFull(slot.entry).length + 1
    if (used + cost > maxInjectChars) break
    slot.full = true
    used += cost
  }

  const hidden = slots.filter((slot) => !slot.full)
  let hiddenShown = 0
  const lines = slots.map((slot, index) => {
    if (slot.full) return lineFull(slot.entry)
    // 索引行最多列 MAX_LISTED_INDEX 条（只列最新的那些），避免清单本身吃 token
    const fromEnd = slots.length - 1 - index
    if (hiddenShown >= MAX_LISTED_INDEX || fromEnd >= MAX_LISTED_INDEX) return null
    hiddenShown += 1
    return lineIndex(slot.entry)
  })

  const omitted = hidden.length - hiddenShown
  const footer =
    hidden.length > 0
      ? `（${hidden.length} 条未展开${omitted > 0 ? `，其中 ${omitted} 条略去` : ''}；用 memory_search 按关键词取全文）`
      : ''

  return ['<memory>', MEMORY_HEADER, ...lines.filter((line) => line !== null), ...(footer ? [footer] : []), '</memory>'].join(
    '\n',
  )
}

/** 轻量检索打分：整体命中权重高于分词命中；中文没有空格，所以子串匹配是主力。 */
export function scoreMemory(entry, query) {
  const whole = String(query ?? '').trim().toLowerCase()
  if (whole === '') return 0
  const hay = `${entry.text} ${entry.tag ?? ''}`.toLowerCase()
  let score = 0
  if (hay.includes(whole)) score += 3
  const terms = whole.split(/\s+/).filter(Boolean)
  if (terms.length > 1) for (const term of terms) if (hay.includes(term)) score += 2
  return score
}

export function apply(ctx, config) {
  const maxBytes =
    Number.isInteger(config?.maxBytes) && config.maxBytes > 0 ? Math.min(config.maxBytes, 64 * 1024) : DEFAULT_MAX_BYTES
  const maxInjectChars =
    Number.isInteger(config?.maxInjectChars) && config.maxInjectChars > 0
      ? Math.min(config.maxInjectChars, 32 * 1024)
      : DEFAULT_MAX_INJECT_CHARS
  const { dir: storeDir, file: storeFile } = storeLocation(config?.storeDir)
  const tools = ctx.tools

  let state = { version: 1, nextId: 1, entries: [] }

  function persist() {
    try {
      mkdirSync(storeDir, { recursive: true })
      const body = JSON.stringify(state, null, 2)
      const temp = `${storeFile}.tmp`
      writeFileSync(temp, body, 'utf8')
      try {
        renameSync(temp, storeFile)
      } catch (error) {
        writeFileSync(storeFile, body, 'utf8')
      }
      return true
    } catch (error) {
      return false
    }
  }

  function load() {
    try {
      const parsed = JSON.parse(readFileSync(storeFile, 'utf8'))
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
      state = {
        version: 1,
        nextId: Number.isInteger(parsed?.nextId) && parsed.nextId > 0 ? parsed.nextId : entries.length + 1,
        entries: entries
          .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.text === 'string')
          .map((entry) => ({
            id: entry.id,
            text: entry.text,
            ...(typeof entry.tag === 'string' && entry.tag !== '' ? { tag: entry.tag } : {}),
            ...(entry.pinned === true ? { pinned: true } : {}),
            addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : new Date().toISOString(),
            updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date().toISOString(),
          })),
      }
    } catch (error) {
      // 没有存档 / 损坏：从空开始
    }
  }

  load()

  const usedChars = () => state.entries.reduce((sum, entry) => sum + entry.text.length, 0)
  const publicEntry = (entry) => ({
    id: entry.id,
    text: entry.text,
    ...(entry.tag ? { tag: entry.tag } : {}),
    ...(entry.pinned ? { pinned: true } : {}),
    addedAt: entry.addedAt,
    updatedAt: entry.updatedAt,
  })
  const injectedBlock = () => renderMemory(state.entries, { maxInjectChars })
  const listOutput = () => ({
    total: state.entries.length,
    usedChars: usedChars(),
    maxBytes,
    maxInjectChars,
    injectedChars: injectedBlock().length,
    entries: state.entries.map(publicEntry),
    block: injectedBlock(),
  })

  // ---- 注入：每个会话装配系统提示时读取当前记忆（分层，成本封顶） ----
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'dsh-memory',
      order: CONTEXT_ORDER,
      text: () => injectedBlock(),
    }),
  )

  // ---- 工具 ----
  const listSchema = {
    type: 'object',
    properties: {
      total: { type: 'integer' },
      usedChars: { type: 'integer' },
      maxBytes: { type: 'integer' },
      maxInjectChars: { type: 'integer' },
      injectedChars: { type: 'integer' },
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            text: { type: 'string' },
            tag: { type: 'string' },
            pinned: { type: 'boolean' },
            addedAt: { type: 'string' },
            updatedAt: { type: 'string' },
          },
          required: ['id', 'text', 'addedAt', 'updatedAt'],
          additionalProperties: false,
        },
      },
      block: { type: 'string' },
    },
    required: ['total', 'usedChars', 'maxBytes', 'maxInjectChars', 'injectedChars', 'entries', 'block'],
    additionalProperties: false,
  }

  const entrySchema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      text: { type: 'string' },
      tag: { type: 'string' },
      pinned: { type: 'boolean' },
      addedAt: { type: 'string' },
      updatedAt: { type: 'string' },
    },
    required: ['id', 'text', 'addedAt', 'updatedAt'],
    additionalProperties: false,
  }

  const renderList = (_args, value) => {
    const entries = Array.isArray(value?.entries) ? value.entries : []
    const head = `记忆 ${value?.total ?? 0} 条，存储 ${value?.usedChars ?? 0}/${value?.maxBytes ?? 0} 字符，本轮注入 ${value?.injectedChars ?? 0}/${value?.maxInjectChars ?? 0} 字符`
    if (entries.length === 0) return [text(`${head}\n（还没有任何记忆。用 memory_add 写入第一条。）`)]
    const lines = entries.map(
      (entry) => `- ${entry.id}${entry.pinned ? ' 📌' : ''}${entry.tag ? ` [${entry.tag}]` : ''} ${entry.text}`,
    )
    return [text(`${head}\n${lines.join('\n')}`)]
  }

  const applyEntryFlags = (entry, args) => {
    if (args?.pinned === true) entry.pinned = true
    else if (args?.pinned === false) delete entry.pinned
  }

  ctx.effect(() =>
    tools.register({
      name: 'memory_list',
      description:
        'List the persistent memories injected into every session, with ids, tags, pinned flags and the exact injected block. Use it before adding or pruning.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: listSchema,
        render: renderList,
      },
      async execute() {
        return listOutput()
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
            matches: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  tag: { type: 'string' },
                  pinned: { type: 'boolean' },
                  score: { type: 'integer' },
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
          const lines = matches.map((item) => `- ${item.id}${item.pinned ? ' 📌' : ''}${item.tag ? ` [${item.tag}]` : ''} ${item.text}`)
          return [text(`匹配 ${value?.matched ?? 0} / ${value?.total ?? 0} 条：\n${lines.join('\n')}`)]
        },
      },
      async execute(args) {
        const query = typeof args?.query === 'string' ? args.query.trim() : ''
        if (query === '') throw new Error('memory_search 需要 query。')
        const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 20) : 5
        const scored = state.entries
          .map((entry) => ({ entry, score: scoreMemory(entry, query) }))
          .filter((item) => item.score > 0)
          .sort(
            (a, b) =>
              b.score - a.score ||
              String(b.entry.updatedAt).localeCompare(String(a.entry.updatedAt)),
          )
        return {
          query,
          total: state.entries.length,
          matched: scored.length,
          matches: scored.slice(0, limit).map((item) => ({
            id: item.entry.id,
            text: item.entry.text,
            ...(item.entry.tag ? { tag: item.entry.tag } : {}),
            ...(item.entry.pinned ? { pinned: true } : {}),
            score: item.score,
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
          pinned: {
            type: 'boolean',
            description: 'Pin it so it is always injected in full, even when the injection budget is tight. Use it for hard rules.',
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
          },
          required: ['entry', 'deduped', 'usedChars', 'maxBytes'],
          additionalProperties: false,
        },
        render(_args, value) {
          const entry = value?.entry
          const head = value?.deduped ? `已存在相同记忆：${entry?.id}` : `已记住：${entry?.id}${entry?.pinned ? '（已置顶）' : ''}`
          return [text(`${head}\n${entry?.text ?? ''}\n（占用 ${value?.usedChars ?? 0}/${value?.maxBytes ?? 0} 字符，下一条模型请求起生效）`)]
        },
      },
      async execute(args) {
        const raw = typeof args?.text === 'string' ? args.text.trim() : ''
        if (raw === '') throw new Error('memory_add 需要 text。')
        if (raw.length > MAX_TEXT_CHARS) {
          throw new Error(`单条记忆最多 ${MAX_TEXT_CHARS} 字符，当前 ${raw.length}。请拆成多条或精简。`)
        }
        const duplicate = state.entries.find((entry) => entry.text === raw)
        if (duplicate) {
          if (args?.pinned === true && !duplicate.pinned) {
            duplicate.pinned = true
            duplicate.updatedAt = new Date().toISOString()
            persist()
          }
          return { entry: publicEntry(duplicate), deduped: true, usedChars: usedChars(), maxBytes }
        }
        if (usedChars() + raw.length > maxBytes) {
          throw new Error(
            `记忆已占用 ${usedChars()} / ${maxBytes} 字符，再加会超预算。先用 memory_list 看看，用 memory_remove 删掉过时的，或 memory_update 精简。`,
          )
        }
        const now = new Date().toISOString()
        const entry = {
          id: `m${state.nextId}`,
          text: raw,
          ...(typeof args?.tag === 'string' && args.tag.trim() !== '' ? { tag: args.tag.trim() } : {}),
          ...(args?.pinned === true ? { pinned: true } : {}),
          addedAt: now,
          updatedAt: now,
        }
        state.nextId += 1
        state.entries.push(entry)
        persist()
        return { entry: publicEntry(entry), deduped: false, usedChars: usedChars(), maxBytes }
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
          pinned: { type: 'boolean', description: 'true pins it to always-injected, false unpins.' },
        },
        required: ['id', 'text'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { entry: entrySchema, usedChars: { type: 'integer' } },
          required: ['entry', 'usedChars'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [text(`已更新 ${value?.entry?.id}：\n${value?.entry?.text ?? ''}\n（占用 ${value?.usedChars ?? 0} 字符）`)]
        },
      },
      async execute(args) {
        const id = typeof args?.id === 'string' ? args.id.trim() : ''
        const next = typeof args?.text === 'string' ? args.text.trim() : ''
        if (id === '') throw new Error('memory_update 需要 id。')
        if (next === '') throw new Error('memory_update 需要新的 text；要删除请用 memory_remove。')
        if (next.length > MAX_TEXT_CHARS) throw new Error(`单条记忆最多 ${MAX_TEXT_CHARS} 字符。`)
        const entry = state.entries.find((item) => item.id === id)
        if (!entry) throw new Error(`没有这条记忆：${id}。先用 memory_list 查看。`)
        const projected = usedChars() - entry.text.length + next.length
        if (projected > maxBytes) {
          throw new Error(`更新后会到 ${projected} / ${maxBytes} 字符，超预算。请精简或先删掉别的条目。`)
        }
        entry.text = next
        if (typeof args?.tag === 'string' && args.tag.trim() !== '') entry.tag = args.tag.trim()
        applyEntryFlags(entry, args)
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
        const id = typeof args?.id === 'string' ? args.id.trim() : ''
        if (id === '') throw new Error('memory_remove 需要 id。')
        const before = state.entries.length
        state.entries = state.entries.filter((entry) => entry.id !== id)
        const removed = state.entries.length !== before
        if (removed) persist()
        return { id, removed, total: state.entries.length }
      },
    }),
  )
}
