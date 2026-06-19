import { normalizeSearchText, normalizeUnit } from './text'

export interface PriceBasisInput {
  price: number
  unit?: string | null
  moq?: string | null
  raw_cell_value?: string | null
  searchable_text?: string | null
  description_text?: string | null
  product_text?: string | null
  table_title?: string | null
  row_headers?: string[]
  column_headers?: string[]
  parent_headers?: string[]
  nearby_notes?: string[]
  section_breadcrumb?: string[]
}

export interface PriceBasisSummary {
  source_price: number
  source_basis_quantity: number
  source_basis_unit: string | null
  source_basis_pack_unit: string | null
  source_basis_label: string | null
  effective_unit_price: number
  effective_unit: string | null
}

export interface RequestedQuantityLike {
  value?: number | null
  unit?: string | null
}

export interface QuotationRate {
  qty: number
  unit: string | null
  unit_price: number
}

const PACK_UNITS = new Set(['coil', 'roll', 'bundle'])

export function inferPriceBasis(input: PriceBasisInput): PriceBasisSummary {
  const price = Number(input.price ?? 0)
  const context = normalizeSearchText([
    input.unit,
    input.moq,
    input.raw_cell_value,
    input.description_text,
    input.product_text,
    input.table_title,
    ...(input.section_breadcrumb ?? []),
    ...(input.parent_headers ?? []),
    ...(input.row_headers ?? []),
    ...(input.column_headers ?? []),
    ...(input.nearby_notes ?? []),
    input.searchable_text
  ].filter(Boolean).join(' '))

  const explicitPer = context.match(/\b(?:rate|price|mrp|amount)?\s*per\s+(\d+(?:\.\d+)?)\s*(meter|kg|piece|pair|box|set)\b/)
  const packedLength = context.match(/\b(\d+(?:\.\d+)?)\s*(meter)\s*\.?\s*(coil|roll|bundle)\b/)
  const packedUnit = context.match(/\b(\d+(?:\.\d+)?)\s*(coil|roll|bundle|box|piece|pair|set)\b/)

  let quantity = 1
  let basisUnit = normalizeUnit(input.unit) ?? null
  let packUnit: string | null = null

  if (explicitPer?.[1] && explicitPer[2]) {
    quantity = Number(explicitPer[1])
    basisUnit = normalizeUnit(explicitPer[2])
  } else if (packedLength?.[1] && packedLength[2]) {
    quantity = Number(packedLength[1])
    basisUnit = normalizeUnit(packedLength[2])
    packUnit = normalizeUnit(packedLength[3]) ?? packedLength[3] ?? null
  } else if (packedUnit?.[1] && packedUnit[2]) {
    quantity = Number(packedUnit[1])
    basisUnit = normalizeUnit(packedUnit[2])
  } else if (!basisUnit && context.includes('meter')) {
    basisUnit = 'meter'
  }

  if (!Number.isFinite(quantity) || quantity <= 0) quantity = 1
  const effectiveUnit = basisUnit && !PACK_UNITS.has(basisUnit) ? basisUnit : basisUnit
  const effectiveUnitPrice = effectiveUnit && quantity > 0 ? roundMoney(price / quantity) : price
  const label = sourceBasisLabel(quantity, basisUnit, packUnit)

  return {
    source_price: price,
    source_basis_quantity: quantity,
    source_basis_unit: basisUnit,
    source_basis_pack_unit: packUnit,
    source_basis_label: label,
    effective_unit_price: effectiveUnitPrice,
    effective_unit: effectiveUnit
  }
}

export function quotationRateForBasis(
  basis: PriceBasisSummary,
  requested?: RequestedQuantityLike | null
): QuotationRate {
  const requestedQty = Number(requested?.value ?? 1)
  const qty = Number.isFinite(requestedQty) && requestedQty > 0 ? requestedQty : 1
  const requestedUnit = normalizeRequestedUnit(requested?.unit)

  if (requestedUnit && PACK_UNITS.has(requestedUnit) && basis.source_basis_pack_unit) {
    return {
      qty,
      unit: requestedUnit === 'bundle' ? 'bundle' : basis.source_basis_pack_unit,
      unit_price: basis.source_price
    }
  }

  if (requestedUnit && basis.effective_unit && requestedUnit === normalizeUnit(basis.effective_unit)) {
    return {
      qty,
      unit: requestedUnit,
      unit_price: basis.effective_unit_price
    }
  }

  return {
    qty,
    unit: basis.source_basis_label ?? basis.source_basis_unit ?? requestedUnit,
    unit_price: basis.source_price
  }
}

function normalizeRequestedUnit(unit: string | null | undefined) {
  if (!unit) return null
  const normalized = normalizeUnit(unit)
  if (normalized === 'bundle') return 'bundle'
  return normalized
}

function sourceBasisLabel(quantity: number, unit: string | null, packUnit: string | null) {
  if (!unit) return null
  const formattedQty = Number.isInteger(quantity) ? String(quantity) : String(quantity)
  const main = quantity === 1 ? unit : `${formattedQty} ${unit}`
  return packUnit ? `${main} ${packUnit}` : main
}

function roundMoney(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 100) / 100
}
