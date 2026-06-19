import { searchItems } from '../utils/search/searchItems'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const { q, limit, vendor_id: vendorId, document_id: documentId } = getQuery(event)
  if (typeof q !== 'string' || !q.trim()) return { hits: [] }
  const client = await userClient(event)
  const lim = Number(limit) || 20
  const result = await searchItems({
    client,
    tenantId: user.id,
    message: q.trim(),
    vendorId: typeof vendorId === 'string' ? vendorId : null,
    documentId: typeof documentId === 'string' ? documentId : null,
    limitPerItem: lim
  })

  return {
    hits: result.priced_items,
    unresolved_items: result.unresolved_items,
    explanations: result.explanations
  }
})
