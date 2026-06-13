/** GET /api/quotations/:id/export?format=pdf|xlsx */
import { renderQuotationPdf } from '../../../utils/pdf'
import { renderQuotationXlsx } from '../../../utils/xlsx'

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const id = getRouterParam(event, 'id')!
  const format = (getQuery(event).format ?? 'pdf') as 'pdf' | 'xlsx'
  const client = await userClient(event)

  const { data: q, error } = await client
    .from('quotations').select('*').eq('id', id).single()
  if (error || !q) throw createError({ statusCode: 404, statusMessage: error?.message ?? 'not found' })

  const { data: items } = await client
    .from('quotation_items').select('*').eq('quotation_id', id)
    .order('line_no', { ascending: true })

  const payload = {
    title:        q.title,
    customer:     q.customer,
    discount_pct: Number(q.discount_pct),
    gst_pct:      Number(q.gst_pct),
    freight:      Number(q.freight),
    notes:        q.notes,
    payment_terms: q.payment_terms,
    delivery_terms: q.delivery_terms,
    validity: q.validity,
    revision_no: Number(q.revision_no ?? 1),
    items: (items ?? []).map((i: any) => ({
      line_no:     Number(i.line_no),
      description: i.description,
      sku:         i.sku,
      unit:        i.unit,
      vendor:      i.vendor,
      qty:         Number(i.qty),
      unit_price:  Number(i.unit_price)
    }))
  }

  const safeName = q.title.replace(/[^a-z0-9-_]+/gi, '_')

  if (format === 'xlsx') {
    const buf = await renderQuotationXlsx(payload)
    setHeader(event, 'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    setHeader(event, 'Content-Disposition', `attachment; filename="${safeName}.xlsx"`)
    return buf
  }

  const buf = await renderQuotationPdf(payload)
  setHeader(event, 'Content-Type', 'application/pdf')
  setHeader(event, 'Content-Disposition', `attachment; filename="${safeName}.pdf"`)
  return buf
})
