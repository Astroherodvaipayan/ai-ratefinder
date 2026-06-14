import type { SupabaseClient } from '@supabase/supabase-js'
import { generateCandidates } from './generateCandidates'
import { normalizeAliases } from './normalizeAliases'
import { parseUserItemQuery, splitItemQueries } from './parseUserItemQuery'
import { explainMatch } from './explainMatch'
import { scoreCandidates, type ScoredCandidate } from './scoreCandidates'

export interface SearchItemsResult {
  answer_text: string
  priced_items: Array<{
    query: string
    doc_price_item_id: string | null
    doc_item_id: string | null
    description: string
    price: number
    unit: string | null
    currency: string
    confidence: number
    source_page: number | null
    source_document: string
    needs_review: boolean
    vendor: string | null
    sku: string | null
    moq: string | null
    matched_table?: string | null
    matched_row?: string | null
    matched_column?: string | null
    match_explanation?: string | null
    requested_quantity?: RequestedQuantitySummary | null
    suggested_query?: string | null
    alternatives?: PriceCandidateSummary[]
  }>
  unresolved_items: Array<{
    query: string
    reason: string
    did_you_mean?: string | null
    closest_candidates: PriceCandidateSummary[]
  }>
  explanations: ReturnType<typeof explainMatch>[]
}

export interface PriceCandidateSummary {
  doc_price_item_id: string | null
  doc_item_id: string | null
  description: string
  price: number
  unit: string | null
  currency: string
  confidence: number
  source_page: number | null
  source_document: string
  vendor: string | null
  sku: string | null
  needs_review: boolean
  suggested_query?: string | null
}

export interface RequestedQuantitySummary {
  value: number
  unit: string | null
  raw: string
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(values.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++
      results[index] = await worker(values[index]!, index)
    }
  })
  await Promise.all(workers)
  return results
}

function pricedItemFromScore(
  query: string,
  scored: ScoredCandidate,
  alternatives: ScoredCandidate[] = [],
  requestedQuantity: RequestedQuantitySummary | null = null
): SearchItemsResult['priced_items'][number] {
  const c = scored.candidate
  return {
    query,
    doc_price_item_id: c.doc_price_item_id,
    doc_item_id: c.doc_item_id,
    description: c.description_text || c.product_text || c.searchable_text,
    price: c.normalized_price,
    unit: c.unit,
    currency: c.currency,
    confidence: scored.score,
    source_page: c.source_page,
    source_document: c.source_document,
    needs_review: scored.needs_review,
    vendor: c.vendor,
    sku: c.sku_text,
    moq: c.moq,
    matched_table: c.table_title,
    matched_row: c.row_headers.join(' ') || null,
    matched_column: c.column_headers.join(' ') || null,
    match_explanation: readableMatchExplanation(scored),
    requested_quantity: requestedQuantity,
    suggested_query: suggestedQuery(scored),
    alternatives: closest(alternatives)
  }
}

function readableMatchExplanation(scored: ScoredCandidate) {
  const labels = new Set<string>()
  for (const field of scored.matched_fields) {
    if (field.startsWith('attribute:size')) labels.add('size')
    else if (field.startsWith('attribute:cores')) labels.add('cores')
    else if (field.startsWith('attribute:length')) labels.add('length')
    else if (field.startsWith('terms:')) labels.add('product wording')
    else if (field === 'row_headers') labels.add('table row')
    else if (field === 'column_headers') labels.add('table column')
    else if (field === 'price') labels.add('listed rate')
    else if (field === 'source_page') labels.add('source page')
  }
  if (!labels.size) return scored.confidence_label
  return `${scored.confidence_label}: matched ${[...labels].join(', ')}.`
}

function closest(scored: ScoredCandidate[]): PriceCandidateSummary[] {
  return scored.slice(0, 5).map(item => ({
    doc_price_item_id: item.candidate.doc_price_item_id,
    doc_item_id: item.candidate.doc_item_id,
    description: item.candidate.description_text || item.candidate.product_text || item.candidate.searchable_text,
    price: item.candidate.normalized_price,
    unit: item.candidate.unit,
    currency: item.candidate.currency,
    confidence: item.score,
    source_page: item.candidate.source_page,
    source_document: item.candidate.source_document,
    vendor: item.candidate.vendor,
    sku: item.candidate.sku_text,
    needs_review: item.needs_review,
    suggested_query: suggestedQuery(item)
  }))
}

