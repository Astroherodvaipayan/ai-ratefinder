export const CATALOGUE_COMPILER_VERSION = 'catalog-v4.0.0'

export const CATALOG_CATEGORIES = [
  'coaxial_cable',
  'data_cable',
  'telephone_cable',
  'power_cable',
  'flexible_cable',
  'single_core_wire',
  'mcb',
  'mccb',
  'rccb',
  'rcbo',
  'isolator',
  'distribution_board',
  'junction_box',
  'modular_box',
  'switch',
  'socket',
  'conduit',
  'accessory',
  'other'
] as const

export type CatalogCategory = typeof CATALOG_CATEGORIES[number]
export type CatalogFacetValue = string | number | boolean
export type CatalogFacets = Record<string, CatalogFacetValue>

export interface CompiledCatalogOffer {
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
  source_table_index: number
  source_row_index: number
  source_col_index: number
  source_table_title: string | null
  source_row_label: string | null
  source_column_label: string | null
  raw_price_value: string
  source_excerpt: string
  validation_errors: string[]
}

const VALID_BASIS_UNITS = new Set([
  'piece', 'meter', 'coil', 'roll', 'box', 'set', 'pair', 'unit', 'kg', 'litre', 'packet', 'dozen'
])

export function validateCompiledOffer(offer: Omit<CompiledCatalogOffer, 'validation_errors'>) {
  const errors: string[] = []
  if (!CATALOG_CATEGORIES.includes(offer.category)) errors.push('unknown_category')
  if (!offer.canonical_name.trim()) errors.push('missing_canonical_name')
  if (!offer.source_row_label?.trim() && !offer.sku?.trim()) errors.push('missing_product_identity')
  if (!Number.isFinite(offer.amount) || offer.amount <= 0) errors.push('invalid_amount')
  if (!/^\d[\d,]*(?:\.\d+)?(?:\s*\/-)?$/.test(offer.raw_price_value.trim())) {
    errors.push('raw_price_is_not_a_plain_monetary_value')
  }
  if (offer.basis_quantity !== null && (!Number.isFinite(offer.basis_quantity) || offer.basis_quantity <= 0)) {
    errors.push('invalid_basis_quantity')
  }
  if (offer.basis_quantity === null || !offer.basis_unit) errors.push('missing_price_basis')
  if (offer.basis_unit && !VALID_BASIS_UNITS.has(offer.basis_unit)) errors.push('invalid_basis_unit')
  if (offer.source_row_index < 0 || offer.source_col_index < 0) errors.push('invalid_source_coordinate')
  if (!offer.source_excerpt.trim()) errors.push('missing_source_excerpt')
  const sourceColumn = offer.source_column_label?.toLowerCase().replace(/\s+/g, ' ') ?? ''
  if (/\b(?:current\s*(?:carrying|rating|capacity|amps?)|amps?|standard\s*pack|standardpacking|std\.?\s*(?:pack|pkg)|packing\s*(?:quantity|qty)|no\.?\s*of\s*coils?|hsn|dimension|conductor\s*construction)\b/.test(sourceColumn)) {
    errors.push('specification_column_published')
  }

  return errors
}
