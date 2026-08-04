#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import { createJiti } from 'jiti'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
  }
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase service credentials are required')

const jiti = createJiti(import.meta.url, { interopDefault: true })
const { extractSourceTables, findRepeatedSourceBlocks, findTruncatedSourceRows } = await jiti.import('../server/utils/catalog/sourceTables.ts')
const { analyzeSourceTableDeterministically, dedupeDocumentOffers, strictMoney } = await jiti.import('../server/utils/catalog/compiler.ts')
const { CATALOGUE_COMPILER_VERSION } = await jiti.import('../server/utils/catalog/contracts.ts')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const outputPath = process.argv[2] ?? 'tmp/catalog-v2-all.json'

const { data: documents, error } = await supabase
  .from('documents')
  .select('id, owner_id, vendor_id, filename, parsed_markdown, page_count, vendor:vendor_id(name)')
  .eq('status', 'parsed')
  .order('created_at', { ascending: true })
if (error) throw error

const { data: activeRelease } = await supabase
  .from('catalog_releases')
  .select('id')
  .eq('status', 'active')
  .maybeSingle()
const activeCounts = new Map()
if (activeRelease?.id) {
  for (let from = 0; ; from += 1000) {
    const { data, error: activeError } = await supabase
      .from('catalog_offers')
      .select('document_id, status')
      .eq('release_id', activeRelease.id)
      .range(from, from + 999)
    if (activeError) throw activeError
    for (const offer of data ?? []) {
      if (offer.status !== 'published') continue
      activeCounts.set(offer.document_id, (activeCounts.get(offer.document_id) ?? 0) + 1)
    }
    if ((data ?? []).length < 1000) break
  }
}

const compiledDocuments = []
for (const [index, doc] of (documents ?? []).entries()) {
  const tables = extractSourceTables(doc.parsed_markdown ?? '')
  const repeatedSourceBlocks = findRepeatedSourceBlocks(tables)
  const truncatedSourceRows = findTruncatedSourceRows(tables)
  const results = tables.map(table => analyzeSourceTableDeterministically({
      table,
      documentName: doc.filename,
      vendorName: doc.vendor?.name ?? null
    }))
  const rawOffers = results.flatMap(result => result.offers)
  const offers = dedupeDocumentOffers(rawOffers)
  const baseTableAudits = results.map(result => result.audit)
  const published = offers.filter(offer => !offer.validation_errors.length)
  const quarantined = offers.filter(offer => offer.validation_errors.length)
  const reconstructionFailures = offers.filter(offer => strictMoney(offer.raw_price_value) !== offer.amount)
  const previousPublished = activeCounts.get(doc.id) ?? 0
  const qualityFailures = []
  const pricedTableFamilies = new Set(results
    .filter(result => result.audit.selected_price_cells > 0)
    .map(result => tableFamilyKey(tables[result.audit.source_table_index]?.title)))
  const tableAudits = baseTableAudits.map(audit => {
    const sourceTable = tables[audit.source_table_index]
    const unresolvedCommercialNumbers = audit.decisions.some(decision => decision.reason === 'insufficient_price_context')
    const explicitlyUnavailable = sourceTable ? tableHasExplicitUnavailablePrices(sourceTable.grid) : false
    const recoveredByTiledPeer = pricedTableFamilies.has(tableFamilyKey(sourceTable?.title))
    const requiresPriceCandidate = audit.commercial
      && audit.numeric_cells > 0
      && audit.selected_price_cells === 0
      && (audit.matrix_likely || unresolvedCommercialNumbers)
      && !explicitlyUnavailable
      && !recoveredByTiledPeer
    return {
      ...audit,
      price_gate: {
        explicitly_unavailable: explicitlyUnavailable,
        recovered_by_tiled_peer: recoveredByTiledPeer,
        unresolved_commercial_numbers: unresolvedCommercialNumbers,
        requires_price_candidate: requiresPriceCandidate
      }
    }
  })
  for (const audit of tableAudits) {
    if (audit.decisions.length !== audit.numeric_cells) {
      qualityFailures.push({ reason: 'numeric_cell_accounting_mismatch', table_index: audit.source_table_index })
    }
    if (audit.price_gate.requires_price_candidate) {
      qualityFailures.push({ reason: 'commercial_table_without_price_candidates', table_index: audit.source_table_index })
    }
  }
  for (const block of repeatedSourceBlocks) {
    qualityFailures.push({ reason: 'repeated_parser_source_block', ...block })
  }
  for (const row of truncatedSourceRows) {
    qualityFailures.push({ reason: 'truncated_parser_source_row', ...row })
  }
  if (previousPublished > 0 && published.length < Math.floor(previousPublished * 0.9)) {
    qualityFailures.push({ reason: 'published_offer_regression', previous: previousPublished, current: published.length })
  }
  if (offers.length > 0 && quarantined.length / offers.length > 0.35) {
    qualityFailures.push({ reason: 'excessive_quarantine_ratio', ratio: quarantined.length / offers.length })
  }
  console.log(`[${index + 1}/${documents.length}] ${doc.filename} tables=${tables.length} raw_offers=${rawOffers.length} duplicates_removed=${rawOffers.length - offers.length} published=${published.length} quarantined=${quarantined.length} quality_failures=${qualityFailures.length}`)
  compiledDocuments.push({
    document: { id: doc.id, owner_id: doc.owner_id, vendor_id: doc.vendor_id, filename: doc.filename, page_count: doc.page_count, vendor: doc.vendor?.name ?? null },
    tables_seen: tables.length,
    numeric_cells_seen: tableAudits.reduce((sum, audit) => sum + audit.numeric_cells, 0),
    price_cells_selected: tableAudits.reduce((sum, audit) => sum + audit.selected_price_cells, 0),
    duplicate_offers_removed: rawOffers.length - offers.length,
    repeated_source_blocks: repeatedSourceBlocks,
    truncated_source_rows: truncatedSourceRows,
    previous_offers_published: previousPublished,
    offers_published: published.length,
    offers_quarantined: quarantined.length,
    reconstruction_failures: reconstructionFailures.length,
    quality_failures: qualityFailures,
    table_audits: tableAudits,
    offers
  })
}

