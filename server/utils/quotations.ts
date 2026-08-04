import type { SupabaseClient } from '@supabase/supabase-js'
import { inferPriceBasis, quotationRateForBasis, type RequestedQuantityLike } from './search/priceBasis'

interface ChatWithQuotation {
  id: string
  title: string
  quotation_id: string | null
}

type QuantitySelection = number | RequestedQuantityLike

function proformaTitle(seed: string): string {
  const title = seed.trim().replace(/\s+/g, ' ').slice(0, 80)
  return title ? `Proforma - ${title}` : 'Proforma invoice'
}

export async function ensureChatQuotation(
  client: SupabaseClient,
  userId: string,
  chat: ChatWithQuotation,
  titleSeed: string
): Promise<string> {
  if (chat.quotation_id) {
    const { data: existing } = await client
      .from('quotations')
      .select('id')
      .eq('id', chat.quotation_id)
      .maybeSingle()
    if (existing?.id) return existing.id as string
  }

  const { data: quotation, error } = await client
    .from('quotations')
    .insert({
      owner_id: userId,
      title: proformaTitle(titleSeed)
    })
    .select('id')
    .single()
  if (error || !quotation) {
    throw createError({
      statusCode: 500,
      statusMessage: error?.message ?? 'Could not create proforma invoice'
    })
  }

  await client
    .from('chats')
    .update({
      quotation_id: quotation.id,
      updated_at: new Date().toISOString()
    })
    .eq('id', chat.id)

  chat.quotation_id = quotation.id as string
  return quotation.id as string
}

export async function addDocItemsToQuotation(
  client: SupabaseClient,
  quotationId: string,
  docItemIds: string[],
  quantitiesById: Map<string, QuantitySelection> = new Map()
): Promise<number> {
  const orderedIds = [...new Set(docItemIds)].filter(Boolean)
  if (!orderedIds.length) return 0

  const { data: existingItems } = await client
    .from('quotation_items')
    .select('doc_item_id, line_no')
    .eq('quotation_id', quotationId)

  const existingDocItemIds = new Set(
    (existingItems ?? [])
      .map((item: any) => item.doc_item_id)
      .filter(Boolean)
  )
  const nextIds = orderedIds.filter(id => !existingDocItemIds.has(id))
  if (!nextIds.length) return 0

  const { data: docItems, error } = await client
    .from('doc_items')
    .select('id, raw_name, sku, unit, price, source_page, document_id, documents:document_id(filename, vendor:vendor_id(name))')
    .in('id', nextIds)
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })

  const itemById = new Map((docItems ?? []).map((item: any) => [item.id as string, item]))
  const lastLine = Math.max(0, ...(existingItems ?? []).map((item: any) => Number(item.line_no) || 0))

  let nextLineNo = lastLine
  const lines = nextIds.flatMap((id) => {
    const item: any = itemById.get(id)
    if (!item) return []
    nextLineNo += 1
    const rate = quotationRateForBasis(inferPriceBasis({
      price: Number(item.price ?? 0),
      unit: item.unit,
      description_text: item.raw_name,
      product_text: item.sku
    }), quantitySelection(quantitiesById.get(item.id)))
    return [{
      quotation_id: quotationId,
      doc_item_id: item.id,
      source_document_id: item.document_id,
      line_no: nextLineNo,
      description: item.raw_name,
      sku: item.sku,
      unit: rate.unit,
      vendor: item.documents?.vendor?.name ?? null,
      qty: rate.qty,
      unit_price: rate.unit_price,
      source_page: item.source_page
    }]
  })

  if (!lines.length) return 0

  const { error: insertError } = await client.from('quotation_items').insert(lines)
  if (insertError) throw createError({ statusCode: 500, statusMessage: insertError.message })

  await client
    .from('quotations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', quotationId)

  return lines.length
}

