export interface CataloguePresentationInput {
  id?: string
  document_id?: string
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
  source_table_index?: number | null
  source_row_index?: number
  source_col_index?: number
  vendor?: { name: string } | null
}

export interface CataloguePresentation {
  title: string
  categoryLabel: string
  sku: string | null
  attributes: string[]
  priceTypeLabel: string
}

export interface CatalogueProductGroup<T extends CataloguePresentationInput> {
  key: string
  primary: T
  offers: T[]
}

function compact(value: unknown) {
  return String(value ?? '').replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\s+/g, ' ').trim()
}

function titleCase(value: string) {
  return value.toLowerCase().replace(/\b\p{L}/gu, letter => letter.toUpperCase())
}

const CATEGORY_LABELS: Record<string, string> = {
  coaxial_cable: 'Coaxial cables',
  data_cable: 'Data cables',
  telephone_cable: 'Telephone cables',
  power_cable: 'Power cables',
  flexible_cable: 'Flexible cables',
  single_core_wire: 'Single-core wires',
  mcb: 'Miniature circuit breakers (MCB)',
  mccb: 'Moulded-case circuit breakers (MCCB)',
  rccb: 'Residual-current breakers (RCCB)',
  rcbo: 'Residual-current breakers with overcurrent (RCBO)',
  isolator: 'Isolators',
  distribution_board: 'Distribution boards',
  junction_box: 'Junction boxes',
  modular_box: 'Modular boxes',
  switch: 'Switches',
  socket: 'Sockets',
  conduit: 'Conduits and fittings',
  accessory: 'Electrical accessories',
  other: 'Other products'
}

const CATEGORY_ITEM_LABELS: Record<string, string> = {
  coaxial_cable: 'Coaxial cable',
  data_cable: 'Data cable',
  telephone_cable: 'Telephone cable',
  power_cable: 'Power cable',
  flexible_cable: 'Flexible cable',
  single_core_wire: 'Single-core wire',
  mcb: 'MCB',
  mccb: 'MCCB',
  rccb: 'RCCB',
  rcbo: 'RCBO',
  isolator: 'Isolator',
  distribution_board: 'Distribution board',
  junction_box: 'Junction box',
  modular_box: 'Modular box',
  switch: 'Switch',
  socket: 'Socket',
  conduit: 'Conduit or fitting',
  accessory: 'Electrical accessory',
  other: 'Other product'
}

const QUARANTINE_REASON_LABELS: Record<string, string> = {
  unknown_category: 'Product category not recognized',
  missing_canonical_name: 'Product name missing',
  missing_product_identity: 'Product identity or SKU missing',
  invalid_amount: 'Price is invalid',
  raw_price_is_not_a_plain_monetary_value: 'Price cell contains non-price text',
  invalid_basis_quantity: 'Pack quantity is invalid',
  missing_price_basis: 'Price unit or pack size missing',
  invalid_basis_unit: 'Price unit not recognized',
  invalid_source_coordinate: 'Source location missing',
  missing_source_excerpt: 'Source evidence missing',
  specification_column_published: 'Specification was mistaken for a price'
}

export function catalogueCategoryFilterLabel(value: string) {
  return CATEGORY_LABELS[value] || titleCase(value.replaceAll('_', ' '))
}

