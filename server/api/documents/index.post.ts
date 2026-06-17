/**
 * Upload one file and kick off the ingest pipeline.
 *
 *   multipart/form-data:
 *     file:        the price doc
 *     vendor_name: required free-text vendor name (auto-created if new)
 *
 * Pipeline: create document → return 202 → storage upload → selected parser → rows.
 * Parser mode is user configurable: auto, internal parser, Chandra OCR, or Sarvam OCR.
 */
import { randomUUID } from 'node:crypto'
import { canonicalizeExtractedRows, type CanonicalTable } from '../../utils/extraction/canonicalizeTable'
import { persistDocumentAliases } from '../../utils/extraction/mineDocumentAliases'
import { priceCellToRecord } from '../../utils/extraction/priceCellRecords'
import { parseInternalPriceDocument } from '../../utils/internalPriceParser'
import { getParserSettings } from '../../utils/parserSettings'
import { runChandraPriceExtraction, type ExtractedPriceRow } from '../../utils/priceExtraction'
import { runSarvamPriceExtraction } from '../../utils/sarvam'
import { adminClient } from '../../utils/supabase'
import { ensureUploadBucketLimit } from '../../utils/uploadBucket'
import {
  MAX_DOCUMENT_UPLOAD_BYTES,
  documentUploadSizeError
} from '~~/shared/documentUpload'

export interface UploadedDoc {
  id: string
  owner_id: string
  vendor_id: string | null
}

type StoredUploadBody = {
  filename?: string
  storage_path?: string
  mime?: string | null
  size?: number
  vendor_name?: string
}

const DOC_ITEM_INSERT_CHUNK_SIZE = 1000

const KNOWN_VENDOR_NAMES = [
  'ABB',
  'Anchor',
  'Bajaj',
  'Crompton',
  'Finolex',
  'Havells',
  'HPL',
  'KEI',
  'L&T',
  'Legrand',
  'Orient',
  'Philips',
  'Polycab',
  'RR Kabel',
  'Schneider',
  'Siemens',
  'Syska',
  'V-Guard',
  'Wipro'
]

export function enqueueIngest(event: any, task: Promise<void>) {
  if (typeof event.waitUntil === 'function') {
    event.waitUntil(task)
  } else {
    task.catch((err) => console.error('Document ingest failed', err))
  }
}

