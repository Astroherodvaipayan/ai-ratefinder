import type { CanonicalAttribute, CanonicalTable, CanonicalTableCell } from './canonicalizeTable'
import { normalizeSearchText, parsePriceNumber, uniqueText } from '../search/text'

const MAX_DB_PRICE = 999_999_999_999.99
const CODE_CONTEXT_RE = /\b(?:product\s*code|productcode|sku|model|catalogue|catalog|cat\s*no|catno|item\s*code|part\s*no|ref(?:erence)?\s*no)\b/
const GENERIC_CODE_RE = /\b(?=[A-Z0-9./-]{5,}\b)(?=[A-Z0-9./-]*[A-Z])(?=[A-Z0-9./-]*\d)[A-Z0-9][A-Z0-9]*(?:[./-][A-Z0-9]+)*\b/i

export interface CanonicalPriceItemInput {
  tenant_id: string
  document_id: string
  vendor_id: string | null
  vendor_name?: string | null
  document_title: string
  source_uploaded_at?: string | null
  legacy_doc_item_id?: string | null
  source_table_id?: string | null
  source_cell_id?: string | null
  table: CanonicalTable
  cell: CanonicalTableCell
}

export interface CanonicalPriceItemInsert {
  tenant_id: string
  document_id: string
  vendor_id: string | null
  legacy_doc_item_id: string | null
  source_page: number | null
  source_table_id: string | null
  source_cell_id: string | null
  source_row_index: number | null
  source_col_index: number | null
  section_breadcrumb: string[]
  table_title: string | null
  row_headers: string[]
  column_headers: string[]
  parent_headers: string[]
  nearby_notes: string[]
  raw_cell_value: string | null
  normalized_price: number
  currency: string
  unit: string | null
  moq: string | null
  product_text: string | null
  sku_text: string | null
  description_text: string | null
  attributes_json: CanonicalAttribute[]
  searchable_text: string
  normalized_search_text: string
  source_confidence: number
  parser_name: string
  source_uploaded_at: string | null
}

function attributeKey(attribute: CanonicalAttribute) {
  return `${attribute.name.toLowerCase()}=${attribute.value.toLowerCase()}:${attribute.unit ?? ''}`
}

function mergeAttributes(values: CanonicalAttribute[][]): CanonicalAttribute[] {
  const seen = new Set<string>()
  const out: CanonicalAttribute[] = []
  for (const attribute of values.flat()) {
    if (!attribute.name || !attribute.value) continue
    const key = attributeKey(attribute)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(attribute)
  }
  return out
}

function cellHeaderText(cell: CanonicalTableCell) {
  return normalizeSearchText([
    ...cell.column_headers,
    ...cell.parent_headers,
    ...cell.row_headers
  ].join(' '))
}

function rowCellsFor(table: CanonicalTable, cell: CanonicalTableCell) {
  return table.cells
    .filter(item => !item.is_header && item.source_row_index === cell.source_row_index)
    .sort((a, b) => a.source_col_index - b.source_col_index)
}

