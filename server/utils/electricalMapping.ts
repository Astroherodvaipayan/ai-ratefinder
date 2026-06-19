export type ElectricalCategory = 'cable' | 'wire'
export type ElectricalConductor = 'copper' | 'aluminium'
export type ElectricalCableType = 'armoured' | 'unarmoured'
export type ElectricalInsulation = 'fr' | 'frls' | 'frlsh'

export interface ElectricalIntent {
  original_query: string
  normalized_query: string
  category: ElectricalCategory | null
  size_sqmm: number | null
  cores: number | null
  conductor: ElectricalConductor | null
  cable_type: ElectricalCableType | null
  insulation_type: ElectricalInsulation | null
  coil_length: number | null
  aliases: string[]
}

export interface ElectricalRecord {
  section_title: string | null
  product_family: string | null
  category: ElectricalCategory | null
  size_sqmm: number | null
  size_label: string | null
  cores: number | null
  conductor: ElectricalConductor | null
  cable_type: ElectricalCableType | null
  insulation_type: ElectricalInsulation | null
  coil_length: number | null
  column_label: string | null
  unit: string | null
}

export interface ElectricalMatch {
  score: number
  confidence: number
  record: ElectricalRecord
  matched_table: string | null
  matched_row: string | null
  matched_column: string | null
  unit: string | null
  explanation: string
}

interface ElectricalRowLike {
  raw_name: string
  sku?: string | null
  unit?: string | null
  vendor?: string | null
  filename?: string | null
}

export function normalizeElectricalText(text: string) {
  const decimalMarker = 'p'
  return text
    .toLowerCase()
    .replace(/[×*]/g, ' x ')
    .replace(/\bfr\s*[-_/]?\s*ls\s*h\b/g, ' frlsh ')
    .replace(/\bfr\s*[-_/]?\s*ls\b/g, ' frls ')
    .replace(/\bcu\b/g, ' copper ')
    .replace(/\bal\b/g, ' aluminium ')
    .replace(/\baluminum\b/g, ' aluminium ')
    .replace(/\bun\s*[-_/]?\s*arm(?:ou?red|ored|d)?\.?\b/g, ' unarmoured ')
    .replace(/\barm(?:ou?red|ored|d)?\.?\b/g, ' armoured ')
    .replace(/(\d+(?:\.\d+)?)\s*sq\.?\s*mm\s*x\s*(\d+)\s*(?:cores?|core|c)\b/g, '$1 sqmm $2 core')
    .replace(/(\d+(?:\.\d+)?)\s*sq\.?\s*mm\b/g, '$1 sqmm')
    .replace(/(\d+)\s*(?:cores?|core|c)\b/g, '$1 core')
    .replace(/(\d+(?:\.\d+)?)\s*(?:mtrs?\.?|met(?:er|re)s?|mtr)\b/g, '$1 mtr')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([0-9a-z])\s*x\s*([0-9])/g, '$1 $2')
    .replace(/(\d)\.(\d)/g, `$1${decimalMarker}$2`)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(new RegExp(`(\\d)${decimalMarker}(\\d)`, 'g'), '$1.$2')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseElectricalIntent(query: string): ElectricalIntent {
  const normalized = normalizeElectricalText(query)
  const aliases: string[] = []
  const compactOriginal = query.toLowerCase().replace(/[×*]/g, ' x ')

  const compactCableMatch = compactOriginal.match(
    /\b(\d+(?:\.\d+)?)\s*(?:sq\.?\s*mm|sqmm)\s*x\s*(\d+)\s*(?:cores?|core|c)\b/i
  )
  const compactCoreFirstMatch = compactOriginal.match(/\b(\d+(?:\.\d+)?)\s*c\s*x\s*(\d+)\b/i)
  const size = toNumber(
    compactCableMatch?.[1]
      ?? normalized.match(/\b(\d+(?:\.\d+)?)\s+sqmm\b/)?.[1]
      ?? null
  )
  const cores = toInteger(
    compactCableMatch?.[2]
      ?? compactCoreFirstMatch?.[2]
      ?? normalized.match(/\b(\d+)\s+core\b/)?.[1]
      ?? null
  )
  const sizeFromCoreFirst = !size && compactCoreFirstMatch?.[1]
    ? toNumber(compactCoreFirstMatch[1])
    : null

  const conductor = /\bcopper\b/.test(normalized)
    ? 'copper'
    : /\baluminium\b/.test(normalized)
      ? 'aluminium'
      : null
  if (/\bcu\b/i.test(query) && conductor === 'copper') aliases.push('Cu mapped to Copper Conductor')

  const cableType = /\bunarmoured\b/.test(normalized)
    ? 'unarmoured'
    : /\barmoured\b/.test(normalized)
      ? 'armoured'
      : null

  const insulationType = /\bfrlsh\b/.test(normalized)
    ? 'frlsh'
    : /\bfrls\b/.test(normalized)
      ? 'frls'
      : /\bfr\b/.test(normalized)
        ? 'fr'
        : null
  if (insulationType === 'frls') aliases.push('FRLS can map to FRLSH when an exact FRLS column is unavailable')

  const coilLength = toNumber(normalized.match(/\b(\d+(?:\.\d+)?)\s+mtr\b/)?.[1] ?? null)
  const hasCableTerm = /\b(cables?|core|xlpe|armoured|unarmoured|conductor)\b/.test(normalized)
  const hasWireTerm = /\b(wires?|fr|frls|frlsh|coil|mtr)\b/.test(normalized)
  const category = hasWireTerm && !cores && !hasCableTerm
    ? 'wire'
    : hasCableTerm || cores
      ? 'cable'
      : hasWireTerm
        ? 'wire'
        : null

  return {
    original_query: query,
    normalized_query: normalized,
    category,
    size_sqmm: size ?? sizeFromCoreFirst,
    cores,
    conductor,
    cable_type: cableType,
    insulation_type: insulationType,
    coil_length: coilLength,
    aliases
  }
}

