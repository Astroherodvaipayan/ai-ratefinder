export default defineEventHandler(async (event) => {
  await requireUser(event)
  const id = getRouterParam(event, 'id')!
  const client = await userClient(event)

  const { data: doc, error } = await client
    .from('documents')
    .select('*, vendor:vendor_id(id, name)')
    .eq('id', id)
    .single()
  if (error) throw createError({ statusCode: 404, statusMessage: error.message })

  const { data: items } = await client
    .from('doc_items')
    .select('id, raw_name, sku, unit, price, moq, currency, source_page')
    .eq('document_id', id)
    .order('source_page', { ascending: true })
    .order('raw_name', { ascending: true })

  return { ...doc, items: items ?? [] }
})
