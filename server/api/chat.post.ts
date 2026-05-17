/**
 * POST /api/chat — RAG endpoint.
 *
 * Body: { question: string, history?: {role, content}[] }
 *
 * 1) Retrieve top-15 candidate rows via the existing rf_match_products RPC
 *    (replace with a doc_items-level search once that table lands).
 * 2) Hand candidates + question to Gemini 2.5 Flash with the structured-
 *    output schema.
 * 3) Return { answer_text, items[] } — the UI renders text above + cards.
 *
 * Note: this targets the price_list_items / products schema we shipped in
 * 0001_init.sql. When we migrate to documents → doc_items (per FLOW.md
 * §4), the retrieval call here is the only thing that changes.
 */
import { z } from 'zod'
import {
  answerFromCandidates,
  type CandidateRow,
  type ChatTurn
} from '../utils/gemini'

const Body = z.object({
  question: z.string().min(1),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string()
  })).optional()
})

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const { question, history } = Body.parse(await readBody(event))
  const client = await userClient(event)

  // Retrieve candidates against the master catalogue + price list.
  // Joined view: one row per (product, vendor) with the latest price.
  const { data: hits } = await client.rpc('rf_match_products', {
    q: question, lim: 15
  })

  const ids = (hits ?? []).map((h: any) => h.product_id)
  let candidates: CandidateRow[] = []

  if (ids.length) {
    const { data: rows } = await client
      .from('price_list_items')
      .select(`
        id, raw_name, sku, unit, price, currency, raw_row, product_id,
        vendors:vendor_id(name)
      `)
      .in('product_id', ids)
      .limit(30)

    candidates = (rows ?? []).map((r: any) => ({
      doc_item_id: r.id,
      product_name: r.raw_name,
      sku: r.sku,
      unit: r.unit,
      price: r.price,
      moq: r.raw_row?.moq ?? null,
      currency: r.currency ?? 'INR',
      vendor: r.vendors?.name ?? 'Unknown',
      source_document: '',
      source_page: r.raw_row?.source_page ?? null,
      context_md: ''
    }))
  }

  const reply = await answerFromCandidates(
    question,
    candidates,
    (history ?? []) as ChatTurn[]
  )

  return reply
})
