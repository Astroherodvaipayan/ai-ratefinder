/**
 * Retrieval for chat RAG: top-N candidate doc_items + ±N lines of surrounding
 * markdown for each. The surrounding markdown gives Gemini the table header,
 * footnotes ("prices in ₹/100m"), and adjacent rows so it can interpret a
 * cell without us shipping the whole document.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CandidateRow } from './gemini'
import { parsePriceRowsFromGrid } from './internalPriceParser'

const CONTEXT_RADIUS = 10  // lines on either side of the matched row
const MAX_SEARCH_SHARDS = 10
const MARKDOWN_RECOVERY_DOC_LIMIT = 20
const MARKDOWN_RECOVERY_ROW_LIMIT = 80
const NORMALIZED_FALLBACK_ROW_LIMIT = 500

type RetrievedRow = {
  doc_item_id: string; document_id: string; raw_name: string;
  sku: string | null; unit: string | null; price: number | null;
  moq: string | null; currency: string; source_page: number | null;
  filename: string; vendor: string; source_uploaded_at?: string | null;
  score?: number; rank: number
}

export interface RetrievalFilters {
  documentId?: string | null
  vendorId?: string | null
  ownerId?: string | null
  skipMarkdownRecovery?: boolean
}

function neighbourhood(markdown: string, needle: string | null): string {
  if (!markdown || !needle) return ''
  const lines = markdown.split('\n')
  const idx = lines.findIndex(l => l.includes(needle))
  if (idx < 0) return ''
  const start = Math.max(0, idx - CONTEXT_RADIUS)
  const end   = Math.min(lines.length, idx + CONTEXT_RADIUS + 1)
  return lines.slice(start, end).join('\n')
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

function coAxialVariants(text: string): string[] {
  const variants = new Set<string>()
  const replacements = [
    text.replace(/\bc[o0]\s*[-_/ ]\s*axial\b/gi, 'coaxial'),
    text.replace(/\bc[o0]\s*[-_/ ]\s*axial\b/gi, 'co axial'),
    text.replace(/\bc[o0]\s*[-_/ ]\s*axial\b/gi, 'co-axial'),
    text.replace(/\bcoaxial\b/gi, 'co axial'),
    text.replace(/\bcoaxial\b/gi, 'co-axial')
  ]
  for (const replacement of replacements) {
    const normalized = replacement.replace(/\s+/g, ' ').trim()
    if (normalized && normalized !== text.trim()) variants.add(normalized)
  }
  return [...variants]
}

export function searchShards(question: string): string[] {
  const clauses = question
    .split(/\n|,|;|\band\b|&|\+/i)
    .map(s => s.trim())
    .filter(s => s.length >= 2)

  const skuLike = question.match(/[A-Za-z]*\d[A-Za-z0-9./-]*|[A-Z]{2,}[A-Z0-9./-]*/g) ?? []
  const baseTexts = unique([question, ...clauses, ...coAxialVariants(question)])
  const punctuationVariants = baseTexts
    .flatMap(text => [
      text.replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ').trim(),
      text.replace(/[-_/\s]+/g, '').trim(),
      ...coAxialVariants(text)
    ])
    .filter(text => text.length >= 2)

  return unique([
    question.trim(),
    ...clauses,
    ...punctuationVariants,
    ...skuLike.map(s => s.trim())
  ].filter(Boolean)).slice(0, MAX_SEARCH_SHARDS)
}