function cleanCodeText(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function looksLikeCatalogueCode(value: string) {
  const text = cleanCodeText(value)
  if (!text || /\s/.test(text)) return false
  if (/^(?:frls?h?|hffr|zhfr)\d+$/i.test(text)) return false
  return GENERIC_CODE_RE.test(text)
}

function productCodeFromRow(cells: CanonicalTableCell[]) {
  const codeCell = cells.find(cell =>
    /\b(?:PRCS|PRCB|PCR|PRBN|PSC|PRFB|PRFBRD)\s*[A-Z0-9/ ]*\b/i.test(cell.raw_cell_value)
  )
  if (codeCell) return cleanCodeText(codeCell.raw_cell_value)

  const genericCodeCell = cells.find(cell =>
    CODE_CONTEXT_RE.test(cellHeaderText(cell))
    && looksLikeCatalogueCode(cell.raw_cell_value)
  )
  if (genericCodeCell) return cleanCodeText(genericCodeCell.raw_cell_value)

  const standaloneCodeCell = cells.find(cell => looksLikeCatalogueCode(cell.raw_cell_value))
  return standaloneCodeCell ? cleanCodeText(standaloneCodeCell.raw_cell_value) : null
}

function sizeTextFromRow(cells: CanonicalTableCell[]) {
  const sizeCell = cells.find(cell =>
    /\b(?:size|od|outside\s+diameter|nominal\s+size)\b/.test(cellHeaderText(cell))
    && /\d/.test(cell.raw_cell_value)
  )
  return sizeCell?.raw_cell_value.replace(/\s+/g, ' ').trim() ?? null
}

function firstNumber(value: string | null | undefined) {
  return value?.match(/\d+(?:\.\d+)?/)?.[0] ?? null
}

function normalizedCode(value: string | null) {
  return (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function codeSize(code: string | null, sizeText: string | null) {
  const fromSize = firstNumber(sizeText)
  if (fromSize) return fromSize
  return normalizedCode(code).match(/(?:PRCS|PRCB|PCR|PRBN|PRFB|PRFBRD)(\d{2})/)?.[1] ?? null
}

function mmAttribute(size: string | null): CanonicalAttribute[] {
  return size ? [{ name: 'mm', value: size, unit: 'mm' }] : []
}

function wayAttribute(way: string | null | undefined): CanonicalAttribute[] {
  return way ? [{ name: 'way', value: way }] : []
}

function precisionCodeInfo(code: string | null, sizeText: string | null) {
  const compact = normalizedCode(code)
  if (!compact) return null

  const size = codeSize(code, sizeText)
  if (/^PRCS\d+M(?:NI)?$/.test(compact) && size) {
    return {
      label: `${size}mm Conduit pipe MMS`,
      unit: 'meter',
      attributes: mmAttribute(size)
    }
  }

  const junction = compact.match(/^PRCB(\d{2})(\d)/)
  if (junction) {
    const junctionSize = size ?? junction[1]!
    const way = junction[2]!
    return {
      label: `${junctionSize}mm ${way}Way Junction`,
      unit: 'piece',
      attributes: [...mmAttribute(junctionSize), ...wayAttribute(way)]
    }
  }

  if (/^PCR\d+/.test(compact) && size) {
    return {
      label: `${size}mm Coupler`,
      unit: 'piece',
      attributes: mmAttribute(size)
    }
  }

  if (/^PRBN\d+/.test(compact) && size) {
    return {
      label: `${size}mm Normal Bend`,
      unit: 'piece',
      attributes: mmAttribute(size)
    }
  }

  if (/^PRFBRD/.test(compact)) {
    return {
      label: 'Fan Box With Rod',
      unit: 'piece',
      attributes: mmAttribute(size)
    }
  }

  if (/^PRFB/.test(compact)) {
    return {
      label: size ? `${size}mm Fan Box` : 'Fan Box',
      unit: 'piece',
      attributes: mmAttribute(size)
    }
  }

  const solvent = compact.match(/^PSC(\d+)(?:ML)?/)
  if (solvent) {
    return {
      label: `Solvent Cement ${solvent[1]}ML`,
      unit: 'piece',
      attributes: [{ name: 'ml', value: solvent[1]!, unit: 'ml' }]
    }
  }

  return null
}

function isDescriptorCell(cell: CanonicalTableCell) {
  const context = cellHeaderText(cell)
  if (/\b(?:sr\s*no|serial)\b/.test(context)) return false
  if (/\b(?:rate|price|mrp|amount|cost)\b|ratepc/.test(context)) return false
  if (/\b(?:standard\s+pack|std\s+pack|pc\s+box|piece\s+box|pc\s+carton|piece\s+carton|carton)\b/.test(context)) return false
  return /[a-z]/i.test(cell.raw_cell_value)
    || /\b(?:product\s*code|productcode|sku|model|catalogue|catalog|cat\s*no|catno|item\s*code|description|product|size|od|colour|color)\b/.test(context)
}

function moqFromRow(cells: CanonicalTableCell[]) {
  const packCells = cells.filter(cell =>
    /\b(?:standard\s+pack|std\s+pack|pc\s+box|piece\s+box|pc\s+carton|piece\s+carton|carton)\b/.test(cellHeaderText(cell))
    && cell.raw_cell_value
    && cell.raw_cell_value !== '-'
  )
  return uniqueText(packCells.map(cell => cell.raw_cell_value)).join(' / ') || null
}

function unitFromPriceContext(cell: CanonicalTableCell, fallback: string | null) {
  if (fallback) return fallback
  const context = cellHeaderText(cell)
  if (/\brate\s*pc\b|ratepc|\bper\s+pc\b|\bper\s+piece\b/.test(context)) return 'piece'
  if (/\b(?:mtr|mtrs|meter|metre)\b/.test(context)) return 'meter'
  if (/\bcoil\b|\broll\b/.test(context)) return 'coil'
  if (/\bbox\b/.test(context) && !/\bpc\s+box\b|\bpiece\s+box\b/.test(context)) return 'box'
  return fallback
}

function rowIdentity(params: { table: CanonicalTable; cell: CanonicalTableCell }) {
  const rowCells = rowCellsFor(params.table, params.cell)
  const productCode = productCodeFromRow(rowCells)
  const sizeText = sizeTextFromRow(rowCells)
  const codeInfo = precisionCodeInfo(productCode, sizeText)
  const descriptors = uniqueText(rowCells
    .filter(cell => cell !== params.cell && isDescriptorCell(cell))
    .map(cell => cell.raw_cell_value))
  const descriptorAttributes = rowCells
    .filter(cell => cell === params.cell || isDescriptorCell(cell))
    .flatMap(cell => cell.attributes)
  const unit = codeInfo?.unit ?? unitFromPriceContext(params.cell, params.cell.unit)

  return {
    productCode,
    label: codeInfo?.label ?? null,
    descriptors,
    unit,
    moq: params.cell.moq ?? moqFromRow(rowCells),
    attributes: mergeAttributes([codeInfo?.attributes ?? [], descriptorAttributes])
  }
}

export function buildSearchableText(params: {
  vendorName?: string | null
  documentTitle: string
  sourcePage?: number | null
  sectionBreadcrumb: string[]
  tableTitle?: string | null
  parentHeaders: string[]
  rowHeaders: string[]
  columnHeaders: string[]
  nearbyNotes: string[]
  descriptionText?: string | null
  unit?: string | null
  price: number
  currency: string
}) {
  return uniqueText([
    params.vendorName ? `Vendor: ${params.vendorName}` : null,
    `Document: ${params.documentTitle}`,
    params.sourcePage ? `Page: ${params.sourcePage}` : null,
    params.sectionBreadcrumb.length ? `Section: ${params.sectionBreadcrumb.join(' > ')}` : null,
    params.tableTitle ? `Table: ${params.tableTitle}` : null,
    params.parentHeaders.length ? `Parent: ${params.parentHeaders.join(' ')}` : null,
    params.rowHeaders.length ? `Row: ${params.rowHeaders.join(' ')}` : null,
    params.columnHeaders.length ? `Column: ${params.columnHeaders.join(' ')}` : null,
    params.nearbyNotes.length ? `Notes: ${params.nearbyNotes.join(' ')}` : null,
    params.descriptionText,
    params.unit ? `Unit: ${params.unit}` : null,
    `Rate: ${params.price} ${params.currency}${params.unit ? ` per ${params.unit}` : ''}`
  ]).join('. ')
}

export function priceCellToRecord(params: CanonicalPriceItemInput): CanonicalPriceItemInsert | null {
  const price = parsePriceNumber(params.cell.raw_cell_value)
  if (price === null) return null
  if (!Number.isFinite(price) || price <= 0 || Math.abs(price) > MAX_DB_PRICE) return null

  const row = rowIdentity({ table: params.table, cell: params.cell })
  const descriptionText = uniqueText([
    row.label,
    row.productCode,
    ...row.descriptors,
    ...params.table.section_breadcrumb,
    params.table.table_title,
    ...params.cell.parent_headers,
    ...params.cell.row_headers,
    ...params.cell.column_headers
  ]).join(' ')
  if (isNonItemTotal(descriptionText, params.cell)) return null
  const productText = uniqueText([
    row.label,
    row.productCode,
    ...row.descriptors,
    ...params.table.section_breadcrumb,
    params.table.table_title,
    ...params.cell.row_headers,
    ...params.cell.parent_headers
  ]).join(' ') || null
  const skuText = row.productCode ?? params.cell.row_headers[0] ?? null
  const currency = params.cell.currency ?? 'INR'
  const unit = row.unit
  const searchableText = buildSearchableText({
    vendorName: params.vendor_name,
    documentTitle: params.document_title,
    sourcePage: params.cell.source_page ?? params.table.source_page,
    sectionBreadcrumb: params.table.section_breadcrumb,
    tableTitle: params.table.table_title,
    parentHeaders: params.cell.parent_headers,
    rowHeaders: params.cell.row_headers,
    columnHeaders: params.cell.column_headers,
    nearbyNotes: params.cell.nearby_notes,
    descriptionText,
    unit,
    price,
    currency
  })

  return {
    tenant_id: params.tenant_id,
    document_id: params.document_id,
    vendor_id: params.vendor_id,
    legacy_doc_item_id: params.legacy_doc_item_id ?? null,
    source_page: params.cell.source_page ?? params.table.source_page,
    source_table_id: params.source_table_id ?? null,
    source_cell_id: params.source_cell_id ?? null,
    source_row_index: params.cell.source_row_index,
    source_col_index: params.cell.source_col_index,
    section_breadcrumb: params.table.section_breadcrumb,
    table_title: params.table.table_title,
    row_headers: params.cell.row_headers,
    column_headers: params.cell.column_headers,
    parent_headers: params.cell.parent_headers,
    nearby_notes: params.cell.nearby_notes,
    raw_cell_value: params.cell.raw_cell_value,
    normalized_price: price,
    currency,
    unit,
    moq: row.moq,
    product_text: productText,
    sku_text: skuText,
    description_text: descriptionText || null,
    attributes_json: mergeAttributes([params.cell.attributes, row.attributes]),
    searchable_text: searchableText,
    normalized_search_text: normalizeSearchText(searchableText),
    source_confidence: params.cell.parser_confidence,
    parser_name: params.table.parser_name,
    source_uploaded_at: params.source_uploaded_at ?? null
  }
}

function isNonItemTotal(descriptionText: string, cell: CanonicalTableCell) {
  const text = normalizeSearchText([
    descriptionText,
    cell.raw_cell_value,
    ...cell.row_headers,
    ...cell.column_headers,
    ...cell.parent_headers
  ].join(' '))
  if (/\b(?:sub\s*total|subtotal|grand\s*total|gst|cgst|sgst|igst|tax\s*amount|round\s*off|amount\s*payable|total\s*amount|quotation\s*total)\b/.test(text)) {
    return true
  }
  if (/^\s*[-–—]?\s*\d+(?:\.\d+)?\s*$/.test(cell.raw_cell_value) && /\b(?:sr\s*no|serial)\b/.test(text) && /\b(?:total|gst)\b/.test(text)) {
    return true
  }
  return false
}

export function priceRecordsFromCanonicalTables(params: {
  tenant_id: string
  document_id: string
  vendor_id: string | null
  vendor_name?: string | null
  document_title: string
  source_uploaded_at?: string | null
  tables: CanonicalTable[]
}) {
  return params.tables.flatMap(table =>
    table.cells.flatMap(cell => {
      if (!cell.is_price) return []
      const record = priceCellToRecord({
        ...params,
        table,
        cell
      })
      return record ? [record] : []
    })
  )
}
