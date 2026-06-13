import type { CanonicalAttribute, CanonicalTable, CanonicalTableCell } from './canonicalizeTable'
import { normalizeSearchText, parsePriceNumber, uniqueText } from '../search/text'

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

  const descriptionText = uniqueText([
    ...params.table.section_breadcrumb,
    params.table.table_title,
    ...params.cell.parent_headers,
    ...params.cell.row_headers,
    ...params.cell.column_headers
  ]).join(' ')
  const productText = uniqueText([
    ...params.table.section_breadcrumb,
    params.table.table_title,
    ...params.cell.row_headers,
    ...params.cell.parent_headers
  ]).join(' ') || null
  const skuText = params.cell.row_headers[0] ?? null
  const currency = params.cell.currency ?? 'INR'
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
    unit: params.cell.unit,
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
    unit: params.cell.unit,
    moq: params.cell.moq,
    product_text: productText,
    sku_text: skuText,
    description_text: descriptionText || null,
    attributes_json: mergeAttributes([params.cell.attributes]),
    searchable_text: searchableText,
    normalized_search_text: normalizeSearchText(searchableText),
    source_confidence: params.cell.parser_confidence,
    parser_name: params.table.parser_name,
    source_uploaded_at: params.source_uploaded_at ?? null
  }
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
