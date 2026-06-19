#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import { createJiti } from 'jiti'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
  }
}

const documentId = process.argv[2] ?? process.env.SEARCH_EVAL_DOCUMENT_ID
assert(documentId, 'Usage: node scripts/backfill-canonical-doc.mjs <document-id>')

const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NUXT_SUPABASE_SERVICE_ROLE_KEY
assert(supabaseUrl, 'SUPABASE_URL is required')
assert(serviceRoleKey, 'SUPABASE_SERVICE_ROLE_KEY is required')

const jiti = createJiti(import.meta.url, { interopDefault: true })
const { expandHtmlTable, canonicalizeGridTable, canonicalizeExtractedRows } = await jiti.import('../server/utils/extraction/canonicalizeTable.ts')
const { priceCellToRecord } = await jiti.import('../server/utils/extraction/priceCellRecords.ts')
const supabase = createClient(supabaseUrl, serviceRoleKey)

const { data: doc, error: docError } = await supabase
  .from('documents')
  .select('id, owner_id, vendor_id, filename, parsed_markdown, created_at, vendor:vendor_id(name)')
  .eq('id', documentId)
  .single()
if (docError || !doc) throw docError ?? new Error('Document not found')
const htmlTables = doc.parsed_markdown ? extractTables(doc.parsed_markdown) : []
const tables = htmlTables.map((table, index) => {
  const grid = expandHtmlTable(table.html)
  const title = grid.flat().find(Boolean) ?? doc.filename
  return canonicalizeGridTable({
    grid,
    sourcePage: table.page,
    tableIndex: index,
    tableTitle: title,
    sectionBreadcrumb: [doc.vendor?.name, doc.filename, title].filter(Boolean),
    parserName: 'parsed-html-backfill',
    parserConfidence: 0.78
  })
})

const legacyRows = await loadLegacyRows(documentId)
const extractedPriceRecordCount = countPriceRecords(tables)
if ((!tables.length || extractedPriceRecordCount === 0) && legacyRows.length) {
  tables.length = 0
  tables.push(...canonicalizeExtractedRows({
    rows: legacyRows,
    documentTitle: doc.filename,
    vendorName: doc.vendor?.name,
    parserName: 'legacy-doc-items-backfill',
    parserConfidence: 0.72,
    ocrConfidence: null
  }))
} else if (process.env.BACKFILL_INCLUDE_LEGACY_SUPPLEMENT === '1' || shouldUseGuardedLegacySupplement(doc, legacyRows, extractedPriceRecordCount)) {
  const supplementalRows = legacyRowsForSupplement(legacyRows)
  if (supplementalRows.length) {
    tables.push(...canonicalizeExtractedRows({
      rows: supplementalRows,
      documentTitle: doc.filename,
      vendorName: doc.vendor?.name,
      parserName: 'legacy-doc-items-supplement',
      parserConfidence: 0.68,
      ocrConfidence: null
    }))
  }
}

if (!tables.length) {
  console.log(JSON.stringify({
    document_id: documentId,
    filename: doc.filename,
    tables: 0,
    cells: 0,
    price_items: 0,
    skipped: 'No HTML tables or legacy priced doc_items were available to backfill.'
  }, null, 2))
  process.exit(0)
}

await deleteRowsByDocument('doc_price_items', documentId)
await deleteRowsByDocument('doc_table_cells', documentId)
await deleteRowsByDocument('doc_tables', documentId)

let insertedTables = 0
let insertedCells = 0
let insertedPrices = 0
const legacyRowsByPage = groupLegacyRowsByPage(legacyRows)

