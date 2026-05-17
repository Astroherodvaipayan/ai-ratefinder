export default defineEventHandler(async (event) => {
  await requireUser(event)
  const client = await userClient(event)
  const { data, error } = await client
    .from('chats')
    .select('id, title, quotation_id, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(50)
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return data
})
