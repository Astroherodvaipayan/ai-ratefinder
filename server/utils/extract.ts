/**
 * Parse Chandra markdown tables into structured PriceRow / BoqLine records.
 *
 * Chandra returns clean GitHub-flavoured markdown for tabular content. We:
 *   1. Walk the markdown, collect every pipe-table.
 *   2. Header-match against synonym lists to label each column.
 *   3. Emit typed rows; reject rows that are obviously not data (headers, totals).
 */

import { PriceRow, BoqLine, type PriceRow as PR, type BoqLine as BL } from '~~/shared/schemas'

interface MdTable { header: string[]; rows: string[][] }

const NAME_SYNS   = ['product', 'item', 'description', 'particulars', 'name', 'material']
const SKU_SYNS    = ['sku', 'code', 'item code', 'product code', 'part', 'model', 'cat', 'hsn']
const UNIT_SYNS   = ['unit', 'uom', 'units']
const PRICE_SYNS  = ['price', 'rate', 'mrp', 'amount', 'cost', 'list price', 'dealer price']
const QTY_SYNS    = ['qty', 'quantity', 'nos']

function normaliseHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function matchColumn(headers: string[], syns: string[]): number {
  const normalised = headers.map(normaliseHeader)
  for (let i = 0; i < normalised.length; i++) {
    if (syns.some(s => normalised[i] === s)) return i
  }
  for (let i = 0; i < normalised.length; i++) {
    if (syns.some(s => normalised[i].includes(s))) return i
  }
  return -1
}

function parseMarkdownTables(markdown: string): MdTable[] {
  const lines = markdown.split('\n')
  const tables: MdTable[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.includes('|') && lines[i + 1]?.match(/^\s*\|?\s*:?-{3,}/)) {
      const header = splitRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]))
        i++
      }
      if (header.length >= 2 && rows.length > 0) tables.push({ header, rows })
    } else {
      i++
    }
  }
  return tables
}

function splitRow(row: string): string[] {
  return row
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map(c => c.trim())
}

function parseNumber(v: string | undefined): number | null {
  if (!v) return null
  const cleaned = v.replace(/[₹$€,\s]/g, '').replace(/[^\d.\-]/g, '')
  if (!cleaned) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

export function extractPriceRows(markdown: string): PR[] {
  const out: PR[] = []
  for (const t of parseMarkdownTables(markdown)) {
    const nameIdx  = matchColumn(t.header, NAME_SYNS)
    const skuIdx   = matchColumn(t.header, SKU_SYNS)
    const unitIdx  = matchColumn(t.header, UNIT_SYNS)
    const priceIdx = matchColumn(t.header, PRICE_SYNS)
    if (nameIdx === -1 || priceIdx === -1) continue

    for (const row of t.rows) {
      const raw_name = row[nameIdx]?.trim()
      if (!raw_name || raw_name.toLowerCase().startsWith('total')) continue
      const candidate: PR = {
        raw_name,
        sku:   skuIdx  >= 0 ? row[skuIdx]?.trim() || null : null,
        unit:  unitIdx >= 0 ? row[unitIdx]?.trim() || null : null,
        price: parseNumber(row[priceIdx]),
        currency: 'INR',
        raw_row: Object.fromEntries(t.header.map((h, i) => [h, row[i] ?? '']))
      }
      const parsed = PriceRow.safeParse(candidate)
      if (parsed.success && (parsed.data.price ?? parsed.data.sku)) out.push(parsed.data)
    }
  }
  return out
}

export function extractBoqLines(markdown: string): BL[] {
  const out: BL[] = []
  let lineCounter = 0
  for (const t of parseMarkdownTables(markdown)) {
    const descIdx = matchColumn(t.header, NAME_SYNS)
    const qtyIdx  = matchColumn(t.header, QTY_SYNS)
    const unitIdx = matchColumn(t.header, UNIT_SYNS)
    if (descIdx === -1) continue
    for (const row of t.rows) {
      const description = row[descIdx]?.trim()
      if (!description) continue
      lineCounter++
      const candidate: BL = {
        line_no: lineCounter,
        description,
        qty:  qtyIdx  >= 0 ? parseNumber(row[qtyIdx]) : null,
        unit: unitIdx >= 0 ? row[unitIdx]?.trim() || null : null,
        remarks: null
      }
      const parsed = BoqLine.safeParse(candidate)
      if (parsed.success) out.push(parsed.data)
    }
  }
  return out
}
