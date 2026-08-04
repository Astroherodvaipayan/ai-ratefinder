#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import { createJiti } from 'jiti'
import { $fetch } from 'ofetch'
import { PDFDocument } from 'pdf-lib'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import Module from 'node:module'
import { resolve } from 'node:path'

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
  }
}

const documentId = process.argv.slice(2).find(arg => !arg.startsWith('--'))
if (!documentId) throw new Error('Usage: node scripts/reparse-doc-chandra-chunks.mjs <document-id>')

const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NUXT_SUPABASE_SERVICE_ROLE_KEY
const datalabKey = process.env.NUXT_DATALAB_API_KEY ?? process.env.DATALAB_API_KEY
if (!supabaseUrl) throw new Error('SUPABASE_URL is required')
if (!serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
if (!datalabKey) throw new Error('NUXT_DATALAB_API_KEY or DATALAB_API_KEY is required')

globalThis.$fetch = $fetch
globalThis.useRuntimeConfig = () => ({ datalabApiKey: datalabKey })
globalThis.createError = ({ statusCode, statusMessage }) =>
  Object.assign(new Error(statusMessage), { statusCode, statusMessage })

registerNuxtAliases()
const supabase = createClient(supabaseUrl, serviceRoleKey)
const jiti = createJiti(import.meta.url, { interopDefault: true })
const { runChandra, runDatalabExtract } = await jiti.import('../server/utils/chandra.ts')
const { PRICE_ROW_SCHEMA, parseDatalabRows } = await jiti.import('../server/utils/priceExtraction.ts')
const { extractPriceRows } = await jiti.import('../server/utils/extract.ts')
const { splitPaginatedMarkdown } = await jiti.import('../server/utils/pricePages.ts')
const { extractSourceTables, findRepeatedSourceBlocks, findTruncatedSourceRows } = await jiti.import('../server/utils/catalog/sourceTables.ts')
const { analyzeSourceTableDeterministically, dedupeDocumentOffers } = await jiti.import('../server/utils/catalog/compiler.ts')

const pagesPerChunk = Math.max(1, Number(process.env.CHANDRA_PAGES_PER_CHUNK || 1))
const chunkDelayMs = Math.max(0, Number(process.env.CHANDRA_CHUNK_DELAY_MS || 1500))
const parserMode = process.env.CHANDRA_MODE || 'accurate'
const candidateOutput = process.env.CHANDRA_CANDIDATE_OUTPUT || ''
const candidateInput = process.env.CHANDRA_CANDIDATE_INPUT || ''
const sourceOutput = process.env.CHANDRA_SOURCE_OUTPUT || ''
const focusedPageRange = process.env.CHANDRA_FOCUSED_PAGE_RANGE || ''
const focusedOutput = process.env.CHANDRA_FOCUSED_OUTPUT || ''
const tilePage = Number(process.env.CHANDRA_TILE_PAGE || 0)
const tileSide = process.env.CHANDRA_TILE_SIDE || 'right'
const tileOutput = process.env.CHANDRA_TILE_OUTPUT || ''
const tileInput = process.env.CHANDRA_TILE_INPUT || ''
const tileMergeTitle = process.env.CHANDRA_TILE_MERGE_TITLE || ''
const dryRun = /^(?:1|true|yes)$/i.test(process.env.CHANDRA_DRY_RUN || '')

const { data: doc, error: docError } = await supabase
  .from('documents')
  .select('id, owner_id, vendor_id, filename, storage_path, mime, parsed_markdown, status, vendor:vendor_id(name)')
  .eq('id', documentId)
  .single()
if (docError || !doc) throw docError ?? new Error('Document not found')
if (!doc.storage_path) throw new Error('Document has no storage_path')

console.log(`Chandra chunk reparse starting: ${doc.filename}`)

const { data: fileData, error: downloadError } = await supabase.storage
  .from('uploads')
  .download(doc.storage_path)
if (downloadError) throw downloadError
const buffer = Buffer.from(await fileData.arrayBuffer())
if (sourceOutput) {
  mkdirSync(sourceOutput.split('/').slice(0, -1).join('/') || '.', { recursive: true })
  writeFileSync(sourceOutput, buffer)
  console.log(`source_pdf=${sourceOutput}`)
}
const pageCount = await pdfPageCount(buffer)
let tiledMarkdownForMerge = ''

if (Number.isInteger(tilePage) && tilePage >= 1 && tilePage <= pageCount) {
  let tiledMarkdown = ''
  if (tileInput) {
    tiledMarkdown = readFileSync(tileInput, 'utf8')
  } else {
    const tiledBuffer = await cropPdfPage(buffer, tilePage, tileSide)
    const tiled = await runChandra(
      new Blob([new Uint8Array(tiledBuffer)], { type: 'application/pdf' }),
      `${doc.filename.replace(/\.pdf$/i, '')}-page-${tilePage}-${tileSide}.pdf`,
      {
        outputFormat: 'markdown',
        mode: 'accurate',
        paginate: true,
        forceOcr: true,
        disableImageExtraction: true,
        disableImageCaptions: true
      }
    )
    tiledMarkdown = tiled.result.markdown ?? ''
  }
  tiledMarkdownForMerge = tiledMarkdown
  if (tileOutput) {
    mkdirSync(tileOutput.split('/').slice(0, -1).join('/') || '.', { recursive: true })
    writeFileSync(tileOutput, tiledMarkdown)
  }
  console.log(`tile_page=${tilePage} tile_side=${tileSide} tile_markdown_chars=${tiledMarkdown.length}${tileInput ? ` tile_input=${tileInput}` : ''}${tileOutput ? ` tile_output=${tileOutput}` : ''}`)
}

if (focusedPageRange) {
  const focused = await runDatalabExtract({
    pageSchema: PRICE_ROW_SCHEMA,
    file: new Blob([new Uint8Array(buffer)], { type: doc.mime || 'application/pdf' }),
    filename: doc.filename,
    mode: 'accurate',
    outputFormat: 'markdown',
    pageRange: focusedPageRange
  })
  const focusedRows = parseDatalabRows(focused.result)
  if (focusedOutput) {
    mkdirSync(focusedOutput.split('/').slice(0, -1).join('/') || '.', { recursive: true })
    writeFileSync(focusedOutput, JSON.stringify({
      request_id: focused.requestId,
      page_range: focusedPageRange,
      extraction_score_average: focused.result.extraction_score_average ?? null,
      rows: focusedRows
    }, null, 2))
  }
  console.log(`focused_page_range=${focusedPageRange} focused_rows=${focusedRows.length}${focusedOutput ? ` focused_output=${focusedOutput}` : ''}`)
}
const chunks = Array.from({ length: Math.ceil(pageCount / pagesPerChunk) }, (_, index) => {
  const start = index * pagesPerChunk + 1
  const end = Math.min(start + pagesPerChunk - 1, pageCount)
  return { start, end }
})

console.log(`pages=${pageCount} chunks=${chunks.length} pages_per_chunk=${pagesPerChunk}`)

const markdownParts = []
const requestIds = []
const rows = []

if (candidateInput) {
  const reviewedMarkdown = readFileSync(candidateInput, 'utf8')
  markdownParts.push(reviewedMarkdown)
  rows.push(...rowsFromMarkdown(reviewedMarkdown, 1, pageCount))
  requestIds.push('reviewed-candidate')
  console.log(`candidate_input=${candidateInput} markdown_chars=${reviewedMarkdown.length}`)
} else {
  for (const [index, chunk] of chunks.entries()) {
    const zeroBasedRange = chunk.start === chunk.end
      ? String(chunk.start - 1)
      : `${chunk.start - 1}-${chunk.end - 1}`
    console.log(`[${index + 1}/${chunks.length}] Chandra pages ${chunk.start}-${chunk.end}`)
    const result = await runChandra(
      new Blob([new Uint8Array(buffer)], { type: doc.mime || 'application/pdf' }),
      doc.filename,
      {
        outputFormat: 'markdown',
        mode: parserMode,
        paginate: true,
        forceOcr: true,
        disableImageExtraction: true,
        disableImageCaptions: true,
        pageRange: zeroBasedRange
      }
    )
    requestIds.push(result.requestId)
    const chunkMarkdown = result.result.markdown ?? ''
    markdownParts.push(remapChunkMarkdownPages(chunkMarkdown, chunk.start))
    const chunkRows = rowsFromMarkdown(chunkMarkdown, chunk.start, chunk.end)
    rows.push(...chunkRows)
    console.log(`[${index + 1}/${chunks.length}] rows=${chunkRows.length} markdown_chars=${chunkMarkdown.length}`)
    if (chunkDelayMs) await new Promise(resolve => setTimeout(resolve, chunkDelayMs))
  }
}

let markdown = markdownParts.filter(Boolean).join('\n\n')
if (tileMergeTitle && tiledMarkdownForMerge) {
  const titleNeedle = tileMergeTitle.toLowerCase()
  const baseMatch = extractSourceTables(markdown)
    .find(table => table.page === tilePage && table.title?.toLowerCase().includes(titleNeedle))
  const tiledMatch = extractSourceTables(tiledMarkdownForMerge)
    .find(table => table.title?.toLowerCase().includes(titleNeedle))
  if (!tiledMatch) throw new Error(`Tiled OCR did not contain requested table title: ${tileMergeTitle}`)
  const supplement = serializeSourceTable({
    ...tiledMatch,
    page: tilePage,
    title: baseMatch?.title ?? tiledMatch.title
  })
  markdown = `${markdown}\n\n${supplement}`
  console.log(`tile_merged_title=${tileMergeTitle} tile_merged_rows=${tiledMatch.grid.length}`)
}
const dedupedRows = dedupeRows(rows)
console.log(`Chandra chunks complete: rows=${dedupedRows.length} markdown_chars=${markdown.length}`)
if (candidateOutput) {
  mkdirSync(candidateOutput.split('/').slice(0, -1).join('/') || '.', { recursive: true })
  writeFileSync(candidateOutput, markdown)
  console.log(`candidate_markdown=${candidateOutput}`)
}

const candidate = compileCandidate(markdown)
const baseline = compileCandidate(doc.parsed_markdown ?? '')
const persistedRows = rowsFromCompiledOffers(candidate.offers)
const candidateFailures = []
if (!candidate.tables.length) candidateFailures.push('no_source_tables')
if (candidate.repeatedBlocks.length) candidateFailures.push(`repeated_source_blocks:${candidate.repeatedBlocks.length}`)
if (candidate.truncatedRows.length) candidateFailures.push(`truncated_source_rows:${candidate.truncatedRows.length}`)
if (candidate.quarantined > 0) candidateFailures.push(`quarantined_offers:${candidate.quarantined}`)
if (candidate.pagesCovered < baseline.pagesCovered) {
  candidateFailures.push(`source_page_coverage_regression:${baseline.pagesCovered}->${candidate.pagesCovered}`)
}
if (baseline.published > 0 && candidate.published < Math.floor(baseline.published * 0.9)) {
  candidateFailures.push(`published_offer_regression:${baseline.published}->${candidate.published}`)
}
if (candidate.unresolvedCommercialTables.length) {
  candidateFailures.push(`commercial_tables_without_prices:${candidate.unresolvedCommercialTables.join(',')}`)
}
console.log(JSON.stringify({
  parser_quality_gate: candidateFailures.length === 0,
  baseline_published: baseline.published,
  candidate_published: candidate.published,
  candidate_quarantined: candidate.quarantined,
  candidate_tables: candidate.tables.length,
  baseline_pages_covered: baseline.pagesCovered,
  candidate_pages_covered: candidate.pagesCovered,
  baseline_table_pages_covered: baseline.tablePagesCovered,
  candidate_table_pages_covered: candidate.tablePagesCovered,
  candidate_failures: candidateFailures
}, null, 2))
if (candidateFailures.length) {
  throw new Error(`Candidate parse rejected; existing document data was preserved. ${candidateFailures.join('; ')}`)
}

if (dryRun) {
  console.log('dry_run=true; candidate passed parser gates and existing document data was preserved')
  process.exit(0)
}

await deleteExistingRows(documentId)
await supabase
  .from('documents')
  .update({
    status: 'extracting',
    error: null,
    parsed_markdown: markdown,
    page_count: pageCount,
    chandra_request_id: `chandra-chunks:${requestIds.join(',')}`,
    updated_at: new Date().toISOString()
  })
  .eq('id', documentId)
  .throwOnError()

await insertDocItems(doc, persistedRows)
await runBackfill(documentId)
await setDocumentStatus(documentId, 'parsed', persistedRows.length ? null : 'Chandra OCR completed, but no deterministic price rows were extracted.')

console.log(JSON.stringify({
  document_id: documentId,
  filename: doc.filename,
  pages: pageCount,
  rows: persistedRows.length
}, null, 2))

function compileCandidate(candidateMarkdown) {
  const tables = extractSourceTables(candidateMarkdown)
  const parsedPages = splitPaginatedMarkdown(candidateMarkdown)
  const results = tables.map(table => analyzeSourceTableDeterministically({
    table,
    documentName: doc.filename,
    vendorName: doc.vendor?.name ?? null
  }))
  const pricedTableFamilies = new Set(results
    .filter(result => result.audit.selected_price_cells > 0)
    .map(result => tableFamilyKey(tables[result.audit.source_table_index]?.title)))
  const offers = dedupeDocumentOffers(results.flatMap(result => result.offers))
  return {
    tables,
    offers,
    repeatedBlocks: findRepeatedSourceBlocks(tables),
    truncatedRows: findTruncatedSourceRows(tables),
    published: offers.filter(offer => !offer.validation_errors.length).length,
    quarantined: offers.filter(offer => offer.validation_errors.length).length,
    // A cover, terms page, or image-only page is still parsed even though it
    // should not manufacture a SourceTable. Keep document coverage separate
    // from the number of pages that contain commercial tables.
    pagesCovered: new Set(parsedPages.map(page => page.pageNumber)).size,
    tablePagesCovered: new Set(tables.map(table => table.page).filter(page => page !== null)).size,
    unresolvedCommercialTables: results
      .filter(result => result.audit.commercial
        && result.audit.numeric_cells > 0
        && result.audit.selected_price_cells === 0
        && !pricedTableFamilies.has(tableFamilyKey(tables[result.audit.source_table_index]?.title))
        && result.audit.decisions.some(decision => decision.reason === 'insufficient_price_context'))
      .map(result => result.audit.source_table_index)
  }
}

function tableFamilyKey(title) {
  return String(title ?? '')
    .split('|')[0]
    .replace(/[*_`<>]/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase()
}

function rowsFromCompiledOffers(offers) {
  return dedupeRows(offers
    .filter(offer => !offer.validation_errors.length)
    .map(offer => ({
      raw_name: offer.canonical_name,
      sku: offer.sku,
      unit: offer.basis_quantity === 1
        ? offer.basis_unit
        : `${offer.basis_quantity} ${offer.basis_unit}`,
      price: offer.amount,
      moq: offer.moq,
      currency: offer.currency,
      source_page: offer.source_page
    })))
}

function remapChunkMarkdownPages(markdown, startPage) {
  const marker = /(^|\n{2})\{(\d+)\}(-{48}\n{2})/g
  const matches = [...markdown.matchAll(marker)]
  if (!matches.length) {
    return markdown.trim() ? `{${startPage}}${'-'.repeat(48)}\n\n${markdown}` : ''
  }
  const labels = [...new Set(matches.map(match => match[2]))]
  const remapped = new Map(labels.map((label, index) => [label, startPage + index]))
  return markdown.replace(marker, (_match, prefix, label, suffix) => `${prefix}{${remapped.get(label) ?? startPage}}${suffix}`)
}

function serializeSourceTable(table) {
  const escapeCell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
  const width = Math.max(1, ...table.grid.map(row => row.length))
  const rows = table.grid.map(row => Array.from({ length: width }, (_, index) => escapeCell(row[index])))
  const header = rows[0] ?? Array(width).fill('')
  const body = rows.slice(1)
  return [
    `{${table.page ?? 1}}${'-'.repeat(48)}`,
    '',
    table.title ? `## ${table.title}` : '',
    `| ${header.join(' | ')} |`,
    `| ${Array(width).fill('---').join(' | ')} |`,
    ...body.map(row => `| ${row.join(' | ')} |`)
  ].filter((line, index, values) => line || (index > 0 && values[index - 1])).join('\n')
}

async function pdfPageCount(buffer) {
  const pdf = await PDFDocument.load(buffer, { ignoreEncryption: true })
  return pdf.getPageCount()
}

async function cropPdfPage(buffer, pageNumber, side) {
  const source = await PDFDocument.load(buffer, { ignoreEncryption: true })
  const output = await PDFDocument.create()
  const [page] = await output.copyPages(source, [pageNumber - 1])
  output.addPage(page)
  const { width, height } = page.getSize()
  const overlap = 0.08
  if (side === 'left') page.setCropBox(0, 0, width * (0.5 + overlap), height)
  else page.setCropBox(width * (0.5 - overlap), 0, width * (0.5 + overlap), height)
  return Buffer.from(await output.save())
}

function rowsFromMarkdown(markdown, chunkStart, chunkEnd) {
  const pages = splitPaginatedMarkdown(markdown)
  if (pages.length) {
    return pages.flatMap((page, index) => {
      const inferredPage = page.pageNumber >= chunkStart && page.pageNumber <= chunkEnd
        ? page.pageNumber
        : chunkStart + index
      return extractPriceRows(page.markdown).map(row => ({
        raw_name: row.raw_name,
        sku: row.sku,
        unit: row.unit,
        price: row.price,
        moq: row.moq,
        currency: 'INR',
        source_page: row.source_page ?? inferredPage
      }))
    })
  }
  return extractPriceRows(markdown).map(row => ({
    raw_name: row.raw_name,
    sku: row.sku,
    unit: row.unit,
    price: row.price,
    moq: row.moq,
    currency: 'INR',
    source_page: chunkStart === chunkEnd ? chunkStart : null
  }))
}

function dedupeRows(values) {
  const seen = new Set()
  return values.filter(row => {
    if (row.price === null || row.price === undefined) return false
    const key = JSON.stringify([
      row.raw_name.toLowerCase().replace(/\s+/g, ' ').trim(),
      row.sku?.toLowerCase().replace(/\s+/g, ' ').trim() ?? '',
      row.unit?.toLowerCase().replace(/\s+/g, ' ').trim() ?? '',
      row.price,
      row.source_page ?? null
    ])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function deleteExistingRows(documentId) {
  for (const table of ['doc_price_items', 'doc_table_cells', 'doc_tables', 'doc_items']) {
    const batchSize = table === 'doc_table_cells' ? 100 : 500
    for (;;) {
      const { data, error } = await supabase
        .from(table)
        .select('id')
        .eq('document_id', documentId)
        .limit(batchSize)
      if (error) throw error
      const ids = (data ?? []).map(row => row.id)
      if (!ids.length) break
      await supabase.from(table).delete().in('id', ids).throwOnError()
    }
  }
}

async function insertDocItems(document, rows) {
  for (let index = 0; index < rows.length; index += 500) {
    const chunk = rows.slice(index, index + 500)
    if (!chunk.length) continue
    await supabase.from('doc_items').insert(chunk.map(row => ({
      owner_id: document.owner_id,
      document_id: document.id,
      raw_name: row.raw_name,
      sku: row.sku,
      unit: row.unit,
      price: row.price,
      moq: row.moq,
      currency: 'INR',
      source_page: row.source_page,
      raw_row: null
    }))).throwOnError()
  }
}

async function setDocumentStatus(documentId, status, error) {
  await supabase
    .from('documents')
    .update({ status, error, updated_at: new Date().toISOString() })
    .eq('id', documentId)
    .throwOnError()
}

async function runBackfill(documentId) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['scripts/backfill-canonical-doc.mjs', documentId], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    })
    let stderr = ''
    child.stdout.on('data', chunk => process.stdout.write(chunk))
    child.stderr.on('data', chunk => {
      stderr += chunk
      process.stderr.write(chunk)
    })
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(stderr || `backfill exited with ${code}`))
    })
  })
}

function registerNuxtAliases() {
  const originalResolveFilename = Module._resolveFilename
  Module._resolveFilename = function patchedResolveFilename(request, parent, isMain, options) {
    if (request === '~~/shared/schemas') return resolve(process.cwd(), 'shared/schemas.ts')
    if (request.startsWith('~~/')) return resolve(process.cwd(), request.slice(3))
    if (request.startsWith('~/')) return resolve(process.cwd(), request.slice(2))
    return originalResolveFilename.call(this, request, parent, isMain, options)
  }
}
