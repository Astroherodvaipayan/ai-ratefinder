export default defineEventHandler(async (event) => {
  await requireUser(event)
  const id = getRouterParam(event, 'id')!
  const client = await userClient(event)
  const { data, error } = await client
    .from('job_messages')
    .select('id, role, content, data, created_at')
    .eq('job_id', id)
    .order('created_at', { ascending: true })
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return data
})
