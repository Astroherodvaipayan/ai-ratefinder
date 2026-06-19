import { normalizeSearchText, tokenize, uniqueText } from './text'
import {
  FULL_KITTING_KNOWN_UNITS,
  fullKittingVendorTermsForQuery,
  normalizeFullKittingUnitToken
} from './fullKittingKnowledge'

export interface ParsedQuantity {
  value: number
  unit: string | null
  raw: string
}

export interface ParsedAttributeHint {
  name: string
  value: string
  unit?: string
  raw: string
}

export interface ParsedUserItemQuery {
  raw_query: string
  normalized_query: string
  normalized_match_query: string
  quantities: ParsedQuantity[]
  requested_quantities: ParsedQuantity[]
  numeric_values: number[]
  units: string[]
  product_terms: string[]
  brand_terms: string[]
  vendor_terms: string[]
  attribute_hints: ParsedAttributeHint[]
  requested_unit: string | null
  intent: 'price_lookup' | 'quote' | 'unknown'
}

const QUERY_SPLIT_RE = /\n+|;|(?:\s{2,})/g
const DIMENSION_UNIT_RE_PART = 'sq\\.?\\s*mm|sqmm|mm|mtrs?\\.?|met(?:er|re)s?|m|cores?|core|c'
const SALES_UNIT_RE_PART = 'bdls?|bundles?|bags?|boxes|box|cases?|coils?|rolls?|pairs?|pieces?|pcs?|nos?|numbers?|kg|kilograms?|ltrs?|lit(?:er|re)s?|pkts?|packets?|sets?|sq\\.?\\s*ft|sqft|sq\\.?\\s*m|sqm|tins?|tons?|unts?|units?|dozens?'
const QUERY_UNIT_RE_PART = `${DIMENSION_UNIT_RE_PART}|${SALES_UNIT_RE_PART}`
const QUERY_UNIT_RE = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${QUERY_UNIT_RE_PART})\\b`, 'gi')
const SALES_QUANTITY_RE = new RegExp(`\\b(\\d+(?:\\.\\d+)?)\\s*(${SALES_UNIT_RE_PART})\\b`, 'gi')
const KNOWN_UNITS = new Set([
  'sqmm', 'mm', 'meter', 'm', 'mtr', 'mtrs', 'core', 'c', 'pair', 'piece', 'pc', 'pcs',
  'no', 'nos', ...FULL_KITTING_KNOWN_UNITS
])
const PRODUCT_STOP = new Set([
  'add', 'and', 'as', 'for', 'give', 'line', 'lines', 'need', 'per', 'please', 'price', 'prices',
  'item', 'qty', 'quantity', 'quote', 'rate', 'rates', 'show', 'to', 'what', 'wire', 'wires', 'bundle', 'bundles', 'bdl'
])
const CATALOGUE_CODE_RE = /\b(?=[A-Z0-9./-]{5,}\b)(?=[A-Z0-9./-]*[A-Z])(?=[A-Z0-9./-]*\d)[A-Z0-9][A-Z0-9]*(?:[./-][A-Z0-9]+)*\b/gi
const SPACED_CATALOGUE_CODE_RE = /\b([A-Z]{2,8})\s+(\d{2,}[A-Z0-9]*|\d+[A-Z][A-Z0-9]*)(?:\s+([A-Z]{1,3}))?\b/gi
const NON_CODE_PREFIXES = new Set([
  'APRIL', 'AUGUST', 'CABEL', 'CABLE', 'DECEMBER', 'FEBRUARY', 'FR', 'FRLS', 'FRLSH',
  'HFFR', 'IEC', 'IS', 'JANUARY', 'JULY', 'JUNE', 'MARCH', 'MAY', 'MM', 'MTR',
  'NOVEMBER', 'OCTOBER', 'PVC', 'SEPTEMBER', 'SQ', 'WIRE', 'WIRES', 'XLPE', 'ZHFR'
])

function splitCompactForms(value: string) {
  const electricalContext = /\b(?:wire|wires|cabels?|cables?|xlpe|fr|frls?h?|hffr|zhfr|sqmm|core|cores|flx|flexible|coper|copper|cu|arm|shielded|screened)\b/i.test(value)
    && !/\b(?:telephone|jelly|pair)\b/i.test(value)
  let out = value
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/\bcabels?\b/gi, 'cable')
    .replace(/\bscensior\b/gi, 'sensor')
    .replace(/\bcopers?\b/gi, 'copper')
    .replace(/\bcoppers?\b/gi, 'copper')
    .replace(/\barm\b/gi, 'armoured')
    .replace(/[×*]/g, 'x')
    .replace(/\bbdls?\b/gi, 'bundle')
    .replace(/\bbundles?\b/gi, 'bundle')
    .replace(/\b(fr|frls?h?|hffr|zhfr)\s*wires?\b/gi, '$1 wire')
    .replace(/(\d+(?:\.\d+)?)\s*(sq\.?\s*mm|sqmm)\s*x\s*sc\b/gi, '$1 sqmm 1 core')
    .replace(/(\d+(?:\.\d+)?)\s*(sq\.?\s*mm|sqmm)\s*x\s*(\d+(?:\.\d+)?)\s*(?:cores?|core|c)\b/gi, '$1 sqmm $3 core')
    .replace(/(\d+(?:\.\d+)?)\s*mm\s*x\s*(\d+(?:\.\d+)?)\s*(?:cores?|core|c)\b/gi, '$1 mm $2 core')
    .replace(/(\d+(?:\.\d+)?)\s*(sq\.?\s*mm|sqmm)\b/gi, '$1 sqmm')
    .replace(/(\d+(?:\.\d+)?)\s*(?:cores?|core|c)\b/gi, '$1 core')
    .replace(/(\d+(?:\.\d+)?)\s*m\b/gi, '$1 meter')
    .replace(/(\d+(?:\.\d+)?)\s*(?:mtrs?\.?|met(?:er|re)s?)\b/gi, '$1 meter')
  if (electricalContext) {
    out = out
      .replace(/\b(?:single\s*core|singlecore)\b/gi, '1 core')
      .replace(/\bsc\b/gi, '1 core')
      .replace(/\bmulti\s*core\b/gi, 'multi core')
      .replace(/(\d+(?:\.\d+)?)\s*mm\b/gi, '$1 sqmm')
  }
  return out
}

function normalizeUnitToken(unit: string) {
  const value = unit.toLowerCase().replace(/\./g, '')
  const fullKittingUnit = normalizeFullKittingUnitToken(value)
  if (fullKittingUnit) return fullKittingUnit
  if (value === 'mtr' || value === 'mtrs' || value === 'metre' || value === 'metres') return 'meter'
  if (value === 'm') return 'meter'
  if (value === 'c' || value === 'core' || value === 'cores') return 'core'
  if (value === 'pc' || value === 'pcs' || value === 'no' || value === 'nos') return 'piece'
  if (value === 'bdl' || value === 'bundle' || value === 'bundles') return 'bundle'
  if (value === 'sq mm') return 'sqmm'
  if (value === 'sq ft') return 'sqft'
  if (value === 'sq m') return 'sqm'
  return value
}

export function splitItemQueries(message: string): string[] {
  const direct = message
    .split(QUERY_SPLIT_RE)
    .map(part => part.trim())
    .filter(Boolean)

  if (direct.length > 1) return direct

  const commaParts = message
    .split(/(?<!\d),(?!\d)/g)
    .map(part => part.trim())
    .filter(part => part.length >= 2)

  return commaParts.length > 1 ? commaParts : [message.trim()].filter(Boolean)
}

export function parseUserItemQuery(rawQuery: string): ParsedUserItemQuery {
  const expanded = splitCompactForms(rawQuery)
  const requested_quantities = extractRequestedQuantities(expanded)
  const matchSource = removeRequestedQuantities(expanded, requested_quantities)
  const normalized = normalizeSearchText(expanded)
  const normalizedMatch = normalizeSearchText(matchSource)
  const attribute_hints: ParsedAttributeHint[] = []
  const quantities: ParsedQuantity[] = []
  const numeric_values: number[] = []
  const units = new Set<string>()

  for (const match of matchSource.matchAll(QUERY_UNIT_RE)) {
    const raw = match[0]!
    const value = Number(match[1])
    const unit = normalizeUnitToken(match[2]!)
    if (!Number.isFinite(value)) continue
    numeric_values.push(value)
    units.add(unit)
    quantities.push({ value, unit, raw })

    const name = attributeNameForUnit(unit)
    attribute_hints.push({
      name,
      value: String(value),
      unit: unit === 'core' ? undefined : unit,
      raw
    })
  }

  for (const match of matchSource.matchAll(/\b(\d+(?:\.\d+)?)\s*x\s*(\d+)\b/gi)) {
    const first = Number(match[1])
    const second = Number(match[2])
    if (Number.isFinite(first)) numeric_values.push(first)
    if (Number.isFinite(second)) numeric_values.push(second)
  }

  for (const match of matchSource.matchAll(/\b(\d+)\s*ways?\b/gi)) {
    const value = Number(match[1])
    if (!Number.isFinite(value)) continue
    numeric_values.push(value)
    attribute_hints.push({
      name: 'way',
      value: String(value),
      raw: match[0]!
    })
  }

  const tokens = tokenize(normalizedMatch)
  const catalogueCodes = extractCatalogueCodes(matchSource)
  const product_terms = uniqueText(tokens.filter(token =>
    !PRODUCT_STOP.has(token)
    && !KNOWN_UNITS.has(token)
    && !/^\d+(?:\.\d+)?$/.test(token)
    && !/^[.\d]+$/.test(token)
    && !isQueryNoiseTerm(token)
  ).concat(catalogueCodes))

  const explicitPerUnit = expanded.match(new RegExp(`\\bper\\s+(${QUERY_UNIT_RE_PART})\\b`, 'i'))?.[1]
  const requestedUnit = explicitPerUnit ? normalizeUnitToken(explicitPerUnit) : null
  const lower = rawQuery.toLowerCase()
  const vendorTerms = fullKittingVendorTermsForQuery(expanded)
  const intent = /\b(?:quote|quotation|proforma|add)\b/.test(lower)
    ? 'quote'
    : /\b(?:price|rate|mrp|cost|what|find|show)\b/.test(lower)
      ? 'price_lookup'
      : 'price_lookup'

  return {
    raw_query: rawQuery,
    normalized_query: normalized,
    normalized_match_query: normalizedMatch,
    quantities,
    requested_quantities,
    numeric_values: uniqueText(numeric_values.map(String)).map(Number),
    units: [...units],
    product_terms,
    brand_terms: vendorTerms,
    vendor_terms: vendorTerms,
    attribute_hints,
    requested_unit: requestedUnit,
    intent
  }
}

function attributeNameForUnit(unit: string) {
  if (unit === 'sqmm') return 'size'
  if (unit === 'core') return 'cores'
  if (unit === 'meter') return 'length'
  return unit
}

function extractRequestedQuantities(expanded: string): ParsedQuantity[] {
  const quantities: ParsedQuantity[] = []
  const add = (value: number, unit: string | null, raw: string) => {
    if (!Number.isFinite(value)) return
    const key = `${value}:${unit ?? ''}:${raw.toLowerCase()}`
    if (quantities.some(quantity => `${quantity.value}:${quantity.unit ?? ''}:${quantity.raw.toLowerCase()}` === key)) return
    quantities.push({ value, unit, raw })
  }

  for (const match of expanded.matchAll(SALES_QUANTITY_RE)) {
    const unit = normalizeUnitToken(match[2]!)
    if (unit === 'pair' && /\b(?:telephone|jelly|cables?)\b/i.test(expanded)) continue
    add(Number(match[1]), unit, match[0])
  }

  for (const match of expanded.matchAll(/\b(?:qty|quantity)\s*[:#-]?\s*(\d+(?:\.\d+)?)\b/gi)) {
    add(Number(match[1]), null, match[0])
  }

  const normalized = normalizeSearchText(expanded)
  const meterIsOrderQuantity = /\b(?:armoured|armored|cable|copper|aluminium)\b/.test(normalized)
    && !/\b(?:fr|frls|frlsh|hffr|zhfr)\b/.test(normalized)
  if (meterIsOrderQuantity) {
    for (const match of expanded.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:meter|mtrs?\.?|met(?:er|re)s?)\b/gi)) {
      add(Number(match[1]), 'meter', match[0])
    }
  }

  return quantities
}

function removeRequestedQuantities(expanded: string, requestedQuantities: ParsedQuantity[]) {
  let out = expanded
  for (const quantity of requestedQuantities) {
    out = out.replace(quantity.raw, ' ')
  }
  return out.replace(/\s+/g, ' ').trim()
}

function extractCatalogueCodes(value: string) {
  const compactCodes = [...value.matchAll(CATALOGUE_CODE_RE)]
    .map(match => match[0])
    .filter(code => {
      const normalized = normalizeSearchText(code)
      if (!normalized || KNOWN_UNITS.has(normalized)) return false
      if (isQueryNoiseTerm(code)) return false
      if (/^\d+(?:\.\d+)?(?:sq\.?\s*mm|sqmm|mm|mtrs?|met(?:er|re)s?|cores?|core|c|pairs?|pair)$/i.test(code)) return false
      if (/^(?:frls?h?|hffr|zhfr)\s*\d+$/i.test(code)) return false
      return true
    })

  const spacedCodes = [...value.matchAll(SPACED_CATALOGUE_CODE_RE)]
    .flatMap(match => {
      const prefix = match[1]!.toUpperCase()
      if (NON_CODE_PREFIXES.has(prefix)) return []
      const body = `${match[2] ?? ''}${match[3] ?? ''}`.toUpperCase()
      if (!/[A-Z]/.test(body) && prefix.length < 3) return []
      return `${prefix}${body}`
    })

  return uniqueText([...compactCodes, ...spacedCodes])
}

function isQueryNoiseTerm(value: string) {
  return /(?:\.pdf|^per\d+$|^sizesq\.?$|^rate(?:pc|mtr)?\.?$|^(?:dt\.?)?\d{1,2}[-./]\d{1,2}[-./]\d{4}(?:\.pdf)?$)/i.test(value)
}
