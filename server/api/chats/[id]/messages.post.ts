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
import { addDocItemsToQuotation, addPriceItemsToQuotation, ensureChatQuotation } from '../../../utils/quotations'
import { searchItems } from '../../../utils/search/searchItems'

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
    currency: item.currency,
    vendor: item.vendor ?? 'Unknown vendor',
    source_document: item.source_document,
    source_page: item.source_page,
    confidence: item.confidence,
    needs_review: item.needs_review,
    matched_table: item.matched_table ?? null,
    matched_row: item.matched_row ?? null,
    matched_column: item.matched_column ?? null,
    match_explanation: item.match_explanation ?? null,
    alternatives: item.alternatives ?? []
  }))

  let quotationId: string | null = chat.quotation_id ?? null
  const highConfidence = deterministic.priced_items.filter(item => !item.needs_review && item.confidence >= 0.85)
  if (highConfidence.length) {
    quotationId = await ensureChatQuotation(client, user.id, chat as any, content)
    const canonicalIds = highConfidence
      .map(item => item.doc_price_item_id)
      .filter((id): id is string => Boolean(id))
    if (canonicalIds.length) await addPriceItemsToQuotation(client, quotationId, canonicalIds)

    const legacyIds = highConfidence
      .filter(item => !item.doc_price_item_id && item.doc_item_id)
      .map(item => item.doc_item_id!)
    if (legacyIds.length) await addDocItemsToQuotation(client, quotationId, legacyIds)
  }

  await persistMatchLogs(client, user.id, deterministic, highConfidence)

  // Persist assistant message
  const { data: msg, error } = await client.from('chat_messages').insert({
    chat_id: chatId,
    role: 'assistant',
    content: deterministic.answer_text,
    items: replyItems
  }).select().single()
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })

  // First user message becomes the chat title
  if (chat.title === 'New chat') {
    await client.from('chats')
      .update({ title: content.slice(0, 60), updated_at: new Date().toISOString() })
      .eq('id', chatId)
  } else {
    await client.from('chats')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', chatId)
  }

  return { ...msg, quotation_id: quotationId }
})

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
