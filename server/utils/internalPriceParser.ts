import ExcelJS from 'exceljs'
import { PriceRow, type PriceRow as PR } from '~~/shared/schemas'

export interface InternalParseResult {
  parser: 'xlsx' | 'csv' | 'pdf-table' | 'pdf-text' | 'unsupported'
  supported: boolean
  rows: PR[]
  markdown: string
  pageCount: number | null
  warnings: string[]
}

interface HeaderMatch {
  headerIndex: number
  nameIdx: number
  skuIdx: number
  unitIdx: number
  priceIdx: number
  moqIdx: number
}

const NAME_SYNS = ['product', 'item', 'description', 'particulars', 'name', 'material', 'details']
const SKU_SYNS = ['sku', 'code', 'item code', 'product code', 'part', 'model', 'cat', 'catalogue', 'hsn', 'size']
const UNIT_SYNS = ['unit', 'uom', 'units', 'packing', 'pack']
const PRICE_SYNS = ['price', 'rate', 'mrp', 'amount', 'cost', 'list price', 'dealer price', 'basic price', 'net rate', 'unit price']
const MOQ_SYNS = ['moq', 'min qty', 'minimum order', 'min order', 'std pack', 'standard pack']

function normaliseHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function matchColumn(headers: string[], syns: string[]): number {
  const n = headers.map(normaliseHeader)
  for (let i = 0; i < n.length; i++) {
    const header = n[i]
    if (header && syns.some(s => header === s)) return i
  }
  for (let i = 0; i < n.length; i++) {
    const header = n[i]
    if (header && syns.some(s => header.includes(s))) return i
  }
  return -1
}

function parseNumber(v: string | undefined): number | null {
  if (!v) return null
  const cleaned = v
    .replace(/[₹$€,\s]/g, '')
    .replace(/\b(rs|inr|mrp|rate|each|ea|pc|pcs|nos?|mtr|meter|kg|box|coil|roll)\b/gi, '')
    .replace(/[^\d.\-]/g, '')
  if (!cleaned) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

function looksLikeProductName(value: string | undefined): boolean {
  const text = value?.trim() ?? ''
  const normalised = text.toLowerCase()
  if (!/[a-z]/i.test(text)) return false
  if (/^(total|subtotal|gst|tax|freight|discount|amount|rate|price|lp)$/i.test(text)) return false
  if (/\b(page|tel|fax|email|www|corporate|registered office|head office|mumbai|delhi|price list|lp no|hsn|gst|tax|freight|iec|bs en)\b/i.test(normalised)) {
    return false
  }
  if (/^[a-z/&\s-]{1,12}$/i.test(text)) return false
  return text.length >= 3
}

function cellToText(cell: ExcelJS.Cell): string {
  const value = cell.value
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map(part => part.text).join('').trim()
    }
    if ('formula' in value) {
      const result = value.result
      return result === null || result === undefined ? '' : String(result).trim()
    }
    if ('text' in value && value.text) return String(value.text).trim()
    if (value instanceof Date) return value.toISOString().slice(0, 10)
  }
  return String(value).trim()
}

function compactRow(row: string[]): string[] {
  let end = row.length
  while (end > 0 && !row[end - 1]?.trim()) end--
  return row.slice(0, end)
}

function findHeader(rows: string[][]): HeaderMatch | null {
  const limit = Math.min(rows.length, 60)
  for (let headerIndex = 0; headerIndex < limit; headerIndex++) {
    const header = rows[headerIndex] ?? []
    const nameIdx = matchColumn(header, NAME_SYNS)
    const skuIdx = matchColumn(header, SKU_SYNS)
    const unitIdx = matchColumn(header, UNIT_SYNS)
    const priceIdx = matchColumn(header, PRICE_SYNS)
    const moqIdx = matchColumn(header, MOQ_SYNS)
    if (nameIdx >= 0 && priceIdx >= 0) {
      return { headerIndex, nameIdx, skuIdx, unitIdx, priceIdx, moqIdx }
    }
  }
  return null
}

