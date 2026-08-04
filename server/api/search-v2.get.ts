import { searchCatalogV2 } from '../utils/catalog/searchV2'

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const { q, vendor_id: vendorId, document_id: documentId } = getQuery(event)
  if (typeof q !== 'string' || !q.trim()) throw createError({ statusCode: 400, statusMessage: 'q is required' })
  const client = await userClient(event)
  return await searchCatalogV2({
    client,
    message: q.trim(),
    vendorId: typeof vendorId === 'string' ? vendorId : null,
    documentId: typeof documentId === 'string' ? documentId : null
  })
})