for (const table of tables) {
  const { data: tableRow, error: tableError } = await supabase
    .from('doc_tables')
    .insert({
      tenant_id: doc.owner_id,
      document_id: doc.id,
      vendor_id: doc.vendor_id,
      source_page: table.source_page,
      table_index: table.table_index,
      table_title: table.table_title,
      section_breadcrumb: table.section_breadcrumb,
      parser_name: table.parser_name,
      parser_confidence: table.parser_confidence,
      ocr_confidence: table.ocr_confidence
    })
    .select('id')
    .single()
  if (tableError || !tableRow) throw tableError ?? new Error('Could not insert table')
  insertedTables += 1

  const cellRows = table.cells.map(cell => ({
    tenant_id: doc.owner_id,
    document_id: doc.id,
    vendor_id: doc.vendor_id,
    source_table_id: tableRow.id,
    source_page: cell.source_page,
    source_row_index: cell.source_row_index,
    source_col_index: cell.source_col_index,
    source_rowspan: cell.source_rowspan,
    source_colspan: cell.source_colspan,
    is_header: cell.is_header,
    is_price: cell.is_price,
    row_headers: cell.row_headers,
    column_headers: cell.column_headers,
    parent_headers: cell.parent_headers,
    merged_headers: cell.merged_headers,
    raw_cell_value: cell.raw_cell_value,
    normalized_value: cell.normalized_value,
    unit: cell.unit,
    currency: cell.currency,
    moq: cell.moq,
    footnotes: cell.footnotes,
    nearby_notes: cell.nearby_notes,
    bbox: cell.bbox,
    parser_confidence: cell.parser_confidence,
    ocr_confidence: cell.ocr_confidence
  }))

  const { data: cells, error: cellError } = await supabase
    .from('doc_table_cells')
    .insert(cellRows)
    .select('id, source_row_index, source_col_index')
  if (cellError) throw cellError
  insertedCells += cells?.length ?? 0

  const cellIdByPosition = new Map((cells ?? []).map(cell => [`${cell.source_row_index}:${cell.source_col_index}`, cell.id]))
  const tableLegacyRows = legacyRowsByPage.get(table.source_page ?? null) ?? []
  const priceRows = table.cells.flatMap(cell => {
    if (!cell.is_price) return []
    const legacyId = tableLegacyRows[cell.source_row_index - 1]?.id ?? null
    const record = priceCellToRecord({
      tenant_id: doc.owner_id,
      document_id: doc.id,
      vendor_id: doc.vendor_id,
      vendor_name: doc.vendor?.name,
      document_title: doc.filename,
      source_uploaded_at: doc.created_at,
      legacy_doc_item_id: legacyId ?? null,
      source_table_id: tableRow.id,
      source_cell_id: cellIdByPosition.get(`${cell.source_row_index}:${cell.source_col_index}`) ?? null,
      table,
      cell
    })
    return record ? [record] : []
  })

  if (priceRows.length) {
    const { error: priceError } = await supabase.from('doc_price_items').insert(priceRows)
    if (priceError) throw priceError
    insertedPrices += priceRows.length
  }
}

console.log(JSON.stringify({
  document_id: documentId,
  filename: doc.filename,
  tables: insertedTables,
  cells: insertedCells,
  price_items: insertedPrices
}, null, 2))

