#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import { SarvamAIClient } from 'sarvamai'
import { load } from 'cheerio'
import JSZip from 'jszip'
import { PDFDocument } from 'pdf-lib'
import { createJiti } from 'jiti'
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

const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NUXT_SUPABASE_SERVICE_ROLE_KEY
const sarvamKey = process.env.SARVAM_API_KEY
if (!supabaseUrl) throw new Error('SUPABASE_URL is required')
if (!serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
if (!sarvamKey) throw new Error('SARVAM_API_KEY is required')

const args = new Set(process.argv.slice(2))
const force = args.has('--force')
const onlyFailedOrEmpty = args.has('--failed-or-empty')
const requestedDocumentIds = process.argv
  .slice(2)
  .filter(arg => !arg.startsWith('--'))
const language = process.env.SARVAM_LANGUAGE || 'en-IN'
const SARVAM_MAX_PDF_PAGES = Number(process.env.SARVAM_MAX_PDF_PAGES || 10)
const SARVAM_CHUNK_CONCURRENCY = Math.max(1, Number(process.env.SARVAM_CHUNK_CONCURRENCY || 1))
const MAX_STORED_PARSED_MARKDOWN_CHARS = Number(process.env.MAX_STORED_PARSED_MARKDOWN_CHARS || 200_000)
const supabase = createClient(supabaseUrl, serviceRoleKey)
registerNuxtAliases()
const jiti = createJiti(import.meta.url, { interopDefault: true })
const { parsePriceRowsFromGrid, parsePriceRowsFromHtmlTables } = await jiti.import('../server/utils/internalPriceParser.ts')

const { data: documents, error: documentsError } = await supabase
  .from('documents')
  .select('id, owner_id, vendor_id, filename, storage_path, mime, status')
  .not('storage_path', 'is', null)
  .order('created_at', { ascending: true })
if (documentsError) throw documentsError

const selectedDocuments = []
for (const document of documents ?? []) {
  if (requestedDocumentIds.length && !requestedDocumentIds.includes(document.id)) continue

  if (!onlyFailedOrEmpty) {
    selectedDocuments.push(document)
    continue
  }

  const { count, error } = await supabase
    .from('doc_price_items')
    .select('id', { count: 'exact', head: true })
    .eq('document_id', document.id)
  if (error) throw error
  if (document.status === 'failed' || !count) selectedDocuments.push(document)
}

if (!selectedDocuments.length) {
  console.log('No documents selected for Sarvam reparse.')
  process.exit(0)
}

console.log(`Sarvam reparse starting: ${selectedDocuments.length}/${documents?.length ?? 0} documents, language=${language}`)

const failures = []
for (const [index, document] of selectedDocuments.entries()) {
  const label = `${index + 1}/${selectedDocuments.length} ${document.filename}`
  try {
    if (!isSarvamSupported(document)) {
      console.log(`\n[${label}] skipped: Sarvam supports PDF, ZIP, JPG, JPEG, and PNG only`)
      const { count } = await supabase
        .from('doc_price_items')
        .select('id', { count: 'exact', head: true })
        .eq('document_id', document.id)
      if (count) await setDocumentStatus(document.id, 'parsed', null)
      continue
    }

    console.log(`\n[${label}] downloading`)
    await setDocumentStatus(document.id, 'ocr', null)
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('uploads')
      .download(document.storage_path)
    if (downloadError) throw downloadError
    const buffer = Buffer.from(await fileData.arrayBuffer())

    console.log(`[${label}] Sarvam OCR`)
    const extraction = await runSarvam({
      buffer,
      filename: document.filename,
      mime: document.mime,
      language
    })

    console.log(`[${label}] rows=${extraction.rows.length} pages=${extraction.pageCount ?? 'unknown'}`)
    await supabase
      .from('documents')
      .update({
        status: 'extracting',
        error: null,
        parsed_markdown: storedParsedMarkdown(extraction.markdown),
        page_count: extraction.pageCount,
        chandra_request_id: `sarvam:${extraction.requestId}`,
        updated_at: new Date().toISOString()
      })
      .eq('id', document.id)
      .throwOnError()

    await deleteExistingRows(document.id)
    await insertDocItems(document, extraction.rows)
    await runBackfill(document.id)
    await setDocumentStatus(document.id, 'parsed', null)
    console.log(`[${label}] done`)
  } catch (err) {
    const message = err?.message ?? String(err)
    failures.push({ document_id: document.id, filename: document.filename, error: message })
    await setDocumentStatus(document.id, 'failed', message).catch(() => {})
    console.error(`[${label}] failed: ${message}`)
    if (!force) break
  }
}

console.log('\nSarvam reparse complete.')
if (failures.length) {
  console.log(JSON.stringify({ failures }, null, 2))
  process.exitCode = 1
}

async function runSarvam({ buffer, filename, mime, language }) {
  const client = new SarvamAIClient({ apiSubscriptionKey: sarvamKey })
  const chunks = isPdf({ filename, mime })
    ? await splitPdfIntoSarvamChunks(buffer)
    : [{ buffer, startPage: 1, pageCount: null }]
  if (chunks.length > 1) {
    console.log(`[${filename}] Sarvam chunks=${chunks.length} pages_per_chunk=${SARVAM_MAX_PDF_PAGES} concurrency=${SARVAM_CHUNK_CONCURRENCY}`)
  }

  const outputs = await mapWithConcurrency(chunks, SARVAM_CHUNK_CONCURRENCY, async (chunk, index) => {
    const label = chunks.length > 1 ? ` chunk ${index + 1}/${chunks.length} pages ${chunk.startPage}-${chunk.startPage + (chunk.pageCount ?? 1) - 1}` : ''
    if (label) console.log(`[${filename}] starting${label}`)
    const output = await runSarvamJob({
      client,
      buffer: chunk.buffer,
      filename: chunks.length > 1 ? filename.replace(/\.pdf$/i, `.part-${index + 1}.pdf`) : filename,
      mime,
      language,
      pageOffset: chunk.startPage - 1
    })
    if (label) console.log(`[${filename}] finished${label}; rows=${output.rows.length}`)
    return output
  })

  return {
    requestId: outputs.map(output => output.requestId).join(','),
    rows: outputs.flatMap(output => output.rows),
    markdown: outputs.map(output => output.markdown).filter(Boolean).join('\n'),
    pageCount: chunks.reduce((total, chunk) => total + (chunk.pageCount ?? 0), 0)
      || outputs.reduce((total, output) => total + (output.pageCount ?? 0), 0)
      || null
  }
}

async function mapWithConcurrency(values, concurrency, worker) {
  const results = new Array(values.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++
      results[index] = await worker(values[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

async function runSarvamJob({ client, buffer, filename, mime, language, pageOffset }) {
  const job = await client.documentIntelligence.createJob({
    language,
    outputFormat: 'html'
  })

  const file = new File([new Uint8Array(buffer)], filename, {
    type: mime || 'application/octet-stream'
  })
  await job.uploadFile(file)
  await job.start()
  const status = await job.waitUntilComplete()
  if (status.job_state === 'Failed') {
    throw new Error(`Sarvam processing failed: ${status.error_message || 'unknown'}`)
  }

  const zipBuffer = await downloadZip(job)
  const extracted = await readSarvamZip(zipBuffer)
  return {
    requestId: job.jobId,
    rows: rowsFromHtml(extracted.html, 1).map(row => ({
      ...row,
      source_page: row.source_page ? row.source_page + pageOffset : row.source_page
    })),
    markdown: extracted.html || extracted.indexableMarkdown,
    pageCount: job.getPageMetrics()?.totalPages || extracted.pageCount
  }
}

async function splitPdfIntoSarvamChunks(buffer) {
  const source = await PDFDocument.load(buffer, { ignoreEncryption: true })
  const pageCount = source.getPageCount()
  if (pageCount <= SARVAM_MAX_PDF_PAGES) return [{ buffer, startPage: 1, pageCount }]

  const chunks = []
  for (let start = 0; start < pageCount; start += SARVAM_MAX_PDF_PAGES) {
    const end = Math.min(start + SARVAM_MAX_PDF_PAGES, pageCount)
    const target = await PDFDocument.create()
    const pages = await target.copyPages(source, Array.from({ length: end - start }, (_, index) => start + index))
    for (const page of pages) target.addPage(page)
    chunks.push({
      buffer: Buffer.from(await target.save()),
      startPage: start + 1,
      pageCount: end - start
    })
  }
  return chunks
}

function isPdf({ filename, mime }) {
  return /\.pdf$/i.test(String(filename ?? '')) || String(mime ?? '').toLowerCase() === 'application/pdf'
}

async function downloadZip(job) {
  const links = await job.getDownloadLinks()
  const first = Object.values(links.download_urls ?? {})[0]
  if (!first?.file_url) throw new Error('Sarvam did not return a download URL')
  const res = await fetch(first.file_url)
  if (!res.ok) throw new Error(`Sarvam download failed: ${res.status} ${res.statusText}`)
  return Buffer.from(await res.arrayBuffer())
}

async function readSarvamZip(buffer) {
  const zip = await JSZip.loadAsync(buffer)
  const files = Object.values(zip.files).filter(file => !file.dir)
  const htmlParts = []
  const jsonParts = []

  for (const file of files) {
    const lowerName = file.name.toLowerCase()
    if (lowerName.endsWith('.html') || lowerName.endsWith('.htm')) {
      htmlParts.push(await file.async('string'))
    } else if (lowerName.endsWith('.json')) {
      try {
        jsonParts.push(JSON.parse(await file.async('string')))
      } catch {
        // HTML is the primary extraction output.
      }
    }
  }

  const html = htmlParts.map(sanitizeHtml).filter(Boolean).join('\n')
  const jsonText = jsonParts.flatMap(extractTextFromJson).join('\n\n')
  return {
    html,
    indexableMarkdown: [htmlToIndexableMarkdown(html), jsonText].filter(Boolean).join('\n\n'),
    pageCount: jsonParts.length || null
  }
}

function sanitizeHtml(html) {
  const $ = load(html)
  $('script, style, iframe, object, embed, link, meta, img, picture, source, svg, canvas, video').remove()
  $('*').each((_, el) => {
    const attribs = $(el).attr() ?? {}
    for (const [name, value] of Object.entries(attribs)) {
      const attr = name.toLowerCase()
      if (attr.startsWith('on') || attr === 'srcdoc') $(el).removeAttr(name)
      if ((attr === 'href' || attr === 'src') && /^\s*javascript:/i.test(String(value))) $(el).removeAttr(name)
    }
  })
  return $('body').length ? $('body').html() ?? '' : $.root().html() ?? ''
}

function rowsFromHtml(html, fallbackSourcePage = null) {
  const $ = load(html)
  const seen = new Set()
  const htmlRows = parsePriceRowsFromHtmlTables(html, fallbackSourcePage)
  const gridRows = $('table').toArray().flatMap((table) => {
    const grid = tableToGrid($.html(table))
    return parsePriceRowsFromGrid(grid, fallbackSourcePage)
  })
  return [...htmlRows, ...gridRows].flatMap((row) => {
      const parsed = {
        raw_name: row.raw_name,
        sku: row.sku,
        unit: row.unit,
        price: row.price,
        moq: row.moq,
        currency: row.currency,
        source_page: row.source_page ?? null
      }
      const key = JSON.stringify([
        parsed.raw_name.toLowerCase(),
        parsed.sku?.toLowerCase() ?? '',
        parsed.unit?.toLowerCase() ?? '',
        parsed.price
      ])
      if (seen.has(key)) return []
      seen.add(key)
      return [parsed]
  })
}

function tableToGrid(tableHtml) {
  const $ = load(tableHtml)
  return $('tr').toArray()
    .map(row => $(row).find('th,td').toArray().map(cell => $(cell).text().replace(/\s+/g, ' ').trim()))
    .filter(row => row.some(cell => cell.length > 0))
}

function htmlToIndexableMarkdown(html) {
  const $ = load(html)
  const chunks = []
  $('h1,h2,h3,h4,h5,h6,p,li,table').each((_, el) => {
    if (el.tagName.toLowerCase() === 'table') {
      const grid = tableToGrid($.html(el))
      if (grid.length > 1) chunks.push(grid.map(row => row.join(' | ')).join('\n'))
    } else {
      const text = $(el).text().replace(/\s+/g, ' ').trim()
      if (text) chunks.push(text)
    }
  })
  return chunks.join('\n\n')
}

function extractTextFromJson(value) {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(extractTextFromJson)
  const direct = ['text', 'content', 'markdown', 'html']
    .map(key => value[key])
    .filter(item => typeof item === 'string' && item.trim().length > 0)
  return [...direct, ...Object.values(value).flatMap(extractTextFromJson)]
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
    .update({
      status,
      error,
      updated_at: new Date().toISOString()
    })
    .eq('id', documentId)
    .throwOnError()
}

async function runBackfill(documentId) {
  await new Promise((resolve, reject) => {
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
      if (code === 0) resolve()
      else reject(new Error(stderr || `backfill exited with ${code}`))
    })
  })
}

function isSarvamSupported(document) {
  const filename = String(document.filename ?? '').toLowerCase()
  const mime = String(document.mime ?? '').toLowerCase()
  return /\.(pdf|zip|jpe?g|png)$/.test(filename)
    || ['application/pdf', 'application/zip', 'image/jpeg', 'image/jpg', 'image/png'].includes(mime)
}

function storedParsedMarkdown(markdown) {
  if (markdown.length <= MAX_STORED_PARSED_MARKDOWN_CHARS) return markdown
  return [
    markdown.slice(0, MAX_STORED_PARSED_MARKDOWN_CHARS),
    '',
    `[AI Ratefinder truncated stored parser preview at ${MAX_STORED_PARSED_MARKDOWN_CHARS} characters; structured price rows remain fully indexed.]`
  ].join('\n')
}

function registerNuxtAliases() {
  const originalResolveFilename = Module._resolveFilename
  Module._resolveFilename = function patchedResolveFilename(request, parent, isMain, options) {
    if (request === '~~/shared/schemas') {
      return resolve(process.cwd(), 'shared/schemas.ts')
    }
    if (request.startsWith('~~/')) {
      return resolve(process.cwd(), request.slice(3))
    }
    if (request.startsWith('~/')) {
      return resolve(process.cwd(), request.slice(2))
    }
    return originalResolveFilename.call(this, request, parent, isMain, options)
  }
}