export function hasStructuredElectricalIntent(intent: ElectricalIntent) {
  return Boolean(
    intent.size_sqmm
    && (
      intent.cores
      || intent.coil_length
      || intent.insulation_type
      || intent.conductor
      || intent.cable_type
    )
  )
}

export function electricalRecordFromRow(row: ElectricalRowLike): ElectricalRecord {
  const rawName = row.raw_name ?? ''
  const unit = row.unit ?? ''
  const sku = row.sku ?? ''
  const normalized = normalizeElectricalText([rawName, sku, unit].filter(Boolean).join(' '))
  const normalizedName = normalizeElectricalText(rawName)
  const normalizedSku = normalizeElectricalText(sku)

  const sizeFromSku = extractSizeSqmm(normalizedSku, true)
  const sizeFromName = extractSizeSqmm(normalizedName, true)
  const size = sizeFromSku.value ?? sizeFromName.value
  const sizeLabel = sizeFromSku.label ?? sizeFromName.label
  const cores = toInteger(normalized.match(/\b(\d+)\s+core\b/)?.[1] ?? null)
  const coilLength = toNumber(normalized.match(/\b(\d+(?:\.\d+)?)\s+mtr\b/)?.[1] ?? null)

  const conductor = /\bcopper\b/.test(normalized)
    ? 'copper'
    : /\baluminium\b/.test(normalized)
      ? 'aluminium'
      : null
  const cableType = /\bunarmoured\b/.test(normalized)
    ? 'unarmoured'
    : /\barmoured\b/.test(normalized)
      ? 'armoured'
      : null
  const insulationType = /\bfrlsh\b/.test(normalized)
    ? 'frlsh'
    : /\bfrls\b/.test(normalized)
      ? 'frls'
      : /\bfr\b/.test(normalized)
        ? 'fr'
        : null

  const hasWireContext = /\b(wires?|fr|frls|frlsh|coil|mtr)\b/.test(normalized)
  const hasCableContext = /\b(cables?|core|xlpe|armoured|unarmoured|conductor)\b/.test(normalized)
  const category = (Boolean(coilLength || insulationType) && !cores)
    ? 'wire'
    : hasWireContext && !cores && !hasCableContext
      ? 'wire'
      : hasCableContext || cores
      ? 'cable'
      : hasWireContext
        ? 'wire'
        : null
  const columnLabel = inferColumnLabel({
    cores,
    insulationType,
    coilLength,
    unit,
    normalized
  })
  const sectionTitle = inferSectionTitle(rawName, {
    size,
    insulationType,
    coilLength,
    cores
  })

  return {
    section_title: sectionTitle,
    product_family: sectionTitle,
    category,
    size_sqmm: size,
    size_label: sizeLabel,
    cores,
    conductor,
    cable_type: cableType,
    insulation_type: insulationType,
    coil_length: coilLength,
    column_label: columnLabel,
    unit: inferUnit({ category, cores, coilLength, unit, normalized })
  }
}

