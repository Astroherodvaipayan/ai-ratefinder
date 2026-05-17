export default defineEventHandler(async (event) => {
  await requireUser(event)
  const id = getRouterParam(event, 'id')!
  const client = await userClient(event)
  const { data, error } = await client
    .from('chats').select('*').eq('id', id).single()
  if (error) throw createError({ statusCode: 404, statusMessage: error.message })
  return data
})
