/**
 * Upload + run the ingest pipeline for one file.
 *
 *   multipart/form-data:
 *     file:        the price doc
 *     vendor_name: optional free-text vendor name (auto-created if new)
 *
 * Pipeline: storage upload → Chandra OCR (poll) → Gemini extractor → rows.
 * Status transitions on the `documents` row: uploading → ocr → extracting → parsed.
 */
import { randomUUID } from 'node:crypto'
import { runChandra } from '../../utils/chandra'
import { extractPriceRowsLLM } from '../../utils/gemini'
import { extractPriceRows } from '../../utils/extract'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const client = await userClient(event)

  const form = await readMultipartFormData(event)
  if (!form?.length) throw createError({ statusCode: 400, statusMessage: 'No multipart body' })

  const filePart   = form.find(p => p.name === 'file')
  const vendorPart = form.find(p => p.name === 'vendor_name')
  if (!filePart?.data || !filePart.filename) {
    throw createError({ statusCode: 400, statusMessage: 'file is required' })
  }

  // Resolve / create vendor
  let vendorId: string | null = null
  const vendorName = vendorPart?.data?.toString('utf8').trim()
  if (vendorName) {
    const { data: existing } = await client
      .from('vendors').select('id').eq('name', vendorName).maybeSingle()
    if (existing) {
      vendorId = existing.id as string
    } else {
      const { data: created, error } = await client
        .from('vendors').insert({ owner_id: user.id, name: vendorName }).select('id').single()
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      vendorId = created.id as string
    }
  }

  // 1. Storage upload
  const storagePath = `${user.id}/${randomUUID()}-${filePart.filename}`
  const { error: upErr } = await client.storage
    .from('uploads')
    .upload(storagePath, filePart.data, {
      contentType: filePart.type || 'application/octet-stream',
      upsert: false
    })
  if (upErr) throw createError({ statusCode: 500, statusMessage: upErr.message })

  const { data: doc, error: docErr } = await client.from('documents').insert({
    owner_id: user.id,
    vendor_id: vendorId,
    filename: filePart.filename,
    storage_path: storagePath,
    mime: filePart.type ?? null,
    size: filePart.data.length,
    status: 'ocr'
  }).select().single()
  if (docErr || !doc) throw createError({ statusCode: 500, statusMessage: docErr?.message ?? 'insert failed' })

  // 2. Chandra OCR (synchronous for now; move to a background task later)
  try {
    const blob = new Blob([filePart.data], { type: filePart.type })
    const { requestId, result } = await runChandra(blob, filePart.filename, {
      outputFormat: 'markdown',
      useLlm: true,
      forceOcr: (filePart.type?.startsWith('image/') ?? false)
              || filePart.filename.toLowerCase().endsWith('.pdf')
    })

    const markdown = result.markdown ?? ''
    await client.from('documents').update({
      status: 'extracting',
      chandra_request_id: requestId,
      parsed_markdown: markdown,
      page_count: result.page_count ?? null,
      updated_at: new Date().toISOString()
    }).eq('id', doc.id)

    // 3. Gemini extractor (regex fallback if it fails)
    let rows: Array<{
      raw_name: string; sku: string | null; unit: string | null
      price: number | null; moq: string | null; currency: string
      source_page: number | null
    }> = []
    try {
      rows = await extractPriceRowsLLM(markdown)
    } catch {
      rows = []
    }
    if (rows.length === 0) {
      rows = extractPriceRows(markdown).map(r => ({
        ...r, source_page: null
      }))
    }
    if (rows.length > 0) {
      await client.from('doc_items').insert(rows.map(r => ({
        owner_id: user.id,
        document_id: doc.id,
        raw_name: r.raw_name,
        sku: r.sku,
        unit: r.unit,
        price: r.price,
        moq: r.moq,
        currency: r.currency,
        source_page: r.source_page,
        raw_row: null
      })))
    }

    await client.from('documents').update({
      status: 'parsed',
      updated_at: new Date().toISOString()
    }).eq('id', doc.id)

    return { ...doc, status: 'parsed', item_count: rows.length }
  } catch (err: any) {
    await client.from('documents').update({
      status: 'failed',
      error: err?.statusMessage || err?.message || 'pipeline failed',
      updated_at: new Date().toISOString()
    }).eq('id', doc.id)
    throw err
  }
})