export function electricalMatchForRow(
  row: ElectricalRowLike,
  query: string
): ElectricalMatch | null {
  const intent = parseElectricalIntent(query)
  if (!hasStructuredElectricalIntent(intent)) return null

  const record = electricalRecordFromRow(row)
  let score = 0
  let possible = 0
  let hardMismatch = false
  const explanations = [...intent.aliases]

  if (intent.size_sqmm !== null) {
    possible += 28
    if (record.size_sqmm !== null && sameNumber(record.size_sqmm, intent.size_sqmm)) score += 28
    else if (record.size_sqmm !== null) hardMismatch = true
  }

  if (intent.cores !== null) {
    possible += 22
    if (record.cores === intent.cores) score += 22
    else if (record.cores !== null) hardMismatch = true
  }

  if (intent.coil_length !== null) {
    possible += 20
    if (record.coil_length !== null && sameNumber(record.coil_length, intent.coil_length)) score += 20
    else if (record.coil_length !== null) hardMismatch = true
  }

  if (intent.insulation_type) {
    possible += 18
    if (record.insulation_type === intent.insulation_type) {
      score += 18
    } else if (intent.insulation_type === 'frls' && record.insulation_type === 'frlsh') {
      score += 16
      explanations.push('FRLS mapped to FRLSH')
    } else if (record.insulation_type) {
      if (intent.insulation_type === 'fr' && record.insulation_type !== 'fr') score -= 10
      else hardMismatch = true
    }
  }

  if (intent.conductor) {
    possible += 12
    if (record.conductor === intent.conductor) score += 12
    else if (record.conductor) hardMismatch = true
  }

  if (intent.cable_type) {
    possible += 12
    if (record.cable_type === intent.cable_type) score += 12
    else if (record.cable_type) hardMismatch = true
  }

  if (intent.category) {
    possible += 8
    if (record.category === intent.category) score += 8
    else if (record.category) score -= 6
  }

  score += familyAliasScore(intent, record, explanations)

  if (hardMismatch && score < Math.max(32, possible * 0.45)) return null
  if (score <= 0) return null

  const confidence = Math.max(0.2, Math.min(0.99, score / Math.max(65, possible)))
  const matchedColumn = inferMatchedColumn(record)
  const matchedRow = record.size_label
    ? `${record.size_label} sq.mm`
    : record.size_sqmm !== null
      ? `${formatNumber(record.size_sqmm)} sq.mm`
      : null
  const explanation = uniqueExplanations(explanations)
    .filter(explanation => explanation.trim())
    .join('; ')
    || 'Matched by structured size, table title, and column attributes'

  return {
    score,
    confidence,
    record,
    matched_table: record.section_title,
    matched_row: matchedRow,
    matched_column: matchedColumn,
    unit: record.unit,
    explanation
  }
}

function familyAliasScore(
  intent: ElectricalIntent,
  record: ElectricalRecord,
  explanations: string[]
) {
  const section = normalizeElectricalText(record.section_title ?? '')
  let score = 0

  if (
    intent.category === 'cable'
    && intent.conductor === 'copper'
    && intent.cable_type === 'armoured'
    && /\bxlpe\b/.test(section)
    && /\barmoured\b/.test(section)
    && /\bcopper\b/.test(section)
  ) {
    score += 10
    explanations.push('Armoured Cable + Cu mapped to XLPE Armoured Cables with Copper Conductor')
  }

  if (
    intent.category === 'wire'
    && /\b(polycab|industrial|multistrand|multistranded)\b/.test(section)
  ) {
    score += 6
  }

  return score
}

function extractSizeSqmm(normalized: string, allowBare: boolean) {
  const explicit = normalized.match(/\b(\d+(?:\.\d+)?)\s+sqmm\b/)
  if (explicit?.[1]) return { value: toNumber(explicit[1]), label: explicit[1] }

  if (!allowBare) return { value: null, label: null }

  const beforeColumn = normalized.match(
    /\b(\d+(?:\.\d+)?)\b(?=\s+(?:fr|frls|frlsh|\d+\s+core|single\s+core|multi\s+core))/i
  )
  if (beforeColumn?.[1]) return { value: toNumber(beforeColumn[1]), label: beforeColumn[1] }

  const bare = normalized.match(/^\s*(\d+(?:\.\d+)?)\s*$/)
  if (bare?.[1]) return { value: toNumber(bare[1]), label: bare[1] }

  return { value: null, label: null }
}