function vendorNeedle(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function inferVendorName(filename: string, markdown: string, existingNames: string[]) {
  const haystack = vendorNeedle(`${filename}\n${markdown.slice(0, 12000)}`)
  const candidates = [...existingNames, ...KNOWN_VENDOR_NAMES]
  const matched = candidates
    .map(name => ({ name, index: haystack.indexOf(vendorNeedle(name)) }))
    .filter(match => match.index >= 0)
    .sort((a, b) => a.index - b.index || b.name.length - a.name.length)

  return matched[0]?.name ?? null
}

async function ensureVendorForMarkdown(params: {
  client: ReturnType<typeof adminClient>
  ownerId: string
  docId: string
  filename: string
  markdown: string
}) {
  const { data: vendors } = await params.client
    .from('vendors')
    .select('id, name')
    .eq('owner_id', params.ownerId)

  const inferred = inferVendorName(
    params.filename,
    params.markdown,
    (vendors ?? []).map(v => v.name as string)
  )
  if (!inferred) return null

  const existing = (vendors ?? []).find(v => vendorNeedle(v.name as string) === vendorNeedle(inferred))
  if (existing?.id) {
    await params.client.from('documents')
      .update({ vendor_id: existing.id, updated_at: new Date().toISOString() })
      .eq('id', params.docId)
    return existing.id as string
  }

  const { data: created, error } = await params.client
    .from('vendors')
    .insert({ owner_id: params.ownerId, name: inferred })
    .select('id')
    .single()
  if (error || !created) return null

  await params.client.from('documents')
    .update({ vendor_id: created.id, updated_at: new Date().toISOString() })
    .eq('id', params.docId)
  return created.id as string
}

type InsertedDocItem = ExtractedPriceRow & { id: string }

async function insertDocItemsInChunks(params: {
  client: ReturnType<typeof adminClient>
  doc: UploadedDoc
  rows: ExtractedPriceRow[]
}): Promise<InsertedDocItem[]> {
  const inserted: InsertedDocItem[] = []
  for (let index = 0; index < params.rows.length; index += DOC_ITEM_INSERT_CHUNK_SIZE) {
    const chunk = params.rows.slice(index, index + DOC_ITEM_INSERT_CHUNK_SIZE)
    const { data, error } = await params.client.from('doc_items').insert(chunk.map(r => ({
      owner_id: params.doc.owner_id,
      document_id: params.doc.id,
      raw_name: r.raw_name,
      sku: r.sku,
      unit: r.unit,
      price: r.price,
      moq: r.moq,
      currency: r.currency,
      source_page: r.source_page,
      raw_row: null
    }))).select('id, raw_name, sku, unit, price, moq, currency, source_page')
    if (error) throw error
    inserted.push(...(data ?? []).map((row: any) => ({
      id: row.id,
      raw_name: row.raw_name,
      sku: row.sku,
      unit: row.unit,
      price: row.price === null ? null : Number(row.price),
      moq: row.moq,
      currency: row.currency,
      source_page: row.source_page
    })))
  }
  return inserted
}

function legacyItemsByPageAndRow(items: InsertedDocItem[]) {
  const grouped = new Map<number | null, InsertedDocItem[]>()
  for (const item of items) {
    const key = item.source_page ?? null
    grouped.set(key, [...(grouped.get(key) ?? []), item])
  }
  return grouped
}

async function persistCanonicalPriceRecords(params: {
  client: ReturnType<typeof adminClient>
  doc: UploadedDoc
  filename: string
  parserName: string
  markdown: string
  rows: ExtractedPriceRow[]
  insertedDocItems: InsertedDocItem[]
}) {
  if (!params.rows.length) return

  try {
    const { data: document } = await params.client
      .from('documents')
      .select('id, filename, created_at, vendor_id, vendor:vendor_id(name)')
      .eq('id', params.doc.id)
      .single()

    const vendorId = (document?.vendor_id as string | null | undefined) ?? params.doc.vendor_id ?? null
    const vendorName = (document as any)?.vendor?.name ?? null
    const sourceUploadedAt = (document?.created_at as string | null | undefined) ?? null
    const tables = canonicalizeExtractedRows({
      rows: params.rows,
      documentTitle: params.filename,
      vendorName,
      parserName: params.parserName,
      parserConfidence: params.parserName === 'legacy-doc-items' ? 0.62 : 0.78,
      ocrConfidence: null
    })
    const legacyByPage = legacyItemsByPageAndRow(params.insertedDocItems)

    for (const table of tables) {
      await persistCanonicalTable({
        ...params,
        table,
        vendorId,
        vendorName,
        sourceUploadedAt,
        legacyByPage
      })
    }

    await persistDocumentAliases({
      client: params.client,
      tenantId: params.doc.owner_id,
      vendorId,
      documentId: params.doc.id,
      text: `${params.filename}\n${params.markdown}`
    })
  } catch (err: any) {
    console.warn('Canonical price record persistence failed', err?.message ?? err)
  }
}

async function persistCanonicalTable(params: {
  client: ReturnType<typeof adminClient>
  doc: UploadedDoc
  filename: string
  table: CanonicalTable
  vendorId: string | null
  vendorName: string | null
  sourceUploadedAt: string | null
  legacyByPage: Map<number | null, InsertedDocItem[]>
}) {
  const { data: tableRow, error: tableError } = await params.client
    .from('doc_tables')
    .insert({
      tenant_id: params.doc.owner_id,
      document_id: params.doc.id,
      vendor_id: params.vendorId,
      source_page: params.table.source_page,
      table_index: params.table.table_index,
      table_title: params.table.table_title,
      section_breadcrumb: params.table.section_breadcrumb,
      parser_name: params.table.parser_name,
      parser_confidence: params.table.parser_confidence,
      ocr_confidence: params.table.ocr_confidence
    })
    .select('id')
    .single()
  if (tableError || !tableRow) throw tableError ?? new Error('Could not insert doc table')

  const cellRows = params.table.cells.map(cell => ({
    tenant_id: params.doc.owner_id,
    document_id: params.doc.id,
    vendor_id: params.vendorId,
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

  const { data: insertedCells, error: cellError } = await params.client
    .from('doc_table_cells')
    .insert(cellRows)
    .select('id, source_row_index, source_col_index')
  if (cellError) throw cellError

  const cellIdByPosition = new Map(
    (insertedCells ?? []).map((cell: any) => [`${cell.source_row_index}:${cell.source_col_index}`, cell.id as string])
  )
  const legacyForPage = params.legacyByPage.get(params.table.source_page ?? null) ?? []

  const priceRows = params.table.cells.flatMap(cell => {
    if (!cell.is_price) return []
    const legacy = legacyForPage[cell.source_row_index - 1] ?? null
    const record = priceCellToRecord({
      tenant_id: params.doc.owner_id,
      document_id: params.doc.id,
      vendor_id: params.vendorId,
      vendor_name: params.vendorName,
      document_title: params.filename,
      source_uploaded_at: params.sourceUploadedAt,
      legacy_doc_item_id: legacy?.id ?? null,
      source_table_id: tableRow.id as string,
      source_cell_id: cellIdByPosition.get(`${cell.source_row_index}:${cell.source_col_index}`) ?? null,
      table: params.table,
      cell
    })
    return record ? [record] : []
  })

  if (priceRows.length) {
    const { error } = await params.client.from('doc_price_items').insert(priceRows)
    if (error) throw error
  }
}

async function ensureVendorByName(params: {
  client: Awaited<ReturnType<typeof userClient>>
  ownerId: string
  name: string
}) {
  const { data: existing } = await params.client
    .from('vendors')
    .select('id')
    .eq('name', params.name)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (existing) return existing.id as string

  const { data: created, error } = await params.client
    .from('vendors')
    .insert({ owner_id: params.ownerId, name: params.name })
    .select('id')
    .single()
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return created.id as string
}

function assertOwnedStoragePath(storagePath: string, ownerId: string) {
  const parts = storagePath.split('/')
  if (
    parts.length !== 2
    || parts[0] !== ownerId
    || !parts[1]
    || storagePath.includes('..')
  ) {
    throw createError({ statusCode: 403, statusMessage: 'Invalid upload path' })
  }
}

async function getStorageObjectSize(storagePath: string) {
  const client = adminClient()
  const [folder, name] = storagePath.split('/')
  const { data, error } = await client.storage
    .from('uploads')
    .list(folder, { search: name, limit: 1 })

  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  const object = data?.find(item => item.name === name)
  if (!object) throw createError({ statusCode: 400, statusMessage: 'Uploaded file was not found in storage' })

  const metadata = object.metadata as { size?: number } | null
  return metadata?.size ?? null
}

async function downloadStoredFile(storagePath: string) {
  const { data, error } = await adminClient().storage.from('uploads').download(storagePath)
  if (error || !data) {
    throw createError({
      statusCode: 500,
      statusMessage: error?.message ?? 'Failed to read uploaded file'
    })
  }

  return Buffer.from(await data.arrayBuffer())
}

async function resolveVendorId(params: {
  client: Awaited<ReturnType<typeof userClient>>
  ownerId: string
  vendorName?: string | null
}) {
  const vendorName = params.vendorName?.trim()
  if (!vendorName) {
    throw createError({ statusCode: 400, statusMessage: 'Vendor name is required.' })
  }
  return await ensureVendorByName({
    client: params.client,
    ownerId: params.ownerId,
    name: vendorName
  })
}

function hasUsableRows(rows: ExtractedPriceRow[]) {
  return rows.some(row => row.price !== null && /[a-z]/i.test(row.raw_name))
}

export async function processUploadedDocument(params: {
  doc: UploadedDoc
  fileData?: Buffer
  filename: string
  mime?: string
  storagePath: string
  storageAlreadyUploaded?: boolean
}) {
  const client = adminClient()

  try {
    const contentType = params.mime || 'application/octet-stream'
    const fileData = params.fileData ?? await downloadStoredFile(params.storagePath)

    const storageUpload = params.storageAlreadyUploaded
      ? Promise.resolve()
      : ensureUploadBucketLimit()
        .then(() => client.storage
          .from('uploads')
          .upload(params.storagePath, fileData, {
            contentType,
            upsert: false
          }))
        .then(({ error }) => {
          if (error) {
            throw createError({ statusCode: 500, statusMessage: error.message })
          }
        })

    const parserSettings = await getParserSettings(client, params.doc.owner_id)
    const parserMode = parserSettings.parser_mode
    let requestId: string | null = null
    let markdown = ''
    let pageCount: number | null = null
    let rows: ExtractedPriceRow[] = []
    let selectedParserName = 'unknown'
    const parserWarnings: string[] = []

    if (parserMode !== 'chandra' && parserMode !== 'sarvam') {
      await client.from('documents').update({
        status: 'extracting',
        updated_at: new Date().toISOString()
      }).eq('id', params.doc.id)

      try {
        const internal = await parseInternalPriceDocument({
          fileData,
          filename: params.filename,
          mime: params.mime
        })
        if (internal.rows.length > 0 || parserMode === 'internal') {
          selectedParserName = internal.parser
          markdown = internal.markdown
          pageCount = internal.pageCount
          rows = internal.rows.map(row => ({
            raw_name: row.raw_name,
            sku: row.sku,
            unit: row.unit,
            price: row.price,
            moq: row.moq,
            currency: row.currency,
            source_page: row.source_page ?? null
          }))
        }
      } catch (err: any) {
        parserWarnings.push(`Internal parser failed; falling back to OCR. ${err?.statusMessage || err?.message || ''}`.trim())
      }
    }

    if (parserMode === 'sarvam') {
      await client.from('documents').update({
        status: 'ocr',
        updated_at: new Date().toISOString()
      }).eq('id', params.doc.id)

      try {
        const sarvam = await runSarvamPriceExtraction({
          fileData,
          filename: params.filename,
          mime: params.mime,
          language: parserSettings.sarvam_language
        })
        requestId = `sarvam:${sarvam.requestId}`
        selectedParserName = 'sarvam'
        markdown = sarvam.markdown
        pageCount = sarvam.pageCount
        rows = sarvam.rows
      } catch (err: any) {
        parserWarnings.push(`Sarvam parser failed; falling back to Chandra. ${err?.statusMessage || err?.message || ''}`.trim())
      }
    }

    if (
      parserMode === 'chandra'
      || ((parserMode === 'auto' || parserMode === 'internal' || parserMode === 'sarvam') && !hasUsableRows(rows))
    ) {
      await client.from('documents').update({
        status: 'ocr',
        updated_at: new Date().toISOString()
      }).eq('id', params.doc.id)

      const chandra = await runChandraPriceExtraction({
        fileData,
        filename: params.filename,
        mime: params.mime
      })
      requestId = chandra.requestId
      selectedParserName = 'chandra'
      markdown = chandra.markdown
      pageCount = chandra.pageCount
      rows = chandra.rows
    }

    for (const warning of parserWarnings) console.warn(warning)

    await storageUpload

    if (!params.doc.vendor_id) {
      await ensureVendorForMarkdown({
        client,
        ownerId: params.doc.owner_id,
        docId: params.doc.id,
        filename: params.filename,
        markdown
      })
    }

    await client.from('documents').update({
      status: 'extracting',
      chandra_request_id: requestId,
      parsed_markdown: markdown,
      page_count: pageCount,
      updated_at: new Date().toISOString()
    }).eq('id', params.doc.id)

    if (rows.length > 0) {
      const insertedDocItems = await insertDocItemsInChunks({ client, doc: params.doc, rows })
      await persistCanonicalPriceRecords({
        client,
        doc: params.doc,
        filename: params.filename,
        parserName: selectedParserName,
        markdown,
        rows,
        insertedDocItems
      })
    }

    await client.from('documents').update({
      status: 'parsed',
      updated_at: new Date().toISOString()
    }).eq('id', params.doc.id)
  } catch (err: any) {
    await client.from('documents').update({
      status: 'failed',
      error: err?.statusMessage || err?.message || 'pipeline failed',
      updated_at: new Date().toISOString()
    }).eq('id', params.doc.id)
  }
}

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const client = await userClient(event)
  const contentType = getRequestHeader(event, 'content-type') ?? ''

  if (contentType.includes('application/json')) {
    const body = await readBody<StoredUploadBody>(event)
    const filename = body.filename?.trim()
    const storagePath = body.storage_path?.trim()
    const size = Number(body.size)

    if (!filename || !storagePath || !Number.isFinite(size)) {
      throw createError({ statusCode: 400, statusMessage: 'filename, storage_path, and size are required' })
    }
    if (!body.vendor_name?.trim()) {
      throw createError({ statusCode: 400, statusMessage: 'Vendor name is required.' })
    }
    if (size > MAX_DOCUMENT_UPLOAD_BYTES) {
      throw createError({
        statusCode: 413,
        statusMessage: documentUploadSizeError(filename, size)
      })
    }

    assertOwnedStoragePath(storagePath, user.id)
    const storageSize = await getStorageObjectSize(storagePath)
    if (storageSize !== null && storageSize > MAX_DOCUMENT_UPLOAD_BYTES) {
      throw createError({
        statusCode: 413,
        statusMessage: documentUploadSizeError(filename, storageSize)
      })
    }

    const vendorId = await resolveVendorId({
      client,
      ownerId: user.id,
      vendorName: body.vendor_name
    })

    const { data: doc, error: docErr } = await client.from('documents').insert({
      owner_id: user.id,
      vendor_id: vendorId,
      filename,
      storage_path: storagePath,
      mime: body.mime ?? null,
      size,
      status: 'ocr'
    }).select().single()
    if (docErr || !doc) throw createError({ statusCode: 500, statusMessage: docErr?.message ?? 'insert failed' })

    enqueueIngest(event, processUploadedDocument({
      doc: { id: doc.id as string, owner_id: user.id, vendor_id: vendorId },
      filename,
      mime: body.mime ?? undefined,
      storagePath,
      storageAlreadyUploaded: true
    }))

    setResponseStatus(event, 202)
    return { ...doc, status: 'ocr', item_count: 0 }
  }

  const form = await readMultipartFormData(event)
  if (!form?.length) throw createError({ statusCode: 400, statusMessage: 'No multipart body' })

  const filePart   = form.find(p => p.name === 'file')
  const vendorPart = form.find(p => p.name === 'vendor_name')
  if (!filePart?.data || !filePart.filename) {
    throw createError({ statusCode: 400, statusMessage: 'file is required' })
  }
  if (filePart.data.length > MAX_DOCUMENT_UPLOAD_BYTES) {
    throw createError({
      statusCode: 413,
      statusMessage: documentUploadSizeError(filePart.filename, filePart.data.length)
    })
  }

  const vendorName = vendorPart?.data?.toString('utf8').trim()
  if (!vendorName) {
    throw createError({ statusCode: 400, statusMessage: 'Vendor name is required.' })
  }
  const vendorId = await resolveVendorId({
    client,
    ownerId: user.id,
    vendorName
  })

  // Create the row immediately; storage upload and parsing continue after the response.
  const storagePath = `${user.id}/${randomUUID()}-${filePart.filename}`
  const { data: doc, error: docErr } = await client.from('documents').insert({
    owner_id: user.id,
    vendor_id: vendorId,
    filename: filePart.filename,
    storage_path: storagePath,
    mime: filePart.type ?? null,
    size: filePart.data.length,
    status: 'uploading'
  }).select().single()
  if (docErr || !doc) throw createError({ statusCode: 500, statusMessage: docErr?.message ?? 'insert failed' })

  enqueueIngest(event, processUploadedDocument({
    doc: { id: doc.id as string, owner_id: user.id, vendor_id: vendorId },
    fileData: filePart.data,
    filename: filePart.filename,
    mime: filePart.type,
    storagePath
  }))

  setResponseStatus(event, 202)
  return { ...doc, status: 'uploading', item_count: 0 }
})
