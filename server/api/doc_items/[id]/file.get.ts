/** Signed URL for the document that contains this doc_item. */
export default defineEventHandler(async (event) => {
  await requireUser(event)
  const id = getRouterParam(event, 'id')!
  const client = await userClient(event)

  const { data: di, error } = await client
    .from('doc_items')
    .select('document_id, source_page, documents:document_id(storage_path, mime)')
    .eq('id', id).single()
  if (error || !di) throw createError({ statusCode: 404, statusMessage: 'not found' })

  const path = (di as any).documents?.storage_path
  if (!path) throw createError({ statusCode: 404, statusMessage: 'no file' })

  const { data, error: signErr } = await client.storage
    .from('uploads').createSignedUrl(path, 300)
  if (signErr || !data) throw createError({ statusCode: 500, statusMessage: signErr?.message ?? 'sign failed' })
  return { url: data.signedUrl, page: di.source_page, mime: (di as any).documents?.mime }
})
