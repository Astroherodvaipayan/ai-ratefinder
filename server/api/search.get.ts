import { searchDocItemHits } from '../utils/retrieval'

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const { q, limit } = getQuery(event)
  if (typeof q !== 'string' || !q.trim()) return { hits: [] }
  const client = await userClient(event)
  const lim = Number(limit) || 20

  return {
    hits: await searchDocItemHits(client, q.trim(), lim)
  }
})
