#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import { createJiti } from 'jiti'
import { $fetch } from 'ofetch'
import { PDFDocument } from 'pdf-lib'
import { existsSync, readFileSync } from 'node:fs'
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
const { runChandra } = await jiti.import('../server/utils/chandra.ts')
const { extractPriceRows } = await jiti.import('../server/utils/extract.ts')
const { splitPaginatedMarkdown } = await jiti.import('../server/utils/pricePages.ts')

const pagesPerChunk = Math.max(1, Number(process.env.CHANDRA_PAGES_PER_CHUNK || 5))
const chunkDelayMs = Math.max(0, Number(process.env.CHANDRA_CHUNK_DELAY_MS || 1500))

const { data: doc, error: docError } = await supabase
  .from('documents')
  .select('id, owner_id, vendor_id, filename, storage_path, mime')
  .eq('id', documentId)
  .single()
if (docError || !doc) throw docError ?? new Error('Document not found')
if (!doc.storage_path) throw new Error('Document has no storage_path')

console.log(`Chandra chunk reparse starting: ${doc.filename}`)
await setDocumentStatus(documentId, 'ocr', null)

const { data: fileData, error: downloadError } = await supabase.storage
  .from('uploads')
  .download(doc.storage_path)
if (downloadError) throw downloadError
const buffer = Buffer.from(await fileData.arrayBuffer())
const pageCount = await pdfPageCount(buffer)
const chunks = Array.from({ length: Math.ceil(pageCount / pagesPerChunk) }, (_, index) => {
  const start = index * pagesPerChunk + 1
  const end = Math.min(start + pagesPerChunk - 1, pageCount)
  return { start, end }
})

console.log(`pages=${pageCount} chunks=${chunks.length} pages_per_chunk=${pagesPerChunk}`)

const markdownParts = []
const requestIds = []
const rows = []

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
      mode: 'fast',
      paginate: true,
      forceOcr: true,
      disableImageExtraction: true,
      disableImageCaptions: true,
      pageRange: zeroBasedRange
    }
  )
  requestIds.push(result.requestId)
  const chunkMarkdown = result.result.markdown ?? ''
  markdownParts.push(chunkMarkdown)
  const chunkRows = rowsFromMarkdown(chunkMarkdown, chunk.start, chunk.end)
  rows.push(...chunkRows)
  console.log(`[${index + 1}/${chunks.length}] rows=${chunkRows.length} markdown_chars=${chunkMarkdown.length}`)
  if (chunkDelayMs) await new Promise(resolve => setTimeout(resolve, chunkDelayMs))
}

const markdown = markdownParts.filter(Boolean).join('\n\n')
const dedupedRows = dedupeRows(rows)
console.log(`Chandra chunks complete: rows=${dedupedRows.length} markdown_chars=${markdown.length}`)

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

await insertDocItems(doc, dedupedRows)
await runBackfill(documentId)
await setDocumentStatus(documentId, 'parsed', dedupedRows.length ? null : 'Chandra OCR completed, but no deterministic price rows were extracted.')

console.log(JSON.stringify({
  document_id: documentId,
  filename: doc.filename,
  pages: pageCount,
  rows: dedupedRows.length
}, null, 2))

async function pdfPageCount(buffer) {
  const pdf = await PDFDocument.load(buffer, { ignoreEncryption: true })
  return pdf.getPageCount()
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
        currency: row.currency ?? 'INR',
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
    currency: row.currency ?? 'INR',
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
  await supabase.from('doc_price_items').delete().eq('document_id', documentId).throwOnError()
  await supabase.from('doc_table_cells').delete().eq('document_id', documentId).throwOnError()
  await supabase.from('doc_tables').delete().eq('document_id', documentId).throwOnError()
  await supabase.from('doc_items').delete().eq('document_id', documentId).throwOnError()
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
      currency: row.currency,
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
