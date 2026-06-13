import type { SupabaseClient } from '@supabase/supabase-js'

interface ChatWithQuotation {
  id: string
  title: string
  quotation_id: string | null
}

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
  docItemIds: string[]
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
    return [{
      quotation_id: quotationId,
      doc_item_id: item.id,
      source_document_id: item.document_id,
      line_no: nextLineNo,
      description: item.raw_name,
      sku: item.sku,
      unit: item.unit,
      vendor: item.documents?.vendor?.name ?? null,
      qty: 1,
      unit_price: Number(item.price ?? 0),
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
  docPriceItemIds: string[]
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
    .select('id, legacy_doc_item_id, document_id, product_text, sku_text, description_text, unit, normalized_price, currency, moq, source_page, documents:document_id(filename, vendor:vendor_id(name))')
    .in('id', nextIds)
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })

  const itemById = new Map((priceItems ?? []).map((item: any) => [item.id as string, item]))
  const lastLine = Math.max(0, ...(existingItems ?? []).map((item: any) => Number(item.line_no) || 0))

  let nextLineNo = lastLine
  const lines = nextIds.flatMap((id) => {
    const item: any = itemById.get(id)
    if (!item) return []
    nextLineNo += 1
    return [{
      quotation_id: quotationId,
      doc_price_item_id: item.id,
      doc_item_id: item.legacy_doc_item_id,
      source_document_id: item.document_id,
      line_no: nextLineNo,
      description: item.description_text || item.product_text || 'Priced item',
      sku: item.sku_text,
      unit: item.unit,
      vendor: item.documents?.vendor?.name ?? null,
      qty: 1,
      unit_price: Number(item.normalized_price ?? 0),
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
