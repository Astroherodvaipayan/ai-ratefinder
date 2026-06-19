import type { SupabaseClient } from '@supabase/supabase-js'
import { generateCandidates } from './generateCandidates'
import { normalizeAliases } from './normalizeAliases'
import { parseUserItemQuery, splitItemQueries } from './parseUserItemQuery'
import { explainMatch } from './explainMatch'
import { scoreCandidates, type ScoredCandidate } from './scoreCandidates'
import { inferPriceBasis, type PriceBasisSummary } from './priceBasis'
import { normalizeSearchText, uniqueText } from './text'

const REVIEW_THRESHOLD = 0.65
const REVIEW_PREVIEW_THRESHOLD = 0.5

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
    price_basis?: PriceBasisSummary
    variant_label?: string | null
    suggested_query?: string | null
    alternatives?: PriceCandidateSummary[]
  }>
  unresolved_items: Array<{
    query: string
    reason: string
    did_you_mean?: string | null
    closest_candidates: PriceCandidateSummary[]
    catalog_matches?: CatalogMatchSummary[]
  }>
  explanations: ReturnType<typeof explainMatch>[]
}

export interface CatalogMatchSummary {
  description: string
  source_page: number | null
  source_document: string
  vendor: string | null
  table_title: string | null
  matched_text: string
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
  price_basis?: PriceBasisSummary
  variant_label?: string | null
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
  const priceBasis = priceBasisFromScore(scored)
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
    price_basis: priceBasis,
    variant_label: variantLabelFromScore(scored),
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
  const meaningful = scored.filter(item =>
    item.score >= 0.35
    && !item.conflicting_fields.some(field => field.startsWith('product_family:'))
    && !item.conflicting_fields.includes('non_price_spec_value')
  )
  return meaningful.slice(0, 5).map(item => ({
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
    price_basis: priceBasisFromScore(item),
    variant_label: variantLabelFromScore(item),
    suggested_query: suggestedQuery(item)
  }))
}

function variantLabelFromScore(item: ScoredCandidate) {
  const c = item.candidate
  return variantLabelFromText([
    c.row_headers.join(' '),
    c.column_headers.join(' '),
    c.parent_headers.join(' '),
    c.table_title,
    c.description_text,
    c.product_text
  ].filter(Boolean).join(' '))
}

function variantLabelFromText(value: string) {
  const text = value.toLowerCase()
  if (/\bfr\s*ls\s*h\b|frlsh/.test(text)) return 'FRLSH'
  if (/\bfr\s*ls\b|frls/.test(text)) return 'FRLS'
  if (/\bhffr\b|hffr\s*\d|hffr\d/.test(text)) return 'HFFR'
  if (/\bzhfr\b|zhfr\s*\d|zhfr\d/.test(text)) return 'ZHFR'
  if (/\bfr\b|fr\s*\d+\s*(?:mtrs?|meter|coil)|fr300/.test(text)) return 'FR'
  return null
}