function tableFamilyKey(title) {
  return String(title ?? '')
    .split('|')[0]
    .replace(/[*_`<>]/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase()
}

function tableHasExplicitUnavailablePrices(grid) {
  const headerRows = grid.slice(0, 4)
  const priceColumns = new Set()
  for (const row of headerRows) {
    row.forEach((cell, index) => {
      if (/\b(?:rate|price|mrp|amount|cost)\b|m\.r\.p\./i.test(cell)) priceColumns.add(index)
    })
  }
  if (!priceColumns.size) return false
  let unavailable = 0
  let numeric = 0
  for (const row of grid.slice(1)) {
    for (const index of priceColumns) {
      const value = row[index]?.trim() ?? ''
      if (/^(?:\*+|-+|n\/?a|on request|price on request)$/i.test(value)) unavailable += 1
      else if (strictMoney(value) !== null) numeric += 1
    }
  }
  return unavailable > 0 && numeric === 0
}

const allOffers = compiledDocuments.flatMap(document => document.offers)
const categoryCounts = Object.entries(allOffers.reduce((counts, offer) => {
  const state = offer.validation_errors.length ? 'quarantined' : 'published'
  const key = `${state}:${offer.category}`
  counts[key] = (counts[key] ?? 0) + 1
  return counts
}, {})).sort(([a], [b]) => a.localeCompare(b))

const artifact = {
  compiler_version: CATALOGUE_COMPILER_VERSION,
  generated_at: new Date().toISOString(),
  summary: {
    documents: compiledDocuments.length,
    tables_seen: compiledDocuments.reduce((sum, document) => sum + document.tables_seen, 0),
    offers_published: allOffers.filter(offer => !offer.validation_errors.length).length,
    offers_quarantined: allOffers.filter(offer => offer.validation_errors.length).length,
    reconstruction_failures: compiledDocuments.reduce((sum, document) => sum + document.reconstruction_failures, 0),
    duplicate_offers_removed: compiledDocuments.reduce((sum, document) => sum + document.duplicate_offers_removed, 0),
    numeric_cells_seen: compiledDocuments.reduce((sum, document) => sum + document.numeric_cells_seen, 0),
    price_cells_selected: compiledDocuments.reduce((sum, document) => sum + document.price_cells_selected, 0),
    quality_failures: compiledDocuments.reduce((sum, document) => sum + document.quality_failures.length, 0),
    quality_gate_passed: compiledDocuments.every(document => document.quality_failures.length === 0),
    category_counts: Object.fromEntries(categoryCounts)
  },
  documents: compiledDocuments
}
mkdirSync(outputPath.split('/').slice(0, -1).join('/') || '.', { recursive: true })
writeFileSync(outputPath, JSON.stringify(artifact, null, 2))
console.log(JSON.stringify({ output: outputPath, ...artifact.summary }, null, 2))