function rowHasEnoughData(row: string[], match: HeaderMatch) {
  const name = row[match.nameIdx]?.trim()
  const price = parseNumber(row[match.priceIdx])
  if (!looksLikeProductName(name)) return false
  return price !== null || Boolean(match.skuIdx >= 0 && row[match.skuIdx]?.trim())
}

export function parsePriceRowsFromGrid(rows: string[][], sourcePage: number | null = null): PR[] {
  const match = findHeader(rows)
  if (!match) return parseMiniRateTables(rows, sourcePage)

  const out: PR[] = []
  for (const row of rows.slice(match.headerIndex + 1)) {
    if (!rowHasEnoughData(row, match)) continue

    const candidate: PR = {
      raw_name: row[match.nameIdx]?.trim() ?? '',
      sku: match.skuIdx >= 0 ? row[match.skuIdx]?.trim() || null : null,
      unit: match.unitIdx >= 0 ? row[match.unitIdx]?.trim() || null : null,
      price: parseNumber(row[match.priceIdx]),
      moq: match.moqIdx >= 0 ? row[match.moqIdx]?.trim() || null : null,
      currency: 'INR',
      source_page: sourcePage
    }
    const parsed = PriceRow.safeParse(candidate)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

function normaliseCell(value: string | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? ''
}

function looksLikeSectionTitle(row: string[]): boolean {
  const cells = row.map(normaliseCell).filter((cell): cell is string => Boolean(cell))
  if (cells.length !== 1) return false
  return looksLikeSectionTitleCell(cells[0])
}

function looksLikeSectionTitleCell(value: string | undefined): boolean {
  const title = normaliseCell(value)
  if (title.length < 6 || !/[a-z]/i.test(title)) return false
  return /\b(cables?|wires?|switch(?:es)?|mcb|db|panel|light|fan|speaker|telephone|cctv|lan)\b/i.test(title)
}

function looksLikeRateHeader(value: string | undefined): boolean {
  const text = normaliseCell(value)
  if (!text) return false
  return /\b(rate|price|mrp|mtrs?|meters?|meter|coil|roll|pair|core|nos?|pcs?)\b/i.test(text)
}

function firstTextColumn(row: string[]): number {
  return row.findIndex(cell => {
    const text = normaliseCell(cell)
    return Boolean(text) && /[a-z]/i.test(text) && parseNumber(text) === null
  })
}

function parseMiniRateTables(rows: string[][], sourcePage: number | null): PR[] {
  const out = [
    ...parseSideBySideMiniRateTables(rows, sourcePage),
    ...parseInlineSectionRateRows(rows, sourcePage)
  ]
  let sectionTitle = ''

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? []
    if (looksLikeSectionTitle(row)) {
      sectionTitle = normaliseCell(row.find(Boolean))
      continue
    }

    const header = row.map(normaliseCell)
    const nameIdx = matchColumn(header, [...NAME_SYNS, ...SKU_SYNS])
    if (nameIdx < 0) continue

    const priceColumns = header
      .map((cell, index) => ({ cell, index }))
      .filter(({ cell, index }) => index !== nameIdx && looksLikeRateHeader(cell))
    if (!priceColumns.length) continue

    let nextIndex = i + 1
    for (; nextIndex < rows.length; nextIndex++) {
      const dataRow = rows[nextIndex] ?? []
      if (looksLikeSectionTitle(dataRow)) break

      const keyIdx = normaliseCell(dataRow[nameIdx]) ? nameIdx : firstTextColumn(dataRow)
      const itemKey = normaliseCell(dataRow[keyIdx])
      if (!itemKey || /^[-–—]+$/.test(itemKey)) continue

      for (const { cell: rateHeader, index: priceIdx } of priceColumns) {
        const price = parseNumber(dataRow[priceIdx])
        if (price === null) continue

        const candidate: PR = {
          raw_name: [sectionTitle, itemKey, rateHeader].filter(Boolean).join(' '),
          sku: itemKey,
          unit: rateHeader ? `per ${rateHeader}` : null,
          price,
          moq: null,
          currency: 'INR',
          source_page: sourcePage
        }
        const parsed = PriceRow.safeParse(candidate)
        if (parsed.success) out.push(parsed.data)
      }
    }
    i = nextIndex - 1
  }

  return dedupeRows(out)
}

function parseInlineSectionRateRows(rows: string[][], sourcePage: number | null): PR[] {
  const out: PR[] = []
  let sectionTitle = ''

  for (const row of rows) {
    if (looksLikeSectionTitle(row)) {
      sectionTitle = normaliseCell(row.find(Boolean))
      continue
    }
    if (!sectionTitle) continue

    const line = row.map(normaliseCell).filter(Boolean).join(' ')
    out.push(...parseInlineSectionRateLine(sectionTitle, line, sourcePage))
  }

  return out
}

function parseInlineSectionRateLine(sectionTitle: string, line: string, sourcePage: number | null): PR[] {
  const itemMatch = normaliseCell(line).match(/^([A-Za-z]+[-/]?\d[A-Za-z0-9./-]*|\d[A-Za-z0-9./-]*)\s+(.+)$/)
  if (!itemMatch) return []

  const itemKey = itemMatch[1]?.trim() ?? ''
  const rest = itemMatch[2] ?? ''
  if (itemKey.length < 2 || !/[a-z0-9]/i.test(itemKey)) return []

  const rows: PR[] = []
  const ratePattern = /((?:\d+(?:\.\d+)?\s*)?(?:mtrs?\.?|meters?|meter|coil|roll|pair|core|nos?\.?|pcs?\.?))\s+(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d{1,2})?)/gi
  for (const match of rest.matchAll(ratePattern)) {
    const rateHeader = normaliseCell(match[1])
    const price = parseNumber(match[2])
    if (!rateHeader || price === null) continue

    const candidate: PR = {
      raw_name: [sectionTitle, itemKey, rateHeader].filter(Boolean).join(' '),
      sku: itemKey,
      unit: `per ${rateHeader}`,
      price,
      moq: null,
      currency: 'INR',
      source_page: sourcePage
    }
    const parsed = PriceRow.safeParse(candidate)
    if (parsed.success) rows.push(parsed.data)
  }

  return rows
}

