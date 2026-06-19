import type { SupabaseClient } from '@supabase/supabase-js'
import type { ParsedUserItemQuery } from './parseUserItemQuery'
import { normalizeSearchText, uniqueText } from './text'

export interface PriceCandidate {
  doc_price_item_id: string | null
  doc_item_id: string | null
  document_id: string
  vendor_id: string | null
  vendor: string | null
  source_document: string
  source_uploaded_at: string | null
  source_page: number | null
  source_table_id: string | null
  source_row_index: number | null
  source_col_index: number | null
  section_breadcrumb: string[]
  table_title: string | null
  row_headers: string[]
  column_headers: string[]
  parent_headers: string[]
  nearby_notes: string[]
  raw_cell_value: string | null
  normalized_price: number
  currency: string
  unit: string | null
  moq: string | null
  product_text: string | null
  sku_text: string | null
  description_text: string | null
  attributes_json: Array<{ name: string; value: string; unit?: string }>
  searchable_text: string
  normalized_search_text: string
  source_confidence: number
  parser_name: string
  recall_path: string
  recall_score: number
}

export interface CandidateFilters {
  tenantId: string
  vendorId?: string | null
  documentId?: string | null
}

function normalizeRpcCandidate(row: any, recallPath: string): PriceCandidate {
  const searchableText = row.searchable_text ?? [
    row.vendor,
    row.filename,
    row.raw_name,
    row.product_text,
    row.sku,
    row.sku_text,
    row.unit,
    row.price,
    row.normalized_price
  ].filter(Boolean).join(' ')
  const attributes = Array.isArray(row.attributes_json) && row.attributes_json.length
    ? row.attributes_json
    : legacyAttributes({
      raw_name: row.product_text ?? row.description_text ?? row.raw_name,
      sku: row.sku_text ?? row.sku,
      unit: row.unit
    }, searchableText)

  return {
    doc_price_item_id: row.doc_price_item_id ?? row.id ?? null,
    doc_item_id: row.legacy_doc_item_id ?? row.doc_item_id ?? null,
    document_id: row.document_id,
    vendor_id: row.vendor_id ?? null,
    vendor: row.vendor ?? null,
    source_document: row.filename ?? row.source_document ?? '',
    source_uploaded_at: row.source_uploaded_at ?? null,
    source_page: row.source_page ?? null,
    source_table_id: row.source_table_id ?? null,
    source_row_index: row.source_row_index ?? null,
    source_col_index: row.source_col_index ?? null,
    section_breadcrumb: row.section_breadcrumb ?? [],
    table_title: row.table_title ?? null,
    row_headers: row.row_headers ?? [],
    column_headers: row.column_headers ?? [],
    parent_headers: row.parent_headers ?? [],
    nearby_notes: row.nearby_notes ?? [],
    raw_cell_value: row.raw_cell_value ?? null,
    normalized_price: Number(row.normalized_price ?? row.price ?? 0),
    currency: row.currency ?? 'INR',
    unit: row.unit ?? null,
    moq: row.moq ?? null,
    product_text: row.product_text ?? row.raw_name ?? null,
    sku_text: row.sku_text ?? row.sku ?? null,
    description_text: row.description_text ?? row.raw_name ?? null,
    attributes_json: attributes,
    searchable_text: searchableText,
    normalized_search_text: row.normalized_search_text ?? normalizeSearchText(row.raw_name ?? ''),
    source_confidence: Number(row.source_confidence ?? 0.65),
    parser_name: row.parser_name ?? 'legacy-doc-items',
    recall_path: recallPath,
    recall_score: Number(row.rank_score ?? row.score ?? 0)
  }
}

function attributesFromText(text: string): PriceCandidate['attributes_json'] {
  const normalized = normalizeSearchText(text)
  const attributes: PriceCandidate['attributes_json'] = []

  for (const match of normalized.matchAll(/\b(\d+(?:\.\d+)?)\s*(sqmm|mm|meter|kg|core|piece|box|bag|case|coil|roll|pair|packet|set|sqft|sqm|tin|ton|unit|dozen)\b/g)) {
    const value = match[1]
    const unit = match[2]
    if (!value || !unit) continue
    attributes.push({
      name: unit === 'sqmm' ? 'size'
        : unit === 'core' ? 'cores'
          : unit === 'meter' ? 'length'
            : unit,
      value,
      unit: unit === 'core' ? undefined : unit
    })
  }

  return uniqueText(attributes.map(attribute => JSON.stringify(attribute)))
    .map(value => JSON.parse(value))
}

