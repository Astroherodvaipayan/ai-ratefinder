import { parseInternalPriceDocument } from '../../utils/internalPriceParser'
import { runChandraPriceExtraction, type ExtractedPriceRow } from '../../utils/priceExtraction'
import { getParserSettings } from '../../utils/parserSettings'
import { runSarvamPriceExtraction } from '../../utils/sarvam'
import {
  MAX_DOCUMENT_UPLOAD_BYTES,
  documentUploadSizeError
} from '~~/shared/documentUpload'
import type { PriceRow } from '~~/shared/schemas'

const ROW_SAMPLE_LIMIT = 50

type EvalRows = Array<PriceRow | ExtractedPriceRow>

interface EvalSide {
  ok: boolean
  parser: string
  supported?: boolean
  row_count: number
  duration_ms: number
  warnings: string[]
  error: string | null
  rows: EvalRows
}

type TimedEvalSide = EvalSide & { allRows: EvalRows }

function normaliseText(value: string | null | undefined) {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function rowKey(row: PriceRow | ExtractedPriceRow) {
  const sku = normaliseText(row.sku)
  const name = normaliseText(row.raw_name)
  const price = row.price === null ? '' : Number(row.price).toFixed(2)
  return `${sku || name}|${price}`
}

function compareRows(params: {
  internalRows: EvalRows
  chandraRows: EvalRows
  sarvamRows: EvalRows
}) {
  const rowSets = {
    internal: new Set(params.internalRows.map(rowKey)),
    chandra: new Set(params.chandraRows.map(rowKey)),
    sarvam: new Set(params.sarvamRows.map(rowKey))
  }
  const allKeys = new Set([...rowSets.internal, ...rowSets.chandra, ...rowSets.sarvam])
  let shared_count = 0
  for (const key of allKeys) {
    const appearances = Number(rowSets.internal.has(key))
      + Number(rowSets.chandra.has(key))
      + Number(rowSets.sarvam.has(key))
    if (appearances >= 2) shared_count++
  }

  return {
    shared_count,
    internal_only_count: [...rowSets.internal].filter(key => !rowSets.chandra.has(key) && !rowSets.sarvam.has(key)).length,
    chandra_only_count: [...rowSets.chandra].filter(key => !rowSets.internal.has(key) && !rowSets.sarvam.has(key)).length,
    sarvam_only_count: [...rowSets.sarvam].filter(key => !rowSets.internal.has(key) && !rowSets.chandra.has(key)).length
  }
}

async function timedSide<T extends { rows: EvalRows; warnings: string[] }>(
  parser: string,
  run: () => Promise<T>,
  extra?: (result: T) => Partial<EvalSide>
): Promise<TimedEvalSide> {
  const started = Date.now()
  try {
    const result = await run()
    return {
      ok: true,
      parser,
      row_count: result.rows.length,
      duration_ms: Date.now() - started,
      warnings: result.warnings,
      error: null,
      rows: result.rows.slice(0, ROW_SAMPLE_LIMIT),
      allRows: result.rows,
      ...extra?.(result)
    }
  } catch (err: any) {
    return {
      ok: false,
      parser,
      row_count: 0,
      duration_ms: Date.now() - started,
      warnings: [],
      error: err?.statusMessage || err?.message || 'Parser failed',
      rows: [],
      allRows: []
    }
  }
}

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const client = await userClient(event)
  const settings = await getParserSettings(client, user.id)
  const form = await readMultipartFormData(event)
  const filePart = form?.find(part => part.name === 'file')

  if (!filePart?.data || !filePart.filename) {
    throw createError({ statusCode: 400, statusMessage: 'file is required' })
  }
  if (filePart.data.length > MAX_DOCUMENT_UPLOAD_BYTES) {
    throw createError({
      statusCode: 413,
      statusMessage: documentUploadSizeError(filePart.filename, filePart.data.length)
    })
  }

  const fileData = filePart.data
  const filename = filePart.filename
  const mime = filePart.type ?? null

  const [internalResult, chandraResult, sarvamResult] = await Promise.all([
    timedSide(
      'internal',
      () => parseInternalPriceDocument({ fileData, filename, mime }),
      result => ({ parser: result.parser, supported: result.supported })
    ),
    timedSide(
      'chandra',
      () => runChandraPriceExtraction({ fileData, filename, mime })
    ),
    timedSide(
      'sarvam',
      () => runSarvamPriceExtraction({
        fileData,
        filename,
        mime,
        language: settings.sarvam_language
      })
    )
  ])
  const { allRows: internalRows, ...internal } = internalResult
  const { allRows: chandraRows, ...chandra } = chandraResult
  const { allRows: sarvamRows, ...sarvam } = sarvamResult

  return {
    filename,
    internal,
    chandra,
    sarvam,
    comparison: compareRows({ internalRows, chandraRows, sarvamRows })
  }
})
