/**
 * Post a user message into a chat.
 *
 *   - Persists the user message
 *   - Parses/searches/scores indexed price records deterministically
 *   - Creates/updates the chat's draft proforma invoice only for high-confidence
 *     source-backed matches
 *   - Persists the assistant message (text + cited items)
 *   - Returns the assistant message
 */
import { z } from 'zod'
import { addCatalogOffersToQuotation, addDocItemsToQuotation, addPriceItemsToQuotation, ensureChatQuotation } from '../../../utils/quotations'
import { searchItems } from '../../../utils/search/searchItems'
import type { PriceCandidateSummary, RequestedQuantitySummary } from '../../../utils/search/searchItems'
import { searchCatalogV2 } from '../../../utils/catalog/searchV2'
import { catalogChatResponse } from '../../../utils/catalog/chatResponse'
import { splitCatalogQueries } from '../../../utils/catalog/query'

const Body = z.object({
  content: z.string().min(1),
  document_id: z.string().uuid().nullish(),
  vendor_id: z.string().uuid().nullish()
})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const chatId = getRouterParam(event, 'id')!
  const { content, document_id: documentId, vendor_id: vendorId } = Body.parse(await readBody(event))
  const client = await userClient(event)

  // Confirm chat exists for this user (RLS does the security; this gives a 404).
  const { data: chat } = await client
    .from('chats')
    .select('id, title, quotation_id')
    .eq('id', chatId)
    .single()
  if (!chat) throw createError({ statusCode: 404, statusMessage: 'Chat not found' })

  // Persist user message
  await client.from('chat_messages').insert({
    chat_id: chatId, role: 'user', content
  })

  const config = useRuntimeConfig()
  if (config.searchV2Enabled === true || String(config.searchV2Enabled).toLowerCase() === 'true') {
    const results = await Promise.all(splitCatalogQueries(content).map(message => searchCatalogV2({
      client,
      message,
      documentId,
      vendorId
    })))
    const response = catalogChatResponse(results)
    const exactOfferIds = response.items
      .filter(item => !item.needs_review && item.confidence >= 0.85)
      .map(item => item.catalog_offer_id)
      .filter((id): id is string => Boolean(id))
    let quotationId: string | null = chat.quotation_id ?? null
    if (exactOfferIds.length) {
      quotationId = await ensureChatQuotation(client, user.id, chat as any, content)
      await addCatalogOffersToQuotation(client, quotationId, exactOfferIds)
    }
    const { data: msg, error } = await client.from('chat_messages').insert({
      chat_id: chatId,
      role: 'assistant',
      content: response.answerText,
      items: response.items
    }).select().single()
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    await touchChat(client, chat, content)
    return { ...msg, quotation_id: quotationId }
  }

  const deterministic = await searchItems({
    client,
    tenantId: user.id,
    message: content,
    documentId,
    vendorId,
    limitPerItem: 40
  })

  const replyItems = deterministic.priced_items.map(item => ({
    doc_price_item_id: item.doc_price_item_id,
    doc_item_id: item.doc_item_id ?? item.doc_price_item_id,
    product_name: item.description,
    sku: item.sku,
    unit: item.unit,
    price: item.price,
    moq: item.moq,
    currency: 'INR',
    vendor: item.vendor ?? 'Unknown vendor',
    source_document: item.source_document,
    source_page: item.source_page,
    confidence: item.confidence,
    needs_review: item.needs_review,
    matched_table: item.matched_table ?? null,
    matched_row: item.matched_row ?? null,
    matched_column: item.matched_column ?? null,
    match_explanation: item.match_explanation ?? null,
    suggested_query: item.suggested_query ?? null,
    variant_label: item.variant_label ?? null,
    price_basis: item.price_basis,
    requested_quantity: item.requested_quantity ?? null,
    alternatives: item.alternatives ?? []
  }))
  const unresolvedReviewItems = deterministic.unresolved_items.flatMap(item => {
    const [primary, ...alternatives] = item.closest_candidates
    if (!primary) return []
    return [reviewItemFromCandidate(item.query, primary, alternatives)]
  })

  let quotationId: string | null = chat.quotation_id ?? null
  const highConfidence = deterministic.priced_items.filter(item => !item.needs_review && item.confidence >= 0.85)
  if (highConfidence.length) {
    quotationId = await ensureChatQuotation(client, user.id, chat as any, content)
    const canonicalIds = highConfidence
      .map(item => item.doc_price_item_id)
      .filter((id): id is string => Boolean(id))
    const canonicalQuantities = new Map(highConfidence
      .filter(item => item.doc_price_item_id && item.requested_quantity?.value)
      .map(item => [item.doc_price_item_id!, item.requested_quantity!]))
    if (canonicalIds.length) await addPriceItemsToQuotation(client, quotationId, canonicalIds, canonicalQuantities)

    const legacyIds = highConfidence
      .filter(item => !item.doc_price_item_id && item.doc_item_id)
      .map(item => item.doc_item_id!)
    const legacyQuantities = new Map(highConfidence
      .filter(item => !item.doc_price_item_id && item.doc_item_id && item.requested_quantity?.value)
      .map(item => [item.doc_item_id!, item.requested_quantity!]))
    if (legacyIds.length) await addDocItemsToQuotation(client, quotationId, legacyIds, legacyQuantities)
  }

  await persistMatchLogs(client, user.id, deterministic, highConfidence)

  // Persist assistant message
  const { data: msg, error } = await client.from('chat_messages').insert({
    chat_id: chatId,
    role: 'assistant',
    content: deterministic.answer_text,
    items: [...replyItems, ...unresolvedReviewItems]
  }).select().single()
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })

  await touchChat(client, chat, content)

  return { ...msg, quotation_id: quotationId }
})

