import { setHeader } from 'h3'

type OfferStatus = 'published' | 'quarantined'

interface CatalogueOfferRow {
  id: string
  document_id: string
  vendor_id: string | null
  status: OfferStatus
  category: string
  canonical_name: string
  brand: string | null
  sku: string | null
  facets: Record<string, unknown>
  amount: number
  currency: string
  basis_quantity: number | null
  basis_unit: string | null
  package_type: string | null
  moq: string | null
  source_page: number | null
  source_table_index: number | null
  source_row_index: number
  source_col_index: number
  source_table_title: string | null
  source_row_label: string | null
  source_column_label: string | null
  raw_price_value: string
  source_excerpt: string
  validation_errors: string[]
  compiled_at: string
  document: { filename: string } | Array<{ filename: string }> | null
  vendor: { name: string } | Array<{ name: string }> | null
}

interface FilterSet {
  status: OfferStatus
  category: string
  reason: string
  search: string
}

const DATABASE_PAGE_SIZE = 1000
const SELECT_COLUMNS = `
  id, document_id, vendor_id, status, category, canonical_name, brand, sku, facets,
  amount, currency, basis_quantity, basis_unit, package_type, moq,
  source_page, source_table_index, source_row_index, source_col_index,
  source_table_title, source_row_label, source_column_label, raw_price_value,
  source_excerpt, validation_errors, compiled_at,
  document:documents(filename), vendor:vendors(name)
`
const metadataCache = new Map<string, {
  reasonCounts: Array<{ value: string; count: number }>
  categoryCounts: Array<{ value: string; count: number }>
}>()

function scalarRelation<T>(relation: T | T[] | null): T | null {
  return Array.isArray(relation) ? relation[0] ?? null : relation
}

function normaliseRow(row: CatalogueOfferRow) {
  return {
    ...row,
    amount: Number(row.amount),
    basis_quantity: row.basis_quantity === null ? null : Number(row.basis_quantity),
    document: scalarRelation(row.document),
    vendor: scalarRelation(row.vendor)
  }
}

