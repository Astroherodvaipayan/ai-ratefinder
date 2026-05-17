import { computeTotals } from '../../../utils/totals'

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const id = getRouterParam(event, 'id')!
  const client = await userClient(event)

  const { data: q, error } = await client
    .from('quotations').select('*').eq('id', id).single()
  if (error || !q) throw createError({ statusCode: 404, statusMessage: error?.message ?? 'not found' })

  const { data: items } = await client
    .from('quotation_items')
    .select('*')
    .eq('quotation_id', id)
    .order('line_no', { ascending: true })

  const lines = (items ?? []) as any[]
  const totals = computeTotals(lines, {
    discount_pct: q.discount_pct, gst_pct: q.gst_pct, freight: q.freight
  })

  return { ...q, items: lines, totals }
})