function compactNumber(value: string) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? String(numeric) : value
}

function sqlLikeTerm(value: string) {
  return value.replace(/[%_]/g, '').trim()
}

function sqlTermVariants(value: string) {
  const normalized = normalizeSearchText(value)
  return uniqueText([
    normalized,
    normalized.replace(/\s+/g, '')
  ]).filter(Boolean)
}

function highSignalProductTerms(parsed: ParsedUserItemQuery) {
  return parsed.product_terms.filter(term =>
    /^(?:copper|aluminium|fr|frls|frlsh|hffr|zhfr|armoured|armored|unarmoured|unarmored|screened|shielded|submersible|xlpe)$/i.test(term)
  )
}

function wireVariantRecallTerms(productTerms: string[]) {
  const terms = new Set<string>()
  if (productTerms.includes('frlsh') || productTerms.includes('frls')) {
    terms.add('FRLSH')
    terms.add('FRLSH300')
    terms.add('FRLS')
  }
  if (productTerms.includes('fr')) {
    terms.add('FR300')
    terms.add('FR ')
  }
  if (productTerms.includes('hffr')) {
    terms.add('HFFR')
    terms.add('HFFR300')
  }
  if (productTerms.includes('zhfr')) terms.add('ZHFR')
  return [...terms]
}

export function buildLegacyStructuredRecallQueries(parsed: ParsedUserItemQuery): Array<{ terms: string[]; score: number }> {
  const coreHint = parsed.attribute_hints.find(hint => hint.name === 'cores')
  const lengthHint = parsed.attribute_hints.find(hint => hint.name === 'length')
  const variantTerms = highSignalProductTerms(parsed)
  const structuredQueries: Array<{ terms: string[]; score: number }> = []

  if (coreHint) {
    const coreVariants = uniqueText([
      ...sqlTermVariants(`${coreHint.value} core`),
      ...sqlTermVariants(`${coreHint.value}core`)
    ])
    for (const coreTerm of coreVariants) {
      structuredQueries.push({
        terms: uniqueText([
          coreTerm,
          ...variantTerms.filter(term => /^(?:copper|aluminium|screened|shielded|submersible|xlpe)$/i.test(term))
        ]),
        score: 0.92
      })
    }
  }

  if (lengthHint || variantTerms.length) {
    structuredQueries.push({
      terms: uniqueText([
        ...variantTerms,
        lengthHint?.value
      ].filter((term): term is string => Boolean(term))),
      score: 0.9
    })
  }

  return structuredQueries
}

function legacyAttributes(row: any, searchable: string): PriceCandidate['attributes_json'] {
  const attributes = attributesFromText(searchable)
  const sku = String(row.sku ?? '')
  const rawName = String(row.raw_name ?? '')
  const unit = String(row.unit ?? '')

  const skuSize = sku.match(/^\s*(\d+(?:\.\d+)?)\b/)
    ?? rawName.match(/\b(\d+(?:\.\d+)?)\s+(?:fr|frls|frlsh|hffr|zhfr|singlecore|\d+\s*core|\d+core)\b/i)
  if (skuSize?.[1]) {
    attributes.push({ name: 'size', value: compactNumber(skuSize[1]), unit: 'sqmm' })
  }

  const core = `${rawName} ${unit}`.match(/\b(\d+(?:\.\d+)?)\s*core\b/i)
  if (core?.[1]) {
    attributes.push({ name: 'cores', value: compactNumber(core[1]) })
  }

  if (/\bsq\.?\s*mm\b/i.test(rawName) && /\bsc\b/i.test(rawName)) {
    attributes.push({ name: 'cores', value: '1' })
  }

  const length = `${rawName} ${unit}`.match(/\b(?:fr|frls|frlsh|hffr|zhfr)\s*(\d+(?:\.\d+)?)\s*(?:mtrs?|meter|metre)?\b/i)
  if (length?.[1]) {
    attributes.push({ name: 'length', value: compactNumber(length[1]), unit: 'meter' })
  }

  return uniqueText(attributes.map(attribute => JSON.stringify(attribute)))
    .map(value => JSON.parse(value))
}

