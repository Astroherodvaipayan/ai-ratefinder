export default defineEventHandler(async (event) => {
  await requireUser(event)
  const id = getRouterParam(event, 'id')!
  const client = await userClient(event)

  const { data: doc } = await client
    .from('documents').select('storage_path').eq('id', id).single()
  if (doc?.storage_path) {
    await client.storage.from('uploads').remove([doc.storage_path])
  }

  const { error } = await client.from('documents').delete().eq('id', id)
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return { ok: true }
})
