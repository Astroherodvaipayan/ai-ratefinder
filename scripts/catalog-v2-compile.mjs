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

const args = process.argv.slice(2)
const flag = name => args.includes(`--${name}`)
const option = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}

const documentId = option('document')
const tablePattern = option('table-match')
const tableLimit = Number(option('table-limit', '0'))
const write = flag('write')
const deterministic = flag('deterministic')
const outputPath = option('output', 'tmp/catalog-v2-compile.json')
if (!documentId) throw new Error('Usage: node scripts/catalog-v2-compile.mjs --document <uuid> [--table-match <regex>] [--table-limit N]')
if (write) throw new Error('Direct document writes are disabled. Compile a full artifact, validate it, then use catalog:v2:import for atomic release loading.')
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase service credentials are required')
if (!deterministic && !process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required unless --deterministic is used')

const jiti = createJiti(import.meta.url, { interopDefault: true })
const { extractSourceTables, findRepeatedSourceBlocks, findTruncatedSourceRows } = await jiti.import('../server/utils/catalog/sourceTables.ts')
const { compileSourceTable, analyzeSourceTableDeterministically, dedupeDocumentOffers } = await jiti.import('../server/utils/catalog/compiler.ts')
const { CATALOGUE_COMPILER_VERSION } = await jiti.import('../server/utils/catalog/contracts.ts')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const { data: doc, error } = await supabase
  .from('documents')
  .select('id, owner_id, vendor_id, filename, parsed_markdown, vendor:vendor_id(name)')
  .eq('id', documentId)
  .single()
if (error || !doc) throw error ?? new Error('Document not found')

const matcher = tablePattern ? new RegExp(tablePattern, 'i') : null
let tables = extractSourceTables(doc.parsed_markdown ?? '')
  .filter(table => !matcher || matcher.test(`${table.title ?? ''} ${table.grid.flat().join(' ')}`))
if (tableLimit > 0) tables = tables.slice(0, tableLimit)
const repeatedSourceBlocks = findRepeatedSourceBlocks(tables)
const truncatedSourceRows = findTruncatedSourceRows(tables)

console.log(`Compiling ${tables.length} table(s) from ${doc.filename} (dry run)`)
const offers = []
const tableAudits = []
for (const [index, table] of tables.entries()) {
  console.log(`[${index + 1}/${tables.length}] page=${table.page ?? '?'} table=${table.tableIndex} rows=${table.grid.length} ${table.title ?? ''}`)
  const compileOptions = {
    table,
    documentName: doc.filename,
    vendorName: doc.vendor?.name ?? null
  }
  const deterministicResult = deterministic ? analyzeSourceTableDeterministically(compileOptions) : null
  const compiled = deterministicResult
    ? deterministicResult.offers
    : await compileSourceTable({ apiKey: process.env.GEMINI_API_KEY, ...compileOptions })
  if (deterministicResult) tableAudits.push(deterministicResult.audit)
  offers.push(...compiled)
  console.log(`  offers=${compiled.length} published=${compiled.filter(offer => !offer.validation_errors.length).length} quarantined=${compiled.filter(offer => offer.validation_errors.length).length}`)
}
const reconciledOffers = dedupeDocumentOffers(offers)

const artifact = {
  compiler_version: CATALOGUE_COMPILER_VERSION,
  document: { id: doc.id, filename: doc.filename, vendor: doc.vendor?.name ?? null },
  tables_seen: tables.length,
  offers_published: reconciledOffers.filter(offer => !offer.validation_errors.length).length,
  offers_quarantined: reconciledOffers.filter(offer => offer.validation_errors.length).length,
  duplicate_offers_removed: offers.length - reconciledOffers.length,
  repeated_source_blocks: repeatedSourceBlocks,
  truncated_source_rows: truncatedSourceRows,
  quality_gate_passed: repeatedSourceBlocks.length === 0 && truncatedSourceRows.length === 0,
  table_audits: tableAudits,
  offers: reconciledOffers
}
mkdirSync(outputPath.split('/').slice(0, -1).join('/') || '.', { recursive: true })
writeFileSync(outputPath, JSON.stringify(artifact, null, 2))

console.log(JSON.stringify({
  output: outputPath,
  tables_seen: artifact.tables_seen,
  offers_published: artifact.offers_published,
  offers_quarantined: artifact.offers_quarantined,
  wrote_database: false
}, null, 2))