function inferColumnLabel(params: {
  cores: number | null
  insulationType: ElectricalInsulation | null
  coilLength: number | null
  unit: string
  normalized: string
}) {
  const unit = params.unit.trim()
  if (unit && !/^per\s+(mtr|meter|metre|coil)$/i.test(unit)) return unit
  if (params.insulationType && params.coilLength !== null) {
    return `${formatInsulation(params.insulationType)} ${formatNumber(params.coilLength)} Mtrs Coil`
  }
  if (params.cores !== null) return `${params.cores} Core`

  const coreLabel = params.normalized.match(/\b(single\s+core|\d+\s+core)\b/)?.[1]
  return coreLabel ? titleCase(coreLabel) : null
}

function inferMatchedColumn(record: ElectricalRecord) {
  if (record.column_label) return record.column_label
  if (record.insulation_type && record.coil_length !== null) {
    return `${formatInsulation(record.insulation_type)} ${formatNumber(record.coil_length)} Mtrs Coil`
  }
  if (record.cores !== null) return `${record.cores} Core`
  return null
}

function inferUnit(params: {
  category: ElectricalCategory | null
  cores: number | null
  coilLength: number | null
  unit: string
  normalized: string
}) {
  if (/\bcoil\b/.test(params.normalized) || params.coilLength !== null) return 'per coil'
  if (params.category === 'cable' && params.cores !== null) return 'per meter'
  if (/\bper\s+(?:mtr|meter|metre)\b/i.test(params.unit)) return 'per meter'
  if (/\bper\s+coil\b/i.test(params.unit)) return 'per coil'
  return params.unit || null
}

function inferSectionTitle(
  rawName: string,
  spec: {
    size: number | null
    insulationType: ElectricalInsulation | null
    coilLength: number | null
    cores: number | null
  }
) {
  const compact = rawName.replace(/\s+/g, ' ').trim()
  if (!compact) return null

  const explicitSize = compact.match(/\b\d+(?:\.\d+)?\s*(?:sq\.?\s*mm|sqmm)\b/i)
  if (explicitSize?.index && explicitSize.index > 0) return compact.slice(0, explicitSize.index).trim()

  if (spec.size !== null) {
    const sizePattern = numberPattern(spec.size)
    const beforeVariant = compact.match(new RegExp(`\\b${sizePattern}\\b\\s+(?:FRLSH|FRLS|FR|\\d+\\s*Core|Single\\s*Core)`, 'i'))
    if (beforeVariant?.index && beforeVariant.index > 0) return compact.slice(0, beforeVariant.index).trim()
  }

  if (spec.cores !== null) {
    const column = compact.match(new RegExp(`\\b${spec.cores}\\s*Core\\b`, 'i'))
    if (column?.index && column.index > 0) return compact.slice(0, column.index).trim()
  }

  if (spec.insulationType || spec.coilLength !== null) {
    const column = compact.match(/\b(?:FRLSH|FRLS|FR)\b/i)
    if (column?.index && column.index > 0) return compact.slice(0, column.index).trim()
  }

  return compact
}

function toNumber(value: string | null | undefined) {
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function toInteger(value: string | null | undefined) {
  const parsed = toNumber(value)
  return parsed !== null && Number.isInteger(parsed) ? parsed : null
}

function sameNumber(left: number, right: number) {
  return Math.abs(left - right) < 0.001
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : String(value)
}

function formatInsulation(value: ElectricalInsulation) {
  return value === 'fr' ? 'FR' : value.toUpperCase()
}

function titleCase(value: string) {
  return value.replace(/\b\w/g, char => char.toUpperCase())
}

function numberPattern(value: number) {
  if (Number.isInteger(value)) return `${value}(?:\\.0+)?`
  const [whole, fraction] = String(value).split('.')
  return `${whole}\\.${fraction}(?:0*)?`
}

function uniqueExplanations(values: string[]) {
  const seen = new Set<string>()
  return values.filter(value => {
    const key = value.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
