#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
  }
}

const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NUXT_SUPABASE_SERVICE_ROLE_KEY

assert(supabaseUrl, 'SUPABASE_URL is required')
assert(serviceRoleKey, 'SUPABASE_SERVICE_ROLE_KEY is required')

const supabase = createClient(supabaseUrl, serviceRoleKey)
const failures = []

async function countRows(table, label = table) {
  const { count, error } = await supabase
    .from(table)
    .select('id', { count: 'exact', head: true })
  if (error) {
    failures.push(`${label}: ${error.message}`)
    return null
  }
  return count ?? 0
}

const requiredTables = [
  'doc_tables',
  'doc_table_cells',
  'doc_price_items',
  'search_aliases',
  'search_eval_cases',
  'search_match_logs',
  'quotation_item_audit_logs'
]

const counts = {}
for (const table of requiredTables) counts[table] = await countRows(table)

const { data: rpcData, error: rpcError } = await supabase.rpc('rf_search_price_items', {
  q: 'readiness probe',
  lim: 1,
  tenant: '00000000-0000-0000-0000-000000000000',
  filter_vendor: null,
  filter_document: null
})
if (rpcError && !/invalid input syntax for type uuid|violates row-level security/i.test(rpcError.message ?? '')) {
  failures.push(`rf_search_price_items: ${rpcError.message}`)
}

const { data: documents, error: documentsError } = await supabase
  .from('documents')
  .select('id, filename, status')
  .eq('status', 'parsed')
if (documentsError) failures.push(`documents: ${documentsError.message}`)

const indexedDocsWithoutCanonical = []
for (const document of documents ?? []) {
  const { count: legacyCount, error: legacyError } = await supabase
    .from('doc_items')
    .select('id', { count: 'exact', head: true })
    .eq('document_id', document.id)
    .not('price', 'is', null)
  if (legacyError) {
    failures.push(`doc_items for ${document.filename}: ${legacyError.message}`)
    continue
  }
  const { count: canonicalCount, error: canonicalError } = await supabase
    .from('doc_price_items')
    .select('id', { count: 'exact', head: true })
    .eq('document_id', document.id)
  if (canonicalError) {
    failures.push(`doc_price_items for ${document.filename}: ${canonicalError.message}`)
    continue
  }
  if ((legacyCount ?? 0) > 0 && (canonicalCount ?? 0) === 0) {
    indexedDocsWithoutCanonical.push(document.filename)
  }
}

if ((counts.doc_price_items ?? 0) === 0) failures.push('doc_price_items has zero canonical records')
if ((counts.search_aliases ?? 0) === 0) failures.push('search_aliases has no seeded aliases')
if (indexedDocsWithoutCanonical.length) {
  failures.push(`parsed documents with legacy prices but no canonical rows: ${indexedDocsWithoutCanonical.join('; ')}`)
}

console.log(JSON.stringify({
  ok: failures.length === 0,
  counts,
  parsed_documents: documents?.length ?? 0,
  rpc_visible: !rpcError,
  rpc_probe_rows: rpcData?.length ?? 0,
  indexed_docs_without_canonical: indexedDocsWithoutCanonical
}, null, 2))

if (failures.length) {
  console.error('\nProduction readiness check failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  console.error("\nRun the latest migrations, including `notify pgrst, 'reload schema';`, then backfill canonical rows.")
  process.exit(1)
}