export async function retrieveCandidates(
  client: SupabaseClient,
  question: string,
  limit = 15,
  filters: RetrievalFilters = {}
): Promise<CandidateRow[]> {
  const scopedDocumentIds = filters.vendorId
    ? await documentIdsForVendor(client, filters.vendorId)
    : null
  const allowedDocumentIds = new Set([
    ...(filters.documentId ? [filters.documentId] : []),
    ...(scopedDocumentIds ?? [])
  ])
  const hasScope = Boolean(filters.documentId || filters.vendorId)

  const rowsById = new Map<string, RetrievedRow>()

  for (const [queryIndex, shard] of searchShards(question).entries()) {
    const { data: hits, error } = await client.rpc('rf_search_items', {
      q: shard, lim: queryIndex === 0 ? limit : Math.max(5, Math.ceil(limit / 2))
    })
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    for (const [hitIndex, hit] of ((hits ?? []) as any[]).entries()) {
      if (hasScope && !allowedDocumentIds.has(hit.document_id)) continue
      const existing = rowsById.get(hit.doc_item_id)
      const rank = queryIndex * 100 + hitIndex
      if (!existing || rank < existing.rank) {
        rowsById.set(hit.doc_item_id, { ...hit, rank })
      }
    }
  }

  let rows = [...rowsById.values()]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)

  if (shouldRecoverFromMarkdown(question, rows)) {
    const fallbackRows = await retrieveNormalizedFallback(client, question, limit, {
      documentId: filters.documentId,
      documentIds: [...allowedDocumentIds]
    })
    if (fallbackRows.length) {
      rows = mergeRowsByPriority([...fallbackRows, ...rows]).slice(0, limit)
    }
  }

  if (
    filters.ownerId
    && !filters.skipMarkdownRecovery
    && shouldRecoverFromMarkdown(question, rows)
  ) {
    const recoveredCount = await recoverMarkdownDocItems(client, {
      ownerId: filters.ownerId,
      question,
      documentId: filters.documentId,
      documentIds: [...allowedDocumentIds]
    })
    if (recoveredCount > 0) {
      return await retrieveCandidates(client, question, limit, {
        ...filters,
        skipMarkdownRecovery: true
      })
    }
  }

  if (!rows.length) return []

  const docIds = [...new Set(rows.map(r => r.document_id))]
  const { data: docs } = await client
    .from('documents')
    .select('id, parsed_markdown')
    .in('id', docIds)

  const markdownByDoc = new Map<string, string>(
    (docs ?? []).map(d => [d.id as string, (d.parsed_markdown as string) ?? ''])
  )

  return rows.map(r => ({
    doc_item_id: r.doc_item_id,
    product_name: r.raw_name,
    sku: r.sku,
    unit: r.unit,
    price: r.price,
    moq: r.moq,
    currency: r.currency ?? 'INR',
    vendor: r.vendor,
    source_document: r.filename,
    source_uploaded_at: r.source_uploaded_at ?? null,
    source_page: r.source_page,
    context_md: neighbourhood(markdownByDoc.get(r.document_id) ?? '', r.raw_name)
  }))
}

function normaliseSearchText(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function compactSearchText(text: string) {
  return normaliseSearchText(text).replace(/\s+/g, '')
}

function queryIntentTokens(question: string) {
  const stop = new Set([
    'available', 'cable', 'cables', 'document', 'documents', 'find', 'for',
    'from', 'listing', 'listings', 'price', 'prices', 'provided', 'rate',
    'rates', 'the', 'with'
  ])
  return unique(normaliseSearchText(question)
    .split(' ')
    .filter(token => token.length >= 3 && !stop.has(token)))
    .slice(0, 6)
}

function shouldRecoverFromMarkdown(
  question: string,
  rows: Array<{ raw_name: string; sku: string | null }>
) {
  const tokens = queryIntentTokens(question)
  if (!tokens.length) return !rows.length
  if (!rows.length) return true

  return !rows.some(row => {
    const haystack = compactSearchText(`${row.raw_name} ${row.sku ?? ''}`)
    return tokens.every(token => haystack.includes(token))
  })
}

function splitMarkdownRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map(cell => cell.trim())
}

function isSeparatorRow(line: string) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line)
}

function markdownTables(markdown: string): string[][][] {
  const lines = markdown.split('\n')
  const tables: string[][][] = []
  let current: string[][] = []

  const flush = () => {
    if (current.length >= 2) tables.push(current)
    current = []
  }

  for (const line of lines) {
    if (line.includes('|') && !isSeparatorRow(line)) {
      current.push(splitMarkdownRow(line))
    } else {
      flush()
    }
  }
  flush()

  return tables
}

