/**
 * Retrieval for chat RAG: top-N candidate doc_items + ±N lines of surrounding
 * markdown for each. The surrounding markdown gives Gemini the table header,
 * footnotes ("prices in ₹/100m"), and adjacent rows so it can interpret a
 * cell without us shipping the whole document.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { load as loadHtml } from 'cheerio'
import type { CandidateRow } from './gemini'
import { parsePriceRowsFromGrid } from './internalPriceParser'

const CONTEXT_RADIUS = 10  // lines on either side of the matched row
const MAX_SEARCH_SHARDS = 24
const MARKDOWN_RECOVERY_SCOPED_DOC_LIMIT = 100
const MARKDOWN_RECOVERY_TARGETED_DOC_LIMIT = 25
const MARKDOWN_RECOVERY_FALLBACK_DOC_LIMIT = 30
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
  const compactNeedle = compactSearchText(needle)
  const idx = lines.findIndex((line) =>
    line.includes(needle) || (compactNeedle.length > 4 && compactSearchText(line).includes(compactNeedle))
  )
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
  const includeWholeQuestion = clauses.length <= 1

  const skuLike = (question.match(/[A-Za-z]+[-/]?\d[A-Za-z0-9./-]*|[A-Za-z]*\d[A-Za-z0-9./-]*|[A-Z]{2,}[A-Z0-9./-]*/g) ?? [])
    .map(s => s.trim())
    .filter(isUsefulSkuShard)
  const normalizedClauses = clauses.map(normaliseSearchText).filter(Boolean)
  const baseTexts = unique([
    ...clauses,
    ...normalizedClauses,
    ...(includeWholeQuestion ? [normaliseSearchText(question), question] : []),
    ...clauses.flatMap(coAxialVariants),
    ...electricalQueryVariants(question)
  ])
  const punctuationVariants = baseTexts
    .flatMap(text => [
      text.replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ').trim(),
      text.replace(/[-_/\s]+/g, '').trim(),
      ...coAxialVariants(text)
    ])
    .filter(text => text.length >= 2)

  return unique([
    ...clauses,
    ...normalizedClauses,
    ...(includeWholeQuestion ? [question.trim()] : []),
    ...punctuationVariants,
    ...skuLike,
    ...skuLike.map(normaliseSearchText),
    ...electricalQueryVariants(question)
  ].filter(Boolean)).slice(0, MAX_SEARCH_SHARDS)
}

function isUsefulSkuShard(value: string) {
  const normalised = normaliseSearchText(value)
  if (!normalised) return false
  if (/^\d+$/.test(normalised)) return true
  if (/[\d./_-]/.test(value)) return true
  if (normalised.length <= 3) return true
  if (['cat6', 'frls', 'xlpe', 'pvc'].includes(normalised)) return true
  return false
}

