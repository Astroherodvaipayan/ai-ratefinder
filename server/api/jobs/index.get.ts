export default defineEventHandler(async (event) => {
  await requireUser(event)
  const client = await userClient(event)
  const { data, error } = await client
    .from('jobs')
    .select('id, kind, status, title, vendor_id, created_at, updated_at')
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return data
})
