import type { CompiledCatalogOffer } from './contracts'

type AuditedOffer = Pick<CompiledCatalogOffer,
  'amount' | 'basis_quantity' | 'basis_unit' | 'package_type' | 'source_table_index'
  | 'source_row_index' | 'source_col_index' | 'source_column_label' | 'canonical_name'
  | 'category' | 'facets' | 'sku' | 'source_row_label' | 'source_table_title'>

export interface CataloguePricePairFailure {
  reason: 'inconsistent_pack_unit_price'
  table_index: number
  row_index: number
  pack_column: number
  unit_column: number
  pack_amount: number
  unit_amount: number
  pack_quantity: number
  relative_error: number
  product: string
}

export interface CatalogueIdentityFailure {
  reason: 'unusable_product_identity' | 'unexpected_other_category'
  table_index: number
  row_index: number
  column_index: number
  product: string
  category: string
}

export type CatalogueSemanticFailure = CataloguePricePairFailure | CatalogueIdentityFailure

function normalized(value: string | null | undefined) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function variantKey(offer: AuditedOffer) {
  return normalized(offer.source_column_label)
    .replace(/\b(?:rate|price|mrp|cost)\s+per\s+(?:coil|roll|mtr|meter|metre)s?\b/g, '')
    .trim()
}

export function auditCatalogueOfferSemantics(offers: AuditedOffer[]): CatalogueSemanticFailure[] {
  const failures: CatalogueSemanticFailure[] = []
  const groups = new Map<string, AuditedOffer[]>()
  for (const offer of offers) {
    const identity = [offer.source_row_label, offer.source_column_label, offer.canonical_name, offer.sku].filter(Boolean).join(' ')
    if (/^(?:n\s*\.?\s*a\.?|not available)(?:\s+—|$)/i.test(offer.canonical_name.trim())) {
      failures.push({
        reason: 'unusable_product_identity', table_index: offer.source_table_index, row_index: offer.source_row_index,
        column_index: offer.source_col_index, product: offer.canonical_name, category: offer.category
      })
    }
    if (offer.category === 'other'
      && (/\b(?:building management system cable|bms cable|speaker wire)\b/i.test(identity)
        || /\b(?:rg[ -]?(?:6|11|59)|cat[ -]?(?:5e|6|6a|7))\b/i.test(offer.sku ?? ''))) {
      failures.push({
        reason: 'unexpected_other_category', table_index: offer.source_table_index, row_index: offer.source_row_index,
        column_index: offer.source_col_index, product: offer.canonical_name, category: offer.category
      })
    }
    const key = `${offer.source_table_index}:${offer.source_row_index}:${variantKey(offer)}`
    const group = groups.get(key)
    if (group) group.push(offer)
    else groups.set(key, [offer])
  }

  for (const group of groups.values()) {
    const packOffers = group.filter(offer => offer.basis_unit === 'meter'
      && Number(offer.basis_quantity) > 1
      && ['coil', 'roll'].includes(offer.package_type ?? ''))
    const unitOffers = group.filter(offer => offer.basis_unit === 'meter'
      && offer.basis_quantity === 1
      && /\b(?:per\s*|rate\s*(?:per\s*)?)(?:mtr|meter|metre)\b/i.test(offer.source_column_label ?? ''))

    for (const pack of packOffers) {
      const unit = unitOffers
        .filter(candidate => candidate.source_col_index > pack.source_col_index && candidate.source_col_index - pack.source_col_index <= 2)
        .sort((left, right) => left.source_col_index - right.source_col_index)[0]
      if (!unit) continue
      const expected = unit.amount * Number(pack.basis_quantity)
      const relativeError = Math.abs(pack.amount - expected) / pack.amount
      if (relativeError <= 0.01) continue
      failures.push({
        reason: 'inconsistent_pack_unit_price',
        table_index: pack.source_table_index,
        row_index: pack.source_row_index,
        pack_column: pack.source_col_index,
        unit_column: unit.source_col_index,
        pack_amount: pack.amount,
        unit_amount: unit.amount,
        pack_quantity: Number(pack.basis_quantity),
        relative_error: relativeError,
        product: pack.canonical_name
      })
    }
  }
  return failures
}
