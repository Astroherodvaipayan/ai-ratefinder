import type { SupabaseClient } from '@supabase/supabase-js'
import type { CatalogCategory, CatalogFacets } from './contracts'
import { normalizeCatalogSku, parseCatalogQuery, type CatalogQuery } from './query'
import { rupeeDisplayStrings, rupeeDisplayText } from '../currency'

export interface CatalogOfferRow {
  id: string
  document_id: string
  vendor_id: string | null
  category: CatalogCategory
  canonical_name: string
  brand: string | null
  sku: string | null
  normalized_sku?: string | null
  aliases: string[]
  facets: CatalogFacets
  amount: number
  currency: string
  basis_quantity: number | null
  basis_unit: string | null
  package_type: string | null
  moq: string | null
  source_page: number | null
  source_table_index: number | null
  source_row_index: number
  source_col_index: number
  source_table_title: string | null
  source_row_label: string | null
  source_column_label: string | null
  raw_price_value: string
  source_excerpt: string
  documents?: { filename?: string } | Array<{ filename?: string }> | null
}

export interface CatalogSearchResult {
  query: CatalogQuery
  state: 'exact' | 'ambiguous' | 'absent'
  match_method: 'sku' | 'facets' | 'none'
  offers: CatalogOfferRow[]
  alternatives: CatalogAlternative[]
  suggestions: CatalogSearchSuggestion[]
  refinements: CatalogRefinement[]
  missing_facets: string[]
  explanation: string
}

export interface CatalogAlternative {
  offer: CatalogOfferRow
  differing_facets: string[]
}

export interface CatalogSearchSuggestion {
  label: string
  query: string
  reason: 'sku' | 'spelling' | 'closest' | 'refinement'
  sku?: string | null
}

export interface CatalogRefinement {
  facet: string
  options: Array<{ label: string, value: string | number | boolean, query: string }>
}

const OFFER_SELECT = 'id, document_id, vendor_id, category, canonical_name, brand, sku, aliases, facets, amount, currency, basis_quantity, basis_unit, package_type, moq, source_page, source_table_index, source_row_index, source_col_index, source_table_title, source_row_label, source_column_label, raw_price_value, source_excerpt, documents:document_id(filename)'

const CATEGORY_FACETS: Partial<Record<CatalogCategory, string[]>> = {
  coaxial_cable: ['standard', 'conductor_material'],
  data_cable: ['standard', 'armour', 'pairs'],
  telephone_cable: ['pairs', 'conductor_size_mm', 'armour'],
  power_cable: ['size_sqmm', 'cores', 'conductor_material', 'armour', 'voltage_grade', 'insulation'],
  flexible_cable: ['size_sqmm', 'cores', 'conductor_material', 'fire_rating', 'variant'],
  single_core_wire: ['size_sqmm', 'cores', 'conductor_material', 'fire_rating'],
  mcb: ['current_a', 'poles', 'curve', 'breaking_capacity_ka'],
  mccb: ['current_a', 'poles', 'breaking_capacity_ka'],
  junction_box: ['size_mm', 'ways'],
  distribution_board: ['ways', 'modules', 'board_type', 'variant'],
  modular_box: ['modules', 'variant'],
  switch: ['current_a', 'poles', 'ways', 'modules', 'indicator', 'variant'],
  socket: ['current_a', 'current_range', 'pins', 'modules', 'combined', 'switched', 'shutter', 'variant'],
  accessory: ['current_a', 'pins', 'modules', 'indicator', 'variant']
}

// A single currently indexed offer does not make a commercially distinct
// product family unambiguous. These facets must be stated when the catalogue
// offer carries them, even if only one compatible row happens to be published.
const REQUIRED_QUERY_FACETS: Partial<Record<CatalogCategory, string[]>> = {
  power_cable: ['armour'],
  flexible_cable: ['fire_rating'],
  socket: ['current_a'],
  accessory: ['current_a']
}

const PRESENCE_DIFFERENTIATES: Partial<Record<CatalogCategory, string[]>> = {
  mcb: ['curve', 'breaking_capacity_ka'],
  mccb: ['breaking_capacity_ka'],
  switch: ['poles', 'ways', 'modules', 'indicator', 'variant'],
  socket: ['current_range', 'pins', 'modules', 'combined', 'switched', 'shutter', 'variant'],
  accessory: ['modules', 'indicator', 'variant']
}

