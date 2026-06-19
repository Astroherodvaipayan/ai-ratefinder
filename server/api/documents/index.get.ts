export default defineEventHandler(async (event) => {
  await requireUser(event)
  const client = await userClient(event)
  const { data, error } = await client
    .from('documents')
    .select(`
      id, owner_id, filename, mime, size, status, page_count, error, created_at, chandra_request_id,
      vendor:vendor_id(id, name),
      doc_items(count)
    `)
    .order('created_at', { ascending: false })
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return (data ?? []).map((d: any) => ({
    ...d,
    parsed_with_internal: d.status === 'parsed' && !d.chandra_request_id,
    chandra_request_id: undefined,
    item_count: d.doc_items?.[0]?.count ?? 0,
    doc_items: undefined
  }))
})
