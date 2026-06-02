/**
 * Regex-only fallback extractor for Chandra markdown.
 * Used only when Datalab structured extraction returns nothing or fails.
 *
 * Walks each pipe-table in the markdown, matches headers against synonym
 * lists, and emits PriceRow records that survive a Zod check.
 */
import { PriceRow, type PriceRow as PR } from '~~/shared/schemas'

interface MdTable { header: string[]; rows: string[][] }

const NAME_SYNS  = ['product', 'item', 'description', 'particulars', 'name', 'material']
const SKU_SYNS   = ['sku', 'code', 'item code', 'product code', 'part', 'model', 'cat', 'hsn']
const UNIT_SYNS  = ['unit', 'uom', 'units']
const PRICE_SYNS = ['price', 'rate', 'mrp', 'amount', 'cost', 'list price', 'dealer price']
const MOQ_SYNS   = ['moq', 'min qty', 'minimum order', 'min order']

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

function splitRow(row: string): string[] {
  return row
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map(c => c.trim())
}

function parseMarkdownTables(markdown: string): MdTable[] {
  const lines = markdown.split('\n')
  const tables: MdTable[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const nextLine = lines[i + 1] ?? ''
    if (line.includes('|') && nextLine.match(/^\s*\|?\s*:?-{3,}/)) {
      const header = splitRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length) {
        const rowLine = lines[i] ?? ''
        if (!rowLine.includes('|') || rowLine.trim() === '') break
        rows.push(splitRow(rowLine))
        i++
      }
      if (header.length >= 2 && rows.length > 0) tables.push({ header, rows })
    } else {
      i++
    }
  }
  return tables
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
    const moqIdx   = matchColumn(t.header, MOQ_SYNS)
    if (nameIdx === -1 || priceIdx === -1) continue

    for (const row of t.rows) {
      const raw_name = row[nameIdx]?.trim()
      if (!raw_name || raw_name.toLowerCase().startsWith('total')) continue
      const candidate: PR = {
        raw_name,
        sku:   skuIdx  >= 0 ? row[skuIdx]?.trim() || null : null,
        unit:  unitIdx >= 0 ? row[unitIdx]?.trim() || null : null,
        price: parseNumber(row[priceIdx]),
        moq:   moqIdx  >= 0 ? row[moqIdx]?.trim() || null : null,
        currency: 'INR'
      }
      const parsed = PriceRow.safeParse(candidate)
      if (parsed.success && (parsed.data.price ?? parsed.data.sku)) out.push(parsed.data)
    }
  }
  return out
}