export async function searchCatalogV2(params: {
  client: SupabaseClient
  message: string
  vendorId?: string | null
  documentId?: string | null
  limit?: number
}): Promise<CatalogSearchResult> {
  const parsed = parseCatalogQuery(params.message)
  const { data: release, error: releaseError } = await params.client
    .from('catalog_releases')
    .select('id')
    .eq('status', 'active')
    .maybeSingle()
  if (releaseError) throw createError({ statusCode: 500, statusMessage: releaseError.message })
  if (!release) throw createError({ statusCode: 503, statusMessage: 'The searchable catalogue has no active release.' })

  if (parsed.sku_candidates.length) {
    const skuFilter = parsed.sku_candidates
      .map(candidate => `sku.ilike.${skuLikePattern(candidate)}`)
      .join(',')
    const skuQuery = baseOfferQuery(params.client, release.id, params)
      .or(skuFilter)
      .limit(Math.max(params.limit ?? 100, 250))
    const { data: skuRows, error: skuError } = await skuQuery
    if (skuError) throw createError({ statusCode: 500, statusMessage: skuError.message })
    const exactSkuRows = (skuRows ?? []).filter((row: any) => parsed.sku_candidates.includes(normalizeCatalogSku(row.sku)))
    if (exactSkuRows.length) {
      return resolveCatalogOffers(parsed, hydrateOffers(exactSkuRows), { identityMatched: true, matchMethod: 'sku' })
    }
  }

  if (!parsed.category) {
    const suggestions = parsed.sku_candidates.length
      ? await skuPrefixSuggestions(params.client, release.id, parsed.sku_candidates[0]!, params)
      : []
    return emptyCatalogResult(parsed, 'ambiguous', ['category'], suggestions,
      parsed.sku_candidates.length
        ? 'No exact SKU was found. Choose a catalogue-code suggestion or add a product family.'
        : 'Specify a supported product family before catalogue retrieval.')
  }

  const strictQuery = applyStrictQueryFilters(
    baseOfferQuery(params.client, release.id, params).eq('category', parsed.category),
    parsed
  ).limit(params.limit ?? 100)
  const recoveryQuery = applyRecoveryIdentityFilter(
    baseOfferQuery(params.client, release.id, params).eq('category', parsed.category),
    parsed
  ).limit(Math.max(params.limit ?? 100, 500))

  const [{ data: strictRows, error: strictError }, { data: recoveryRows, error: recoveryError }] = await Promise.all([
    strictQuery,
    recoveryQuery
  ])
  if (strictError) throw createError({ statusCode: 500, statusMessage: strictError.message })
  if (recoveryError) throw createError({ statusCode: 500, statusMessage: recoveryError.message })

  const combined = dedupeRows([...(strictRows ?? []), ...(recoveryRows ?? [])])
  return resolveCatalogOffers(parsed, hydrateOffers(combined), { matchMethod: 'facets' })
}

export function resolveCatalogOffers(
  parsed: CatalogQuery,
  offers: CatalogOfferRow[],
  options: { identityMatched?: boolean, matchMethod?: CatalogSearchResult['match_method'] } = {}
): CatalogSearchResult {
  const hydrated = offers.map(repairCatalogOfferIdentity)
  const compatible = dedupeCompatibleOffers(hydrated.filter(offer => offerIsCompatible(parsed, offer)))
  if (!compatible.length) {
    const alternatives = closestAlternatives(parsed, hydrated)
    return {
      query: parsed,
      state: 'absent',
      match_method: options.matchMethod ?? 'none',
      offers: [],
      alternatives,
      suggestions: resultSuggestions(parsed, alternatives),
      refinements: [],
      missing_facets: [],
      explanation: 'No published catalogue offer satisfies every specified product facet.'
    }
  }

  const missingFacets = differentiatingMissingFacets(parsed, compatible, Boolean(options.identityMatched))
  return {
    query: parsed,
    state: missingFacets.length ? 'ambiguous' : 'exact',
    match_method: options.matchMethod ?? 'facets',
    offers: compatible,
    alternatives: [],
    suggestions: resultSuggestions(parsed, []),
    refinements: refinementOptions(parsed, compatible, missingFacets),
    missing_facets: missingFacets,
    explanation: missingFacets.length
      ? `The request is underspecified for ${missingFacets.join(', ')}.`
      : 'Every returned offer satisfies the specified product facets.'
  }
}

function baseOfferQuery(
  client: SupabaseClient,
  releaseId: string,
  params: { vendorId?: string | null, documentId?: string | null }
) {
  let query = client
    .from('catalog_offers')
    .select(OFFER_SELECT)
    .eq('status', 'published')
    .eq('release_id', releaseId)
  if (params.vendorId) query = query.eq('vendor_id', params.vendorId)
  if (params.documentId) query = query.eq('document_id', params.documentId)
  return query
}

