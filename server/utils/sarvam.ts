import { SarvamAIClient } from 'sarvamai'
import { load } from 'cheerio'
import JSZip from 'jszip'
import { PDFDocument } from 'pdf-lib'
import { parsePriceRowsFromGrid, parsePriceRowsFromHtmlTables } from './internalPriceParser'
import type { ExtractedPriceRow } from './priceExtraction'
import type { SarvamLanguage } from './parserSettings'

export interface SarvamPriceExtractionResult {
  requestId: string
  rows: ExtractedPriceRow[]
  markdown: string
  pageCount: number | null
  warnings: string[]
}

const SARVAM_MAX_PDF_PAGES = Number(process.env.SARVAM_MAX_PDF_PAGES || 10)

function apiKey() {
  const key = useRuntimeConfig().sarvamApiKey || process.env.SARVAM_API_KEY
  if (!key) {
    throw createError({
      statusCode: 500,
      statusMessage: 'SARVAM_API_KEY is not configured'
    })
  }
  return key
}

function sanitizeHtml(html: string) {
  const $ = load(html)
  $('script, style, iframe, object, embed, link, meta, img, picture, source, svg, canvas, video').remove()
  $('*').each((_, el) => {
    const attribs = $(el).attr() ?? {}
    for (const [name, value] of Object.entries(attribs)) {
      const attr = name.toLowerCase()
      if (attr.startsWith('on') || attr === 'srcdoc') {
        $(el).removeAttr(name)
      }
      if ((attr === 'href' || attr === 'src') && /^\s*javascript:/i.test(String(value))) {
        $(el).removeAttr(name)
      }
    }
  })

  return $('body').length ? $('body').html() ?? '' : $.root().html() ?? ''
}

function tableToGrid(tableHtml: string) {
  const $ = load(tableHtml)
  return $('tr').toArray()
    .map(row => $(row).find('th,td').toArray().map(cell => $(cell).text().replace(/\s+/g, ' ').trim()))
    .filter(row => row.some(cell => cell.length > 0))
}

function tableToMarkdown(tableHtml: string) {
  const grid = tableToGrid(tableHtml)
  if (grid.length < 2) return ''
  const width = Math.max(...grid.map(row => row.length))
  const normalized = grid.map(row => Array.from({ length: width }, (_, index) => row[index] ?? ''))
  const firstRow = normalized[0] ?? []
  const escapeCell = (value: string) => value.replace(/\|/g, '\\|')
  return [
    `| ${firstRow.map(escapeCell).join(' | ')} |`,
    `| ${firstRow.map(() => '---').join(' | ')} |`,
    ...normalized.slice(1).map(row => `| ${row.map(escapeCell).join(' | ')} |`)
  ].join('\n')
}

function htmlToIndexableMarkdown(html: string) {
  const $ = load(html)
  const chunks: string[] = []
  $('h1,h2,h3,h4,h5,h6,p,li,table').each((_, el) => {
    if (el.tagName.toLowerCase() === 'table') {
      const tableMarkdown = tableToMarkdown($.html(el))
      if (tableMarkdown) chunks.push(tableMarkdown)
    } else {
      const text = $(el).text().replace(/\s+/g, ' ').trim()
      if (text) chunks.push(text)
    }
  })
  return chunks.join('\n\n')
}

function rowsFromHtml(html: string, fallbackSourcePage: number | null = null): ExtractedPriceRow[] {
  const $ = load(html)
  const seen = new Set<string>()
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

function extractTextFromJson(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(extractTextFromJson)

  const record = value as Record<string, unknown>
  const direct = ['text', 'content', 'markdown', 'html']
    .map(key => record[key])
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  return [
    ...direct,
    ...Object.values(record).flatMap(extractTextFromJson)
  ]
}

async function readSarvamZip(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer)
  const files = Object.values(zip.files).filter(file => !file.dir)
  const htmlParts: string[] = []
  const jsonParts: unknown[] = []

  for (const file of files) {
    const lowerName = file.name.toLowerCase()
    if (lowerName.endsWith('.html') || lowerName.endsWith('.htm')) {
      htmlParts.push(await file.async('string'))
    } else if (lowerName.endsWith('.json')) {
      try {
        jsonParts.push(JSON.parse(await file.async('string')))
      } catch {
        // Ignore malformed companion JSON; HTML is the primary Sarvam output here.
      }
    }
  }

  const sanitizedHtml = htmlParts.map(sanitizeHtml).filter(Boolean).join('\n')
  const jsonText = jsonParts.flatMap(extractTextFromJson).join('\n\n')
  const indexableMarkdown = [
    htmlToIndexableMarkdown(sanitizedHtml),
    jsonText
  ].filter(Boolean).join('\n\n')

  return {
    html: sanitizedHtml,
    indexableMarkdown,
    pageCount: jsonParts.length || null
  }
}

