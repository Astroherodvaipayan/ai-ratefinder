import { load as loadHtml } from 'cheerio'
import { expandHtmlTable } from '../extraction/canonicalizeTable'
import { splitPaginatedMarkdown } from '../pricePages'

export interface SourceTable {
  page: number | null
  tableIndex: number
  title: string | null
  grid: string[][]
}

export interface RepeatedSourceBlock {
  source_page: number | null
  source_table_index: number
  first_row_index: number
  repeated_row_index: number
  row_count: number
}

export interface TruncatedSourceRow {
  source_page: number | null
  source_table_index: number
  source_row_index: number
  expected_columns: number
  actual_columns: number
}

export function extractSourceTables(markdownHtml: string): SourceTable[] {
  const tables: SourceTable[] = []
  const tableRe = /<table[\s\S]*?<\/table>/gi
  let match: RegExpExecArray | null

  while ((match = tableRe.exec(markdownHtml))) {
    const before = markdownHtml.slice(0, match.index)
    const pageNumberMatches = [...before.slice(-5000).matchAll(/class=["']page-number["'][^>]*>\s*(\d+)\s*</gi)]
    const pageContainers = [...before.matchAll(/class=["'][^"']*\bpage-body-container\b[^"']*["']/gi)]
    const explicitPage = Number(pageNumberMatches.at(-1)?.[1])
    const page = Number.isFinite(explicitPage) ? explicitPage : pageContainers.length || null
    const expanded = expandHtmlTable(match[0])
    const grid = expanded.map(row => Array.from({ length: row.length }, (_, index) => row[index] ?? ''))
    const inferredTitle = inferTableTitle(match[0], grid)
    const ownBasisContext = tableBasisContext(grid, inferredTitle)
    const inheritedBasisContext = ownBasisContext ? null : nearestPriceBasisContext(before)
    const title = [nearestSectionTitle(before), ownBasisContext ?? inheritedBasisContext, inferredTitle]
      .filter(Boolean)
      .join(' | ') || null
    tables.push({ page, tableIndex: tables.length, title, grid })
  }

  for (const table of extractMarkdownTables(markdownHtml, tables.length)) {
    const signature = tableSignature(table.grid)
    if (tables.some(existing => tableSignature(existing.grid) === signature)) continue
    tables.push({ ...table, tableIndex: tables.length })
  }

  return splitEmbeddedSourceTables(removeNearDuplicateTables(tables))
    .map((table, tableIndex) => ({ ...table, tableIndex }))
}

/**
 * Separates a table that is visually overlaid beside another table in the same
 * OCR grid. Dense catalogue pages commonly place a second matrix halfway
 * across the page; OCR then emits its title and rows inside the first matrix.
 * Treating that as one table assigns the right-hand prices to the left-hand
 * headers. The child table keeps its own local title/headers, while its cells
 * are blanked from the parent so a price is never compiled twice.
 */
export function splitEmbeddedSourceTables(tables: SourceTable[]): SourceTable[] {
  const output: SourceTable[] = []
  for (const table of tables) {
    const regions = embeddedSubtableRegions(table.grid)
    if (!regions.length) {
      output.push(table)
      continue
    }

    const parentGrid = table.grid.map(row => [...row])
    const children: SourceTable[] = []
    for (const region of regions) {
      let childGrid = table.grid
        .slice(region.startRow, region.endRow + 1)
        .map(row => row.slice(region.startCol, region.endCol + 1))
        .filter(row => row.some(cell => cell.trim()))
      if (childGrid.length < 3) continue
      const childHasVariantHeaders = childGrid.slice(0, 4)
        .some(row => row.filter(isDimensionVariantHeader).length >= 2)
      const childHasPriceHeaders = childGrid.slice(0, 4)
        .some(row => row.some(cell => /\b(?:rate|price|mrp|amount|cost)\b/i.test(cell)))
      if (!childHasVariantHeaders && !childHasPriceHeaders) {
        const inheritedHeaders = table.grid
          .slice(0, region.startRow)
          .map(row => row.slice(region.startCol, region.endCol + 1))
          .filter(row => row.filter(isDimensionVariantHeader).length >= 2)
          .slice(-2)
        if (inheritedHeaders.length) childGrid = [childGrid[0]!, ...inheritedHeaders, ...childGrid.slice(1)]
      }
      children.push({
        page: table.page,
        tableIndex: table.tableIndex,
        title: [
          region.title,
          concisePriceBasisContext({ ...table, title: region.title, grid: childGrid })
            ?? concisePriceBasisContext(table)
        ].filter(Boolean).join(' | '),
        grid: childGrid
      })
      for (let rowIndex = region.startRow; rowIndex <= region.endRow; rowIndex++) {
        for (let colIndex = region.startCol; colIndex <= region.endCol; colIndex++) {
          if (parentGrid[rowIndex]) parentGrid[rowIndex]![colIndex] = ''
        }
      }
    }

    const nonEmptyParent = parentGrid.filter(row => row.some(cell => cell.trim()))
    if (nonEmptyParent.length >= 2) output.push({ ...table, grid: nonEmptyParent })
    output.push(...children)
  }
  return output
}

function isDimensionVariantHeader(value: string) {
  const text = value.replace(/\s+/g, ' ').trim()
  return /^\(?\d+(?:\.\d+)?(?:\s+\d+\s*\/\s*\d+|\s*\/\s*\d+(?:\.\d+)?)?\s*(?:mm|inch|inches|core|pole|module|way|amp|a|["”])\)?$/i.test(text)
}

function concisePriceBasisContext(table: SourceTable) {
  const values = [table.title ?? '', ...table.grid.slice(0, 8).flat()]
  for (const value of values) {
    const clean = value.replace(/\s+/g, ' ').trim()
    const quantityPrice = clean.match(/\b\d+(?:\.\d+)?\s*(?:mtrs?|meters?|metres?)\.?\s*(?:coil\s*)?price\b/i)
    if (quantityPrice?.[0]) return quantityPrice[0]
    const rate = clean.match(/\b(?:rate|price|mrp)\s+per\s+(?:\d+(?:\.\d+)?\s*)?(?:mtrs?|meters?|metres?|coils?|rolls?|pieces?|pcs?|numbers?|units?|kg)\b/i)
    if (rate?.[0]) return rate[0]
  }
  return null
}

function embeddedSubtableRegions(grid: string[][]) {
  const candidates: Array<{ startRow: number, startCol: number, title: string }> = []
  const strongSection = /\b(?:cables?|wires?|pipes?|fittings?|switches?|sockets?|distribution\s+boards?|junction\s+boxes?|welding|screened|armou?red)\b/i
  const numeric = (value: string) => /^\s*(?:₹|rs\.?|inr)?\s*\d[\d,]*(?:\.\d+)?\s*(?:\/-)?\s*$/i.test(value)

  for (let rowIndex = 0; rowIndex < grid.length; rowIndex++) {
    const row = grid[rowIndex] ?? []
    for (let colIndex = 1; colIndex < row.length; colIndex++) {
      const title = row[colIndex]?.replace(/\s+/g, ' ').trim() ?? ''
      if (title.length < 8 || !strongSection.test(title) || numeric(title)) continue
      // A genuine side-by-side overlay starts after live numeric cells from the
      // neighboring table on the same visual row. Ordinary section labels can
      // also be indented into later columns, but do not have this evidence.
      if (row.slice(0, colIndex).filter(numeric).length < 2) continue
      const headerCells = grid.slice(rowIndex + 1, rowIndex + 4)
        .flatMap(next => next.slice(colIndex))
        .filter(value => /[a-z]/i.test(value) && !numeric(value)).length
      const numericRows = grid.slice(rowIndex + 1)
        .filter(next => next.slice(colIndex).filter(numeric).length >= 2).length
      if (headerCells < 2 || numericRows < 3) continue
      candidates.push({ startRow: rowIndex, startCol: colIndex, title })
    }
  }

  return candidates.map((candidate, index) => {
    const nextRight = candidates
      .filter(other => other.startCol > candidate.startCol)
      .sort((a, b) => a.startCol - b.startCol)[0]
    const nextBelow = candidates
      .filter(other => other.startRow > candidate.startRow && other.startCol <= candidate.startCol)
      .sort((a, b) => a.startRow - b.startRow)[0]
    const naturalEndCol = nextRight?.startCol !== undefined
      ? nextRight.startCol - 1
      : Math.max(candidate.startCol, ...grid.slice(candidate.startRow).map(row => {
          let last = candidate.startCol
          for (let col = candidate.startCol; col < row.length; col++) if (row[col]?.trim()) last = col
          return last
        }))
    const explicitPriceColumns = grid
      .slice(candidate.startRow + 1, candidate.startRow + 4)
      .flatMap(row => row.flatMap((cell, colIndex) =>
        colIndex >= candidate.startCol && /\b(?:rate|price|mrp|amount|cost)\b/i.test(cell)
          ? [colIndex]
          : []))
    const endCol = explicitPriceColumns.length
      ? Math.min(naturalEndCol, Math.max(...explicitPriceColumns))
      : naturalEndCol
    return {
      ...candidate,
      endCol,
      endRow: nextBelow ? nextBelow.startRow - 1 : grid.length - 1,
      index
    }
  })
}

export function findRepeatedSourceBlocks(tables: SourceTable[], minimumRows = 5): RepeatedSourceBlock[] {
  const blocks: RepeatedSourceBlock[] = []
  for (const table of tables) {
    const rows = table.grid.map(row => row
      .map(value => value.replace(/\s+/g, ' ').trim().toLowerCase())
      .join('|'))
    for (let first = 0; first <= rows.length - minimumRows; first++) {
      if (!rows[first]?.replace(/\|/g, '').trim()) continue
      for (let repeated = first + minimumRows; repeated <= rows.length - minimumRows; repeated++) {
        if (rows[first] !== rows[repeated]) continue
        let count = 0
        while (first + count < repeated && repeated + count < rows.length && rows[first + count] === rows[repeated + count]) count += 1
        if (count < minimumRows) continue
        blocks.push({
          source_page: table.page,
          source_table_index: table.tableIndex,
          first_row_index: first,
          repeated_row_index: repeated,
          row_count: count
        })
        first += count - 1
        break
      }
    }
  }
  return blocks
}

/** Detects parser output that ends or breaks part-way through a numeric row. */
export function findTruncatedSourceRows(tables: SourceTable[]): TruncatedSourceRow[] {
  const failures: TruncatedSourceRow[] = []
  for (const table of tables) {
    for (const [rowIndex, row] of table.grid.entries()) {
      const numericCells = row.filter(value => /^\s*(?:₹|rs\.?|inr)?\s*\d[\d,]*(?:\.\d+)?\s*(?:\/-)?\s*$/i.test(value)).length
      if (!numericCells) continue
      const precedingRows = table.grid.slice(Math.max(0, rowIndex - 3), rowIndex)
      const expectedColumns = Math.max(row.length, ...precedingRows.map(value => value.length))
      if (expectedColumns < 3) continue
      // Sparse rows are normally represented with empty cells up to the table
      // width. Compare with the immediate matrix, not the whole HTML block,
      // because parsers sometimes concatenate adjacent tables of different widths.
      if (row.length >= Math.ceil(expectedColumns * 0.6)) continue
      failures.push({
        source_page: table.page,
        source_table_index: table.tableIndex,
        source_row_index: rowIndex,
        expected_columns: expectedColumns,
        actual_columns: row.length
      })
    }
  }
  return failures
}

function comparableDataRow(row: string[]) {
  const values = row.map(value => value.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const numeric = values.filter(value => /^\s*(?:₹|rs\.?|inr)?\s*\d[\d,]*(?:\.\d+)?\s*(?:\/-)?\s*$/i.test(value)).length
  if (numeric < 2) return null
  return values.join('|').toLowerCase()
}

function removeNearDuplicateTables(tables: SourceTable[]) {
  const kept: SourceTable[] = []
  for (const table of tables) {
    const rows = new Set(table.grid.map(comparableDataRow).filter((value): value is string => Boolean(value)))
    const duplicate = kept.some(existing => {
      if (existing.page !== table.page) return false
      const existingRows = new Set(existing.grid.map(comparableDataRow).filter((value): value is string => Boolean(value)))
      const smaller = Math.min(rows.size, existingRows.size)
      if (smaller < 5) return false
      let overlap = 0
      for (const row of rows) if (existingRows.has(row)) overlap += 1
      return overlap / smaller >= 0.8
    })
    if (!duplicate) kept.push(table)
  }
  return kept
}

function extractMarkdownTables(markdown: string, startingIndex: number): SourceTable[] {
  const pages = splitPaginatedMarkdown(markdown)
  const sources = pages.length ? pages : [{ pageNumber: null, markdown }]
  const tables: SourceTable[] = []

  for (const page of sources) {
    const lines = page.markdown.split('\n')
    let section: string | null = null
    let rateContext: string | null = null
    let productContext: string | null = null
    let index = 0
    while (index < lines.length) {
      const line = lines[index]?.trim() ?? ''
      const heading = line.match(/^#{1,6}\s+(.+)$/)?.[1]?.trim()
      if (heading) section = heading

      if (!isMarkdownTableRow(line)) {
        const contextLine = cleanMarkdownContextLine(line)
        if (/\b(?:rate|price|mrp|amount|cost)\b.*\b(?:rs|inr|per)\b|\b(?:rs|inr)\b.*\b(?:rate|price|per)\b/i.test(contextLine)) {
          rateContext = contextLine
        }
        if (contextLine.length >= 20
          && /\b(?:cables?|wires?|pipes?|fittings?|switches?|sockets?|mcb|mccb|rccb|rcbo|isolators?|boxes?|boards?|conduits?|accessories?)\b/i.test(contextLine)
          && !/\b(?:price list|rate list|contact|marketing department|gst|tax|freight)\b/i.test(contextLine)) {
          productContext = contextLine
        }
      }

      const separator = lines[index + 1]?.trim() ?? ''
      if (!isMarkdownTableRow(line) || !isMarkdownSeparatorRow(separator)) {
        index += 1
        continue
      }

      const grid = [parseMarkdownRow(line)]
      index += 2
      while (index < lines.length && isMarkdownTableRow(lines[index] ?? '')) {
        const row = parseMarkdownRow(lines[index] ?? '')
        if (row.some(Boolean)) grid.push(row)
        index += 1
      }
      if (grid.length < 2) continue
      tables.push({
        page: page.pageNumber,
        tableIndex: startingIndex + tables.length,
        title: [section, productContext, rateContext, grid[0]?.filter(Boolean).join(' | ')]
          .filter(Boolean)
          .join(' | ') || null,
        grid
      })
    }
  }
  return tables
}

function cleanMarkdownContextLine(value: string) {
  return value
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]+/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isMarkdownTableRow(value: string) {
  const line = value.trim()
  return line.includes('|') && !/^\s*<\/?(?:table|tr|td|th)\b/i.test(line)
}

function isMarkdownSeparatorRow(value: string) {
  const cells = parseMarkdownRow(value)
  // Chandra occasionally emits two dashes for very narrow OCR columns. It is
  // still an unambiguous separator when every cell on the line is dashes.
  return cells.length > 0 && cells.every(cell => /^:?-{2,}:?$/.test(cell.replace(/\s+/g, '')))
}

function parseMarkdownRow(value: string) {
  return value.trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell
      .replace(/<br\s*\/?\s*>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\\\|/g, '|')
      .replace(/\s+/g, ' ')
      .trim())
}

function tableSignature(grid: string[][]) {
  return grid.slice(0, 8).map(row => row.join('|')).join('\n').toLowerCase().replace(/\s+/g, ' ').slice(0, 4000)
}

function nearestSectionTitle(before: string) {
  const tail = before.slice(-8000)
  const candidates = [
    ...[...tail.matchAll(/^#{1,6}\s+(.+)$/gm)].map(match => ({ index: match.index ?? 0, value: match[1] })),
    ...[...tail.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)].map(match => ({ index: match.index ?? 0, value: match[1] })),
    ...[...tail.matchAll(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/gi)].map(match => ({ index: match.index ?? 0, value: match[1] })),
    ...[...tail.matchAll(/<[^>]+class=["'][^"']*image-caption[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/gi)].map(match => ({ index: match.index ?? 0, value: match[1] }))
  ]
    .map(item => ({ ...item, value: item.value?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }))
    .filter((item): item is { index: number, value: string } => Boolean(item.value && item.value.length < 500))
    .sort((a, b) => a.index - b.index)
  return candidates.at(-1)?.value ?? null
}

function tableBasisContext(grid: string[][], title: string | null) {
  const candidates = [title ?? '', ...grid.slice(0, 6).flat()]
    .map(value => value.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  return candidates.find(isPriceBasisContext)
    ?? candidates.find(value => /\b\d+(?:\.\d+)?\s*(?:mtrs?|meters?|metres?)\b.*\b(?:length|coil|roll|packing|pack)\b/i.test(value))
    ?? null
}

function nearestPriceBasisContext(before: string) {
  const pageMarkers = [...before.matchAll(/class=["'][^"']*\bpage-number\b[^"']*["']/gi)]
  const pageStart = pageMarkers.at(-1)?.index ?? Math.max(0, before.length - 30000)
  const scope = before.slice(pageStart)
  const $ = loadHtml(scope)
  const candidates = $('th, td, p, figcaption, h1, h2, h3, h4, h5, h6')
    .toArray()
    .map(element => $(element).text().replace(/\s+/g, ' ').trim())
    .filter(value => value.length > 0 && value.length < 300 && isPriceBasisContext(value))
  return candidates.at(-1) ?? null
}

function isPriceBasisContext(value: string) {
  const text = value
    .replace(/(\d)(rate|price|mrp)/gi, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
  if (!/\b(?:rate|price|mrp|m\.?\s*r\.?\s*p\.?|unit\s+sale|maximum\s+retail)\b/i.test(text)) return false
  return /\bper\s+(?:\d+(?:\.\d+)?\s*)?(?:mtrs?|meters?|metres?|coils?|rolls?|pieces?|pcs?|numbers?|units?|sets?|pairs?|kg|litres?)\b/i.test(text)
    || /\b\d+(?:\.\d+)?\s*(?:mtrs?|meters?|metres?)\b.*\b(?:coil\s+)?price\b/i.test(text)
}

function inferTableTitle(html: string, grid: string[][]) {
  const $ = loadHtml(html)
  const caption = $('caption').first().text().replace(/\s+/g, ' ').trim()
  if (caption) return caption

  const firstTextRow = grid.find(row => row.some(cell => /[a-z]/i.test(cell)))
  const title = firstTextRow?.filter(Boolean).join(' | ').replace(/\s+/g, ' ').trim()
  return title || null
}

export function sourceExcerpt(grid: string[][], rowIndex: number, radius = 1) {
  return grid
    .slice(Math.max(0, rowIndex - radius), Math.min(grid.length, rowIndex + radius + 1))
    .map((row, offset) => {
      const actualRow = Math.max(0, rowIndex - radius) + offset
      return `row ${actualRow}: ${row.map((cell, col) => `[${col}] ${cell}`).join(' | ')}`
    })
    .join('\n')
    .slice(0, 4000)
}