export function quarantineReasonLabel(value: string) {
  if (QUARANTINE_REASON_LABELS[value]) return QUARANTINE_REASON_LABELS[value]
  const missingFacet = value.match(/^missing_required_facet:(.+)$/)
  if (missingFacet?.[1]) return `Required specification missing: ${missingFacet[1].replaceAll('_', ' ')}`
  return titleCase(value.replaceAll('_', ' '))
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

function escaped(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function priceType(row: CataloguePresentationInput) {
  const facet = textFacet(row.facets, 'price_type')?.toLowerCase()
  if (facet) return facet
  const source = compact(row.source_column_label).toLowerCase()
  if (/maximum retail price|\bmrp\b/.test(source)) return 'mrp'
  if (/unit sale price|price per (?:number|piece|unit)/.test(source)) return 'unit_sale_price'
  if (/\bnet price\b|\bnet rate\b/.test(source)) return 'net_price'
  if (/\blist price\b/.test(source)) return 'list_price'
  return 'price'
}

function priceTypeLabel(row: CataloguePresentationInput) {
  const type = priceType(row)
  if (type === 'unit_sale_price') return 'Unit price'
  if (type === 'mrp') return row.basis_quantity && row.basis_quantity > 1 ? 'Pack MRP' : 'MRP'
  if (type === 'net_price') return 'Net price'
  if (type === 'list_price') return 'List price'
  if (type === 'line_total') return 'Line total'
  return 'Quoted price'
}

function alignedSourceCells(row: CataloguePresentationInput) {
  const lines = compact(row.source_excerpt).split(/(?=row\s+\d+\s*:)/i)
  const rowLine = lines.find(line => row.source_row_index === undefined
    || new RegExp(`^row\\s+${row.source_row_index}\\s*:`, 'i').test(line))
  if (!rowLine) return []
  return [...rowLine.matchAll(/\[(\d+)]\s*([^|]*)/g)]
    .map(match => ({ index: Number(match[1]), value: compact(match[2]) }))
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

function switchDescription(row: CataloguePresentationInput) {
  const alignedDescription = alignedSourceCells(row)
    .map(cell => cell.value)
    .find(value => /\b(?:switch|bell\s+push)\b/i.test(value)
      && /\p{L}/u.test(value)
      && !/\b(?:unit sale price|maximum retail price|standard pack)\b/i.test(value))

  let value = compact(alignedDescription || row.source_row_label || row.canonical_name.split(/\s+—\s+/)[0])
  value = value
    .replace(/^(?:dura\s+)?switches?\s*(?:\(?isi\)?)?\s*/i, '')
    .replace(/^isi\s+/i, '')
  const sku = compact(row.sku)
  if (sku) value = value.replace(new RegExp(`^${escaped(sku)}\\s*[-:|]?\\s*`, 'i'), '')
  value = value
    .replace(/\b85361010\b/g, '')
    .replace(/\b(\d+AX)(\d+\s*way)\b/gi, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()

  return value
    .replace(/\b(\d+)\s*A\s+Bell Push\b/i, '$1 A bell push')
    .replace(/\b(\d+)\s*Way Switch\b/i, '$1-way switch')
    .replace(/\bWith Neon\b/i, 'with neon')
    .replace(/\b(\d+)\s*W\s+SBL Load\b/i, '$1 W SBL load')
}

function switchPresentation(row: CataloguePresentationInput): CataloguePresentation | null {
  const description = switchDescription(row)
  const isSwitch = row.category === 'switch'
    || /\b(?:switch|bell\s+push)\b/i.test(description)
  if (!isSwitch || !description) return null

  return {
    title: description,
    categoryLabel: 'Switch',
    sku: isUsefulSku(row.sku) ? compact(row.sku) : null,
    attributes: [],
    priceTypeLabel: priceTypeLabel(row)
  }
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
    ]),
    priceTypeLabel: priceTypeLabel(row)
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
  const switchItem = switchPresentation(row)
  if (switchItem) return switchItem

  return {
    title: compact(row.canonical_name) || 'Unnamed catalogue item',
    categoryLabel: CATEGORY_ITEM_LABELS[row.category] || titleCase(row.category.replaceAll('_', ' ')),
    sku: isUsefulSku(row.sku) ? compact(row.sku) : null,
    attributes: [],
    priceTypeLabel: priceTypeLabel(row)
  }
}

export function groupCatalogueRows<T extends CataloguePresentationInput>(rows: T[]): CatalogueProductGroup<T>[] {
  const groups = new Map<string, CatalogueProductGroup<T>>()
  for (const row of rows) {
    const hasSourceIdentity = Boolean(row.document_id)
      && row.source_table_index !== undefined
      && row.source_table_index !== null
      && row.source_row_index !== undefined
    const key = hasSourceIdentity
      ? [
          row.document_id,
          row.source_table_index,
          row.source_row_index,
          compact(row.sku),
          cataloguePresentation(row).title.toLowerCase()
        ].join(':')
      : row.id || `${compact(row.sku)}:${cataloguePresentation(row).title}`
    const existing = groups.get(key)
    if (existing) existing.offers.push(row)
    else groups.set(key, { key, primary: row, offers: [row] })
  }

  for (const group of groups.values()) {
    group.offers.sort((left, right) => {
      const rank = (row: T) => priceType(row) === 'unit_sale_price' ? 0 : priceType(row) === 'mrp' ? 2 : 1
      return rank(left) - rank(right) || (left.source_col_index ?? 0) - (right.source_col_index ?? 0)
    })
    group.primary = group.offers[0]!
  }
  return [...groups.values()]
}
