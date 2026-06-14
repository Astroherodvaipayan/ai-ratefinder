import { load as loadHtml } from 'cheerio'
import type { ExtractedPriceRow } from '../priceExtraction'
import { normalizeSearchText, parsePriceNumber, uniqueText } from '../search/text'

export interface CanonicalAttribute {
  name: string
  value: string
  unit?: string
}

export interface CanonicalTableCell {
  source_page: number | null
  source_row_index: number
  source_col_index: number
  source_rowspan: number
  source_colspan: number
  is_header: boolean
  is_price: boolean
  row_headers: string[]
  column_headers: string[]
  parent_headers: string[]
  merged_headers: string[]
  raw_cell_value: string
  normalized_value: string
  unit: string | null
  currency: string | null
  moq: string | null
  footnotes: string[]
  nearby_notes: string[]
  bbox: Record<string, unknown> | null
  parser_confidence: number
  ocr_confidence: number | null
  attributes: CanonicalAttribute[]
}

export interface CanonicalTable {
  source_page: number | null
  table_index: number
  table_title: string | null
  section_breadcrumb: string[]
  parser_name: string
  parser_confidence: number
  ocr_confidence: number | null
  cells: CanonicalTableCell[]
}

interface GridCell {
  text: string
  originRow: number
  originCol: number
  rowspan: number
  colspan: number
  isHeader: boolean
  propagated: boolean
}