function suggestedQuery(item: ScoredCandidate) {
  const c = item.candidate
  const tableTitle = normalizeForSuggestion(c.table_title)
  const columnHeaders = c.column_headers
    .map(normalizeForSuggestion)
    .filter(Boolean)
    .filter(header => !/^(?:rate|price|mrp|amount)$/i.test(header))
    .filter(header => header !== tableTitle)
  const signalHeaders = columnHeaders.filter(header =>
    /\b(?:armou?red|aluminium|copper|fr|frls|frlsh|hffr|core|coil|jelly|speaker|unarmou?red)\b/i.test(header)
  )
  const parts = [
    c.row_headers.join(' '),
    ...(signalHeaders.length ? signalHeaders : columnHeaders.slice(-2)),
    signalHeaders.length ? null : tableTitle
  ].filter(Boolean).join(' ')
  return parts.replace(/\s+/g, ' ').trim() || null
}

function normalizeForSuggestion(value: string | null | undefined) {
  return (value ?? '')
    .replace(/\b(?:confirming|conforming)\s+to\s+IS:?[\s\S]*$/i, '')
    .replace(/\bwith\s+Flexible\s+Bright[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function requestedQuantityFor(parsed: { requested_quantities?: RequestedQuantitySummary[] }) {
  return parsed.requested_quantities?.[0] ?? null
}

function answerText(result: Pick<SearchItemsResult, 'priced_items' | 'unresolved_items'>) {
  const matched = result.priced_items.filter(item => !item.needs_review).length
  const review = result.priced_items.filter(item => item.needs_review).length
  const unresolved = result.unresolved_items.length
  const parts: string[] = []
  if (matched) parts.push(`Matched ${matched} source-backed item${matched === 1 ? '' : 's'}.`)
  if (review) {
    const reviewExamples = result.priced_items
      .filter(item => item.needs_review)
      .slice(0, 3)
      .map(item => item.suggested_query
        ? `${item.query} -> did you mean ${item.suggested_query} at ${item.price} ${item.currency}`
        : item.query)
      .join('; ')
    parts.push(`${review} item${review === 1 ? ' needs' : 's need'} review before quotation${reviewExamples ? `. Did you mean: ${reviewExamples}` : ''}.`)
  }
  if (unresolved) {
    const examples = result.unresolved_items
      .slice(0, 5)
      .map(item => {
        const suggestions = item.closest_candidates
          .slice(0, 3)
          .flatMap(candidate => candidate.suggested_query
            ? [`${candidate.suggested_query} at ${candidate.price} ${candidate.currency}`]
            : [])
        return suggestions.length
          ? `${item.query} -> did you mean ${suggestions.join(' OR ')}`
          : item.query
      })
      .join('; ')
    parts.push(
      `Needs clarification for ${unresolved} line${unresolved === 1 ? '' : 's'}; no source-backed price was safe enough to quote automatically${examples ? `. Did you mean: ${examples}${unresolved > 5 ? '; ...' : ''}` : ''}.`
    )
  }
  return parts.join(' ') || 'No reliable priced records were found.'
}

export async function searchItems(params: {
  client: SupabaseClient
  tenantId: string
  message: string
  vendorId?: string | null
  documentId?: string | null
  limitPerItem?: number
}): Promise<SearchItemsResult> {
  const queries = splitItemQueries(params.message)
  const perQuery = await mapWithConcurrency(queries, 6, async (query) => {
    const parsed = parseUserItemQuery(query)
    const normalized = await normalizeAliases({
      client: params.client,
      tenantId: params.tenantId,
      parsed,
      vendorId: params.vendorId,
      documentId: params.documentId
    })
    const candidates = await generateCandidates({
      client: params.client,
      parsed: normalized.query,
      filters: {
        tenantId: params.tenantId,
        vendorId: params.vendorId,
        documentId: params.documentId
      },
      limit: params.limitPerItem ?? 40
    })
    const scored = scoreCandidates({
      parsed: normalized.query,
      candidates,
      aliasesUsed: normalized.aliases_used
    })
    const best = scored[0] ?? null
    const explanation = explainMatch({
      query,
      scored: best && best.score >= 0.65 ? best : null,
      alternatives: scored.slice(best && best.score >= 0.65 ? 1 : 0, 6)
    })

    return { query, parsed: normalized.query, scored, best, explanation }
  })

  const priced_items = perQuery.flatMap(item => {
    if (!item.best || item.best.score < 0.65) return []
    return [pricedItemFromScore(
      item.query,
      item.best,
      item.scored.slice(1, 6),
      requestedQuantityFor(item.parsed)
    )]
  })

  const unresolved_items = perQuery.flatMap(item => {
    if (item.best && item.best.score >= 0.65) return []
    return [{
      query: item.query,
      reason: item.scored.length
        ? 'Closest records did not meet the deterministic confidence threshold.'
        : 'No indexed price records matched this query.',
      did_you_mean: item.scored[0] ? suggestedQuery(item.scored[0]) : null,
      closest_candidates: closest(item.scored)
    }]
  })

  return {
    answer_text: answerText({ priced_items, unresolved_items }),
    priced_items,
    unresolved_items,
    explanations: perQuery.map(item => item.explanation)
  }
}
