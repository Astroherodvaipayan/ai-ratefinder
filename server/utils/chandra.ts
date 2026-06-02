/**
 * Datalab Chandra 2 hosted OCR client.
 *
 * Flow:
 *   1. POST /api/v1/convert (multipart) → { request_id, request_check_url }
 *   2. Poll request_check_url until { status: "complete" | "failed" }
 *   3. Result carries markdown / json / pages / images / metadata.
 */

const CONVERT_ENDPOINT = 'https://www.datalab.to/api/v1/convert'
const EXTRACT_ENDPOINT = 'https://www.datalab.to/api/v1/extract'

export interface ChandraSubmitOptions {
  outputFormat?: 'markdown' | 'json' | 'html'
  mode?: 'fast' | 'balanced' | 'accurate'
  useLlm?: boolean
  forceOcr?: boolean
  paginate?: boolean
  maxPages?: number
  pageRange?: string
  language?: string
  saveCheckpoint?: boolean
  skipCache?: boolean
  disableImageExtraction?: boolean
  disableImageCaptions?: boolean
  tokenEfficientMarkdown?: boolean
  extras?: string[]
  additionalConfig?: Record<string, unknown>
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
  output_format: 'markdown' | 'json' | 'html' | 'chunks'
  markdown?: string
  json?: unknown
  html?: string
  pages?: unknown[]
  images?: Record<string, string>
  metadata?: Record<string, unknown>
  page_count?: number
  checkpoint_id?: string
  error?: string
}

export interface DatalabExtractOptions {
  pageSchema: Record<string, unknown>
  file?: Blob | File
  filename?: string
  checkpointId?: string | null
  outputFormat?: 'markdown' | 'json' | 'html' | 'chunks'
  mode?: 'fast' | 'balanced' | 'accurate'
  maxPages?: number
  pageRange?: string
  saveCheckpoint?: boolean
  skipCache?: boolean
}

export interface DatalabExtractResult extends ChandraResult {
  extraction_schema_json?: string | Record<string, unknown>
  extraction_score_average?: number
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
  if (opts.mode)     form.append('mode', opts.mode)
  if (opts.useLlm)   form.append('use_llm',   'true')
  if (opts.forceOcr) form.append('force_ocr', 'true')
  if (opts.paginate) form.append('paginate',  'true')
  if (opts.maxPages) form.append('max_pages', String(opts.maxPages))
  if (opts.pageRange) form.append('page_range', opts.pageRange)
  if (opts.language) form.append('language',  opts.language)
  if (opts.saveCheckpoint) form.append('save_checkpoint', 'true')
  if (opts.skipCache) form.append('skip_cache', 'true')
  if (opts.disableImageExtraction) form.append('disable_image_extraction', 'true')
  if (opts.disableImageCaptions) form.append('disable_image_captions', 'true')
  if (opts.tokenEfficientMarkdown) form.append('token_efficient_markdown', 'true')
  if (opts.extras?.length) form.append('extras', opts.extras.join(','))
  if (opts.additionalConfig) form.append('additional_config', JSON.stringify(opts.additionalConfig))

  const res = await $fetch<ChandraSubmitResponse>(CONVERT_ENDPOINT, {
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

export async function submitDatalabExtract(
  opts: DatalabExtractOptions
): Promise<ChandraSubmitResponse> {
  const form = new FormData()
  form.append('page_schema', JSON.stringify(opts.pageSchema))
  form.append('output_format', opts.outputFormat ?? 'markdown')
  form.append('mode', opts.mode ?? 'fast')
  if (opts.maxPages) form.append('max_pages', String(opts.maxPages))
  if (opts.pageRange) form.append('page_range', opts.pageRange)
  if (opts.saveCheckpoint) form.append('save_checkpoint', 'true')
  if (opts.skipCache) form.append('skip_cache', 'true')
  if (opts.checkpointId) form.append('checkpoint_id', opts.checkpointId)
  if (!opts.checkpointId && opts.file && opts.filename) {
    form.append('file', opts.file, opts.filename)
  }

  const res = await $fetch<ChandraSubmitResponse>(EXTRACT_ENDPOINT, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey() },
    body: form
  })

  if (!res.success) {
    throw createError({
      statusCode: 502,
      statusMessage: `Datalab extract failed: ${res.error ?? 'unknown'}`
    })
  }
  return res
}

export async function pollDatalabExtract(
  checkUrl: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<DatalabExtractResult> {
  return await pollChandra(checkUrl, opts) as DatalabExtractResult
}

export async function runDatalabExtract(
  opts: DatalabExtractOptions
): Promise<{ requestId: string; result: DatalabExtractResult }> {
  const sub = await submitDatalabExtract(opts)
  const result = await pollDatalabExtract(sub.request_check_url)
  return { requestId: sub.request_id, result }
}