function priceBasisFromScore(item: ScoredCandidate) {
  const c = item.candidate
  return inferPriceBasis({
    price: c.normalized_price,
    unit: c.unit,
    moq: c.moq,
    raw_cell_value: c.raw_cell_value,
    searchable_text: c.searchable_text,
    description_text: c.description_text,
    product_text: c.product_text,
    table_title: c.table_title,
    row_headers: c.row_headers,
    column_headers: c.column_headers,
    parent_headers: c.parent_headers,
    nearby_notes: c.nearby_notes,
    section_breadcrumb: c.section_breadcrumb
  })
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

function formatPriceValue(price: number) {
  if (!Number.isFinite(price)) return String(price)
  const rounded = Math.round(price * 100) / 100
  return Number.isInteger(rounded) ? String(rounded) : String(rounded)
}

function pricePhrase(item: Pick<PriceCandidateSummary, 'price' | 'currency' | 'price_basis' | 'variant_label'>) {
  const variant = item.variant_label ? `${item.variant_label}: ` : ''
  const basis = item.price_basis?.source_basis_label ? ` / ${item.price_basis.source_basis_label}` : ''
  const effective = item.price_basis?.effective_unit && item.price_basis.effective_unit_price !== item.price
    ? `, effective ${item.currency} ${formatPriceValue(item.price_basis.effective_unit_price)}/${item.price_basis.effective_unit}`
    : ''
  return `${variant}${item.currency} ${formatPriceValue(item.price)}${basis}${effective}`
}

function wireVariantGuidance(query: string) {
  const normalized = query.toLowerCase()
  const asksVariantDifference = /\bfr\b/.test(normalized)
    && /\bfrls?h?\b/.test(normalized)
    && !/\d+(?:[.,]\d+)?\s*(?:sq\s*mm|sqmm|mm)\b/i.test(query)
  if (!asksVariantDifference) return null
  return 'FR and FRLS/FRLSH are different wire variants. FR is flame-retardant. FRLS/FRLSH is flame-retardant with low-smoke/halogen wording in the price list. For pricing, choose the variant plus size and quantity, for example "2.5mm FR wire 6 bdl" or "2.5mm FRLS wire 6 bdl"; if you omit the variant, the app will show FR, FRLSH, and HFFR alternatives for review.'
}

function plural(value: number, singular: string, pluralValue = `${singular}s`) {
  return value === 1 ? singular : pluralValue
}

function needVerb(value: number) {
  return value === 1 ? 'needs' : 'need'
}

function quotedSummary(value: string | null | undefined, fallback: string, maxLength = 96) {
  const summary = (value || fallback || '').replace(/\s+/g, ' ').trim()
  if (!summary) return null
  const clipped = summary.length > maxLength ? `${summary.slice(0, maxLength - 3).trim()}...` : summary
  return `"${clipped}"`
}

function reviewLine(item: SearchItemsResult['priced_items'][number]) {
  const suggestion = quotedSummary(item.suggested_query, item.description)
  const source = suggestion ? `possible match ${suggestion}` : 'possible match'
  const action = item.confidence >= REVIEW_THRESHOLD
    ? 'Please check it before adding.'
    : 'Please open the source or make the item name more specific.'
  return `- ${item.query}: ${source} at ${pricePhrase(item)}. ${action}`
}

function unresolvedLine(item: SearchItemsResult['unresolved_items'][number]) {
  if (item.catalog_matches?.length) {
    const suggestions = item.catalog_matches
      .slice(0, 3)
      .map(match => {
        const source = [match.vendor, match.source_document, match.source_page ? `p.${match.source_page}` : null]
          .filter(Boolean)
          .join(' · ')
        return `"${match.description}"${source ? ` (${source})` : ''}`
      })
    return `- ${item.query}: I found matching catalogue text, but not a clear price next to it: ${suggestions.join('; ')}.`
  }

  const suggestions = item.closest_candidates
    .slice(0, 2)
    .map(candidate => {
      const label = quotedSummary(candidate.suggested_query, candidate.description)
      return label ? `${label} at ${pricePhrase(candidate)}` : null
    })
    .filter((value): value is string => Boolean(value))

  if (!suggestions.length) {
    return `- ${item.query}: I could not find a clear price in the selected document. Try adding brand, model, or the exact catalogue wording.`
  }

  const remaining = Math.max(0, item.closest_candidates.length - suggestions.length)
  const suffix = remaining ? `; plus ${remaining} more possible ${plural(remaining, 'match', 'matches')}` : ''
  return `- ${item.query}: I found possible prices, but need you to choose the right one: ${suggestions.join('; ')}${suffix}.`
}

function answerText(result: Pick<SearchItemsResult, 'priced_items' | 'unresolved_items'> & { guidance_messages?: string[] }) {
  const matched = result.priced_items.filter(item => !item.needs_review).length
  const review = result.priced_items.filter(item => item.needs_review).length
  const unresolved = result.unresolved_items.length
  const parts: string[] = []
  if (result.guidance_messages?.length) parts.push(...result.guidance_messages)
  if (matched) {
    parts.push(`Found ${matched} ${plural(matched, 'item')} ready to add to the quote.`)
  }
  if (review) {
    const reviewItems = result.priced_items
      .filter(item => item.needs_review)
      .slice(0, 3)
    const reviewLines = reviewItems.map(reviewLine)
    const hidden = review - reviewLines.length
    parts.push([
      `${review} possible ${plural(review, 'match', 'matches')} ${needVerb(review)} a quick check before adding:`,
      ...reviewLines,
      hidden ? `- ${hidden} more ${plural(hidden, 'item')} shown in the cards below.` : null
    ].filter(Boolean).join('\n'))
  }
  if (unresolved) {
    const unresolvedItems = result.unresolved_items.slice(0, 3)
    const unresolvedLines = unresolvedItems.map(unresolvedLine)
    const hidden = unresolved - unresolvedLines.length
    parts.push([
      `I need help with ${unresolved} ${plural(unresolved, 'item')} before adding them to the quote:`,
      ...unresolvedLines,
      hidden ? `- ${hidden} more ${plural(hidden, 'item')} need a clearer brand, size, model, or document.` : null
    ].filter(Boolean).join('\n'))
  }
  if (review || unresolved) {
    parts.push(matched
      ? 'I added only the clear matches. The rest are waiting for your review.'
      : review
        ? 'I have not added anything to the quote yet. Please review the cards below.'
        : 'I have not added anything to the quote yet.')
  }
  return parts.join('\n\n') || 'I could not find a clear price. Try adding brand, size, model, or the document name.'
}

function canShowReviewCard(scored: ScoredCandidate | null): scored is ScoredCandidate {
  if (!scored) return false
  if (scored.score >= REVIEW_THRESHOLD) return true
  if (scored.score < REVIEW_PREVIEW_THRESHOLD) return false
  if (scored.conflicting_fields.includes('non_price_spec_value')) return false
  if (scored.conflicting_fields.some(field => field.startsWith('product_family:'))) return false
  return Boolean(scored.candidate.doc_price_item_id || scored.candidate.doc_item_id)
}

async function catalogMatches(params: {
  client: SupabaseClient
  tenantId: string
  documentId?: string | null
  vendorId?: string | null
  parsed: ReturnType<typeof parseUserItemQuery>
  limit?: number
}): Promise<CatalogMatchSummary[]> {
  const productTerms = uniqueText(params.parsed.product_terms
    .filter(term => term.length >= 2)
    .filter(term => !/^(?:hl|hills?)$/.test(term))
    .filter(term => !params.parsed.vendor_terms.includes(term) && !params.parsed.brand_terms.includes(term)))
  const tokenTerms = uniqueText(params.parsed.normalized_query
    .split(/\s+/)
    .filter(term => term.length >= 2)
    .filter(term => !/^(?:price|rate|show|find|give|need|hl|hills?)$/.test(term)))
  const terms = uniqueText([
    ...productTerms,
    ...tokenTerms,
    ...params.parsed.attribute_hints.map(hint => hint.value),
    ...params.parsed.attribute_hints.map(hint => hint.unit)
  ].filter((term): term is string => Boolean(term && term.length >= 2)))
    .slice(0, 10)
  if (!terms.length) return []

  let query = params.client
    .from('doc_table_cells')
    .select('id, document_id, vendor_id, source_page, row_headers, column_headers, parent_headers, raw_cell_value, normalized_value, is_header, doc_tables:source_table_id(table_title, section_breadcrumb), documents:document_id(filename, vendor:vendor_id(name))')
    .eq('tenant_id', params.tenantId)
    .eq('is_header', false)
    .limit(params.documentId ? 5000 : 1000)
  if (params.documentId) query = query.eq('document_id', params.documentId)
  if (params.vendorId) query = query.eq('vendor_id', params.vendorId)

  const { data, error } = await query
  if (error) return []

  const normalizedTerms = terms.map(normalizeSearchText).filter(Boolean)
  const normalizedProductTerms = productTerms.map(normalizeSearchText).filter(Boolean)
  const compactQuery = normalizeSearchText(params.parsed.normalized_query).replace(/\s+/g, '')
  const scored = (data ?? []).map((row: any) => {
    const table = Array.isArray(row.doc_tables) ? row.doc_tables[0] : row.doc_tables
    const document = Array.isArray(row.documents) ? row.documents[0] : row.documents
    const text = uniqueText([
      row.raw_cell_value,
      ...(row.row_headers ?? []),
      ...(row.column_headers ?? []),
      ...(row.parent_headers ?? []),
      table?.table_title,
      ...(table?.section_breadcrumb ?? []),
      document?.filename,
      document?.vendor?.name
    ].filter(Boolean)).join(' ')
    const normalizedText = normalizeSearchText(text)
    const compactText = normalizedText.replace(/\s+/g, '')
    const productHit = normalizedProductTerms.length
      ? normalizedProductTerms.some(term => normalizedText.includes(term) || compactText.includes(term.replace(/\s+/g, '')))
      : true
    const score = normalizedTerms.reduce((sum, term) => {
      const hit = normalizedText.includes(term) || compactText.includes(term.replace(/\s+/g, ''))
      if (!hit) return sum
      return sum + (normalizedProductTerms.includes(term) ? 2 : 1)
    }, compactQuery && compactText.includes(compactQuery) ? 4 : 0)
    return { row, table, document, text, score, productHit }
  })
    .filter(item => item.productHit && item.score >= 2)
    .sort((a, b) => b.score - a.score || a.text.length - b.text.length)

  const seen = new Set<string>()
  const out: CatalogMatchSummary[] = []
  for (const item of scored) {
    const description = uniqueText([
      ...(item.row.row_headers ?? []),
      item.row.raw_cell_value,
      ...(item.row.parent_headers ?? [])
    ].filter(Boolean)).join(' ')
    const key = normalizeSearchText(description)
    if (!description || seen.has(key)) continue
    seen.add(key)
    out.push({
      description,
      source_page: item.row.source_page ?? null,
      source_document: item.document?.filename ?? '',
      vendor: item.document?.vendor?.name ?? null,
      table_title: item.table?.table_title ?? null,
      matched_text: item.text
    })
    if (out.length >= (params.limit ?? 5)) break
  }
  return out
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
    const guidance = wireVariantGuidance(query)
    if (guidance) {
      return { query, parsed, scored: [], best: null, explanation: explainMatch({ query, scored: null, alternatives: [] }), guidance }
    }
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
      scored: best && best.score >= REVIEW_THRESHOLD ? best : null,
      alternatives: scored.slice(best && best.score >= REVIEW_THRESHOLD ? 1 : 0, 6)
    })

    const catalog = scored.length ? [] : await catalogMatches({
      client: params.client,
      tenantId: params.tenantId,
      parsed: normalized.query,
      vendorId: params.vendorId,
      documentId: params.documentId
    })

    return { query, parsed: normalized.query, scored, best, explanation, guidance: null, catalog }
  })

  const priced_items = perQuery.flatMap(item => {
    if (!canShowReviewCard(item.best)) return []
    return [pricedItemFromScore(
      item.query,
      item.best,
      item.scored.slice(1, 6),
      requestedQuantityFor(item.parsed)
    )]
  })

  const unresolved_items = perQuery.flatMap(item => {
    if (item.guidance) return []
    if (canShowReviewCard(item.best)) return []
    const closestCandidates = closest(item.scored)
    return [{
      query: item.query,
      reason: item.scored.length
        ? 'Closest records did not meet the deterministic confidence threshold.'
        : item.catalog?.length
          ? 'Catalogue records matched, but no deterministic price/rate cell exists for this query.'
          : 'No indexed price records matched this query.',
      did_you_mean: closestCandidates[0]?.suggested_query ?? null,
      closest_candidates: closestCandidates,
      catalog_matches: item.catalog ?? []
    }]
  })

  return {
    answer_text: answerText({
      priced_items,
      unresolved_items,
      guidance_messages: perQuery.flatMap(item => item.guidance ? [item.guidance] : [])
    }),
    priced_items,
    unresolved_items,
    explanations: perQuery.map(item => item.explanation)
  }
}
