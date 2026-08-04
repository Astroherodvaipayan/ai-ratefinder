/**
 * Add a line to a quotation.
 *
 * Price lines must originate from indexed source records. We copy description,
 * sku, unit, vendor, source, and price server-side so the client cannot create
 * or override a sourced rate while adding it.
 */
import { z } from 'zod'
import { inferPriceBasis, quotationRateForBasis } from '../../../utils/search/priceBasis'

const Body = z.object({
  catalog_offer_id: z.string().uuid().optional(),
  doc_price_item_id: z.string().uuid().optional(),
  doc_item_id: z.string().uuid().optional(),
  qty: z.number().positive().default(1),
  requested_unit: z.string().nullable().optional(),
  review_confirmed: z.boolean().optional()
})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const quotationId = getRouterParam(event, 'id')!
  const body = Body.parse(await readBody(event))
  const client = await userClient(event)

  if (!body.catalog_offer_id && !body.doc_price_item_id && !body.doc_item_id) {
    throw createError({
      statusCode: 400,
      statusMessage: 'A source-backed price record is required to add a quotation line.'
    })
  }

  let line: any = {
    quotation_id: quotationId,
    qty: body.qty
  }

  if (body.catalog_offer_id) {
    const { data: release, error: releaseError } = await client
      .from('catalog_releases')
      .select('id')
      .eq('status', 'active')
      .single()
    if (releaseError || !release) throw createError({ statusCode: 503, statusMessage: 'No active catalogue release is available' })
    const { data: offer, error } = await client
      .from('catalog_offers')
      .select('id, document_id, canonical_name, sku, amount, basis_quantity, basis_unit, package_type, source_page, documents:document_id(filename, vendor:vendor_id(name))')
      .eq('id', body.catalog_offer_id)
      .eq('release_id', release.id)
      .eq('status', 'published')
      .single()
    if (error || !offer) throw createError({ statusCode: 404, statusMessage: 'catalog_offer not found in the active release' })
    const sourceQuantity = Number((offer as any).basis_quantity ?? 1) || 1
    const sourceUnit = (offer as any).basis_unit ?? null
    const sourcePrice = Number((offer as any).amount)
    const basis = {
      source_price: sourcePrice,
      source_basis_quantity: sourceQuantity,
      source_basis_unit: sourceUnit,
      source_basis_pack_unit: (offer as any).package_type ?? null,
      source_basis_label: sourceUnit
        ? [sourceQuantity === 1 ? null : sourceQuantity, sourceUnit, (offer as any).package_type].filter(Boolean).join(' ')
        : null,
      effective_unit_price: sourceUnit ? sourcePrice / sourceQuantity : sourcePrice,
      effective_unit: sourceUnit
    }
    const rate = quotationRateForBasis(basis, { value: body.qty, unit: body.requested_unit ?? null })
    line = {
      ...line,
      catalog_offer_id: offer.id,
      source_document_id: (offer as any).document_id,
      description: (offer as any).canonical_name,
      sku: (offer as any).sku,
      unit: rate.unit,
      vendor: (offer as any).documents?.vendor?.name ?? null,
      qty: rate.qty,
      unit_price: rate.unit_price,
      source_page: (offer as any).source_page
    }
  } else if (body.doc_price_item_id) {
    const { data: dpi, error } = await client
      .from('doc_price_items')
      .select('id, legacy_doc_item_id, document_id, product_text, sku_text, description_text, unit, normalized_price, moq, source_page, raw_cell_value, searchable_text, table_title, row_headers, column_headers, parent_headers, nearby_notes, section_breadcrumb, documents:document_id(filename, vendor:vendor_id(name))')
      .eq('id', body.doc_price_item_id).single()
    if (error || !dpi) throw createError({ statusCode: 404, statusMessage: 'doc_price_item not found' })
    const rate = quotationRateForBasis(inferPriceBasis({
      price: Number((dpi as any).normalized_price ?? 0),
      unit: (dpi as any).unit,
      moq: (dpi as any).moq,
      raw_cell_value: (dpi as any).raw_cell_value,
      searchable_text: (dpi as any).searchable_text,
      description_text: (dpi as any).description_text,
      product_text: (dpi as any).product_text,
      table_title: (dpi as any).table_title,
      row_headers: (dpi as any).row_headers,
      column_headers: (dpi as any).column_headers,
      parent_headers: (dpi as any).parent_headers,
      nearby_notes: (dpi as any).nearby_notes,
      section_breadcrumb: (dpi as any).section_breadcrumb
    }), { value: body.qty, unit: body.requested_unit ?? null })

    line = {
      ...line,
      doc_price_item_id: dpi.id,
      doc_item_id: (dpi as any).legacy_doc_item_id,
      source_document_id: (dpi as any).document_id,
      description: (dpi as any).description_text ?? (dpi as any).product_text ?? 'Priced item',
      sku: (dpi as any).sku_text,
      unit: rate.unit,
      vendor: (dpi as any).documents?.vendor?.name ?? null,
      qty: rate.qty,
      unit_price: rate.unit_price,
      source_page: (dpi as any).source_page
    }
  } else if (body.doc_item_id) {
    const { data: di, error } = await client
      .from('doc_items')
      .select('id, raw_name, sku, unit, price, source_page, document_id, documents:document_id(filename, vendor:vendor_id(name))')
      .eq('id', body.doc_item_id).single()
    if (error || !di) throw createError({ statusCode: 404, statusMessage: 'doc_item not found' })
    const rate = quotationRateForBasis(inferPriceBasis({
      price: Number(di.price ?? 0),
      unit: di.unit,
      description_text: di.raw_name,
      product_text: di.sku
    }), { value: body.qty, unit: body.requested_unit ?? null })

    line = {
      ...line,
      doc_item_id:        di.id,
      source_document_id: (di as any).document_id,
      description: di.raw_name,
      sku:         di.sku,
      unit:        rate.unit,
      vendor:      (di as any).documents?.vendor?.name ?? null,
      qty:         rate.qty,
      unit_price:  rate.unit_price,
      source_page: di.source_page
    }
  }

  const existing = await findExistingLine(client, quotationId, {
    catalog_offer_id: line.catalog_offer_id,
    doc_price_item_id: line.doc_price_item_id,
    doc_item_id: line.doc_item_id,
    unit: line.unit
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
        catalog_offer_id: line.catalog_offer_id ?? null,
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
      catalog_offer_id: line.catalog_offer_id ?? null,
      doc_price_item_id: line.doc_price_item_id ?? null,
      doc_item_id: line.doc_item_id ?? null
    }
  })

  return data
})