function parseSideBySideMiniRateTables(rows: string[][], sourcePage: number | null): PR[] {
  const out: PR[] = []

  for (let titleRowIndex = 0; titleRowIndex < rows.length - 1; titleRowIndex++) {
    const titleRow = rows[titleRowIndex] ?? []
    const titleCells = titleRow
      .map((cell, index) => ({ title: normaliseCell(cell), index }))
      .filter(({ title }) => looksLikeSectionTitleCell(title))
    if (titleCells.length < 2) continue

    const headerRow = rows[titleRowIndex + 1] ?? []
    const followingRows = rows.slice(titleRowIndex + 2)
    const headerStarts = headerRow
      .map((cell, index) => ({ cell: normaliseCell(cell), index }))
      .filter(({ cell }) => matchColumn([cell], [...NAME_SYNS, ...SKU_SYNS]) === 0)
      .map(({ index }) => index)

    for (let groupIndex = 0; groupIndex < titleCells.length; groupIndex++) {
      const group = titleCells[groupIndex]!
      const start = headerStarts[groupIndex] ?? group.index
      const end = headerStarts[groupIndex + 1]
        ?? titleCells[groupIndex + 1]?.index
        ?? Math.max(titleRow.length, headerRow.length)
      const header = headerRow.slice(start, end).map(normaliseCell)

      const localNameIdx = matchColumn(header, [...NAME_SYNS, ...SKU_SYNS])
      const nameIdx = start + (localNameIdx >= 0 ? localNameIdx : 0)
      const priceColumns = header
        .map((cell, localIndex) => ({ cell, index: start + localIndex }))
        .filter(({ cell, index }) => index !== nameIdx && looksLikeRateHeader(cell))
      if (!priceColumns.length) continue

      for (const row of followingRows) {
        if (row.some(cell => looksLikeSectionTitleCell(cell))) break

        const itemKey = normaliseCell(row[nameIdx])
        if (!itemKey || /^[-–—]+$/.test(itemKey)) continue

        for (const { cell: rateHeader, index: priceIdx } of priceColumns) {
          const price = parseNumber(row[priceIdx])
          if (price === null) continue

          const candidate: PR = {
            raw_name: [group.title, itemKey, rateHeader].filter(Boolean).join(' '),
            sku: itemKey,
            unit: rateHeader ? `per ${rateHeader}` : null,
            price,
            moq: null,
            currency: 'INR',
            source_page: sourcePage
          }
          const parsed = PriceRow.safeParse(candidate)
          if (parsed.success) out.push(parsed.data)
        }
      }
    }
  }

  return out
}

