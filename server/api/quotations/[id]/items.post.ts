/**
 * Add a line to a quotation.
 *
 *   - If `doc_item_id` is supplied, we copy description / sku / unit / price
 *     from that doc_item (server-side, so the client can't fake a price).
 *   - Otherwise, the client supplies all fields directly.
 */
import { z } from 'zod'

const Body = z.object({
  doc_item_id: z.string().uuid().optional(),
  description: z.string().optional(),
  sku:         z.string().nullable().optional(),
  unit:        z.string().nullable().optional(),
  vendor:      z.string().nullable().optional(),
  qty:         z.number().min(0).default(1),
  unit_price:  z.number().min(0).optional(),
  source_page: z.number().int().nullable().optional()
})

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const quotationId = getRouterParam(event, 'id')!
  const body = Body.parse(await readBody(event))
  const client = await userClient(event)

  let line: any = {
    quotation_id: quotationId,
    description: body.description ?? '',
    sku:         body.sku         ?? null,
    unit:        body.unit        ?? null,
    vendor:      body.vendor      ?? null,
    qty:         body.qty,
    unit_price:  body.unit_price  ?? 0,
    source_page: body.source_page ?? null
  }

  if (body.doc_item_id) {
    const { data: di, error } = await client
      .from('doc_items')
      .select('id, raw_name, sku, unit, price, source_page, document_id, documents:document_id(filename, vendor:vendor_id(name))')
      .eq('id', body.doc_item_id).single()
    if (error || !di) throw createError({ statusCode: 404, statusMessage: 'doc_item not found' })

    line = {
      ...line,
      doc_item_id:        di.id,
      source_document_id: (di as any).document_id,
      description: body.description ?? di.raw_name,
      sku:         body.sku  ?? di.sku,
      unit:        body.unit ?? di.unit,
      vendor:      body.vendor ?? (di as any).documents?.vendor?.name ?? null,
      unit_price:  body.unit_price ?? Number(di.price ?? 0),
      source_page: body.source_page ?? di.source_page
    }
  }

  // Append at the end.
  const { data: last } = await client
    .from('quotation_items').select('line_no')
    .eq('quotation_id', quotationId)
    .order('line_no', { ascending: false }).limit(1).maybeSingle()
  line.line_no = (last?.line_no ?? 0) + 1

  const { data, error } = await client.from('quotation_items').insert(line).select().single()
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })

  await client.from('quotations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', quotationId)

  return data
})