function markdownLineBlocks(markdown: string): string[][][] {
  const lines = markdown.split('\n').map(line => line.trim()).filter(Boolean)
  const blocks: string[][][] = []

  for (let i = 0; i < lines.length - 1; i++) {
    const title = lines[i] ?? ''
    if (!/\b(cables?|wires?|lan|speaker|telephone|cctv)\b/i.test(title)) continue
    const header = lines[i + 1] ?? ''

    if (/\b(size|sku|model|code)\b/i.test(header) && /\b(rate|mtrs?|meters?|coil|pair)\b/i.test(header)) {
      const block: string[][] = [[title], header.split(/\s{2,}|\t/).map(cell => cell.trim()).filter(Boolean)]
      for (let j = i + 2; j < lines.length; j++) {
        const row = lines[j] ?? ''
        if (/\b(cables?|wires?|lan|speaker|telephone|cctv)\b/i.test(row) && j > i + 2) break
        const cells = row.split(/\s{2,}|\t/).map(cell => cell.trim()).filter(Boolean)
        if (cells.length < 2) break
        block.push(cells)
      }
      if (block.length > 2) blocks.push(block)
    }

    const inlineBlock: string[][] = [[title]]
    for (let j = i + 1; j < lines.length; j++) {
      const row = lines[j] ?? ''
      if (/\b(cables?|wires?|lan|speaker|telephone|cctv)\b/i.test(row) && j > i + 1) break
      if (!/^[A-Za-z]*\d[A-Za-z0-9./-]*\s+/.test(row)) {
        if (inlineBlock.length > 1) break
        continue
      }
      inlineBlock.push([row])
    }
    if (inlineBlock.length > 1) blocks.push(inlineBlock)
  }

  return blocks
}

function rowsMatchingQuestion(markdown: string, question: string) {
  const tokens = queryIntentTokens(question)
  if (!tokens.length) return []

  const grids = [...markdownTables(markdown), ...markdownLineBlocks(markdown)]
  return grids
    .flatMap(grid => parsePriceRowsFromGrid(grid))
    .filter(row => {
      const haystack = compactSearchText(`${row.raw_name} ${row.sku ?? ''} ${row.unit ?? ''}`)
      return tokens.every(token => haystack.includes(token))
    })
    .slice(0, MARKDOWN_RECOVERY_ROW_LIMIT)
}

async function recoverMarkdownDocItems(
  client: SupabaseClient,
  params: {
    ownerId: string
    question: string
    documentId?: string | null
    documentIds: string[]
  }
) {
  let query = client
    .from('documents')
    .select('id, parsed_markdown')
    .eq('status', 'parsed')
    .not('parsed_markdown', 'is', null)
    .order('created_at', { ascending: false })
    .limit(MARKDOWN_RECOVERY_DOC_LIMIT)

  if (params.documentId) {
    query = query.eq('id', params.documentId)
  } else if (params.documentIds.length) {
    query = query.in('id', params.documentIds)
  }

  const { data: docs, error } = await query
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })

  const rows = (docs ?? []).flatMap(doc =>
    rowsMatchingQuestion((doc.parsed_markdown as string) ?? '', params.question)
      .map(row => ({
        owner_id: params.ownerId,
        document_id: doc.id as string,
        raw_name: row.raw_name,
        sku: row.sku,
        unit: row.unit,
        price: row.price,
        moq: row.moq,
        currency: row.currency,
        source_page: row.source_page ?? null,
        raw_row: { recovered_from: 'parsed_markdown' }
      }))
  )
  if (!rows.length) return 0

  const { data: existing, error: existingError } = await client
    .from('doc_items')
    .select('document_id, raw_name, sku, unit, price')
    .in('document_id', [...new Set(rows.map(row => row.document_id))])
  if (existingError) throw createError({ statusCode: 500, statusMessage: existingError.message })

  const existingKeys = new Set((existing ?? []).map((row: any) => JSON.stringify([
    row.document_id,
    normaliseSearchText(row.raw_name ?? ''),
    normaliseSearchText(row.sku ?? ''),
    normaliseSearchText(row.unit ?? ''),
    Number(row.price ?? 0)
  ])))

  const toInsert = rows.filter(row => {
    const key = JSON.stringify([
      row.document_id,
      normaliseSearchText(row.raw_name),
      normaliseSearchText(row.sku ?? ''),
      normaliseSearchText(row.unit ?? ''),
      Number(row.price ?? 0)
    ])
    return !existingKeys.has(key)
  })
  if (!toInsert.length) return 0

  const { error: insertError } = await client.from('doc_items').insert(toInsert)
  if (insertError) throw createError({ statusCode: 500, statusMessage: insertError.message })
  return toInsert.length
}