function applyStrictQueryFilters(query: any, parsed: CatalogQuery) {
  let filtered = query
  if (Object.keys(parsed.facets).length) filtered = filtered.contains('facets', parsed.facets)
  if (parsed.requested_basis_quantity !== null) filtered = filtered.eq('basis_quantity', parsed.requested_basis_quantity)
  if (parsed.requested_basis_unit) filtered = filtered.eq('basis_unit', parsed.requested_basis_unit)
  return filtered
}

function applyRecoveryIdentityFilter(query: any, parsed: CatalogQuery) {
  const needle = recoveryIdentityNeedle(parsed)
  return needle ? query.ilike('canonical_name', `%${needle}%`) : query
}

function recoveryIdentityNeedle(parsed: CatalogQuery) {
  const facet = parsed.facets
  if (facet.standard) return String(facet.standard).replace('-', '%')
  if (parsed.category === 'power_cable' && facet.size_sqmm !== undefined) return String(facet.size_sqmm)
  if (parsed.category === 'single_core_wire' && facet.size_sqmm !== undefined) return `${facet.size_sqmm}%SQ`
  if (parsed.category === 'flexible_cable' && facet.size_sqmm !== undefined) return `${facet.size_sqmm}%SQ`
  if (parsed.category === 'junction_box' && facet.ways !== undefined) return `${facet.ways}%WAY`
  if (parsed.category === 'distribution_board' && facet.ways !== undefined) return `${facet.ways}%WAY`
  if (parsed.category === 'modular_box' && facet.modules !== undefined) return `${facet.modules}%MODULE`
  if ((parsed.category === 'mcb' || parsed.category === 'mccb') && facet.current_a !== undefined) return `${facet.current_a}%A`
  if (parsed.category === 'telephone_cable' && facet.pairs !== undefined) return `${facet.pairs}%PAIR`
  return null
}

function dedupeRows(rows: any[]) {
  return [...new Map(rows.map(row => [row.id, row])).values()]
}

function hydrateOffers(rows: any[]): CatalogOfferRow[] {
  return rows.map(row => ({
    ...row,
    amount: Number(row.amount),
    currency: 'INR',
    canonical_name: rupeeDisplayText(row.canonical_name),
    aliases: rupeeDisplayStrings(row.aliases),
    source_table_title: rupeeDisplayText(row.source_table_title),
    source_row_label: rupeeDisplayText(row.source_row_label),
    source_column_label: rupeeDisplayText(row.source_column_label),
    raw_price_value: rupeeDisplayText(row.raw_price_value),
    source_excerpt: rupeeDisplayText(row.source_excerpt)
  })) as CatalogOfferRow[]
}

export function repairCatalogOfferIdentity(offer: CatalogOfferRow): CatalogOfferRow {
  const identityText = [
    offer.canonical_name,
    offer.source_row_label,
    offer.source_column_label
  ].filter(Boolean).join(' ')
  const derived = parseCatalogQuery(identityText)
  return {
    ...offer,
    normalized_sku: offer.normalized_sku ?? normalizeCatalogSku(offer.sku),
    facets: { ...offer.facets, ...derived.facets }
  }
}

function emptyCatalogResult(
  query: CatalogQuery,
  state: CatalogSearchResult['state'],
  missingFacets: string[],
  suggestions: CatalogSearchSuggestion[],
  explanation: string
): CatalogSearchResult {
  return {
    query,
    state,
    match_method: 'none',
    offers: [],
    alternatives: [],
    suggestions: [
      ...queryCorrectionSuggestions(query),
      ...suggestions
    ],
    refinements: [],
    missing_facets: missingFacets,
    explanation
  }
}

async function skuPrefixSuggestions(
  client: SupabaseClient,
  releaseId: string,
  normalizedSku: string,
  params: { vendorId?: string | null, documentId?: string | null }
): Promise<CatalogSearchSuggestion[]> {
  const { data, error } = await baseOfferQuery(client, releaseId, params)
    .ilike('sku', skuLikePattern(normalizedSku))
    .not('sku', 'is', null)
    .order('sku')
    .limit(100)
  if (error) return []
  const seen = new Set<string>()
  return (data ?? []).flatMap((row: any) => {
    const normalized = normalizeCatalogSku(row.sku)
    if (!normalized.startsWith(normalizedSku) || seen.has(normalized)) return []
    seen.add(normalized)
    return [{
      label: [row.sku, row.brand, shortProductName(row.canonical_name)].filter(Boolean).join(' · '),
      query: `SKU ${row.sku}`,
      reason: 'sku' as const,
      sku: row.sku
    }]
  }).slice(0, 6)
}

