import { enqueueIngest, processUploadedDocument } from '../index.post'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id')!
  const client = await userClient(event)

  const { data: doc, error } = await client
    .from('documents')
    .select('id, owner_id, vendor_id, filename, storage_path, mime')
    .eq('id', id)
    .single()

  if (error || !doc) {
    throw createError({ statusCode: 404, statusMessage: error?.message ?? 'Document not found' })
  }

  if (doc.owner_id !== user.id) {
    throw createError({ statusCode: 403, statusMessage: 'Not allowed' })
  }

  await client.from('doc_items').delete().eq('document_id', id)

  const { error: updateError } = await client
    .from('documents')
    .update({
      status: 'ocr',
      error: null,
      parsed_markdown: null,
      page_count: null,
      chandra_request_id: null,
      updated_at: new Date().toISOString()
    })
    .eq('id', id)

  if (updateError) {
    throw createError({ statusCode: 500, statusMessage: updateError.message })
  }

  enqueueIngest(event, processUploadedDocument({
    doc: {
      id: doc.id as string,
      owner_id: user.id,
      vendor_id: doc.vendor_id as string | null
    },
    filename: doc.filename as string,
    mime: doc.mime ?? undefined,
    storagePath: doc.storage_path as string,
    storageAlreadyUploaded: true
  }))

  setResponseStatus(event, 202)
  return { ok: true, status: 'ocr' }
})
