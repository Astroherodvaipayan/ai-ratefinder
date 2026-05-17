export default defineEventHandler(async (event) => {
  await requireUser(event)
  const { q, limit } = getQuery(event)
  if (typeof q !== 'string' || !q.trim()) return { hits: [] }
  const client = await userClient(event)
  const hits = await matchProducts(client, q.trim(), Number(limit) || 20)
  return { hits }
})