function dedupeRows(rows: PR[]): PR[] {
  const seen = new Set<string>()
  return rows.filter(row => {
    const key = JSON.stringify([
      row.raw_name.toLowerCase(),
      row.sku?.toLowerCase() ?? '',
      row.unit?.toLowerCase() ?? '',
      row.price
    ])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function parseDelimited(text: string): string[][] {
  const rows: string[][] = []
  let current = ''
  let row: string[] = []
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    const next = text[i + 1]
    if (char === '"' && next === '"' && inQuotes) {
      current += '"'
      i++
    } else if (char === '"') {
      inQuotes = !inQuotes
    } else if (char === ',' && !inQuotes) {
      row.push(current.trim())
      current = ''
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i++
      row.push(current.trim())
      if (row.some(cell => cell)) rows.push(compactRow(row))
      row = []
      current = ''
    } else {
      current += char
    }
  }

  row.push(current.trim())
  if (row.some(cell => cell)) rows.push(compactRow(row))
  return rows
}

function rowsToMarkdown(rows: string[][]): string {
  return rows
    .map(row => row.join(' | '))
    .join('\n')
}

async function parseWorkbook(buffer: Buffer): Promise<InternalParseResult> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as any)

  const allRows: PR[] = []
  const markdownParts: string[] = []
  for (const worksheet of workbook.worksheets) {
    const rows: string[][] = []
    const maxColumns = Math.max(worksheet.columnCount, 1)
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = []
      const width = Math.max(maxColumns, row.cellCount)
      for (let col = 1; col <= width; col++) {
        cells.push(cellToText(row.getCell(col)))
      }
      if (cells.some(cell => cell)) rows.push(compactRow(cells))
    })
    if (!rows.length) continue
    markdownParts.push(`## ${worksheet.name}\n${rowsToMarkdown(rows)}`)
    allRows.push(...parsePriceRowsFromGrid(rows))
  }

  return {
    parser: 'xlsx',
    supported: true,
    rows: allRows,
    markdown: markdownParts.join('\n\n'),
    pageCount: workbook.worksheets.length || null,
    warnings: allRows.length ? [] : ['No product/price table header was detected in the workbook.']
  }
}

function parseCsv(buffer: Buffer): InternalParseResult {
  const text = buffer.toString('utf8')
  const rows = parseDelimited(text)
  const parsedRows = parsePriceRowsFromGrid(rows)
  return {
    parser: 'csv',
    supported: true,
    rows: parsedRows,
    markdown: rowsToMarkdown(rows),
    pageCount: null,
    warnings: parsedRows.length ? [] : ['No product/price table header was detected in the CSV.']
  }
}

