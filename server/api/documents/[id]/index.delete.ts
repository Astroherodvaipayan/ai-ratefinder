export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id')!
  const client = await userClient(event)

  const { data: doc } = await client
    .from('documents').select('owner_id, storage_path').eq('id', id).single()
  if (!doc) throw createError({ statusCode: 404, statusMessage: 'Document not found' })
  if (doc.owner_id !== user.id) {
    throw createError({ statusCode: 403, statusMessage: 'Only the uploader can delete this document.' })
  }

  if (doc?.storage_path) {
    await client.storage.from('uploads').remove([doc.storage_path])
  }

  const { error } = await client.from('documents').delete().eq('id', id)
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return { ok: true }
})
