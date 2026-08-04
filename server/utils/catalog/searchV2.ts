import type { SupabaseClient } from '@supabase/supabase-js'
import type { CatalogCategory, CatalogFacets } from './contracts'
import { parseCatalogQuery, type CatalogQuery } from './query'
import { rupeeDisplayStrings, rupeeDisplayText } from '../currency'

export interface CatalogOfferRow {
  id: string
  document_id: string
  vendor_id: string | null
  category: CatalogCategory
  canonical_name: string
  brand: string | null
  sku: string | null
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
  offers: CatalogOfferRow[]
  missing_facets: string[]
  explanation: string
}

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
  if (!parsed.category) {
    return {
      query: parsed,
      state: 'ambiguous',
      offers: [],
      missing_facets: ['category'],
      explanation: 'Specify a supported product family before catalogue retrieval.'
    }
  }
  const { data: release, error: releaseError } = await params.client
    .from('catalog_releases')
    .select('id')
    .eq('status', 'active')
    .maybeSingle()
  if (releaseError) throw createError({ statusCode: 500, statusMessage: releaseError.message })
  if (!release) throw createError({ statusCode: 503, statusMessage: 'The searchable catalogue has no active release.' })

  let query = params.client
    .from('catalog_offers')
    .select('id, document_id, vendor_id, category, canonical_name, brand, sku, aliases, facets, amount, currency, basis_quantity, basis_unit, package_type, moq, source_page, source_table_index, source_row_index, source_col_index, source_table_title, source_row_label, source_column_label, raw_price_value, source_excerpt, documents:document_id(filename)')
    .eq('status', 'published')
    .eq('release_id', release.id)
    .limit(params.limit ?? 100)
  if (parsed.category) query = query.eq('category', parsed.category)
  if (Object.keys(parsed.facets).length) query = query.contains('facets', parsed.facets)
  if (parsed.requested_basis_quantity !== null) query = query.eq('basis_quantity', parsed.requested_basis_quantity)
  if (parsed.requested_basis_unit) query = query.eq('basis_unit', parsed.requested_basis_unit)
  if (params.vendorId) query = query.eq('vendor_id', params.vendorId)
  if (params.documentId) query = query.eq('document_id', params.documentId)

  const { data, error } = await query
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return resolveCatalogOffers(parsed, (data ?? []).map(row => ({
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
  })) as CatalogOfferRow[])
}

export function resolveCatalogOffers(parsed: CatalogQuery, offers: CatalogOfferRow[]): CatalogSearchResult {
  const compatible = dedupeCompatibleOffers(offers.filter(offer => offerIsCompatible(parsed, offer)))
  if (!compatible.length) {
    return {
      query: parsed,
      state: 'absent',
      offers: [],
      missing_facets: [],
      explanation: 'No published catalogue offer satisfies every specified product facet.'
    }
  }

  const missingFacets = differentiatingMissingFacets(parsed, compatible)
  return {
    query: parsed,
    state: missingFacets.length ? 'ambiguous' : 'exact',
    offers: compatible,
    missing_facets: missingFacets,
    explanation: missingFacets.length
      ? `The request is underspecified for ${missingFacets.join(', ')}.`
      : 'Every returned offer satisfies the specified product facets.'
  }
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
  for (const [name, expected] of Object.entries(query.facets)) {
    const actual = offer.facets[name]
    if (actual === undefined || !sameFacet(actual, expected)) return false
  }
  if (query.requested_basis_quantity !== null && Number(offer.basis_quantity) !== query.requested_basis_quantity) return false
  if (query.requested_basis_unit && offer.basis_unit !== query.requested_basis_unit) return false
  return true
}

function sameFacet(actual: string | number | boolean, expected: string | number | boolean) {
  if (typeof expected === 'number') return Number(actual) === expected
  return String(actual).toLowerCase() === String(expected).toLowerCase()
}

function differentiatingMissingFacets(query: CatalogQuery, offers: CatalogOfferRow[]) {
  const category = query.category ?? offers[0]?.category ?? 'other'
  const relevant = CATEGORY_FACETS[category] ?? []
  const required = new Set(REQUIRED_QUERY_FACETS[category] ?? [])
  const presenceSensitive = new Set(PRESENCE_DIFFERENTIATES[category] ?? [])
  const missing: string[] = []
  for (const facet of relevant) {
    if (query.facets[facet] !== undefined) continue
    const defined = offers.map(offer => offer.facets[facet]).filter(value => value !== undefined)
    const values = new Set(defined.map(String))
    const presenceDiffers = presenceSensitive.has(facet) && defined.length > 0 && defined.length < offers.length
    if (values.size > 1 || presenceDiffers || (required.has(facet) && values.size > 0)) missing.push(facet)
  }
  if (query.requested_basis_quantity === null) {
    const bases = new Set(offers.map(offer => `${offer.basis_quantity ?? ''}:${offer.basis_unit ?? ''}`))
    if (bases.size > 1) missing.push('price_basis')
  }
  return missing
}
