/**
 * Retrieval for chat RAG: top-N candidate doc_items + ±N lines of surrounding
 * markdown for each. The surrounding markdown gives Gemini the table header,
 * footnotes ("prices in ₹/100m"), and adjacent rows so it can interpret a
 * cell without us shipping the whole document.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CandidateRow } from './gemini'

const CONTEXT_RADIUS = 10  // lines on either side of the matched row

function neighbourhood(markdown: string, needle: string | null): string {
  if (!markdown || !needle) return ''
  const lines = markdown.split('\n')
  const idx = lines.findIndex(l => l.includes(needle))
  if (idx < 0) return ''
  const start = Math.max(0, idx - CONTEXT_RADIUS)
  const end   = Math.min(lines.length, idx + CONTEXT_RADIUS + 1)
  return lines.slice(start, end).join('\n')
}

export async function retrieveCandidates(
  client: SupabaseClient,
  question: string,
  limit = 15
): Promise<CandidateRow[]> {
  const { data: hits, error } = await client.rpc('rf_search_items', {
    q: question, lim: limit
  })
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })

  const rows = (hits ?? []) as Array<{
    doc_item_id: string; document_id: string; raw_name: string;
    sku: string | null; unit: string | null; price: number | null;
    moq: string | null; currency: string; source_page: number | null;
    filename: string; vendor: string
  }>

  if (!rows.length) return []

  const docIds = [...new Set(rows.map(r => r.document_id))]
  const { data: docs } = await client
    .from('documents')
    .select('id, parsed_markdown')
    .in('id', docIds)

  const markdownByDoc = new Map<string, string>(
    (docs ?? []).map(d => [d.id as string, (d.parsed_markdown as string) ?? ''])
  )

  return rows.map(r => ({
    doc_item_id: r.doc_item_id,
    product_name: r.raw_name,
    sku: r.sku,
    unit: r.unit,
    price: r.price,
    moq: r.moq,
    currency: r.currency ?? 'INR',
    vendor: r.vendor,
    source_document: r.filename,
    source_page: r.source_page,
    context_md: neighbourhood(markdownByDoc.get(r.document_id) ?? '', r.raw_name)
  }))
}
