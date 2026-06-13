import ExcelJS from 'exceljs'
import { load as loadHtml } from 'cheerio'
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

interface HtmlGridCell {
  text: string
  originRow: number
  originCol: number
  isHeader: boolean
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
  const original = normaliseCell(v)
  if (!original) return null
  if (/^\d+(?:\.\d+)?\s*(?:sq\.?\s*mm|mm|mtrs?\.?|met(?:er|re)s?|pair|core|nos?\.?|pcs?\.?)$/i.test(original)) return null
  if (/[+]/.test(original) && !/(?:₹|rs\.?|inr)/i.test(original)) return null
  if (/[\/]/.test(original) && !/(?:₹|rs\.?|inr|\/-)/i.test(original)) return null
  if (/[a-z]/i.test(original) && !/\b(rs|inr|mrp|rate|each|ea|pc|pcs|nos?|mtrs?|meter|kg|box|coil|roll)\b/i.test(original)) return null
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
  const grouped = parseGroupedMatrixTables(rows, sourcePage)
  if (grouped.length) return grouped

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
  return value
    ?.replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() ?? ''
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
    ...parseGroupedMatrixTables(rows, sourcePage),
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
          unit: unitForMatrixCell(sectionTitle, rateHeader),
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

function parseGroupedMatrixTables(rows: string[][], sourcePage: number | null): PR[] {
  const out: PR[] = []

  for (let titleRowIndex = 0; titleRowIndex < rows.length - 1; titleRowIndex++) {
    const titleRow = rows[titleRowIndex] ?? []
    const titleCells = titleRow
      .map((cell, index) => ({ title: normaliseCell(cell), index }))
      .filter(({ title }) => looksLikeSectionTitleCell(title))
    if (!titleCells.length) continue

    const headerRow = rows[titleRowIndex + 1] ?? []
    const followingRows = rows.slice(titleRowIndex + 2)

    for (let groupIndex = 0; groupIndex < titleCells.length; groupIndex++) {
      const group = titleCells[groupIndex]!
      const softStop = titleCells[groupIndex + 1]?.index ?? Math.max(titleRow.length, headerRow.length)

      for (const row of followingRows) {
        if (row.some(cell => looksLikeSectionTitleCell(cell))) break

        const rowQualifier = firstMatrixQualifier(row, headerRow, group.index)
        let sawPrice = false
        let emptyAfterPrice = 0

        for (let col = group.index + 1; col < Math.max(headerRow.length, row.length); col++) {
          const header = normaliseCell(headerRow[col])
          const value = normaliseCell(row[col])
          const price = parseMatrixPrice(value)
          const variant = matrixVariantLabel(header)

          if (
            col >= softStop
            && !(sawPrice && price !== null && variant && looksLikeMatrixContinuation(header))
          ) {
            break
          }

          if (!header && !value) {
            if (sawPrice && ++emptyAfterPrice >= 2) break
            continue
          }

          if (isDescriptorHeader(header)) {
            if (sawPrice && !value) break
            continue
          }

          if (price === null || !variant) {
            if (sawPrice && !price && !looksLikeMatrixContinuation(header)) break
            continue
          }

          sawPrice = true
          emptyAfterPrice = 0
          const candidate: PR = {
            raw_name: [group.title, rowQualifier, variant].filter(Boolean).join(' '),
            sku: rowQualifier || null,
            unit: unitForMatrixCell(group.title, variant),
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

  return dedupeRows(out)
}

function firstMatrixQualifier(row: string[], headerRow: string[], start: number): string {
  const direct = normaliseCell(row[start])
  const directHeader = normaliseCell(headerRow[start])
  if (
    direct
    && (
      isDescriptorHeader(directHeader)
      || looksLikeDimensionOnly(direct)
      || parseMatrixPrice(direct) === null
    )
  ) {
    return direct
  }

  for (let col = start + 1; col < Math.min(row.length, start + 4); col++) {
    const header = normaliseCell(headerRow[col])
    const value = normaliseCell(row[col])
    if (!value || parseMatrixPrice(value) !== null) continue
    if (isDescriptorHeader(header) || looksLikeDimensionOnly(value)) return value
  }

  return ''
}

function isDescriptorHeader(value: string | undefined) {
  const text = normaliseCell(value).toLowerCase()
  if (!text) return false
  return /^(size|sizes?|code|model|item|description|rate per coil|rate)$/.test(text)
}

function looksLikeDimensionOnly(value: string | undefined) {
  const text = normaliseCell(value)
  return /^\d+(?:\.\d+)?\s*(?:sq\.?\s*mm|mm|mtrs?\.?|met(?:er|re)s?|pair|core|nos?\.?|pcs?\.?)$/i.test(text)
}

function matrixVariantLabel(value: string | undefined) {
  const text = normaliseCell(value)
  if (!text || isDescriptorHeader(text)) return ''
  if (/^-+$/.test(text)) return ''
  return text
}

function looksLikeMatrixContinuation(value: string | undefined) {
  const text = normaliseCell(value)
  return Boolean(text) && (
    looksLikeRateHeader(text)
    || /\b(mm|mtrs?\.?|met(?:er|re)s?|pair|core|coil|roll|fr|lsoh|cat|nos?\.?|pcs?\.?)\b/i.test(text)
    || /^\d+(?:\.\d+)?(?:\+\d+)?$/.test(text)
  )
}

function parseMatrixPrice(value: string | undefined) {
  const text = normaliseCell(value)
  if (!text || looksLikeDimensionOnly(text)) return null
  return parseNumber(text)
}

function unitForMatrixCell(sectionTitle: string, variant: string) {
  const combined = `${sectionTitle} ${variant}`
  if (/\bcoil|roll\b/i.test(combined)) return 'per coil'
  if (/\bcore\b/i.test(variant) && /\b(cables?|conductor|xlpe|pvc)\b/i.test(sectionTitle)) return 'per meter'
  return variant ? `per ${variant}` : null
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
      unit: unitForMatrixCell(sectionTitle, rateHeader),
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
            unit: unitForMatrixCell(group.title, rateHeader),
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

function clampSpan(value: string | undefined, fallback = 1) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 && parsed < 100 ? parsed : fallback
}

function uniqueNonEmpty(values: string[]) {
  return [...new Set(values.map(normaliseCell).filter(Boolean))]
}

function meaningfulParts(values: string[]) {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values.map(normaliseCell).filter(Boolean)) {
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

function isUnavailableCell(value: string | undefined) {
  return /^[-–—]+$/.test(normaliseCell(value))
}

function tableToGrid($: ReturnType<typeof loadHtml>, table: any): HtmlGridCell[][] {
  const grid: HtmlGridCell[][] = []

  $(table).find('tr').each((rowIndex, tr) => {
    const row = grid[rowIndex] ?? []
    grid[rowIndex] = row
    let colIndex = 0

    $(tr).children('th,td').each((_, cell) => {
      while (row[colIndex]) colIndex++

      const cellElement = $(cell)
      const text = normaliseCell(cellElement.text())
      const rowSpan = clampSpan(cellElement.attr('rowspan'))
      const colSpan = clampSpan(cellElement.attr('colspan'))
      const isHeader = String((cell as any).tagName ?? '').toLowerCase() === 'th'
      const gridCell: HtmlGridCell = {
        text,
        originRow: rowIndex,
        originCol: colIndex,
        isHeader
      }

      for (let r = rowIndex; r < rowIndex + rowSpan; r++) {
        const targetRow = grid[r] ?? []
        grid[r] = targetRow
        for (let c = colIndex; c < colIndex + colSpan; c++) {
          targetRow[c] = gridCell
        }
      }

      colIndex += colSpan
    })
  })

  const width = Math.max(0, ...grid.map(row => row.length))
  for (let rowIndex = 0; rowIndex < grid.length; rowIndex++) {
    const row = grid[rowIndex] ?? []
    for (let colIndex = 0; colIndex < width; colIndex++) {
      row[colIndex] ??= {
        text: '',
        originRow: rowIndex,
        originCol: colIndex,
        isHeader: false
      }
    }
  }

  return grid
}

function isSectionRow(row: HtmlGridCell[], rowIndex: number) {
  const currentTexts = uniqueNonEmpty(row
    .filter(cell => cell.originRow === rowIndex)
    .map(cell => cell.text))
  if (currentTexts.length !== 1) return null

  const title = currentTexts[0]!
  const occupied = row.filter(cell => cell.originRow === rowIndex && cell.text === title).length
  if (occupied < Math.max(1, Math.floor(row.length * 0.45))) return null
  if (looksLikeSectionTitleCell(title) || row.some(cell => cell.isHeader && cell.originRow === rowIndex)) {
    return title
  }
  if (rowIndex === 0 && title.length >= 8 && /[a-z]/i.test(title)) return title
  return null
}

function headerContextForColumn(
  grid: HtmlGridCell[][],
  rowIndex: number,
  colIndex: number,
  sectionStart: number
) {
  const values: string[] = []
  for (let r = sectionStart; r < rowIndex; r++) {
    const cell = grid[r]?.[colIndex]
    if (!cell?.text || cell.originRow !== r) continue
    if (isUnavailableCell(cell.text)) continue
    if (parseNumber(cell.text) !== null && !/[a-z]/i.test(cell.text) && !looksLikeDimensionOnly(cell.text)) continue
    values.push(cell.text)
  }
  return meaningfulParts(values)
}

function headerTextLooksLikePriceColumn(text: string) {
  return /\b(rate|price|mrp|amount|cost|unarmou?red|armou?red|screened|jellyfilled|single\s*core|\d+(?:\.\d+)?\s*core|mtrs?\.?|meters?|coil|sq\.?\s*mm|mm\.?)\b/i
    .test(text)
}

function headerTextLooksLikeDescriptorOnly(text: string) {
  const normalized = normaliseHeader(text)
  return /^(cond|conductor|cond const|amps?|no of pair size|no of pair|item|items?|description|size|sizes?|sku|code)$/.test(normalized)
}

function isHtmlPriceCell(
  grid: HtmlGridCell[][],
  rowIndex: number,
  colIndex: number,
  sectionStart: number
) {
  const cell = grid[rowIndex]?.[colIndex]
  if (!cell || cell.originRow !== rowIndex || !cell.text || isUnavailableCell(cell.text)) return false
  if (looksLikeDimensionOnly(cell.text)) return false

  const price = parseNumber(cell.text)
  if (price === null) return false
  if (/[a-z]/i.test(cell.text) && !/(?:₹|rs\.?|inr)/i.test(cell.text)) return false

  const headerText = headerContextForColumn(grid, rowIndex, colIndex, sectionStart).join(' ')
  if (headerTextLooksLikeDescriptorOnly(headerText) && !headerTextLooksLikePriceColumn(headerText)) return false
  if (price < 100 && !/\b(rate|price|mrp|amount|cost)\b/i.test(headerText)) return false

  const row = grid[rowIndex] ?? []
  const currentLeftText = row
    .slice(0, colIndex)
    .filter(left => left.originRow === rowIndex && left.text && !isUnavailableCell(left.text))
    .map(left => left.text)
  const hasPriceHeader = headerTextLooksLikePriceColumn(headerText)
  return currentLeftText.length > 0 || hasPriceHeader
}

function priceGroupsForRow(grid: HtmlGridCell[][], rowIndex: number, sectionStart: number) {
  const row = grid[rowIndex] ?? []
  const groups: number[][] = []
  let current: number[] = []

  for (let col = 0; col < row.length; col++) {
    if (isHtmlPriceCell(grid, rowIndex, col, sectionStart)) {
      current.push(col)
    } else if (current.length) {
      groups.push(current)
      current = []
    }
  }
  if (current.length) groups.push(current)
  return groups
}

function rowDescriptorForGroup(
  grid: HtmlGridCell[][],
  rowIndex: number,
  group: number[],
  previousGroupEnd: number,
  sectionStart: number
) {
  const row = grid[rowIndex] ?? []
  const start = group[0] ?? 0
  const rangeStart = previousGroupEnd + 1
  const local = row
    .slice(rangeStart, start)
    .filter(cell => cell.originRow === rowIndex && cell.text && !isUnavailableCell(cell.text))
    .map(cell => cell.text)

  const prefix = row
    .slice(0, start)
    .filter((cell, index) =>
      index < start
      && cell.originRow === rowIndex
      && cell.text
      && !isUnavailableCell(cell.text)
      && !isHtmlPriceCell(grid, rowIndex, index, sectionStart)
    )
    .map(cell => cell.text)

  const descriptor = local.length ? local : prefix
  return meaningfulParts(descriptor).join(' ')
}

function parseHtmlGridPriceRows(grid: HtmlGridCell[][], sourcePage: number | null = null): PR[] {
  const out: PR[] = []
  let sectionTitle = ''
  let sectionStart = 0

  for (let rowIndex = 0; rowIndex < grid.length; rowIndex++) {
    const row = grid[rowIndex] ?? []
    const title = isSectionRow(row, rowIndex)
    if (title) {
      sectionTitle = title
      if (rowIndex === 0 || row.some(cell => cell.isHeader && cell.originRow === rowIndex)) {
        sectionStart = rowIndex + 1
      }
      continue
    }

    const groups = priceGroupsForRow(grid, rowIndex, sectionStart)
    if (!groups.length) continue

    let previousGroupEnd = -1
    for (const group of groups) {
      const rowDescriptor = rowDescriptorForGroup(grid, rowIndex, group, previousGroupEnd, sectionStart)
      previousGroupEnd = group[group.length - 1] ?? previousGroupEnd
      if (!rowDescriptor && !sectionTitle) continue
      if (/^(item|items?|description|sku|code|size|sizes?)$/i.test(rowDescriptor)) continue

      for (const colIndex of group) {
        const cell = grid[rowIndex]?.[colIndex]
        const price = parseNumber(cell?.text)
        if (price === null) continue

        const columnContext = headerContextForColumn(grid, rowIndex, colIndex, sectionStart)
          .filter(value => value.toLowerCase() !== sectionTitle.toLowerCase())
        const columnLabel = columnContext.join(' ')
        const rawName = meaningfulParts([sectionTitle, rowDescriptor, columnLabel]).join(' ')
        if (!rawName || !/[a-z0-9]/i.test(rawName)) continue

        const candidate: PR = {
          raw_name: rawName,
          sku: rowDescriptor || null,
          unit: unitForMatrixCell(sectionTitle, columnLabel),
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

  return dedupeRows(out)
}

export function parsePriceRowsFromHtmlTables(markdown: string, sourcePage: number | null = null): PR[] {
  if (!/<table[\s>]/i.test(markdown)) return []

  const $ = loadHtml(markdown)
  const rows: PR[] = []
  $('table').each((_, table) => {
    rows.push(...parseHtmlGridPriceRows(tableToGrid($, table), sourcePage))
  })
  return dedupeRows(rows)
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
