export default defineEventHandler(async (event) => {
  await requireUser(event)
  const { q, limit } = getQuery(event)
  if (typeof q !== 'string' || !q.trim()) return { hits: [] }
  const client = await userClient(event)
  const { data, error } = await client.rpc('rf_search_items', {
    q: q.trim(),
    lim: Number(limit) || 20
  })
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return { hits: data ?? [] }
})