async function documentIdsForVendor(client: SupabaseClient, vendorId: string): Promise<string[]> {
  const { data, error } = await client
    .from('documents')
    .select('id')
    .eq('vendor_id', vendorId)
    .eq('status', 'parsed')
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return (data ?? []).map(d => d.id as string)
}

function mergeRowsByPriority(rows: RetrievedRow[]) {
  const merged = new Map<string, RetrievedRow>()
  for (const [index, row] of rows.entries()) {
    const existing = merged.get(row.doc_item_id)
    const rank = index
    if (!existing || rank < existing.rank) {
      merged.set(row.doc_item_id, { ...row, rank })
    }
  }
  return [...merged.values()].sort((a, b) =>
    (b.score ?? 0) - (a.score ?? 0) || a.rank - b.rank
  )
}

function scoreRow(row: { raw_name: string; sku: string | null; unit?: string | null }, question: string) {
  const shards = searchShards(question)
  const tokens = queryIntentTokens(question)
  const name = normaliseSearchText(row.raw_name)
  const sku = normaliseSearchText(row.sku ?? '')
  const unit = normaliseSearchText(row.unit ?? '')
  const compactHaystack = compactSearchText(`${row.raw_name} ${row.sku ?? ''} ${row.unit ?? ''}`)
  let score = tokens.length && tokens.every(token => compactHaystack.includes(token)) ? 10 : 0

  for (const shard of shards) {
    const q = normaliseSearchText(shard)
    const compact = compactSearchText(shard)
    if (!q && !compact) continue

    if (sku && sku === q) score += 12
    if (sku && (sku.includes(q) || compactSearchText(row.sku ?? '').includes(compact))) score += 6
    if (name.includes(q)) score += 4
    if (compact && compactHaystack.includes(compact)) score += 5
    if (unit.includes(q)) score += 1
  }

  return score
}

async function retrieveNormalizedFallback(
  client: SupabaseClient,
  question: string,
  limit: number,
  scope: { documentId?: string | null; documentIds: string[] }
) {
  let query = client
    .from('doc_items')
    .select(`
      id, document_id, raw_name, sku, unit, price, moq, currency, source_page,
      documents:document_id(filename, created_at, vendor:vendor_id(name))
    `)
    .not('price', 'is', null)
    .order('created_at', { ascending: false })
    .limit(NORMALIZED_FALLBACK_ROW_LIMIT)

  if (scope.documentId) {
    query = query.eq('document_id', scope.documentId)
  } else if (scope.documentIds.length) {
    query = query.in('document_id', scope.documentIds)
  }

  const { data, error } = await query
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })

  return ((data ?? []) as any[])
    .map((row, index) => ({
      doc_item_id: row.id,
      document_id: row.document_id,
      raw_name: row.raw_name,
      sku: row.sku,
      unit: row.unit,
      price: row.price,
      moq: row.moq,
      currency: row.currency,
      source_page: row.source_page,
      filename: row.documents?.filename ?? 'Unknown document',
      vendor: row.documents?.vendor?.name ?? 'Unknown',
      source_uploaded_at: row.documents?.created_at ?? null,
      rank: index,
      score: scoreRow(row, question)
    }))
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || a.rank - b.rank)
    .slice(0, limit)
}
