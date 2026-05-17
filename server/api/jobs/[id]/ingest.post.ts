/**
 * Ingest a file for an existing job.
 *
 *   - Uploads the file to Supabase Storage under `uploads/<owner>/<job>/<name>`.
 *   - Runs Chandra 2 (markdown output).
 *   - For ingest_price_list: parses tables → inserts price_list_items and
 *     creates products on first sight.
 *   - For ingest_boq: parses tables → inserts boq_items.
 *   - Writes a transcript message into job_messages with the structured result
 *     so the chat UI can render the table.
 */
import { randomUUID } from 'node:crypto'
import { extractPriceRows, extractBoqLines } from '../../../utils/extract'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const jobId = getRouterParam(event, 'id')!
  const client = await userClient(event)

  const { data: job, error: jobErr } = await client
    .from('jobs').select('*').eq('id', jobId).single()
  if (jobErr || !job) throw createError({ statusCode: 404, statusMessage: 'Job not found' })

  const form = await readMultipartFormData(event)
  const file = form?.find(p => p.name === 'file')
  if (!file?.data || !file.filename) {
    throw createError({ statusCode: 400, statusMessage: 'file is required' })
  }

  const storagePath = `${user.id}/${jobId}/${randomUUID()}-${file.filename}`
  const { error: upErr } = await client.storage
    .from('uploads')
    .upload(storagePath, file.data, {
      contentType: file.type || 'application/octet-stream',
      upsert: false
    })
  if (upErr) throw createError({ statusCode: 500, statusMessage: upErr.message })

  await client.from('jobs').update({
    status: 'ocr',
    source_path: storagePath,
    updated_at: new Date().toISOString()
  }).eq('id', jobId)

  await client.from('job_messages').insert({
    job_id: jobId,
    role: 'user',
    content: `Uploaded ${file.filename}`,
    data: { filename: file.filename, size: file.data.length }
  })

  // Chandra 2 — markdown output, force OCR for scanned PDFs, use_llm for tables.
  const blob = new Blob([file.data], { type: file.type })
  const { requestId, result } = await runChandra(blob, file.filename, {
    outputFormat: 'markdown',
    useLlm: true,
    forceOcr: file.type?.startsWith('image/') || file.filename.toLowerCase().endsWith('.pdf')
  })

  await client.from('jobs').update({
    status: 'extracting',
    chandra_request_id: requestId,
    updated_at: new Date().toISOString()
  }).eq('id', jobId)

  const markdown = result.markdown ?? ''

  // Branch by job kind.
  if (job.kind === 'ingest_price_list') {
    if (!job.vendor_id) {
      throw createError({ statusCode: 400, statusMessage: 'vendor_id required for price-list ingest' })
    }
    const rows = extractPriceRows(markdown)
    if (rows.length > 0) {
      const inserts = rows.map(r => ({
        owner_id: user.id,
        vendor_id: job.vendor_id,
        source_job_id: jobId,
        raw_name: r.raw_name,
        sku: r.sku,
        unit: r.unit,
        price: r.price,
        currency: r.currency,
        raw_row: r.raw_row ?? null
      }))
      await client.from('price_list_items').insert(inserts)
    }

    await client.from('job_messages').insert({
      job_id: jobId,
      role: 'assistant',
      content: `Extracted ${rows.length} price row${rows.length === 1 ? '' : 's'} from ${file.filename}.`,
      data: { kind: 'price_rows', rows, page_count: result.page_count ?? null }
    })
  } else if (job.kind === 'ingest_boq') {
    const lines = extractBoqLines(markdown)
    if (lines.length > 0) {
      await client.from('boq_items').insert(lines.map(l => ({
        owner_id: user.id,
        job_id: jobId,
        line_no: l.line_no,
        description: l.description,
        qty: l.qty,
        unit: l.unit,
        remarks: l.remarks
      })))
    }
    await client.from('job_messages').insert({
      job_id: jobId,
      role: 'assistant',
      content: `Found ${lines.length} BOQ line item${lines.length === 1 ? '' : 's'}.`,
      data: { kind: 'boq_lines', lines, page_count: result.page_count ?? null }
    })
  }

  await client.from('jobs').update({
    status: 'ready',
    updated_at: new Date().toISOString()
  }).eq('id', jobId)

  return { ok: true, jobId, requestId, markdownLength: markdown.length }
})