function skuLikePattern(normalizedSku: string) {
  return `%${normalizedSku.split('').join('%')}%`
}

function shortProductName(value: string | null | undefined) {
  const text = String(rupeeDisplayText(value) ?? '').replace(/\s+/g, ' ').trim()
  return text.length > 90 ? `${text.slice(0, 87)}…` : text
}

function dedupeCompatibleOffers(offers: CatalogOfferRow[]) {
  const byIdentity = new Map<string, CatalogOfferRow>()
  for (const offer of offers) {
    const key = JSON.stringify([
      offer.brand?.toLowerCase() ?? null,
      offer.category,
      offer.sku?.toLowerCase() ?? null,
      offer.facets,
      Number(offer.amount),
      Number(offer.basis_quantity),
      offer.basis_unit,
      offer.package_type
    ])
    if (!byIdentity.has(key)) byIdentity.set(key, offer)
  }
  return [...byIdentity.values()]
}

function offerIsCompatible(query: CatalogQuery, offer: CatalogOfferRow) {
  if (query.category && offer.category !== query.category) return false
  if (!offerMatchesProductIntent(query, offer)) return false
  for (const [name, expected] of Object.entries(query.facets)) {
    const actual = offer.facets[name]
    if (actual === undefined || !sameFacet(actual, expected)) return false
  }
  if (query.requested_basis_quantity !== null && Number(offer.basis_quantity) !== query.requested_basis_quantity) return false
  if (query.requested_basis_unit && offer.basis_unit !== query.requested_basis_unit) return false
  return true
}

function offerMatchesProductIntent(query: CatalogQuery, offer: CatalogOfferRow) {
  const requested = query.normalized_text
  const identity = [offer.canonical_name, offer.source_row_label, offer.source_column_label]
    .filter(Boolean).join(' ').toLowerCase()
  if (query.category === 'distribution_board' && /\b(?:box|db|distribution board|enclosure)\b/.test(requested)) {
    if (/\b(?:conversion kit|cable end box|bus ?bar|neutral link|earth link)\b/.test(identity)) return false
    if (!/\b(?:db|distribution board|enclosure|box)\b/.test(identity)) return false
  }
  if (query.category === 'data_cable' && /\bcable\b/.test(requested) && /\b(?:socket|jack|rj\s*45|outlet)\b/.test(identity)) {
    return false
  }
  return true
}

function sameFacet(actual: string | number | boolean, expected: string | number | boolean) {
  if (typeof expected === 'number') return Number(actual) === expected
  return String(actual).toLowerCase() === String(expected).toLowerCase()
}

function differentiatingMissingFacets(query: CatalogQuery, offers: CatalogOfferRow[], identityMatched = false) {
  const category = query.category ?? offers[0]?.category ?? 'other'
  const relevant = CATEGORY_FACETS[category] ?? []
  const required = new Set(REQUIRED_QUERY_FACETS[category] ?? [])
  const presenceSensitive = new Set(PRESENCE_DIFFERENTIATES[category] ?? [])
  const missing: string[] = []
  for (const facet of relevant) {
    if (query.facets[facet] !== undefined) continue
    const defined = offers.map(offer => offer.facets[facet]).filter(value => value !== undefined)
    const values = new Set(defined.map(String))
    const presenceDiffers = !identityMatched && presenceSensitive.has(facet) && defined.length > 0 && defined.length < offers.length
    if (values.size > 1 || presenceDiffers || (!identityMatched && required.has(facet) && values.size > 0)) missing.push(facet)
  }
  if (query.requested_basis_quantity === null) {
    const bases = new Set(offers.map(offer => `${offer.basis_quantity ?? ''}:${offer.basis_unit ?? ''}`))
    if (bases.size > 1) missing.push('price_basis')
  }
  return missing
}

