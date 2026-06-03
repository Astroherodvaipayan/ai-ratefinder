import { searchShards } from '../utils/retrieval'

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const { q, limit } = getQuery(event)
  if (typeof q !== 'string' || !q.trim()) return { hits: [] }
  const client = await userClient(event)
  const lim = Number(limit) || 20
  const hitsById = new Map<string, any>()

  for (const [queryIndex, shard] of searchShards(q.trim()).entries()) {
    const { data, error } = await client.rpc('rf_search_items', {
      q: shard,
      lim: queryIndex === 0 ? lim : Math.max(5, Math.ceil(lim / 2))
    })
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    for (const [hitIndex, hit] of ((data ?? []) as any[]).entries()) {
      const rank = queryIndex * 100 + hitIndex
      const existing = hitsById.get(hit.doc_item_id)
      if (!existing || rank < existing.rank) hitsById.set(hit.doc_item_id, { ...hit, rank })
    }
  }

  return {
    hits: [...hitsById.values()]
      .sort((a, b) => a.rank - b.rank)
      .slice(0, lim)
      .map(({ rank: _rank, ...hit }) => hit)
  }
})