function extractTables(markdownHtml) {
  const tables = []
  const tableRe = /<table[\s\S]*?<\/table>/gi
  let match
  while ((match = tableRe.exec(markdownHtml))) {
    const start = match.index
    const before = markdownHtml.slice(Math.max(0, start - 5000), start)
    const pageMatches = [...before.matchAll(/class="page-number"[^>]*>\s*(\d+)\s*</gi)]
    const fullBefore = markdownHtml.slice(0, start)
    const pageContainerMatches = [...fullBefore.matchAll(/class=["'][^"']*\bpage-body-container\b[^"']*["']/gi)]
    const page = pageMatches.length ? Number(pageMatches.at(-1)?.[1]) : pageContainerMatches.length || null
    tables.push({ html: match[0], page: Number.isFinite(page) ? page : null })
  }
  return tables
}

async function loadLegacyRows(documentId) {
  const { data, error } = await supabase
    .from('doc_items')
    .select('id, raw_name, sku, unit, price, moq, currency, source_page')
    .eq('document_id', documentId)
    .not('price', 'is', null)
    .order('source_page', { ascending: true, nullsFirst: false })
    .order('raw_name', { ascending: true })
  if (error) throw error
  return (data ?? []).map(row => ({
    id: row.id,
    raw_name: row.raw_name,
    sku: row.sku,
    unit: row.unit,
    price: row.price === null ? null : Number(row.price),
    moq: row.moq,
    currency: row.currency ?? 'INR',
    source_page: row.source_page
  }))
}

function groupLegacyRowsByPage(rows) {
  const grouped = new Map()
  for (const row of rows) {
    const key = row.source_page ?? null
    grouped.set(key, [...(grouped.get(key) ?? []), row])
  }
  return grouped
}

function legacyRowsForSupplement(rows) {
  const priceSetsByIdentity = new Map()
  for (const row of rows) {
    const key = legacyIdentityKey(row)
    if (!key) continue
    priceSetsByIdentity.set(key, priceSetsByIdentity.get(key) ?? new Set())
    priceSetsByIdentity.get(key).add(Number(row.price))
  }

  return rows.filter(row => {
    const price = Number(row.price)
    if (!Number.isFinite(price) || price <= 0 || price > 10_000_000) return false

    const name = String(row.raw_name ?? '').trim()
    if (name.length < 3) return false
    if (/^(?:sr\.?\s*no|s\.?\s*no|page|phone|mobile|tel|contact)\b/i.test(name)) return false

    const unit = String(row.unit ?? '').trim()
    if (/^per\s+\d{2,}/i.test(unit)) return false
    if (/^\d{6,}$/.test(String(row.sku ?? '').trim())) return false

    const key = legacyIdentityKey(row)
    const sameIdentityPrices = key ? priceSetsByIdentity.get(key) : null
    const hasSizeToken = /\b\d+(?:\.\d+)?\s*(?:sq\.?\s*mm|sqmm|mm)\b/i.test(`${name} ${row.sku ?? ''}`)
    if (sameIdentityPrices && sameIdentityPrices.size > 1 && !hasSizeToken) return false

    return true
  })
}

function shouldUseGuardedLegacySupplement(doc, rows, extractedPriceRecordCount) {
  if (!rows.length) return false
  const label = `${doc.vendor?.name ?? ''} ${doc.filename ?? ''}`.toLowerCase()
  if (label.includes('precision')) return false
  if (label.includes('hills')) return false

  const cleanRows = legacyRowsForSupplement(rows)
  if (!cleanRows.length) return false
  if (/(?:legrand)/i.test(label) && extractedPriceRecordCount < rows.length) return true

  return extractedPriceRecordCount < 10
    && rows.length <= 50
    && cleanRows.length >= Math.max(1, rows.length * 0.7)
}

function legacyIdentityKey(row) {
  const value = `${row.raw_name ?? ''} ${row.sku ?? ''} ${row.unit ?? ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
  return value || null
}

async function checked(query, action) {
  const { error } = await query
  if (!error) return
  if (/schema cache|Could not find the table|Could not find the function/i.test(error.message ?? '')) {
    throw new Error(`${action} failed because Supabase PostgREST has not reloaded the schema cache. Run: notify pgrst, 'reload schema';`)
  }
  throw error
}

function countPriceRecords(tables) {
  let count = 0
  for (const table of tables) {
    for (const cell of table.cells) {
      if (!cell.is_price) continue
      const record = priceCellToRecord({
        tenant_id: doc.owner_id,
        document_id: doc.id,
        vendor_id: doc.vendor_id,
        vendor_name: doc.vendor?.name,
        document_title: doc.filename,
        source_uploaded_at: doc.created_at,
        legacy_doc_item_id: null,
        source_table_id: null,
        source_cell_id: null,
        table,
        cell
      })
      if (record) count += 1
    }
  }
  return count
}

async function deleteRowsByDocument(table, documentId) {
  for (;;) {
    const { data, error } = await supabase
      .from(table)
      .select('id')
      .eq('document_id', documentId)
      .limit(500)
    if (error) throw error
    const ids = (data ?? []).map(row => row.id)
    if (!ids.length) return

    await checked(
      supabase.from(table).delete().in('id', ids),
      `delete ${table}`
    )
  }
}
