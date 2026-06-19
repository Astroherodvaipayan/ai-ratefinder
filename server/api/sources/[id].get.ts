import { adminClient } from '../../utils/supabase'

function asNumber(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function formatPriceValue(value: unknown) {
  const number = asNumber(value)
  if (number === null) return String(value ?? '')
  const rounded = Math.round(number * 100) / 100
  return Number.isInteger(rounded) ? String(rounded) : String(rounded)
}

function signedUrlForPage(baseUrl: string, page: number | null) {
  const params: string[] = []
  if (page) params.push(`page=${page}`)
  return params.length ? `${baseUrl}#${params.join('&')}` : baseUrl
}

function sourceDocument(row: any) {
  const doc = row.documents
  if (!doc?.storage_path) {
    throw createError({ statusCode: 404, statusMessage: 'Source file not found' })
  }
  return doc
}

async function signedSourceUrl(document: any, page: number | null) {
  const { data, error } = await adminClient().storage
    .from('uploads')
    .createSignedUrl(document.storage_path, 300)
  if (error || !data) {
    throw createError({ statusCode: 500, statusMessage: error?.message ?? 'Could not sign source file' })
  }
  return signedUrlForPage(data.signedUrl, page)
}

function canonicalEvidence(row: any, fileUrl: string, cells: any[]) {
  const matchRow = asNumber(row.source_row_index)
  const matchCol = asNumber(row.source_col_index)
  return {
    kind: 'canonical' as const,
    id: row.id,
    legacy_doc_item_id: row.legacy_doc_item_id,
    document: {
      id: row.document_id,
      filename: row.documents?.filename ?? 'Source document',
      mime: row.documents?.mime ?? null,
      vendor: row.documents?.vendor?.name ?? null
    },
    file_url: fileUrl,
    source_page: row.source_page ?? null,
    table: {
      id: row.source_table_id,
      title: row.table_title ?? null,
      section_breadcrumb: row.section_breadcrumb ?? [],
      row_index: matchRow,
      col_index: matchCol
    },
    match: {
      description: row.description_text ?? row.product_text ?? null,
      sku: row.sku_text ?? null,
      row_headers: row.row_headers ?? [],
      column_headers: row.column_headers ?? [],
      parent_headers: row.parent_headers ?? [],
      nearby_notes: row.nearby_notes ?? [],
      raw_cell_value: row.raw_cell_value ?? null,
      price: Number(row.normalized_price ?? 0),
      currency: row.currency ?? 'INR',
      unit: row.unit ?? null,
      moq: row.moq ?? null
    },
    cells: cells.map(cell => ({
      id: cell.id,
      row_index: cell.source_row_index,
      col_index: cell.source_col_index,
      rowspan: cell.source_rowspan,
      colspan: cell.source_colspan,
      is_header: Boolean(cell.is_header),
      is_price: Boolean(cell.is_price),
      is_match: Boolean(
        row.source_cell_id && cell.id === row.source_cell_id
        || (matchRow !== null && matchCol !== null && cell.source_row_index === matchRow && cell.source_col_index === matchCol)
      ),
      text: cell.raw_cell_value ?? cell.normalized_value ?? '',
      row_headers: cell.row_headers ?? [],
      column_headers: cell.column_headers ?? [],
      parent_headers: cell.parent_headers ?? [],
      unit: cell.unit ?? null,
      currency: cell.currency ?? null,
      moq: cell.moq ?? null,
      bbox: cell.bbox ?? null
    }))
  }
}

function legacyEvidence(row: any, fileUrl: string) {
  return {
    kind: 'legacy' as const,
    id: row.id,
    legacy_doc_item_id: row.id,
    document: {
      id: row.document_id,
      filename: row.documents?.filename ?? 'Source document',
      mime: row.documents?.mime ?? null,
      vendor: row.documents?.vendor?.name ?? null
    },
    file_url: fileUrl,
    source_page: row.source_page ?? null,
    table: {
      id: null,
      title: row.documents?.filename ?? null,
      section_breadcrumb: [row.documents?.vendor?.name, row.documents?.filename].filter(Boolean),
      row_index: null,
      col_index: null
    },
    match: {
      description: row.raw_name,
      sku: row.sku ?? null,
      row_headers: [row.raw_name, row.sku].filter(Boolean),
      column_headers: [row.unit].filter(Boolean),
      parent_headers: [row.documents?.vendor?.name].filter(Boolean),
      nearby_notes: [],
      raw_cell_value: row.price === null || row.price === undefined ? null : formatPriceValue(row.price),
      price: row.price === null || row.price === undefined ? null : Number(row.price),
      currency: row.currency ?? 'INR',
      unit: row.unit ?? null,
      moq: row.moq ?? null
    },
    cells: []
  }
}

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const id = getRouterParam(event, 'id')!
  const client = await userClient(event)

  const canonical = await client
    .from('doc_price_items')
    .select(`
      id, legacy_doc_item_id, document_id, source_page, source_table_id, source_cell_id,
      source_row_index, source_col_index, section_breadcrumb, table_title,
      row_headers, column_headers, parent_headers, nearby_notes, raw_cell_value,
      normalized_price, currency, unit, moq, product_text, sku_text, description_text,
      documents:document_id(id, filename, mime, storage_path, vendor:vendor_id(name))
    `)
    .eq('id', id)
    .maybeSingle()
  if (canonical.error) {
    throw createError({ statusCode: 500, statusMessage: canonical.error.message })
  }

  if (canonical.data) {
    const doc = sourceDocument(canonical.data)
    const fileUrl = await signedSourceUrl(
      doc,
      canonical.data.source_page ?? null
    )

    let cells: any[] = []
    if (canonical.data.source_table_id) {
      let cellQuery = client
        .from('doc_table_cells')
        .select(`
          id, source_row_index, source_col_index, source_rowspan, source_colspan,
          is_header, is_price, row_headers, column_headers, parent_headers,
          raw_cell_value, normalized_value, unit, currency, moq, bbox
        `)
        .eq('source_table_id', canonical.data.source_table_id)
        .order('source_row_index', { ascending: true })
        .order('source_col_index', { ascending: true })

      if (canonical.data.source_row_index !== null && canonical.data.source_row_index !== undefined) {
        cellQuery = cellQuery.or(`is_header.eq.true,source_row_index.eq.${canonical.data.source_row_index}`)
      } else {
        cellQuery = cellQuery.eq('is_header', true)
      }

      const cellResult = await cellQuery.limit(300)
      if (!cellResult.error) cells = cellResult.data ?? []
    }

    return canonicalEvidence(canonical.data, fileUrl, cells)
  }

  const legacy = await client
    .from('doc_items')
    .select(`
      id, document_id, raw_name, sku, unit, price, moq, currency, source_page,
      documents:document_id(id, filename, mime, storage_path, vendor:vendor_id(name))
    `)
    .eq('id', id)
    .maybeSingle()
  if (legacy.error) {
    throw createError({ statusCode: 500, statusMessage: legacy.error.message })
  }
  if (!legacy.data) {
    throw createError({ statusCode: 404, statusMessage: 'Source match not found' })
  }

  const doc = sourceDocument(legacy.data)
  const fileUrl = await signedSourceUrl(
    doc,
    legacy.data.source_page ?? null
  )
  return legacyEvidence(legacy.data, fileUrl)
})