function cellText(value: string | null | undefined) {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function numericAttributes(text: string): CanonicalAttribute[] {
  const attributes: CanonicalAttribute[] = []
  for (const match of normalizeSearchText(text).matchAll(/\b(\d+(?:\.\d+)?)\s*(sqmm|mm|meter|kg|core|piece|box|coil|pair)\b/g)) {
    const [, value, unit] = match
    if (!value || !unit) continue
    const name = unit === 'core' ? 'cores' : unit === 'meter' ? 'length' : unit === 'sqmm' ? 'size' : unit
    attributes.push({ name, value, unit: unit === 'core' ? undefined : unit })
  }
  for (const match of normalizeSearchText(text).matchAll(/\b(\d+)\s*c\b/g)) {
    attributes.push({ name: 'cores', value: match[1]! })
  }
  return attributes
}

function descriptorAttributes(value: string, descriptorHeaders: string[]): CanonicalAttribute[] {
  const normalizedValue = normalizeSearchText(value)
  const normalizedHeaders = normalizeSearchText(descriptorHeaders.join(' '))
  const number = normalizedValue.match(/\b\d+(?:\.\d+)?\b/)?.[0]
  if (!number) return []

  if (/\bpair\b/.test(normalizedValue)) {
    return [{ name: 'pair', value: number, unit: 'pair' }]
  }
  if (/\b(?:sqmm|sq mm|cross section|conductor area|conductorarea|size)\b/.test(normalizedHeaders)) {
    return [{ name: 'size', value: number, unit: 'sqmm' }]
  }
  if (/\bno of cores\b/.test(normalizedHeaders)) {
    return [{ name: 'cores', value: number }]
  }
  return []
}

function currencyFor(value: string) {
  if (/[₹]|(?:\brs\.?\b|\binr\b)/i.test(value)) return 'INR'
  if (/\$/.test(value)) return 'USD'
  if (/€/.test(value)) return 'EUR'
  return null
}

function unitFor(text: string) {
  const normalized = normalizeSearchText(text)
  if (/\bmeter\b/.test(normalized)) return 'meter'
  if (/\bcoil\b|\broll\b/.test(normalized)) return 'coil'
  if (/\bbox\b/.test(normalized)) return 'box'
  if (/\bkg\b/.test(normalized)) return 'kg'
  if (/\bpiece\b/.test(normalized)) return 'piece'
  if (/\bpair\b/.test(normalized)) return 'pair'
  return null
}

function isPriceLike(value: string, headers: string[]) {
  if (parsePriceNumber(value) === null) return false
  const context = normalizeSearchText([...headers, value].join(' '))
  if (/\b(?:rate|price|mrp|amount|cost|inr|rs|₹)\b/.test(context)) return true
  return !/\b(?:sqmm|mm|meter|core|kg|piece|pair)\b/.test(normalizeSearchText(value))
}

function buildCellsFromGrid(params: {
  grid: string[][]
  sourcePage: number | null
  parserName: string
  parserConfidence?: number
  ocrConfidence?: number | null
}) {
  const headerRows = inferHeaderRowCount(params.grid)
  const descriptorColumns = inferDescriptorColumns(params.grid, headerRows)
  const cells: CanonicalTableCell[] = []
  const rowCarry: string[] = []

  for (let rowIndex = 0; rowIndex < params.grid.length; rowIndex++) {
    const row = params.grid[rowIndex] ?? []
    const firstCell = cellText(row[0])
    if (rowIndex >= headerRows && firstCell) rowCarry[0] = firstCell

    for (let colIndex = 0; colIndex < row.length; colIndex++) {
      const raw = cellText(row[colIndex])
      if (!raw) continue
      const columnHeaders = uniqueText(params.grid
        .slice(0, headerRows)
        .map(headerRow => headerCellAt(headerRow, colIndex)))
      const descriptorCol = nearestDescriptorColumn(descriptorColumns, colIndex)
      const rowDescriptor = descriptorCol === null ? firstCell : cellText(row[descriptorCol])
      const descriptorHeaders = descriptorCol === null
        ? []
        : uniqueText(params.grid.slice(0, headerRows).map(headerRow => headerCellAt(headerRow, descriptorCol)))
      const rowHeaders = rowIndex >= headerRows
        ? uniqueText([rowDescriptor || firstCell || rowCarry[0]])
        : []
      const parentHeaders = uniqueText([
        ...params.grid.slice(0, Math.max(0, headerRows - 1)).map(headerRow => headerCellAt(headerRow, colIndex)),
        rowIndex >= headerRows ? rowDescriptor || params.grid[rowIndex]?.[0] : null
      ])
      const headerContext = [...columnHeaders, ...rowHeaders, ...parentHeaders]
      const isHeader = rowIndex < headerRows
      const isLikelyRowDescriptor = descriptorColumns.has(colIndex) && row.length > 1
      cells.push({
        source_page: params.sourcePage,
        source_row_index: rowIndex,
        source_col_index: colIndex,
        source_rowspan: 1,
        source_colspan: 1,
        is_header: isHeader,
        is_price: !isHeader && !isLikelyRowDescriptor && isPriceLike(raw, headerContext),
        row_headers: rowHeaders,
        column_headers: columnHeaders,
        parent_headers: parentHeaders,
        merged_headers: [],
        raw_cell_value: raw,
        normalized_value: normalizeSearchText(raw),
        unit: unitFor(headerContext.join(' ')),
        currency: currencyFor(raw) ?? currencyFor(headerContext.join(' ')),
        moq: null,
        footnotes: [],
        nearby_notes: [],
        bbox: null,
        parser_confidence: params.parserConfidence ?? 0.75,
        ocr_confidence: params.ocrConfidence ?? null,
        attributes: [
          ...numericAttributes(headerContext.join(' ')),
          ...descriptorAttributes(rowDescriptor, descriptorHeaders)
        ]
      })
    }
  }
  return cells
}

function headerCellAt(row: string[], colIndex: number) {
  const direct = cellText(row[colIndex])
  if (direct) return direct
  for (let index = colIndex - 1; index >= 0; index--) {
    const carried = cellText(row[index])
    if (carried) return carried
  }
  return ''
}

function inferDescriptorColumns(grid: string[][], headerRows: number) {
  const columns = new Set<number>()
  const width = Math.max(0, ...grid.map(row => row.length))
  for (let colIndex = 0; colIndex < width; colIndex++) {
    const text = normalizeSearchText(grid.slice(0, headerRows).map(row => row[colIndex]).join(' '))
    if (/\b(?:description|product|sku|code|size|sqmm|sq mm|cross section|conductor area|conductorarea|no of cores)\b/.test(text)) {
      columns.add(colIndex)
    }
  }
  if (width > 1) columns.add(0)
  return columns
}

function nearestDescriptorColumn(columns: Set<number>, colIndex: number) {
  let nearest: number | null = null
  for (const column of columns) {
    if (column >= colIndex) continue
    if (nearest === null || column > nearest) nearest = column
  }
  return nearest
}

function inferHeaderRowCount(grid: string[][]) {
  const max = Math.min(grid.length, 4)
  let count = 1
  for (let index = 0; index < max; index++) {
    const row = grid[index] ?? []
    const text = normalizeSearchText(row.join(' '))
    if (/\b(?:rate|price|mrp|amount|cost|unit|uom|description|product|sku|code|size|model|cross section|conductor area|conductorarea|no of cores|amps?|core|mm|mtrs?|coil)\b/.test(text)) {
      count = index + 1
    }
  }
  return Math.max(1, count)
}

export function expandHtmlTable(html: string): string[][] {
  const $ = loadHtml(html)
  const table = $('table').first()
  const grid: GridCell[][] = []

  table.find('tr').each((rowIndex, tr) => {
    grid[rowIndex] ??= []
    let colIndex = 0
    $(tr).children('th,td').each((_, cell) => {
      while (grid[rowIndex]![colIndex]) colIndex += 1
      const text = $(cell).text().replace(/\s+/g, ' ').trim()
      const rowspan = Math.max(1, Number($(cell).attr('rowspan')) || 1)
      const colspan = Math.max(1, Number($(cell).attr('colspan')) || 1)
      const isHeader = cell.tagName?.toLowerCase() === 'th'
      for (let r = 0; r < rowspan; r++) {
        grid[rowIndex + r] ??= []
        for (let c = 0; c < colspan; c++) {
          grid[rowIndex + r]![colIndex + c] = {
            text,
            originRow: rowIndex,
            originCol: colIndex,
            rowspan,
            colspan,
            isHeader,
            propagated: r > 0 || c > 0
          }
        }
      }
      colIndex += colspan
    })
  })

  return grid.map(row => row.map(cell => cell?.text ?? ''))
}

export function canonicalizeGridTable(params: {
  grid: string[][]
  sourcePage?: number | null
  tableIndex?: number
  tableTitle?: string | null
  sectionBreadcrumb?: string[]
  parserName: string
  parserConfidence?: number
  ocrConfidence?: number | null
}): CanonicalTable {
  const sourcePage = params.sourcePage ?? null
  return {
    source_page: sourcePage,
    table_index: params.tableIndex ?? 0,
    table_title: params.tableTitle ?? null,
    section_breadcrumb: params.sectionBreadcrumb ?? [],
    parser_name: params.parserName,
    parser_confidence: params.parserConfidence ?? 0.75,
    ocr_confidence: params.ocrConfidence ?? null,
    cells: buildCellsFromGrid({
      grid: params.grid,
      sourcePage,
      parserName: params.parserName,
      parserConfidence: params.parserConfidence,
      ocrConfidence: params.ocrConfidence
    })
  }
}

export function canonicalizeExtractedRows(params: {
  rows: ExtractedPriceRow[]
  documentTitle: string
  vendorName?: string | null
  parserName: string
  parserConfidence?: number
  ocrConfidence?: number | null
}): CanonicalTable[] {
  const grouped = new Map<number | null, ExtractedPriceRow[]>()
  for (const row of params.rows) {
    const key = row.source_page ?? null
    grouped.set(key, [...(grouped.get(key) ?? []), row])
  }

  let tableIndex = 0
  return [...grouped.entries()].map(([sourcePage, rows]) => {
    const grid = [
      ['Description', 'SKU', 'Unit', 'MOQ', 'Currency', 'Rate'],
      ...rows.map(row => [
        row.raw_name,
        row.sku ?? '',
        row.unit ?? '',
        row.moq ?? '',
        row.currency,
        row.price === null ? '' : String(row.price)
      ])
    ]
    const table = canonicalizeGridTable({
      grid,
      sourcePage,
      tableIndex: tableIndex++,
      tableTitle: params.documentTitle,
      sectionBreadcrumb: uniqueText([params.vendorName, params.documentTitle]),
      parserName: params.parserName,
      parserConfidence: params.parserConfidence,
      ocrConfidence: params.ocrConfidence
    })
    for (const cell of table.cells) {
      if (!cell.is_price) continue
      const row = rows[cell.source_row_index - 1]
      if (!row) continue
      cell.unit = row.unit ?? cell.unit
      cell.currency = row.currency ?? cell.currency
      cell.moq = row.moq ?? cell.moq
      cell.attributes = [
        ...cell.attributes,
        ...numericAttributes([row.raw_name, row.sku, row.unit, row.moq].filter(Boolean).join(' '))
      ]
    }
    return table
  })
}