function electricalQueryVariants(text: string): string[] {
  const parts = text
    .split(/\n|,|;|\band\b|&|\+/i)
    .map(part => part.trim())
    .filter(part => part.length >= 2)
  const includeWholeText = parts.length <= 1
  const normalizedTexts = unique([
    ...(includeWholeText ? [normaliseSearchText(text)] : []),
    ...parts.map(part => normaliseSearchText(part))
  ].filter(Boolean))
  const variants = new Set<string>(normalizedTexts)

  for (const normalized of normalizedTexts) {
    for (const match of normalized.matchAll(/\b(\d+(?:\.\d+)?)\s+sqmm(?:\s+(\d+)\s+core)?/gi)) {
      const size = match[1]
      const core = match[2]
      if (!size) continue
      variants.add(core ? `${size} sqmm ${core} core` : `${size} sqmm`)
      variants.add(core ? `${size}sqmm${core}core` : `${size}sqmm`)
    }

    for (const match of normalized.matchAll(/\b(\d+(?:\.\d+)?)\s+sqmm\b.*?\b(\d+(?:\.\d+)?)\s+mtr\b/gi)) {
      const size = match[1]
      const length = match[2]
      if (size && length) variants.add(`${size} sqmm ${length} mtr`)
    }
  }

  return [...variants].filter(variant => variant.length >= 2)
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

  let rows = await searchRows(client, question, limit, {
    documentIds: hasScope ? allowedDocumentIds : null,
    stopWhen: candidateRows => !shouldRecoverFromMarkdown(question, candidateRows)
  })

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

export async function searchDocItemHits(
  client: SupabaseClient,
  question: string,
  limit = 20
) {
  return (await searchRows(client, question, limit))
    .map(({ rank: _rank, ...hit }) => hit)
}

async function searchRows(
  client: SupabaseClient,
  question: string,
  limit: number,
  options: {
    documentIds?: Set<string> | string[] | null
    stopWhen?: (rows: RetrievedRow[]) => boolean
  } = {}
): Promise<RetrievedRow[]> {
  const shards = searchShards(question)
  const rowsById = new Map<string, RetrievedRow>()
  const documentIds = options.documentIds
    ? new Set(Array.isArray(options.documentIds) ? options.documentIds : [...options.documentIds])
    : null

  const addHits = (hits: any[], queryIndex: number) => {
    for (const [hitIndex, hit] of hits.entries()) {
      if (hit.price === null || hit.price === undefined) continue
      if (documentIds && !documentIds.has(hit.document_id)) continue
      const existing = rowsById.get(hit.doc_item_id)
      const rank = queryIndex * 100 + hitIndex
      if (!existing || rank < existing.rank) {
        rowsById.set(hit.doc_item_id, { ...hit, rank })
      }
    }
  }

  const runShard = async (shard: string, queryIndex: number) => {
    const { data, error } = await client.rpc('rf_search_items', {
      q: shard,
      lim: queryIndex === 0 ? limit : Math.max(5, Math.ceil(limit / 2))
    })
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    return { queryIndex, hits: (data ?? []) as any[] }
  }

  if (!shards.length) return []

  const primary = await runShard(shards[0]!, 0)
  addHits(primary.hits, primary.queryIndex)

  let rows = sortedSearchRows(rowsById, limit)
  if (options.stopWhen?.(rows)) return rows

  const remaining = await Promise.all(
    shards.slice(1).map((shard, index) => runShard(shard, index + 1))
  )
  for (const result of remaining) addHits(result.hits, result.queryIndex)

  rows = sortedSearchRows(rowsById, limit)
  return rows
}

function sortedSearchRows(rowsById: Map<string, RetrievedRow>, limit: number) {
  return [...rowsById.values()]
    .sort((a, b) =>
      (b.score ?? 0) - (a.score ?? 0) || a.rank - b.rank
    )
    .slice(0, limit)
}

function normaliseSearchText(text: string) {
  const decimalMarker = 'p'

  return text
    .toLowerCase()
    .replace(/[×*]/g, ' x ')
    .replace(/\bfr\s*[-_/]?\s*ls\b/g, ' frls ')
    .replace(/\bcu\b/g, ' copper ')
    .replace(/\bal\b/g, ' aluminium ')
    .replace(/\barm(?:ou?red|ored|d)?\.?\b/g, ' armoured ')
    .replace(/(\d+(?:\.\d+)?)\s*sq\.?\s*mm\s*x\s*(\d+)\s*(?:cores?|core|c)\b/g, '$1 sqmm $2 core')
    .replace(/(\d+(?:\.\d+)?)\s*sq\.?\s*mm\b/g, '$1 sqmm')
    .replace(/(\d+)\s*(?:cores?|core|c)\b/g, '$1 core')
    .replace(/(\d+(?:\.\d+)?)\s*(?:mtrs?\.?|met(?:er|re)s?|mtr)\b/g, '$1 mtr')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([0-9a-z])\s*x\s*([0-9])/g, '$1 $2')
    .replace(/(\d)\.(\d)/g, `$1${decimalMarker}$2`)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(new RegExp(`(\\d)${decimalMarker}(\\d)`, 'g'), '$1.$2')
    .replace(/\s+/g, ' ')
    .trim()
}

function compactSearchText(text: string) {
  return normaliseSearchText(text).replace(/[^a-z0-9]+/g, '')
}

function queryIntentTokens(question: string) {
  const stop = new Set([
    'about', 'all', 'any', 'are', 'available', 'cable', 'cables', 'can', 'could',
    'document', 'documents', 'find', 'for', 'from', 'give', 'have', 'how', 'is',
    'listing', 'listings', 'much', 'please', 'price', 'prices', 'provided', 'rate',
    'rates', 'show', 'tell', 'the', 'there', 'these', 'this', 'what', 'when', 'where',
    'which', 'with', 'would', 'you', 'your'
  ])
  const shortDomainTokens = new Set(['fr'])
  return unique(normaliseSearchText(question)
    .split(' ')
    .filter(token => {
      const isNumber = /^\d+(?:\.\d+)?$/.test(token)
      const usefulLength = isNumber || token.length >= 3 || shortDomainTokens.has(token)
      return usefulLength && !stop.has(token)
    }))
    .slice(0, 12)
}

