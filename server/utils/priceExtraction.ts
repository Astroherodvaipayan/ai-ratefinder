import { runChandra, runDatalabExtract } from './chandra'
import { extractPriceRows } from './extract'
import { selectPricePagesForExtraction, splitPaginatedMarkdown } from './pricePages'

export type ExtractedPriceRow = {
  raw_name: string
  sku: string | null
  unit: string | null
  price: number | null
  moq: string | null
  currency: string
  source_page: number | null
}

export interface ChandraPriceExtractionResult {
  requestId: string
  rows: ExtractedPriceRow[]
  markdown: string
  pageCount: number | null
  warnings: string[]
}

export const PRICE_ROW_SCHEMA = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      description: 'Every priced product, SKU, size, variant, packing/length, and rate line found in the vendor price list. For matrix tables with multiple rate columns, emit one row per priced cell.',
      items: {
        type: 'object',
        properties: {
          raw_name: {
            type: 'string',
            description: 'Full product description including the nearby section/table title, brand/series/variant, size, grade, cable type, and rate basis when relevant. For compact tables such as "RATNA CO-AXIAL CABLES" with row "RG-6F" and rate columns "90 MTRS." / "305 MTRS.", emit separate rows like "RATNA CO-AXIAL CABLES RG-6F 90 MTRS." and "RATNA CO-AXIAL CABLES RG-6F 305 MTRS.".'
          },
          sku: {
            type: ['string', 'null'],
            description: 'SKU, item code, conductor/wire size, catalogue number, or model number if present.'
          },
          unit: {
            type: ['string', 'null'],
            description: 'Unit exactly as implied by the table, such as per mtr, per 90m coil, per 300m coil, pc, kg, box.'
          },
          price: {
            type: ['number', 'null'],
            description: 'Numeric price/rate/MRP/list price. Do not include currency symbols, commas, or "/-".'
          },
          moq: {
            type: ['string', 'null'],
            description: 'Minimum order quantity, packing size, standard coil packing, carton quantity, or null if absent.'
          },
          currency: {
            type: 'string',
            description: 'Currency code. Use INR if the document uses rupees or does not explicitly state another currency.'
          },
          source_page: {
            type: ['integer', 'null'],
            description: '1-based source page number for the row if known.'
          }
        },
        required: ['raw_name', 'currency']
      }
    }
  },
  required: ['rows']
}

function parseDatalabPrice(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const cleaned = String(value)
    .replace(/[₹$€,\s]/g, '')
    .replace(/\b(rs|inr|mrp|rate|each|ea|pc|pcs|nos?|mtr|meter|kg|box|coil|roll)\b/gi, '')
    .replace(/[^\d.\-]/g, '')
  if (!cleaned) return null
  const price = Number(cleaned)
  return Number.isFinite(price) ? price : null
}

function parseDatalabPage(value: unknown): number | null {
  if (Number.isInteger(value)) return value as number
  const page = Number(String(value ?? '').replace(/[^\d-]/g, ''))
  return Number.isInteger(page) ? page : null
}

export function parseDatalabRows(result: Awaited<ReturnType<typeof runDatalabExtract>>['result']): ExtractedPriceRow[] {
  const raw = result.extraction_schema_json
  if (!raw) return []

  let parsed: any
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return []
    }
  } else {
    parsed = raw
  }

  const rows = Array.isArray(parsed?.rows)
    ? parsed.rows
    : Array.isArray(parsed)
      ? parsed
      : []

  const seen = new Set<string>()
  return rows.flatMap((row: any) => {
    const rawName = typeof row?.raw_name === 'string'
      ? row.raw_name.trim()
      : typeof row?.product === 'string'
        ? row.product.trim()
        : ''
    if (!rawName) return []

    const parsedRow = {
      raw_name: rawName,
      sku: typeof row.sku === 'string' && row.sku.trim() ? row.sku.trim() : null,
      unit: typeof row.unit === 'string' && row.unit.trim() ? row.unit.trim() : null,
      price: parseDatalabPrice(row.price),
      moq: typeof row.moq === 'string' && row.moq.trim() ? row.moq.trim() : null,
      currency: typeof row.currency === 'string' && row.currency.trim() ? row.currency.trim() : 'INR',
      source_page: parseDatalabPage(row.source_page)
    }
    const key = JSON.stringify([
      parsedRow.raw_name.toLowerCase(),
      parsedRow.sku?.toLowerCase() ?? '',
      parsedRow.unit?.toLowerCase() ?? '',
      parsedRow.price
    ])
    if (seen.has(key)) return []
    seen.add(key)
    return [parsedRow]
  })
}