export async function addPriceItemsToQuotation(
  client: SupabaseClient,
  quotationId: string,
  docPriceItemIds: string[],
  quantitiesById: Map<string, QuantitySelection> = new Map()
): Promise<number> {
  const orderedIds = [...new Set(docPriceItemIds)].filter(Boolean)
  if (!orderedIds.length) return 0

  const { data: existingItems } = await client
    .from('quotation_items')
    .select('doc_price_item_id, doc_item_id, line_no')
    .eq('quotation_id', quotationId)

  const existingPriceItemIds = new Set(
    (existingItems ?? [])
      .map((item: any) => item.doc_price_item_id)
      .filter(Boolean)
  )
  const nextIds = orderedIds.filter(id => !existingPriceItemIds.has(id))
  if (!nextIds.length) return 0

  const { data: priceItems, error } = await client
    .from('doc_price_items')
    .select('id, legacy_doc_item_id, document_id, product_text, sku_text, description_text, unit, normalized_price, currency, moq, source_page, raw_cell_value, searchable_text, table_title, row_headers, column_headers, parent_headers, nearby_notes, section_breadcrumb, documents:document_id(filename, vendor:vendor_id(name))')
    .in('id', nextIds)
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })

  const itemById = new Map((priceItems ?? []).map((item: any) => [item.id as string, item]))
  const lastLine = Math.max(0, ...(existingItems ?? []).map((item: any) => Number(item.line_no) || 0))

  let nextLineNo = lastLine
  const lines = nextIds.flatMap((id) => {
    const item: any = itemById.get(id)
    if (!item) return []
    nextLineNo += 1
    const rate = quotationRateForBasis(inferPriceBasis({
      price: Number(item.normalized_price ?? 0),
      unit: item.unit,
      moq: item.moq,
      raw_cell_value: item.raw_cell_value,
      searchable_text: item.searchable_text,
      description_text: item.description_text,
      product_text: item.product_text,
      table_title: item.table_title,
      row_headers: item.row_headers,
      column_headers: item.column_headers,
      parent_headers: item.parent_headers,
      nearby_notes: item.nearby_notes,
      section_breadcrumb: item.section_breadcrumb
    }), quantitySelection(quantitiesById.get(item.id)))
    return [{
      quotation_id: quotationId,
      doc_price_item_id: item.id,
      doc_item_id: item.legacy_doc_item_id,
      source_document_id: item.document_id,
      line_no: nextLineNo,
      description: item.description_text || item.product_text || 'Priced item',
      sku: item.sku_text,
      unit: rate.unit,
      vendor: item.documents?.vendor?.name ?? null,
      qty: rate.qty,
      unit_price: rate.unit_price,
      source_page: item.source_page
    }]
  })

  if (!lines.length) return 0

  const { error: insertError } = await client.from('quotation_items').insert(lines)
  if (insertError) throw createError({ statusCode: 500, statusMessage: insertError.message })

  await client
    .from('quotations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', quotationId)

  return lines.length
}

export async function addCatalogOffersToQuotation(
  client: SupabaseClient,
  quotationId: string,
  catalogOfferIds: string[],
  quantitiesById: Map<string, QuantitySelection> = new Map()
): Promise<number> {
  const orderedIds = [...new Set(catalogOfferIds)].filter(Boolean)
  if (!orderedIds.length) return 0

  const { data: activeRelease, error: releaseError } = await client
    .from('catalog_releases')
    .select('id')
    .eq('status', 'active')
    .single()
  if (releaseError || !activeRelease) {
    throw createError({ statusCode: 503, statusMessage: 'No active catalogue release is available' })
  }

  const { data: existingItems } = await client
    .from('quotation_items')
    .select('catalog_offer_id, line_no')
    .eq('quotation_id', quotationId)
  const existingOfferIds = new Set((existingItems ?? []).map((item: any) => item.catalog_offer_id).filter(Boolean))
  const nextIds = orderedIds.filter(id => !existingOfferIds.has(id))
  if (!nextIds.length) return 0

  const { data: offers, error } = await client
    .from('catalog_offers')
    .select('id, document_id, canonical_name, sku, amount, basis_quantity, basis_unit, package_type, source_page, documents:document_id(filename, vendor:vendor_id(name))')
    .eq('release_id', activeRelease.id)
    .eq('status', 'published')
    .in('id', nextIds)
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })

  const offerById = new Map((offers ?? []).map((offer: any) => [offer.id as string, offer]))
  const lastLine = Math.max(0, ...(existingItems ?? []).map((item: any) => Number(item.line_no) || 0))
  let nextLineNo = lastLine
  const lines = nextIds.flatMap(id => {
    const offer: any = offerById.get(id)
    if (!offer) return []
    nextLineNo += 1
    const rate = quotationRateForBasis(catalogOfferBasis(offer), quantitySelection(quantitiesById.get(id)))
    return [{
      quotation_id: quotationId,
      catalog_offer_id: offer.id,
      source_document_id: offer.document_id,
      line_no: nextLineNo,
      description: offer.canonical_name,
      sku: offer.sku,
      unit: rate.unit,
      vendor: offer.documents?.vendor?.name ?? null,
      qty: rate.qty,
      unit_price: rate.unit_price,
      source_page: offer.source_page
    }]
  })

  if (!lines.length) return 0
  const { error: insertError } = await client.from('quotation_items').insert(lines)
  if (insertError) throw createError({ statusCode: 500, statusMessage: insertError.message })
  await client.from('quotations').update({ updated_at: new Date().toISOString() }).eq('id', quotationId)
  return lines.length
}

function catalogOfferBasis(offer: {
  amount: number | string
  basis_quantity: number | string | null
  basis_unit: string | null
  package_type: string | null
}) {
  const sourcePrice = Number(offer.amount)
  const sourceQuantity = Number(offer.basis_quantity ?? 1) || 1
  const sourceUnit = offer.basis_unit ?? null
  const sourceLabel = sourceUnit
    ? [sourceQuantity === 1 ? null : sourceQuantity, sourceUnit, offer.package_type].filter(Boolean).join(' ')
    : null
  return {
    source_price: sourcePrice,
    source_basis_quantity: sourceQuantity,
    source_basis_unit: sourceUnit,
    source_basis_pack_unit: offer.package_type,
    source_basis_label: sourceLabel,
    effective_unit_price: sourceUnit ? sourcePrice / sourceQuantity : sourcePrice,
    effective_unit: sourceUnit
  }
}

function quantitySelection(selection: QuantitySelection | undefined): RequestedQuantityLike | null {
  if (typeof selection === 'number') return { value: selection, unit: null }
  return selection ?? null
}