function shouldRecoverFromMarkdown(
  question: string,
  rows: Array<{ raw_name: string; sku: string | null; unit?: string | null; price?: number | null; vendor?: string | null; filename?: string | null }>
) {
  const tokens = queryIntentTokens(question)
  if (!tokens.length) return !rows.length
  if (!rows.length) return true

  return !rows.some(row => {
    if (row.price === null || row.price === undefined) return false
    const haystack = compactSearchText(`${row.raw_name} ${row.sku ?? ''} ${row.unit ?? ''} ${row.vendor ?? ''} ${row.filename ?? ''}`)
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
    if (isSeparatorRow(line)) continue
    if (line.includes('|')) {
      current.push(splitMarkdownRow(line))
    } else {
      flush()
    }
  }
  flush()

  return tables
}

function htmlTables(markdown: string): string[][][] {
  if (!/<table[\s>]/i.test(markdown)) return []

  const $ = loadHtml(markdown)
  const tables: string[][][] = []
  $('table').each((_, table) => {
    const rows: string[][] = []
    $(table).find('tr').each((__, tr) => {
      const cells = $(tr)
        .children('th,td')
        .map((___, cell) => $(cell).text().replace(/\s+/g, ' ').trim())
        .get()
        .filter(Boolean)
      if (cells.length) rows.push(cells)
    })
    if (rows.length >= 2) tables.push(rows)
  })
  return tables
}

function htmlTextBlocks(markdown: string): string[][][] {
  if (!/<\/?[a-z][\s\S]*>/i.test(markdown)) return []

  const $ = loadHtml(markdown)
  $('script,style,noscript').remove()
  $('br').replaceWith('\n')

  const rows: string[][] = []
  $('tr,p,li,div,h1,h2,h3,h4,h5,h6').each((_, element) => {
    const text = $(element).text().replace(/\s+/g, ' ').trim()
    if (text) rows.push([text])
  })

  return rows.length >= 2 ? [rows] : []
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
      if (!/^(?:[A-Za-z]+[-/]?\d[A-Za-z0-9./-]*|\d[A-Za-z0-9./-]*)\s+/.test(row)) {
        if (inlineBlock.length > 1) break
        continue
      }
      inlineBlock.push([row])
    }
    if (inlineBlock.length > 1) blocks.push(inlineBlock)
  }

  return blocks
}

function rowsMatchingQuestion(markdown: string, question: string, ignoredTokens: Set<string> = new Set()) {
  const tokens = queryIntentTokens(question)
    .filter(token => !ignoredTokens.has(token))
  if (!tokens.length) return []

  const structuredGrids = [
    ...htmlTables(markdown),
    ...markdownTables(markdown),
    ...markdownLineBlocks(markdown)
  ]
  const structuredRows = rowsMatchingTokens(structuredGrids, tokens)
  if (structuredRows.some(row => row.price !== null)) return structuredRows

  return [
    ...structuredRows,
    ...rowsMatchingTokens(htmlTextBlocks(markdown), tokens)
  ].slice(0, MARKDOWN_RECOVERY_ROW_LIMIT)
}

function rowsMatchingTokens(grids: string[][][], tokens: string[]) {
  const matches: ReturnType<typeof parsePriceRowsFromGrid> = []

  for (const grid of grids) {
    const rows = [
      ...parsePriceRowsFromGrid(grid),
      ...visibleRowsMatchingQuestion(grid, tokens)
    ]

    for (const row of rows) {
      const haystack = compactSearchText(`${row.raw_name} ${row.sku ?? ''} ${row.unit ?? ''}`)
      if (tokens.every(token => haystack.includes(token))) matches.push(row)
      if (matches.length >= MARKDOWN_RECOVERY_ROW_LIMIT) return matches
    }
  }

  return matches
}

function visibleRowsMatchingQuestion(grid: string[][], tokens: string[]) {
  const rows: ReturnType<typeof parsePriceRowsFromGrid> = []
  let sectionTitle = ''

  for (const row of grid) {
    const cells = row.map(cell => cell.replace(/\s+/g, ' ').trim()).filter(Boolean)
    if (!cells.length) continue

    const rowText = cells.join(' ')
    if (cells.length === 1 && /\b(cables?|wires?|speaker|telephone|cctv|lan|transparent)\b/i.test(rowText)) {
      sectionTitle = rowText
    }

    const combined = [sectionTitle, rowText].filter(Boolean).join(' ')
    const haystack = compactSearchText(combined)
    if (!tokens.every(token => haystack.includes(token))) continue

    const candidate = {
      raw_name: combined.slice(0, 240),
      sku: null,
      unit: extractUnit(combined),
      price: extractVisiblePrice(cells),
      moq: null,
      currency: 'INR',
      source_page: null
    }
    if (candidate.price !== null) rows.push(candidate)
  }

  return rows
}