async function touchChat(
  client: Awaited<ReturnType<typeof userClient>>,
  chat: { id: string; title: string },
  content: string
) {
  await client.from('chats')
    .update(chat.title === 'New chat'
      ? { title: content.slice(0, 60), updated_at: new Date().toISOString() }
      : { updated_at: new Date().toISOString() })
    .eq('id', chat.id)
}

function reviewItemFromCandidate(
  query: string,
  candidate: PriceCandidateSummary,
  alternatives: PriceCandidateSummary[]
) {
  return {
    doc_price_item_id: candidate.doc_price_item_id,
    doc_item_id: candidate.doc_item_id ?? candidate.doc_price_item_id,
    product_name: candidate.description,
    sku: candidate.sku,
    unit: candidate.unit,
    price: candidate.price,
    moq: null,
    currency: 'INR',
    vendor: candidate.vendor ?? 'Unknown vendor',
    source_document: candidate.source_document,
    source_page: candidate.source_page,
    confidence: candidate.confidence,
    needs_review: true,
    matched_table: null,
    matched_row: null,
    matched_column: null,
    match_explanation: `Possible price for "${query}". Choose this only if the source row matches your BOQ line.`,
    suggested_query: candidate.suggested_query ?? null,
    variant_label: candidate.variant_label ?? null,
    price_basis: candidate.price_basis,
    requested_quantity: null as RequestedQuantitySummary | null,
    alternatives: alternatives.map(alt => ({
      ...alt,
      needs_review: true
    }))
  }
}

async function persistMatchLogs(
  client: Awaited<ReturnType<typeof userClient>>,
  tenantId: string,
  result: Awaited<ReturnType<typeof searchItems>>,
  highConfidence: Array<{ doc_price_item_id: string | null; doc_item_id: string | null }>
) {
  const selected = new Set(highConfidence.map(item => item.doc_price_item_id ?? item.doc_item_id).filter(Boolean))
  const rows = result.explanations.flatMap((explanation: any) => {
    const candidate = explanation.best_candidate
    const id = candidate?.doc_price_item_id ?? candidate?.doc_item_id
    if (!candidate || !id) return []
    return [{
      tenant_id: tenantId,
      query: explanation.query,
      normalized_query: explanation.query.toLowerCase().replace(/\s+/g, ' ').trim(),
      doc_price_item_id: candidate.doc_price_item_id,
      legacy_doc_item_id: candidate.doc_item_id,
      confidence_score: explanation.confidence_score,
      confidence_label: explanation.confidence_label,
      matched_fields: explanation.matched_fields,
      missing_fields: explanation.missing_fields,
      conflicting_fields: explanation.conflicting_fields,
      aliases_used: explanation.aliases_used,
      needs_review: explanation.needs_review,
      selected_for_quotation: selected.has(id)
    }]
  })
  if (!rows.length) return

  const { error } = await client.from('search_match_logs').insert(rows)
  if (error) {
    console.warn('Could not persist search match logs', error.message)
  }
}