function parseTextLines(text: string): PR[] {
  const rows: PR[] = []
  let sectionTitle = ''
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/\s+/g, ' ').trim()
    if (trimmed.length < 8 || /^total\b/i.test(trimmed)) continue

    if (looksLikeSectionTitleCell(trimmed)) {
      sectionTitle = trimmed
      continue
    }

    if (sectionTitle) {
      const inlineRows = parseInlineSectionRateLine(sectionTitle, trimmed, null)
      if (inlineRows.length) {
        rows.push(...inlineRows)
        continue
      }
    }

    const match = trimmed.match(/^(.+?)\s+(₹|rs\.?|inr)?\s*([\d,]+(?:\.\d{1,2})?)\s*(\/-)?(?:\s+(per\s+.+|each|ea|pc|pcs|nos?|mtr|meter|kg|box|coil|roll))?$/i)
    if (!match) continue

    const candidate: PR = {
      raw_name: match[1]?.trim() ?? '',
      sku: null,
      unit: match[5]?.trim() ?? null,
      price: parseNumber(match[3]),
      moq: null,
      currency: 'INR'
    }
    const parsed = PriceRow.safeParse(candidate)
    if (parsed.success && parsed.data.price !== null && looksLikeProductName(parsed.data.raw_name)) {
      rows.push(parsed.data)
    }
  }
  return rows
}

async function parsePdf(buffer: Buffer): Promise<InternalParseResult> {
  const PDFParse = await loadPdfParser()
  if (!PDFParse) {
    return {
      parser: 'unsupported',
      supported: false,
      rows: [],
      markdown: '',
      pageCount: null,
      warnings: ['Internal PDF parsing is not available in this runtime, so this PDF should be handled by OCR.']
    }
  }

  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  try {
    const tableResult = await parser.getTable().catch(() => null)
    const tableRows: PR[] = []
    const markdownParts: string[] = []
    for (const page of tableResult?.pages ?? []) {
      for (const table of page.tables) {
        markdownParts.push(`{${page.num}}\n${rowsToMarkdown(table)}`)
        tableRows.push(...parsePriceRowsFromGrid(table, page.num))
      }
    }
    if (tableRows.length > 0) {
      return {
        parser: 'pdf-table',
        supported: true,
        rows: tableRows,
        markdown: markdownParts.join('\n\n'),
        pageCount: tableResult?.total ?? null,
        warnings: []
      }
    }

    const textResult = await parser.getText()
    const textRows = parseTextLines(textResult.text)
    return {
      parser: 'pdf-text',
      supported: true,
      rows: textRows,
      markdown: textResult.pages.map(page => `{${page.num}}\n${page.text}`).join('\n\n'),
      pageCount: textResult.total ?? null,
      warnings: textRows.length
        ? ['PDF did not expose clear table geometry, so the internal parser used line-based text extraction.']
        : ['PDF text was readable, but no confident product/price rows were detected. This may be a scanned PDF that needs OCR.']
    }
  } finally {
    await parser.destroy()
  }
}

async function loadPdfParser() {
  try {
    const mod = await import('pdf-parse')
    return mod.PDFParse
  } catch {
    return null
  }
}

function isPdf(filename: string, mime?: string | null) {
  return mime === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')
}

function isCsv(filename: string, mime?: string | null) {
  const lower = filename.toLowerCase()
  return lower.endsWith('.csv') || mime === 'text/csv' || mime === 'application/csv'
}

function isXlsx(filename: string, mime?: string | null) {
  const lower = filename.toLowerCase()
  return lower.endsWith('.xlsx') || mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
}

export async function parseInternalPriceDocument(params: {
  fileData: Buffer
  filename: string
  mime?: string | null
}): Promise<InternalParseResult> {
  if (isXlsx(params.filename, params.mime)) {
    return await parseWorkbook(params.fileData)
  }
  if (isCsv(params.filename, params.mime)) {
    return parseCsv(params.fileData)
  }
  if (isPdf(params.filename, params.mime)) {
    return await parsePdf(params.fileData)
  }

  return {
    parser: 'unsupported',
    supported: false,
    rows: [],
    markdown: '',
    pageCount: null,
    warnings: ['Internal parser currently supports .xlsx, .csv, and text-based PDFs.']
  }
}