function closestAlternatives(query: CatalogQuery, offers: CatalogOfferRow[]): CatalogAlternative[] {
  const explicitFacets = Object.entries(query.facets)
  if (!explicitFacets.length) return []
  return offers
    .map((offer) => {
      const differing = explicitFacets.flatMap(([name, expected]) => {
        const actual = offer.facets[name]
        return actual === undefined || !sameFacet(actual, expected) ? [name] : []
      })
      const missingExplicit = explicitFacets.filter(([name]) => offer.facets[name] === undefined).length
      const matching = explicitFacets.length - differing.length
      return { offer, differing_facets: differing, score: matching * 10 - differing.length, missingExplicit }
    })
    .filter(item => {
      const matching = explicitFacets.length - item.differing_facets.length
      return (matching > 0 && item.differing_facets.length <= 2)
        || (explicitFacets.length === 1 && item.differing_facets.length === 1 && item.missingExplicit === 0)
    })
    .sort((a, b) => b.score - a.score || Number(a.offer.amount) - Number(b.offer.amount))
    .slice(0, 6)
    .map(({ offer, differing_facets }) => ({ offer, differing_facets }))
}

function resultSuggestions(query: CatalogQuery, alternatives: CatalogAlternative[]): CatalogSearchSuggestion[] {
  const suggestions = queryCorrectionSuggestions(query)
  const seen = new Set(suggestions.map(suggestion => suggestion.query.toLowerCase()))
  for (const alternative of alternatives) {
    const offer = alternative.offer
    const nextQuery = offer.sku ? `SKU ${offer.sku}` : sourceBackedQuery(offer)
    if (!nextQuery || seen.has(nextQuery.toLowerCase())) continue
    seen.add(nextQuery.toLowerCase())
    suggestions.push({
      label: `${offer.sku ? `${offer.sku} · ` : ''}${facetSummary(offer)} — differs in ${alternative.differing_facets.map(prettyFacet).join(', ')}`,
      query: nextQuery,
      reason: 'closest',
      sku: offer.sku
    })
  }
  return suggestions.slice(0, 6)
}

function queryCorrectionSuggestions(query: CatalogQuery): CatalogSearchSuggestion[] {
  if (!query.corrected_text || query.corrected_text.toLowerCase() === query.raw.trim().toLowerCase()) return []
  return [{
    label: `Showing the corrected wording: ${query.corrected_text}`,
    query: query.corrected_text,
    reason: 'spelling'
  }]
}

function refinementOptions(query: CatalogQuery, offers: CatalogOfferRow[], missingFacets: string[]): CatalogRefinement[] {
  return missingFacets.flatMap((facet) => {
    if (facet === 'price_basis') {
      const options = uniqueRefinementOptions(offers.map(offer => {
        const label = [offer.basis_quantity && offer.basis_quantity !== 1 ? offer.basis_quantity : null, offer.basis_unit, offer.package_type]
          .filter(Boolean).join(' ')
        return label ? { label, value: label, query: `${query.raw} ${label}` } : null
      }))
      return options.length > 1 ? [{ facet, options }] : []
    }
    const options = uniqueRefinementOptions(offers.map((offer) => {
      const value = offer.facets[facet]
      if (value === undefined) return null
      const label = facetValueLabel(facet, value)
      return { label, value, query: `${query.raw} ${label}` }
    }))
    return options.length > 1 ? [{ facet, options }] : []
  })
}

function uniqueRefinementOptions(options: Array<CatalogRefinement['options'][number] | null>) {
  const byValue = new Map<string, CatalogRefinement['options'][number]>()
  for (const option of options) {
    if (option) byValue.set(String(option.value).toLowerCase(), option)
  }
  return [...byValue.values()].slice(0, 10)
}

function facetValueLabel(facet: string, value: string | number | boolean) {
  if (facet === 'current_a') return `${value}A`
  if (facet === 'poles') return `${value} pole`
  if (facet === 'cores') return `${value} core`
  if (facet === 'pairs') return `${value} pair`
  if (facet === 'modules') return `${value} module`
  if (facet === 'ways') return `${value} way`
  if (facet === 'size_sqmm') return `${value} sqmm`
  if (facet === 'breaking_capacity_ka') return `${value}kA`
  if (facet === 'curve') return `${value} curve`
  return String(value)
}

function prettyFacet(value: string) {
  return value.replace(/_/g, ' ')
}

function facetSummary(offer: CatalogOfferRow) {
  const labels = Object.entries(offer.facets)
    .filter(([name]) => name !== 'price_basis_inferred')
    .slice(0, 6)
    .map(([name, value]) => facetValueLabel(name, value))
  return labels.join(' · ') || shortProductName(offer.canonical_name)
}

function sourceBackedQuery(offer: CatalogOfferRow) {
  const parts = [offer.brand, facetSummary(offer), offer.category.replace(/_/g, ' ')]
  return parts.filter(Boolean).join(' ')
}