function extractUnit(text: string) {
  const match = text.match(/\b\d+(?:\.\d+)?\s*(?:mtrs?\.?|met(?:er|re)s?|mtr|coil|roll|pair|core|nos?\.?|pcs?\.?)\b/i)
  return match?.[0]?.replace(/\s+/g, ' ').trim() ?? null
}

function extractVisiblePrice(cells: string[]) {
  const moneyCell = cells.find(cell => /(?:₹|rs\.?|inr)\s*[\d,]+(?:\.\d{1,2})?/i.test(cell))
  const source = moneyCell ?? cells.slice().reverse().find(cell =>
    /^[\s₹$]*(?:rs\.?|inr)?\s*[\d,]+(?:\.\d{1,2})?\s*(?:\/-)?\s*$/i.test(cell)
    && !/\b(?:mtrs?\.?|met(?:er|re)s?|mtr|nos?\.?|pcs?\.?)\b/i.test(cell)
  )
  if (!source) return null

  const cleaned = source
    .replace(/[₹$,\s]/g, '')
    .replace(/\b(rs|inr)\b/gi, '')
    .replace(/[^\d.\-]/g, '')
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : null
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
  const docs = await fetchMarkdownRecoveryDocs(client, params)

  const rows = docs.flatMap(doc => {
    const docTokens = new Set(queryIntentTokens([
      doc.filename,
      (doc as any).vendor?.name
    ].filter(Boolean).join(' ')))

    return rowsMatchingQuestion((doc.parsed_markdown as string) ?? '', params.question, docTokens)
      .filter(row => row.price !== null)
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
  })
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

async function fetchMarkdownRecoveryDocs(
  client: SupabaseClient,
  params: {
    question: string
    documentId?: string | null
    documentIds: string[]
  }
) {
  const applyScope = (query: any) => {
    if (params.documentId) return query.eq('id', params.documentId)
    if (params.documentIds.length) return query.in('id', params.documentIds)
    return query
  }

  const baseQuery = () => applyScope(client
    .from('documents')
    .select('id, filename, parsed_markdown, vendor:vendor_id(name)')
    .eq('status', 'parsed')
    .not('parsed_markdown', 'is', null))

  const textTokens = queryIntentTokens(params.question)
    .filter(token => !/^\d+$/.test(token) && token !== 'mtr')
    .slice(0, 4)

  if (textTokens.length) {
    const tokenOr = textTokens
      .flatMap(token => [
        `parsed_markdown.ilike.%${token}%`,
        `filename.ilike.%${token}%`
      ])
      .join(',')

    let tokenQuery = baseQuery()
      .order('created_at', { ascending: false })
      .limit(markdownRecoveryLimit(params, true))

    tokenQuery = tokenQuery.or(tokenOr)

    const { data, error } = await tokenQuery
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    if (data?.length) return data as Array<{ id: string; filename: string | null; parsed_markdown: string | null; vendor?: { name?: string | null } | null }>
  }

  const { data, error } = await baseQuery()
    .order('created_at', { ascending: false })
    .limit(markdownRecoveryLimit(params, false))
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return (data ?? []) as Array<{ id: string; filename: string | null; parsed_markdown: string | null; vendor?: { name?: string | null } | null }>
}

function markdownRecoveryLimit(
  params: { documentId?: string | null; documentIds: string[] },
  targeted: boolean
) {
  if (params.documentId || params.documentIds.length) return MARKDOWN_RECOVERY_SCOPED_DOC_LIMIT
  return targeted ? MARKDOWN_RECOVERY_TARGETED_DOC_LIMIT : MARKDOWN_RECOVERY_FALLBACK_DOC_LIMIT
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

function scoreRow(
  row: { raw_name: string; sku: string | null; unit?: string | null; vendor?: string | null; filename?: string | null },
  question: string
) {
  const shards = searchShards(question)
  const tokens = queryIntentTokens(question)
  const name = normaliseSearchText(row.raw_name)
  const sku = normaliseSearchText(row.sku ?? '')
  const unit = normaliseSearchText(row.unit ?? '')
  const vendor = normaliseSearchText(row.vendor ?? '')
  const filename = normaliseSearchText(row.filename ?? '')
  const compactHaystack = compactSearchText(`${row.raw_name} ${row.sku ?? ''} ${row.unit ?? ''} ${row.vendor ?? ''} ${row.filename ?? ''}`)
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
    if (vendor.includes(q)) score += 3
    if (filename.includes(q)) score += 1
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
    .map((row, index) => {
      const hydrated = {
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
        rank: index
      }
      return {
        ...hydrated,
        score: scoreRow(hydrated, question)
      }
    })
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || a.rank - b.rank)
    .slice(0, limit)
}
