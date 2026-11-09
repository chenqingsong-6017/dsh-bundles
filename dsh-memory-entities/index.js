/**
 * dsh-memory-entities —— 零模型实体共现图（独立插件）。
 * 职责单一：读 dsh-memory 的 memory.db，查实体出现在哪些记忆、与谁共现。
 * 只读不写；数据唯一真源是 memory.db，不依赖 dsh-memory 运行时（整体强=各插件职责清晰+靠同一份数据协同）。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'

export const name = 'dsh-memory-entities'
export const inject = ['tools']

const fail = (code, message) => { const error = new Error(message); error.code = code; return error }
const text = (value) => ({ type: 'text', text: value })

/** 零模型共现：不建实体表、不建边表、不抽 LLM，从条目 entities 标签现场构建倒排。 */
export function queryEntity(entries, name) {
  const key = String(name ?? '').trim().toLowerCase()
  if (key === '') return { entity: String(name ?? ''), count: 0, memories: [], cooccurring: [] }
  const memories = []
  const cooc = new Map()
  for (const entry of entries) {
    if (!Array.isArray(entry.entities)) continue
    const hit = entry.entities.some((x) => String(x).trim().toLowerCase() === key)
    if (!hit) continue
    memories.push({ id: entry.id, text: entry.text })
    for (const raw of entry.entities) {
      const k = String(raw).trim().toLowerCase()
      if (k !== '' && k !== key) cooc.set(k, (cooc.get(k) ?? 0) + 1)
    }
  }
  return {
    entity: String(name ?? ''),
    count: memories.length,
    memories,
    cooccurring: [...cooc.entries()].sort((a, b) => b[1] - a[1]).map(([entity, count]) => ({ entity, count })),
  }
}

export function apply(ctx, config) {
  const dbPath = typeof config?.storeFile === 'string' && config.storeFile !== '' ? config.storeFile : 'D:\\AI\\dsh-data\\memory\\memory.db'
  const tools = ctx.tools

  function loadEntries() {
    if (!existsSync(dbPath)) return []
    const db = new DatabaseSync(dbPath)
    try {
      return db.prepare('SELECT id, payload FROM entries ORDER BY seq').all()
        .map((row) => { try { return JSON.parse(row.payload) } catch { return null } })
        .filter((e) => e && typeof e.id === 'string' && typeof e.text === 'string' && typeof e.supersededBy !== 'string' && e.status !== 'deprecated')
    } finally {
      db.close()
    }
  }

  ctx.effect(() =>
    tools.register({
      name: 'memory_entities',
      description: 'Query the zero-model entity co-occurrence graph over dsh-memory: which memories mention an entity, and which entities co-occur with it. Read-only; answer how X and Y relate via shared memories.',
      parameters: {
        type: 'object',
        properties: {
          entity: { type: 'string', description: 'Entity label (case-insensitive), e.g. dsh-memory or Obsidian.' },
        },
        required: ['entity'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            entity: { type: 'string' },
            count: { type: 'integer' },
            memories: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'], additionalProperties: false } },
            cooccurring: { type: 'array', items: { type: 'object', properties: { entity: { type: 'string' }, count: { type: 'integer' } }, required: ['entity', 'count'], additionalProperties: false } },
          },
          required: ['entity', 'count', 'memories', 'cooccurring'],
          additionalProperties: false,
        },
      },
      render(_args, value) {
        const mems = Array.isArray(value?.memories) ? value.memories : []
        const cooc = Array.isArray(value?.cooccurring) ? value.cooccurring : []
        if (mems.length === 0) return [text('没有记忆提到实体「' + (value?.entity ?? '') + '」。')]
        const lines = mems.map((m) => '- ' + m.id + ' ' + m.text)
        if (cooc.length > 0) lines.push('共现实体：' + cooc.map((c) => c.entity + '(' + c.count + ')').join('、'))
        return [text('实体「' + value?.entity + '」出现在 ' + value?.count + ' 条记忆：\n' + lines.join('\n'))]
      },
      async execute(args) {
        const name = String(args?.entity ?? '').trim()
        if (name === '') throw fail('MEMORY_ARG_MISSING', 'memory_entities 需要 entity。')
        return queryEntity(loadEntries(), name)
      },
    }),
  )
}