async function downloadZip(job: Awaited<ReturnType<SarvamAIClient['documentIntelligence']['createJob']>>) {
  const links = await job.getDownloadLinks()
  const first = Object.values(links.download_urls ?? {})[0]
  if (!first?.file_url) {
    throw createError({
      statusCode: 502,
      statusMessage: 'Sarvam did not return a download URL'
    })
  }

  const res = await fetch(first.file_url)
  if (!res.ok) {
    throw createError({
      statusCode: 502,
      statusMessage: `Sarvam download failed: ${res.status} ${res.statusText}`
    })
  }
  return Buffer.from(await res.arrayBuffer())
}

async function splitPdfIntoSarvamChunks(fileData: Buffer) {
  const source = await PDFDocument.load(fileData, { ignoreEncryption: true })
  const pageCount = source.getPageCount()
  if (pageCount <= SARVAM_MAX_PDF_PAGES) return [{ fileData, startPage: 1, pageCount }]

  const chunks: Array<{ fileData: Buffer; startPage: number; pageCount: number }> = []
  for (let start = 0; start < pageCount; start += SARVAM_MAX_PDF_PAGES) {
    const end = Math.min(start + SARVAM_MAX_PDF_PAGES, pageCount)
    const target = await PDFDocument.create()
    const copied = await target.copyPages(source, Array.from({ length: end - start }, (_, index) => start + index))
    for (const page of copied) target.addPage(page)
    chunks.push({
      fileData: Buffer.from(await target.save()),
      startPage: start + 1,
      pageCount: end - start
    })
  }
  return chunks
}

function isPdf(filename: string, mime?: string | null) {
  return /\.pdf$/i.test(filename) || String(mime ?? '').toLowerCase() === 'application/pdf'
}

async function runSarvamJob(params: {
  client: SarvamAIClient
  fileData: Buffer
  filename: string
  mime?: string | null
  language: SarvamLanguage
  pageOffset?: number
}) {
  const job = await params.client.documentIntelligence.createJob({
    language: params.language,
    outputFormat: 'html'
  })

  const file = new File([new Uint8Array(params.fileData)], params.filename, {
    type: params.mime || 'application/octet-stream'
  })
  await job.uploadFile(file)
  await job.start()

  const status = await job.waitUntilComplete()
  if (status.job_state === 'Failed') {
    throw createError({
      statusCode: 502,
      statusMessage: `Sarvam processing failed: ${status.error_message || 'unknown'}`
    })
  }

  const metrics = job.getPageMetrics()
  const zipBuffer = await downloadZip(job)
  const extracted = await readSarvamZip(zipBuffer)
  const pageOffset = params.pageOffset ?? 0
  return {
    requestId: job.jobId,
    rows: rowsFromHtml(extracted.html, 1).map(row => ({
      ...row,
      source_page: row.source_page ? row.source_page + pageOffset : row.source_page
    })),
    markdown: extracted.html || extracted.indexableMarkdown,
    pageCount: metrics.totalPages || extracted.pageCount
  }
}

export async function runSarvamPriceExtraction(params: {
  fileData: Buffer
  filename: string
  mime?: string | null
  language: SarvamLanguage
}): Promise<SarvamPriceExtractionResult> {
  const client = new SarvamAIClient({ apiSubscriptionKey: apiKey() })
  const chunks = isPdf(params.filename, params.mime)
    ? await splitPdfIntoSarvamChunks(params.fileData)
    : [{ fileData: params.fileData, startPage: 1, pageCount: null }]
  const extractedChunks = []
  for (const [index, chunk] of chunks.entries()) {
    extractedChunks.push(await runSarvamJob({
      client,
      fileData: chunk.fileData,
      filename: chunks.length > 1 ? params.filename.replace(/\.pdf$/i, `.part-${index + 1}.pdf`) : params.filename,
      mime: params.mime,
      language: params.language,
      pageOffset: chunk.startPage - 1
    }))
  }

  const rows = extractedChunks.flatMap(chunk => chunk.rows)
  const warnings: string[] = []
  if (!rows.length) warnings.push('Sarvam completed, but no product/price rows were detected in the HTML tables.')
  if (chunks.length > 1) warnings.push(`Sarvam processed the PDF in ${chunks.length} chunks because the provider limit is ${SARVAM_MAX_PDF_PAGES} pages per job.`)

  return {
    requestId: extractedChunks.map(chunk => chunk.requestId).join(','),
    rows,
    markdown: extractedChunks.map(chunk => chunk.markdown).filter(Boolean).join('\n'),
    pageCount: chunks.reduce((total, chunk) => total + (chunk.pageCount ?? 0), 0) || extractedChunks.reduce((total, chunk) => total + (chunk.pageCount ?? 0), 0) || null,
    warnings
  }
}