async function canonicalCandidates(
  client: SupabaseClient,
  parsed: ParsedUserItemQuery,
  filters: CandidateFilters,
  limit: number
) {
  const [rpcResult, directCandidates] = await Promise.all([
    client.rpc('rf_search_price_items', {
      q: parsed.normalized_match_query || parsed.normalized_query || parsed.raw_query,
      lim: limit,
      tenant: filters.tenantId,
      filter_vendor: filters.vendorId ?? null,
      filter_document: filters.documentId ?? null
    }),
    canonicalDirectCandidates(client, parsed, filters, limit)
  ])
  const { data, error } = rpcResult
  if (error) {
    if (/function .*rf_search_price_items|does not exist/i.test(error.message ?? '')) {
      return dedupe(directCandidates).slice(0, limit)
    }
    throw createError({ statusCode: 500, statusMessage: error.message })
  }
  const rpcCandidates = (data ?? []).map((row: any) => normalizeRpcCandidate(row, 'canonical_sql'))
  return dedupe([...rpcCandidates, ...directCandidates]).slice(0, limit)
}

async function canonicalDirectCandidates(
  client: SupabaseClient,
  parsed: ParsedUserItemQuery,
  filters: CandidateFilters,
  limit: number
) {
  const rowsById = new Map<string, any>()
  const addRows = (rows: any[] | null, score: number) => {
    for (const row of rows ?? []) {
      const existing = rowsById.get(row.id)
      if (!existing || score > (existing.rank_score ?? 0)) rowsById.set(row.id, { ...row, rank_score: score })
    }
  }
  const tasks: Array<Promise<{ data: any[] | null; error: any; score: number }>> = []
  const enqueue = (query: PromiseLike<{ data: any[] | null; error: any }>, score: number) => {
    tasks.push(Promise.resolve(query).then(result => ({ ...result, score })))
  }
  const runBaseQuery = () => {
    let query = client
      .from('doc_price_items')
      .select('id, legacy_doc_item_id, document_id, vendor_id, source_page, source_table_id, source_row_index, source_col_index, section_breadcrumb, table_title, row_headers, column_headers, parent_headers, nearby_notes, raw_cell_value, normalized_price, currency, unit, moq, product_text, sku_text, description_text, attributes_json, searchable_text, normalized_search_text, source_confidence, parser_name, source_uploaded_at, documents:document_id(filename, vendor:vendor_id(name))')
      .limit(limit)
    if (filters.documentId) query = query.eq('document_id', filters.documentId)
    if (filters.vendorId) query = query.eq('vendor_id', filters.vendorId)
    return query
  }

  const usefulTerms = uniqueText([
    ...parsed.attribute_hints.map(hint => hint.value),
    ...parsed.attribute_hints.map(hint => hint.unit),
    ...parsed.product_terms,
    ...parsed.units
  ].filter((term): term is string => Boolean(term && term.length >= 2)))
    .slice(0, 10)

  const focusedTerms = uniqueText([
    ...parsed.product_terms,
    ...parsed.attribute_hints.map(hint => hint.value)
  ].filter((term): term is string => Boolean(term && term.length >= 1)))
    .slice(0, 5)

  const sizeHint = parsed.attribute_hints.find(hint => hint.name === 'size')
  const wireVariantTerms = wireVariantRecallTerms(parsed.product_terms)
  if (sizeHint && wireVariantTerms.length) {
    const sizeValues = uniqueText([
      sizeHint.value,
      Number.isFinite(Number(sizeHint.value)) ? Number(sizeHint.value).toFixed(2) : null
    ].filter(Boolean) as string[])
    for (const variant of wireVariantTerms) {
      for (const size of sizeValues) {
        enqueue(runBaseQuery()
          .ilike('searchable_text', `%${sqlLikeTerm(variant)}%`)
          .ilike('searchable_text', `%${sqlLikeTerm(size)}%`)
          .limit(Math.max(limit, 160)), 0.94)
      }
    }
  }

  if (focusedTerms.length >= 2) {
    let query = runBaseQuery().limit(Math.max(limit, 120))
    for (const term of focusedTerms) {
      query = query.ilike('searchable_text', `%${term.replace(/[%_]/g, '')}%`)
    }
    enqueue(query, 0.9)
  }

  for (const hint of parsed.attribute_hints.slice(0, 4)) {
    const numeric = Number(hint.value)
    const variants = [
      { name: hint.name, value: hint.value, ...(hint.unit ? { unit: hint.unit } : {}) },
      { name: hint.name, value: String(numeric), ...(hint.unit ? { unit: hint.unit } : {}) },
      { name: hint.name, value: Number.isFinite(numeric) ? numeric.toFixed(2) : hint.value, ...(hint.unit ? { unit: hint.unit } : {}) },
      { name: hint.name, value: hint.value },
      { name: hint.name, value: String(numeric) },
      { name: hint.name, value: Number.isFinite(numeric) ? numeric.toFixed(2) : hint.value }
    ].filter(item => item.value && item.value !== 'NaN')
    for (const variant of variants) {
      enqueue(runBaseQuery()
        .contains('attributes_json', JSON.stringify([variant]))
        .limit(Math.max(limit, 120)), 0.82)
    }
  }

  if (usefulTerms.length) {
    const escaped = usefulTerms
      .flatMap(term => {
        const value = term.replace(/[%(),]/g, '')
        return [
          `searchable_text.ilike.%${value}%`,
          `product_text.ilike.%${value}%`,
          `sku_text.ilike.%${value}%`,
          `unit.ilike.%${value}%`
        ]
      })
      .join(',')
    enqueue(runBaseQuery().or(escaped).limit(Math.max(limit, 80)), 0.62)
  }

  const compact = parsed.normalized_query.replace(/\s+/g, '%')
  if (compact) {
    enqueue(runBaseQuery()
      .ilike('searchable_text', `%${compact}%`)
      .limit(limit), 0.58)
  }

  const results = await Promise.all(tasks)
  for (const result of results) {
    if (!result.error) addRows(result.data as any[], result.score)
  }

  return dedupe([...rowsById.values()].map((row: any) => {
    const document = Array.isArray(row.documents) ? row.documents[0] : row.documents
    return normalizeRpcCandidate({
      ...row,
      doc_price_item_id: row.id,
      vendor: document?.vendor?.name ?? null,
      filename: document?.filename ?? '',
      rank_score: row.rank_score
    }, 'canonical_direct_sql')
  })).slice(0, limit)
}

