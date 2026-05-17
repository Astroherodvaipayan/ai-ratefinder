export default defineEventHandler(async (event) => {
  await requireUser(event)
  const client = await userClient(event)
  const { data, error } = await client
    .from('vendors')
    .select('id, name, notes, created_at')
    .order('created_at', { ascending: false })
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return data
})