async function findExistingLine(
  client: Awaited<ReturnType<typeof userClient>>,
  quotationId: string,
  source: { catalog_offer_id?: string | null; doc_price_item_id?: string | null; doc_item_id?: string | null; unit?: string | null }
) {
  if (source.catalog_offer_id) {
    let query = client
      .from('quotation_items')
      .select('id, qty')
      .eq('quotation_id', quotationId)
      .eq('catalog_offer_id', source.catalog_offer_id)
    query = source.unit ? query.eq('unit', source.unit) : query.is('unit', null)
    const { data } = await query.maybeSingle()
    if (data) return data as any
  }
  if (source.doc_price_item_id) {
    let query = client
      .from('quotation_items')
      .select('id, qty')
      .eq('quotation_id', quotationId)
      .eq('doc_price_item_id', source.doc_price_item_id)
    query = source.unit ? query.eq('unit', source.unit) : query.is('unit', null)
    const { data } = await query
      .maybeSingle()
    if (data) return data as any
  }

  if (source.doc_item_id) {
    let query = client
      .from('quotation_items')
      .select('id, qty')
      .eq('quotation_id', quotationId)
      .eq('doc_item_id', source.doc_item_id)
    query = source.unit ? query.eq('unit', source.unit) : query.is('unit', null)
    const { data } = await query
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
