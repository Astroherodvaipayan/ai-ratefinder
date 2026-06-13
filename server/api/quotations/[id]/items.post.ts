/**
 * Add a line to a quotation.
 *
 * Price lines must originate from indexed source records. We copy description,
 * sku, unit, vendor, source, and price server-side so the client cannot create
 * or override a sourced rate while adding it.
 */
import { z } from 'zod'

const Body = z.object({
  doc_price_item_id: z.string().uuid().optional(),
  doc_item_id: z.string().uuid().optional(),
  qty: z.number().positive().default(1),
  review_confirmed: z.boolean().optional()
})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const quotationId = getRouterParam(event, 'id')!
  const body = Body.parse(await readBody(event))
  const client = await userClient(event)

  if (!body.doc_price_item_id && !body.doc_item_id) {
    throw createError({
      statusCode: 400,
      statusMessage: 'A source-backed price record is required to add a quotation line.'
    })
  }

  let line: any = {
    quotation_id: quotationId,
    qty: body.qty
  }

  if (body.doc_price_item_id) {
    const { data: dpi, error } = await client
      .from('doc_price_items')
      .select('id, legacy_doc_item_id, document_id, product_text, sku_text, description_text, unit, normalized_price, source_page, documents:document_id(filename, vendor:vendor_id(name))')
      .eq('id', body.doc_price_item_id).single()
    if (error || !dpi) throw createError({ statusCode: 404, statusMessage: 'doc_price_item not found' })

    line = {
      ...line,
      doc_price_item_id: dpi.id,
      doc_item_id: (dpi as any).legacy_doc_item_id,
      source_document_id: (dpi as any).document_id,
      description: (dpi as any).description_text ?? (dpi as any).product_text ?? 'Priced item',
      sku: (dpi as any).sku_text,
      unit: (dpi as any).unit,
      vendor: (dpi as any).documents?.vendor?.name ?? null,
      unit_price: Number((dpi as any).normalized_price ?? 0),
      source_page: (dpi as any).source_page
    }
  } else if (body.doc_item_id) {
    const { data: di, error } = await client
      .from('doc_items')
      .select('id, raw_name, sku, unit, price, source_page, document_id, documents:document_id(filename, vendor:vendor_id(name))')
      .eq('id', body.doc_item_id).single()
    if (error || !di) throw createError({ statusCode: 404, statusMessage: 'doc_item not found' })

    line = {
      ...line,
      doc_item_id:        di.id,
      source_document_id: (di as any).document_id,
      description: di.raw_name,
      sku:         di.sku,
      unit:        di.unit,
      vendor:      (di as any).documents?.vendor?.name ?? null,
      unit_price:  Number(di.price ?? 0),
      source_page: di.source_page
    }
  }

  const existing = await findExistingLine(client, quotationId, {
    doc_price_item_id: line.doc_price_item_id,
    doc_item_id: line.doc_item_id
  })

  if (existing) {
    const nextQty = Number(existing.qty ?? 0) + Number(body.qty)
    const { data, error } = await client
      .from('quotation_items')
      .update({ qty: nextQty })
      .eq('id', existing.id)
      .select()
      .single()
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    await client.from('quotations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', quotationId)

    await logQuotationItemAction(client, {
      quotationId,
      quotationItemId: existing.id,
      userId: user.id,
      action: 'merged_duplicate',
      reviewConfirmed: body.review_confirmed ?? false,
      metadata: {
        added_qty: body.qty,
        previous_qty: Number(existing.qty ?? 0),
        next_qty: nextQty
      }
    })

    return data
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

  await logQuotationItemAction(client, {
    quotationId,
    quotationItemId: data.id,
    userId: user.id,
    action: body.review_confirmed ? 'review_confirmed_add' : 'add',
    reviewConfirmed: body.review_confirmed ?? false,
    metadata: {
      doc_price_item_id: line.doc_price_item_id ?? null,
      doc_item_id: line.doc_item_id ?? null
    }
  })

  return data
})

async function findExistingLine(
  client: Awaited<ReturnType<typeof userClient>>,
  quotationId: string,
  source: { doc_price_item_id?: string | null; doc_item_id?: string | null }
) {
  if (source.doc_price_item_id) {
    const { data } = await client
      .from('quotation_items')
      .select('id, qty')
      .eq('quotation_id', quotationId)
      .eq('doc_price_item_id', source.doc_price_item_id)
      .maybeSingle()
    if (data) return data as any
  }

  if (source.doc_item_id) {
    const { data } = await client
      .from('quotation_items')
      .select('id, qty')
      .eq('quotation_id', quotationId)
      .eq('doc_item_id', source.doc_item_id)
      .maybeSingle()
    if (data) return data as any
  }

  return null
}

async function logQuotationItemAction(
  client: Awaited<ReturnType<typeof userClient>>,
  params: {
    quotationId: string
    quotationItemId: string
    userId: string
    action: string
    reviewConfirmed: boolean
    metadata: Record<string, unknown>
  }
) {
  const { error } = await client.from('quotation_item_audit_logs').insert({
    quotation_id: params.quotationId,
    quotation_item_id: params.quotationItemId,
    actor_id: params.userId,
    action: params.action,
    review_confirmed: params.reviewConfirmed,
    metadata: params.metadata
  })
  if (error && !/quotation_item_audit_logs/i.test(error.message)) {
    console.warn('Could not persist quotation item audit log', error.message)
  }
}