function countValues(values: string[]) {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

async function getMetadata(
  client: Awaited<ReturnType<typeof userClient>>,
  releaseId: string,
  status: OfferStatus
) {
  const cacheKey = `${releaseId}:${status}`
  const cached = metadataCache.get(cacheKey)
  if (cached) return cached

  const categories: string[] = []
  const reasons: string[] = []
  for (let from = 0; ; from += DATABASE_PAGE_SIZE) {
    const { data, error } = await client
      .from('catalog_offers')
      .select('category, validation_errors')
      .eq('release_id', releaseId)
      .eq('status', status)
      .range(from, from + DATABASE_PAGE_SIZE - 1)

    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    const batch = (data ?? []) as Array<{ category: string; validation_errors: string[] }>
    for (const row of batch) {
      categories.push(row.category)
      reasons.push(...row.validation_errors)
    }
    if (batch.length < DATABASE_PAGE_SIZE) break
  }

  const metadata = {
    reasonCounts: countValues(reasons),
    categoryCounts: countValues(categories)
  }
  metadataCache.set(cacheKey, metadata)
  return metadata
}

function applyFilters(request: any, filters: FilterSet) {
  let filtered = request
    .eq('status', filters.status)

  if (filters.category) filtered = filtered.eq('category', filters.category)
  if (filters.reason && filters.status === 'quarantined') {
    filtered = filtered.contains('validation_errors', [filters.reason])
  }
  if (filters.search) {
    const pattern = `%${filters.search}%`
    filtered = filtered.or([
      `canonical_name.ilike.${pattern}`,
      `sku.ilike.${pattern}`,
      `brand.ilike.${pattern}`,
      `source_row_label.ilike.${pattern}`,
      `source_column_label.ilike.${pattern}`,
      `raw_price_value.ilike.${pattern}`
    ].join(','))
  }

  return filtered
}

function ordered(request: any) {
  return request
    .order('document_id')
    .order('source_table_index')
    .order('source_row_index')
    .order('source_col_index')
}

async function fetchExportRows(
  client: Awaited<ReturnType<typeof userClient>>,
  releaseId: string,
  filters: FilterSet
) {
  const rows: CatalogueOfferRow[] = []
  for (let from = 0; ; from += DATABASE_PAGE_SIZE) {
    let request = client
      .from('catalog_offers')
      .select(SELECT_COLUMNS)
      .eq('release_id', releaseId)
    request = ordered(applyFilters(request, filters))
    const { data, error } = await request.range(from, from + DATABASE_PAGE_SIZE - 1)
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    const batch = (data ?? []) as unknown as CatalogueOfferRow[]
    rows.push(...batch)
    if (batch.length < DATABASE_PAGE_SIZE) break
  }
  return rows.map(normaliseRow)
}

function csvCell(value: unknown) {
  let text = value === null || value === undefined
    ? ''
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value)

  // Prevent spreadsheet software from treating source-controlled text as a formula.
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

function toCsv(rows: Array<ReturnType<typeof normaliseRow>>) {
  const headers = [
    'id', 'status', 'document', 'vendor', 'category', 'canonical_name', 'brand', 'sku',
    'amount', 'currency', 'basis_quantity', 'basis_unit', 'package_type', 'moq',
    'validation_errors', 'facets', 'source_page', 'source_table_index',
    'source_row_index', 'source_col_index', 'source_table_title',
    'source_row_label', 'source_column_label', 'raw_price_value', 'source_excerpt'
  ]

  const lines = rows.map(row => [
    row.id,
    row.status,
    row.document?.filename,
    row.vendor?.name,
    row.category,
    row.canonical_name,
    row.brand,
    row.sku,
    row.amount,
    row.currency,
    row.basis_quantity,
    row.basis_unit,
    row.package_type,
    row.moq,
    row.validation_errors.join(' | '),
    row.facets,
    row.source_page,
    row.source_table_index,
    row.source_row_index,
    row.source_col_index,
    row.source_table_title,
    row.source_row_label,
    row.source_column_label,
    row.raw_price_value,
    row.source_excerpt
  ].map(csvCell).join(','))

  return `\uFEFF${headers.map(csvCell).join(',')}\n${lines.join('\n')}\n`
}

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const client = await userClient(event)
  const query = getQuery(event)

  const { data: release, error: releaseError } = await client
    .from('catalog_releases')
    .select('id, compiler_version, offers_published, offers_quarantined, activated_at')
    .eq('status', 'active')
    .maybeSingle()

  if (releaseError) throw createError({ statusCode: 500, statusMessage: releaseError.message })
  if (!release) throw createError({ statusCode: 404, statusMessage: 'No active catalogue release was found' })

  const status: OfferStatus = query.status === 'published' ? 'published' : 'quarantined'
  // Strip PostgREST filter punctuation while preserving useful product punctuation.
  const search = typeof query.search === 'string'
    ? query.search.trim().replace(/[^\p{L}\p{N}\s.\-]/gu, ' ').replace(/\s+/g, ' ').trim()
    : ''
  const filters: FilterSet = {
    status,
    search,
    reason: typeof query.reason === 'string' ? query.reason.trim() : '',
    category: typeof query.category === 'string' ? query.category.trim() : ''
  }
  const metadata = await getMetadata(client, release.id, status)

  if (query.export === 'csv') {
    const exportRows = await fetchExportRows(client, release.id, filters)
    setHeader(event, 'content-type', 'text/csv; charset=utf-8')
    setHeader(event, 'content-disposition', `attachment; filename="${status}-catalogue-${new Date().toISOString().slice(0, 10)}.csv"`)
    return toCsv(exportRows)
  }

  const pageSize = Math.min(100, Math.max(10, Number(query.page_size) || 50))
  const requestedPage = Math.max(1, Number(query.page) || 1)
  let request = client
    .from('catalog_offers')
    .select(SELECT_COLUMNS, { count: 'exact' })
    .eq('release_id', release.id)
  request = ordered(applyFilters(request, filters))

  const requestedFrom = (requestedPage - 1) * pageSize
  let { data: rows, count, error } = await request.range(requestedFrom, requestedFrom + pageSize - 1)
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })

  const filteredTotal = count ?? 0
  const pageCount = Math.max(1, Math.ceil(filteredTotal / pageSize))
  const page = Math.min(requestedPage, pageCount)
  if (page !== requestedPage) {
    let fallback = client
      .from('catalog_offers')
      .select(SELECT_COLUMNS, { count: 'exact' })
      .eq('release_id', release.id)
    fallback = ordered(applyFilters(fallback, filters))
    const from = (page - 1) * pageSize
    const fallbackResult = await fallback.range(from, from + pageSize - 1)
    if (fallbackResult.error) throw createError({ statusCode: 500, statusMessage: fallbackResult.error.message })
    rows = fallbackResult.data
  }

  return {
    status,
    release,
    summary: {
      total_current: status === 'published' ? release.offers_published : release.offers_quarantined,
      filtered_total: filteredTotal,
      reason_counts: metadata.reasonCounts,
      category_counts: metadata.categoryCounts
    },
    pagination: {
      page,
      page_size: pageSize,
      page_count: pageCount
    },
    rows: ((rows ?? []) as unknown as CatalogueOfferRow[]).map(normaliseRow)
  }
})
