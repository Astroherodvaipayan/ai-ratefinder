export interface CataloguePresentationInput {
  category: string
  canonical_name: string
  brand: string | null
  sku: string | null
  facets: Record<string, unknown>
  basis_quantity: number | null
  basis_unit: string | null
  source_table_title: string | null
  source_row_label: string | null
  source_column_label: string | null
  source_excerpt?: string
  source_row_index?: number
  vendor?: { name: string } | null
}

export interface CataloguePresentation {
  title: string
  categoryLabel: string
  sku: string | null
  attributes: string[]
}

function compact(value: unknown) {
  return String(value ?? '').replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\s+/g, ' ').trim()
}

function titleCase(value: string) {
  return value.toLowerCase().replace(/\b\p{L}/gu, letter => letter.toUpperCase())
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 }).format(value)
}

function numericFacet(facets: Record<string, unknown>, name: string) {
  const value = Number(facets[name])
  return Number.isFinite(value) && value > 0 ? value : null
}

function textFacet(facets: Record<string, unknown>, name: string) {
  const value = compact(facets[name])
  return value || null
}

function unique(values: Array<string | null | undefined>) {
  const seen = new Set<string>()
  return values.filter((value): value is string => {
    const clean = compact(value)
    const key = clean.toLowerCase()
    if (!clean || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function isUsefulSku(value: string | null) {
  const sku = compact(value)
  if (!sku) return false
  if (/^(?:mm|sq\.?\s*mm|sqmm|amp|amps|coil|meter|mtr)\s*\d/i.test(sku)) return false
  if (/^\d{1,3}\s*\/\s*\d+(?:\.\d+)?$/.test(sku)) return false
  return true
}

function alignedWireCurrent(row: CataloguePresentationInput, construction: RegExpMatchArray | null) {
  if (!construction || !/\bcurrent\b.*\bamps?\b/i.test(row.source_table_title ?? '')) return null
  const rowLine = compact(row.source_excerpt)
    .split(/(?=row\s+\d+\s*:)/i)
    .find(line => row.source_row_index === undefined || new RegExp(`^row\\s+${row.source_row_index}\\s*:`, 'i').test(line))
  if (!rowLine) return null

  const cells = [...rowLine.matchAll(/\[(\d+)]\s*([^|]*)/g)]
    .map(match => ({ index: Number(match[1]), value: compact(match[2]) }))
  const constructionCell = cells.find(cell => cell.value.replace(/\s+/g, '') === `${construction[1]}/${construction[2]}`)
  if (!constructionCell) return null
  const current = Number(cells.find(cell => cell.index === constructionCell.index + 1)?.value)
  return Number.isFinite(current) && current > 0 ? current : null
}

function wirePresentation(row: CataloguePresentationInput, evidence: string): CataloguePresentation | null {
  const isWire = /\b(?:single[ -]?core|multistrand|multi[ -]?strand|homecab|conflame|banfire|frlsh|frls|hffr|zhfr)\b/i.test(evidence)
    && /\b(?:wire|cable|conductor)\b/i.test(evidence)
  if (!isWire) return null

  const brand = compact(row.brand || row.vendor?.name)
  const seriesMatch = row.source_column_label?.match(/\b(homecab|conflame|banfire)\b/i)
    ?? evidence.match(/\b(homecab|conflame|banfire)\b/i)
  const series = seriesMatch?.[1] ? titleCase(seriesMatch[1]) : ''
  const fireRating = textFacet(row.facets, 'fire_rating')?.toUpperCase()
    || row.source_column_label?.match(/\b(FRLSH|FRLS|HFFR|ZHFR|HRFR|FR)\b/i)?.[1]?.toUpperCase()
    || ''
  const sizeFacet = numericFacet(row.facets, 'size_sqmm')
  const sizeFromRow = Number(row.source_row_label?.match(/(?:^|\s)(\d+(?:\.\d+)?)\s*(?:sq\.?\s*mm|sqmm)\b/i)?.[1] ?? NaN)
  const size = sizeFacet ?? (Number.isFinite(sizeFromRow) && sizeFromRow > 0 ? sizeFromRow : null)
  const construction = evidence.match(/\b(\d{1,3})\s*\/\s*(\d+(?:\.\d+)?)\b/)
  const current = numericFacet(row.facets, 'current_a') ?? alignedWireCurrent(row, construction)
  const material = /\bcopper\b/i.test(row.source_table_title ?? '')
    ? 'Copper conductor'
    : /\baluminium\b/i.test(row.source_table_title ?? '')
      ? 'Aluminium conductor'
      : null
  const industrial = /\bindustrial\b/i.test(row.source_table_title ?? '') ? 'Industrial ' : ''
  const ratingAlreadyInSeries = series && fireRating && series.toLowerCase().includes(fireRating.toLowerCase())
  const identity = unique([brand, series, ratingAlreadyInSeries ? null : fireRating, `${industrial}single-core wire`]).join(' ')
  const sizeLabel = size ? `${formatNumber(size)} sq mm` : null

  return {
    title: [identity || 'Single-core wire', sizeLabel].filter(Boolean).join(' · '),
    categoryLabel: 'Single-core wire',
    sku: isUsefulSku(row.sku) ? compact(row.sku) : null,
    attributes: unique([
      construction ? `${construction[1]} strands × ${construction[2]} mm` : null,
      current ? `${formatNumber(current)} A` : null,
      material
    ])
  }
}

export function cataloguePresentation(row: CataloguePresentationInput): CataloguePresentation {
  const evidence = compact([
    row.source_table_title,
    row.source_row_label,
    row.source_column_label,
    row.canonical_name
  ].filter(Boolean).join(' '))
  const wire = wirePresentation(row, evidence)
  if (wire) return wire

  return {
    title: compact(row.canonical_name) || 'Unnamed catalogue item',
    categoryLabel: titleCase(row.category.replaceAll('_', ' ')),
    sku: isUsefulSku(row.sku) ? compact(row.sku) : null,
    attributes: []
  }
}
