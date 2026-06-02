export interface MarkdownPage {
  pageNumber: number
  markdown: string
}

export interface PricePageSelection {
  pageNumbers: number[]
  pageRange: string | null
  shouldLimitExtraction: boolean
  shouldRunStructuredExtraction: boolean
}

const PAGE_MARKER_RE = /(?:^|\n{2})\{(\d+)\}-{48}\n{2}/g
const LARGE_DOCUMENT_PAGE_THRESHOLD = 20
const MAX_STRUCTURED_EXTRACTION_PAGES = 20
const PRICE_PAGE_CONTEXT_WINDOW = 1

const PRICE_HEADER_RE = /\b(price|rate|mrp|amount|cost|list\s*price|dealer\s*price|basic\s*price|net\s*rate|unit\s*price)\b/i
const MONEY_RE = /(?:₹|rs\.?|inr)\s*[\d,]+(?:\.\d+)?|[\d,]+(?:\.\d+)?\s*(?:₹|rs\.?|inr)\b/gi
const NUMERIC_TABLE_CELL_RE = /\|\s*[\d,]+(?:\.\d{1,2})?\s*(?:\/-|each|ea|pc|pcs|nos?|mtr|meter|kg|box|coil|roll)?\s*(?=\|)/gi
const PRODUCT_TABLE_RE = /\|.*\b(product|item|description|particulars|material|sku|code|model|cat(?:alogue)?\s*no)\b.*\|/i
const UNIT_RE = /\b(per|uom|unit|nos?|pcs?|mtr|meter|coil|box|kg|set|roll|length)\b/i

function normalisePageNumber(label: number, firstLabel: number) {
  return label + (firstLabel === 0 ? 1 : 0)
}

export function splitPaginatedMarkdown(markdown: string): MarkdownPage[] {
  const markers = [...markdown.matchAll(PAGE_MARKER_RE)].map(match => ({
    label: Number(match[1]),
    index: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length
  })).filter(marker => Number.isFinite(marker.label))

  if (!markers.length) {
    return markdown.trim() ? [{ pageNumber: 1, markdown }] : []
  }

  const firstLabel = markers[0]?.label ?? 0
  const pages: MarkdownPage[] = []
  const leading = markdown.slice(0, markers[0]?.index ?? 0)

  if (leading.trim()) {
    for (let i = 0; i <= markers.length; i++) {
      const start = i === 0 ? 0 : markers[i - 1]!.end
      const end = i < markers.length ? markers[i]!.index : markdown.length
      const body = markdown.slice(start, end).trim()
      if (!body) continue

      const label = i < markers.length
        ? markers[i]!.label
        : markers[i - 1]!.label + 1
      pages.push({
        pageNumber: normalisePageNumber(label, firstLabel),
        markdown: body
      })
    }
    return pages
  }

  for (let i = 0; i < markers.length; i++) {
    const body = markdown.slice(markers[i]!.end, markers[i + 1]?.index ?? markdown.length).trim()
    if (!body) continue
    pages.push({
      pageNumber: normalisePageNumber(markers[i]!.label, firstLabel),
      markdown: body
    })
  }

  return pages
}

function priceSignalScore(markdown: string) {
  const tableLike = markdown.includes('|') ? 1 : 0
  const moneyHits = (markdown.match(MONEY_RE) ?? []).length
  const numericTableHits = (markdown.match(NUMERIC_TABLE_CELL_RE) ?? []).length

  let score = 0
  if (PRICE_HEADER_RE.test(markdown)) score += 4
  if (PRODUCT_TABLE_RE.test(markdown)) score += 2
  if (tableLike) score += 1
  if (UNIT_RE.test(markdown)) score += 1
  if (moneyHits >= 1) score += Math.min(4, moneyHits)
  if (numericTableHits >= 6) score += 3
  else if (numericTableHits >= 3) score += 2

  return score
}

function compressPageRange(pageNumbers: number[]) {
  const zeroBasedPages = [...new Set(pageNumbers)]
    .filter(page => page > 0)
    .sort((a, b) => a - b)
    .map(page => page - 1)

  const ranges: string[] = []
  for (let i = 0; i < zeroBasedPages.length; i++) {
    const start = zeroBasedPages[i]!
    let end = start
    while (zeroBasedPages[i + 1] === end + 1) {
      end = zeroBasedPages[++i]!
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`)
  }

  return ranges.join(',')
}

export function selectPricePagesForExtraction(
  pages: MarkdownPage[],
  pageCount: number | null | undefined
): PricePageSelection {
  const totalPages = pageCount ?? pages.length
  const isLargeDocument = totalPages > LARGE_DOCUMENT_PAGE_THRESHOLD || pages.length > LARGE_DOCUMENT_PAGE_THRESHOLD
  if (!isLargeDocument) {
    return {
      pageNumbers: [],
      pageRange: null,
      shouldLimitExtraction: false,
      shouldRunStructuredExtraction: true
    }
  }

  const byNumber = new Map(pages.map(page => [page.pageNumber, page]))
  const selected = new Set<number>()

  for (const page of pages) {
    if (priceSignalScore(page.markdown) < 4) continue

    for (let offset = -PRICE_PAGE_CONTEXT_WINDOW; offset <= PRICE_PAGE_CONTEXT_WINDOW; offset++) {
      const pageNumber = page.pageNumber + offset
      if (byNumber.has(pageNumber)) selected.add(pageNumber)
    }
  }

  const pageNumbers = [...selected].sort((a, b) => a - b)
  if (
    !pageNumbers.length
    || pageNumbers.length >= pages.length
    || pageNumbers.length > MAX_STRUCTURED_EXTRACTION_PAGES
  ) {
    return {
      pageNumbers,
      pageRange: null,
      shouldLimitExtraction: false,
      shouldRunStructuredExtraction: false
    }
  }

  return {
    pageNumbers,
    pageRange: compressPageRange(pageNumbers),
    shouldLimitExtraction: true,
    shouldRunStructuredExtraction: true
  }
}

export function markdownForPages(pages: MarkdownPage[], pageNumbers: number[]) {
  const selected = new Set(pageNumbers)
  return pages
    .filter(page => selected.has(page.pageNumber))
    .map(page => page.markdown)
    .join('\n\n')
}