function hasPricedRows(rows: ExtractedPriceRow[]) {
  return rows.some(row => row.price !== null && /[a-z0-9]/i.test(row.raw_name))
}

function regexRowsFromMarkdown(
  markdown: string,
  pageSelection: ReturnType<typeof selectPricePagesForExtraction>,
  markdownPages = splitPaginatedMarkdown(markdown)
) {
  const selectedFallbackPages = pageSelection.pageNumbers.length
    ? new Set(pageSelection.pageNumbers)
    : null
  const pagesForFallback = markdownPages.length
    ? selectedFallbackPages
      ? markdownPages.filter(page => selectedFallbackPages.has(page.pageNumber))
      : markdownPages
    : [{ pageNumber: null, markdown }]

  return pagesForFallback.flatMap(page =>
    extractPriceRows(page.markdown).map(r => ({
      ...r,
      source_page: r.source_page ?? page.pageNumber
    }))
  )
}

export async function runChandraPriceExtraction(params: {
  fileData: Buffer
  filename: string
  mime?: string | null
}): Promise<ChandraPriceExtractionResult> {
  const contentType = params.mime || 'application/octet-stream'
  const blob = new Blob([new Uint8Array(params.fileData)], { type: contentType })
  const warnings: string[] = []
  let requestId = ''
  let markdown = ''
  let pageCount: number | null = null
  let rows: ExtractedPriceRow[] = []
  let checkpointId: string | null = null

  try {
    const direct = await runDatalabExtract({
      pageSchema: PRICE_ROW_SCHEMA,
      file: blob,
      filename: params.filename,
      mode: 'fast',
      outputFormat: 'markdown',
      saveCheckpoint: true
    })
    requestId = direct.requestId
    markdown = direct.result.markdown ?? ''
    pageCount = direct.result.page_count ?? null
    checkpointId = direct.result.checkpoint_id ?? null
    rows = parseDatalabRows(direct.result)
  } catch (err: any) {
    warnings.push(`Datalab direct structured extraction failed; falling back to OCR convert. ${err?.statusMessage || err?.message || ''}`.trim())
  }

  if (!hasPricedRows(rows) || !markdown) {
    const converted = await runChandra(blob, params.filename, {
      outputFormat: 'markdown',
      mode: 'fast',
      paginate: true,
      saveCheckpoint: true,
      forceOcr: params.mime?.startsWith('image/') ?? false,
      disableImageExtraction: true,
      disableImageCaptions: true
    })
    requestId ||= converted.requestId
    markdown ||= converted.result.markdown ?? ''
    pageCount ??= converted.result.page_count ?? null
    checkpointId ||= converted.result.checkpoint_id ?? null
  }

  if (!hasPricedRows(rows)) {
    const markdownPages = splitPaginatedMarkdown(markdown)
    const pricePageSelection = selectPricePagesForExtraction(markdownPages, pageCount)

    if (pricePageSelection.shouldRunStructuredExtraction) {
      try {
        const focused = await runDatalabExtract({
          pageSchema: PRICE_ROW_SCHEMA,
          checkpointId,
          file: checkpointId ? undefined : blob,
          filename: checkpointId ? undefined : params.filename,
          mode: 'fast',
          outputFormat: 'markdown',
          pageRange: pricePageSelection.pageRange ?? undefined
        })
        requestId ||= focused.requestId
        rows = parseDatalabRows(focused.result)
        markdown ||= focused.result.markdown ?? ''
        pageCount ??= focused.result.page_count ?? null
      } catch (err: any) {
        warnings.push(`Datalab focused structured extraction failed; using regex fallback. ${err?.statusMessage || err?.message || ''}`.trim())
      }
    } else {
      warnings.push('Focused structured extraction was skipped because no reliable price pages were selected.')
    }

    if (!hasPricedRows(rows)) {
      rows = regexRowsFromMarkdown(markdown, pricePageSelection, markdownPages)
      if (!rows.length) warnings.push('Regex fallback did not find any product/price rows.')
    }
  }

  return {
    requestId,
    rows,
    markdown,
    pageCount,
    warnings
  }
}
