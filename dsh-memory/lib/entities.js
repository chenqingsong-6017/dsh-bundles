/**
 * 零模型实体共现图（v4.6）。不建实体表、不建边表、不抽 LLM。
 * 从条目的 entities 标签现场构建倒排，回答「哪些记忆提到 X」「X 和谁共现」。
 * 这是 Graphiti 实体图的最小零模型版——只做共现，不做语义关系（那是 LLM 的活）。
 */
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
