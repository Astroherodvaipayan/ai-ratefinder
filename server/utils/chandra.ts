/**
 * Datalab Chandra 2 hosted OCR client.
 *
 * Flow:
 *   1. POST /api/v1/convert (multipart) → { request_id, request_check_url }
 *   2. Poll request_check_url until { status: "complete" | "failed" }
 *   3. Result carries markdown / json / pages / images / metadata.
 */

const BASE = 'https://www.datalab.to/api/v1/convert'

export interface ChandraSubmitOptions {
  outputFormat?: 'markdown' | 'json' | 'html'
  useLlm?: boolean
  forceOcr?: boolean
  paginate?: boolean
  maxPages?: number
  language?: string
}

export interface ChandraSubmitResponse {
  success: boolean
  request_id: string
  request_check_url: string
  error?: string
}

export interface ChandraResult {
  status: 'processing' | 'complete' | 'failed'
  success: boolean
  output_format: 'markdown' | 'json' | 'html'
  markdown?: string
  json?: unknown
  html?: string
  pages?: unknown[]
  images?: Record<string, string>
  metadata?: Record<string, unknown>
  page_count?: number
  error?: string
}

function apiKey(): string {
  const key = useRuntimeConfig().datalabApiKey
  if (!key) {
    throw createError({
      statusCode: 500,
      statusMessage: 'DATALAB_API_KEY is not configured'
    })
  }
  return key
}

export async function submitChandra(
  file: Blob | File,
  filename: string,
  opts: ChandraSubmitOptions = {}
): Promise<ChandraSubmitResponse> {
  const form = new FormData()
  form.append('file', file, filename)
  form.append('output_format', opts.outputFormat ?? 'markdown')
  if (opts.useLlm)   form.append('use_llm',   'true')
  if (opts.forceOcr) form.append('force_ocr', 'true')
  if (opts.paginate) form.append('paginate',  'true')
  if (opts.maxPages) form.append('max_pages', String(opts.maxPages))
  if (opts.language) form.append('language',  opts.language)

  const res = await $fetch<ChandraSubmitResponse>(BASE, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey() },
    body: form
  })

  if (!res.success) {
    throw createError({
      statusCode: 502,
      statusMessage: `Chandra submit failed: ${res.error ?? 'unknown'}`
    })
  }
  return res
}

export async function pollChandra(
  checkUrl: string,
  { timeoutMs = 5 * 60_000, intervalMs = 2000 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<ChandraResult> {
  const deadline = Date.now() + timeoutMs
  let delay = intervalMs

  while (Date.now() < deadline) {
    const res = await $fetch<ChandraResult>(checkUrl, {
      headers: { 'X-API-Key': apiKey() }
    })

    if (res.status === 'complete') return res
    if (res.status === 'failed') {
      throw createError({
        statusCode: 502,
        statusMessage: `Chandra processing failed: ${res.error ?? 'unknown'}`
      })
    }

    await new Promise(r => setTimeout(r, delay))
    delay = Math.min(delay * 1.5, 8000)
  }

  throw createError({ statusCode: 504, statusMessage: 'Chandra polling timed out' })
}

/** Submit a file and wait for the parsed result in a single call. */
export async function runChandra(
  file: Blob | File,
  filename: string,
  opts: ChandraSubmitOptions = {}
): Promise<{ requestId: string; result: ChandraResult }> {
  const sub = await submitChandra(file, filename, opts)
  const result = await pollChandra(sub.request_check_url)
  return { requestId: sub.request_id, result }
}