function shouldUseLegacyFallback(canonical: PriceCandidate[]) {
  if (process.env.RF_ALWAYS_QUERY_LEGACY === '1') return true
  if (process.env.RF_LEGACY_FALLBACK === '0') return false
  return canonical.length === 0
}

async function legacyCandidates(
  client: SupabaseClient,
  parsed: ParsedUserItemQuery,
  filters: CandidateFilters,
  limit: number
) {
  const rowsById = new Map<string, any>()
  const addRows = (rows: any[] | null, score: number) => {
    for (const row of rows ?? []) {
      const existing = rowsById.get(row.id)
      if (!existing || score > (existing.score ?? 0)) rowsById.set(row.id, { ...row, score })
    }
  }

  const runBaseQuery = () => {
    let query = client
      .from('doc_items')
      .select('id, document_id, raw_name, sku, unit, price, moq, currency, source_page, documents:document_id(filename, created_at, vendor_id, vendor:vendor_id(name))')
      .not('price', 'is', null)
      .limit(Math.max(limit, 80))
    if (filters.documentId) query = query.eq('document_id', filters.documentId)
    return query
  }

  const structuredTasks = buildLegacyStructuredRecallQueries(parsed)
    .filter(structured => structured.terms.length)
    .map(async (structured) => {
      let query = runBaseQuery().limit(Math.max(240, limit * 6))
      for (const term of structured.terms.slice(0, 4)) {
        query = query.ilike('raw_name', `%${sqlLikeTerm(term)}%`)
      }
      const { data, error } = await query
      return { data, error, score: structured.score }
    })

  const textTasks = uniqueText([parsed.raw_query, parsed.normalized_query])
    .slice(0, 2)
    .map(async (textQuery) => {
      const { data, error } = await runBaseQuery()
        .textSearch('search_doc', textQuery, { type: 'plain', config: 'simple' })
      return { data, error, score: 0.85 }
    })

  const usefulTerms = uniqueText([
    ...parsed.attribute_hints.map(hint => hint.value),
    ...parsed.attribute_hints.map(hint => hint.unit),
    ...parsed.product_terms
  ].filter((term): term is string => Boolean(term && term.length >= 2)))
    .slice(0, 8)

  const fuzzyTask = usefulTerms.length
    ? (async () => {
      const escaped = usefulTerms
        .flatMap(term => [
          `raw_name.ilike.%${term.replace(/[%(),]/g, '')}%`,
          `sku.ilike.%${term.replace(/[%(),]/g, '')}%`
        ])
        .join(',')
      const { data, error } = await runBaseQuery().or(escaped)
      return { data, error, score: 0.55 }
    })()
    : null

  const recallResults = await Promise.all([
    ...structuredTasks,
    ...textTasks,
    ...(fuzzyTask ? [fuzzyTask] : [])
  ])

  for (const result of recallResults) {
    if (!result.error) addRows(result.data as any[], result.score)
  }

  return dedupe([...rowsById.values()]
    .map((row: any) => {
      const document = Array.isArray(row.documents) ? row.documents[0] : row.documents
      const searchable = [document?.vendor?.name, document?.filename, row.raw_name, row.sku, row.unit, row.price].filter(Boolean).join(' ')
      return normalizeRpcCandidate({
      doc_price_item_id: null,
      legacy_doc_item_id: row.doc_item_id ?? row.id,
      document_id: row.document_id,
      vendor_id: document?.vendor_id ?? null,
      vendor: document?.vendor?.name ?? null,
      filename: document?.filename ?? '',
      source_uploaded_at: document?.created_at ?? null,
      source_page: row.source_page,
      normalized_price: row.price,
      currency: row.currency,
      unit: row.unit,
      moq: row.moq,
      product_text: row.raw_name,
      sku_text: row.sku,
      description_text: row.raw_name,
      section_breadcrumb: uniqueText([row.vendor, row.filename]),
      table_title: row.filename ?? null,
      row_headers: uniqueText([row.raw_name, row.sku]),
      column_headers: uniqueText([row.unit]),
      parent_headers: uniqueText([row.vendor]),
      raw_cell_value: row.price === null || row.price === undefined ? null : String(row.price),
      attributes_json: legacyAttributes(row, searchable),
      searchable_text: searchable,
      normalized_search_text: normalizeSearchText([row.raw_name, row.sku, row.unit].filter(Boolean).join(' ')),
      source_confidence: 0.78,
      parser_name: 'legacy-doc-items',
      rank_score: row.score
    }, 'legacy_indexed_sql')
    })
  ).slice(0, limit)
}

function dedupe(candidates: PriceCandidate[]) {
  const byId = new Map<string, PriceCandidate>()
  for (const candidate of candidates) {
    const key = candidate.doc_item_id
      ? `legacy:${candidate.doc_item_id}`
      : candidate.doc_price_item_id ?? `${candidate.document_id}:${candidate.normalized_search_text}:${candidate.normalized_price}`
    const existing = byId.get(key)
    if (
      !existing
      || (candidate.doc_price_item_id && !existing.doc_price_item_id)
      || candidate.recall_score > existing.recall_score
    ) byId.set(key, candidate)
  }
  return [...byId.values()]
}

export async function generateCandidates(params: {
  client: SupabaseClient
  parsed: ParsedUserItemQuery
  filters: CandidateFilters
  limit?: number
}) {
  const limit = params.limit ?? 40
  const canonical = await canonicalCandidates(params.client, params.parsed, params.filters, limit)
  if (!shouldUseLegacyFallback(canonical)) return dedupe(canonical).slice(0, limit)
  const legacy = await legacyCandidates(params.client, params.parsed, params.filters, limit)
  return dedupe([...canonical, ...legacy]).slice(0, limit)
}
