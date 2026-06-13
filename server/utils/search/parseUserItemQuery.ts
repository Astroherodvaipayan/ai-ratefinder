import { normalizeSearchText, tokenize, uniqueText } from './text'

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
  quantities: ParsedQuantity[]
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
const KNOWN_UNITS = new Set(['sqmm', 'mm', 'meter', 'm', 'mtr', 'mtrs', 'core', 'c', 'kg', 'box', 'coil', 'roll', 'pair', 'piece', 'pc', 'pcs', 'no', 'nos'])
const PRODUCT_STOP = new Set([
  'add', 'and', 'as', 'for', 'give', 'line', 'lines', 'need', 'per', 'please', 'price', 'prices',
  'qty', 'quantity', 'quote', 'rate', 'rates', 'show', 'to', 'what', 'wire', 'wires'
])

function splitCompactForms(value: string) {
  return value
    .replace(/\b(fr|frls?h?|hffr|zhfr)\s*wires?\b/gi, '$1 wire')
    .replace(/(\d+(?:\.\d+)?)\s*(sq\.?\s*mm|sqmm)\s*[x×]\s*(\d+)\s*(?:cores?|core|c)\b/gi, '$1 sqmm $3 core')
    .replace(/(\d+(?:\.\d+)?)\s*mm\s*[x×]\s*(\d+)\s*(?:cores?|core|c)\b/gi, '$1 mm $2 core')
    .replace(/(\d+(?:\.\d+)?)\s*(sq\.?\s*mm|sqmm)\b/gi, '$1 sqmm')
    .replace(/(\d+)\s*(?:cores?|core|c)\b/gi, '$1 core')
    .replace(/(\d+(?:\.\d+)?)\s*m\b/gi, '$1 meter')
    .replace(/(\d+(?:\.\d+)?)\s*(?:mtrs?\.?|met(?:er|re)s?)\b/gi, '$1 meter')
}

function normalizeUnitToken(unit: string) {
  const value = unit.toLowerCase().replace(/\./g, '')
  if (value === 'mtr' || value === 'mtrs' || value === 'metre' || value === 'metres') return 'meter'
  if (value === 'm') return 'meter'
  if (value === 'c' || value === 'core' || value === 'cores') return 'core'
  if (value === 'pc' || value === 'pcs' || value === 'no' || value === 'nos') return 'piece'
  if (value === 'sq mm') return 'sqmm'
  return value
}

export function splitItemQueries(message: string): string[] {
  const direct = message
    .split(QUERY_SPLIT_RE)
    .map(part => part.trim())
    .filter(Boolean)

  if (direct.length > 1) return direct

  const commaParts = message
    .split(/,(?!\d{3}\b)/g)
    .map(part => part.trim())
    .filter(part => part.length >= 2)

  return commaParts.length > 1 ? commaParts : [message.trim()].filter(Boolean)
}

export function parseUserItemQuery(rawQuery: string): ParsedUserItemQuery {
  const expanded = splitCompactForms(rawQuery)
  const normalized = normalizeSearchText(expanded)
  const attribute_hints: ParsedAttributeHint[] = []
  const quantities: ParsedQuantity[] = []
  const numeric_values: number[] = []
  const units = new Set<string>()

  for (const match of expanded.matchAll(/(\d+(?:\.\d+)?)\s*(sq\.?\s*mm|sqmm|mm|m|mtrs?\.?|met(?:er|re)s?|cores?|core|c|kg|box|coil|roll|pair|pcs?|nos?)\b/gi)) {
    const raw = match[0]!
    const value = Number(match[1])
    const unit = normalizeUnitToken(match[2]!)
    if (!Number.isFinite(value)) continue
    numeric_values.push(value)
    units.add(unit)
    quantities.push({ value, unit, raw })

    const name = unit === 'sqmm' ? 'size'
      : unit === 'core' ? 'cores'
        : unit === 'meter' ? 'length'
          : unit
    attribute_hints.push({
      name,
      value: String(value),
      unit: unit === 'core' ? undefined : unit,
      raw
    })
  }

  for (const match of expanded.matchAll(/\b(\d+(?:\.\d+)?)\s*[x×]\s*(\d+)\b/gi)) {
    const first = Number(match[1])
    const second = Number(match[2])
    if (Number.isFinite(first)) numeric_values.push(first)
    if (Number.isFinite(second)) numeric_values.push(second)
  }

  const tokens = tokenize(normalized)
  const product_terms = uniqueText(tokens.filter(token =>
    !PRODUCT_STOP.has(token)
    && !KNOWN_UNITS.has(token)
    && !/^\d+(?:\.\d+)?$/.test(token)
    && !/^[.\d]+$/.test(token)
  ))

  const explicitPerUnit = expanded.match(/\bper\s+(m|mtrs?\.?|met(?:er|re)s?|kg|box|coil|roll|pair|pcs?|nos?)\b/i)?.[1]
  const requestedUnit = explicitPerUnit ? normalizeUnitToken(explicitPerUnit) : null
  const lower = rawQuery.toLowerCase()
  const intent = /\b(?:quote|quotation|proforma|add)\b/.test(lower)
    ? 'quote'
    : /\b(?:price|rate|mrp|cost|what|find|show)\b/.test(lower)
      ? 'price_lookup'
      : 'price_lookup'

  return {
    raw_query: rawQuery,
    normalized_query: normalized,
    quantities,
    numeric_values: uniqueText(numeric_values.map(String)).map(Number),
    units: [...units],
    product_terms,
    brand_terms: [],
    vendor_terms: [],
    attribute_hints,
    requested_unit: requestedUnit,
    intent
  }
}
