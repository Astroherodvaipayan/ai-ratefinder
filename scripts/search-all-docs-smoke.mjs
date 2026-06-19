#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import { createJiti } from 'jiti'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
  }
}

globalThis.createError = ({ statusCode, statusMessage }) =>
  Object.assign(new Error(statusMessage), { statusCode, statusMessage })

const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NUXT_SUPABASE_SERVICE_ROLE_KEY
const sampleSize = Number(process.env.SEARCH_ALL_DOCS_SAMPLE_SIZE ?? 8)

assert(supabaseUrl, 'SUPABASE_URL is required')
assert(serviceRoleKey, 'SUPABASE_SERVICE_ROLE_KEY is required')
assert(Number.isInteger(sampleSize) && sampleSize > 0, 'SEARCH_ALL_DOCS_SAMPLE_SIZE must be a positive integer')

const jiti = createJiti(import.meta.url, { interopDefault: true })
const { searchItems } = await jiti.import('../server/utils/search/searchItems.ts')
const { parseUserItemQuery } = await jiti.import('../server/utils/search/parseUserItemQuery.ts')
const supabase = createClient(supabaseUrl, serviceRoleKey)

function buildQuery(row) {
  return [row.raw_name, row.sku, row.unit]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function samePrice(actual, expected) {
  return Math.abs(Number(actual) - Number(expected)) < 0.0001
}

const started = performance.now()
const { data: documents, error: documentsError } = await supabase
  .from('documents')
  .select('id, owner_id, filename, vendor:vendor_id(name)')
  .order('created_at', { ascending: true })

if (documentsError) throw documentsError

const failures = []
const skipped = []
const skippedRows = []
let passed = 0
let tested = 0

for (const document of documents ?? []) {
  const { count, error: countError } = await supabase
    .from('doc_items')
    .select('id', { count: 'exact', head: true })
    .eq('document_id', document.id)
    .not('price', 'is', null)

  if (countError) throw countError
  if (!count) {
    skipped.push({
      document,
      reason: 'No indexed price rows'
    })
    continue
  }

  const { data: rows, error: rowsError } = await supabase
    .from('doc_items')
    .select('id, raw_name, sku, unit, price')
    .eq('document_id', document.id)
    .not('price', 'is', null)
    .order('raw_name', { ascending: true })
    .order('sku', { ascending: true })
    .limit(sampleSize * 4)

  if (rowsError) throw rowsError

  console.log(`\nDOC | ${document.vendor?.name ?? 'no vendor'} | ${document.filename} | rows=${count} | target_sample=${sampleSize}`)

  let documentTested = 0
  for (const row of rows) {
    const query = buildQuery(row)
    if (!query) continue
    const parsed = parseUserItemQuery(query)
    const lowSignal = parsed.product_terms.length === 0
      || (parsed.attribute_hints.length === 0 && /^\d/.test(parsed.normalized_query))
    if (lowSignal) {
      skippedRows.push({
        document,
        row,
        reason: 'Low-signal legacy row lacks enough product/attribute context after normalization'
      })
      continue
    }
    tested += 1
    documentTested += 1

    const result = await searchItems({
      client: supabase,
      tenantId: document.owner_id,
      documentId: document.id,
      message: query,
      limitPerItem: 150
    })
    const item = result.priced_items[0] ?? null
    const ok = Boolean(
      item
      && !item.needs_review
      && item.doc_item_id === row.id
      && samePrice(item.price, row.price)
    )

    const candidate = item ?? result.unresolved_items[0]?.closest_candidates[0] ?? null
    const line = `${ok ? 'PASS' : 'FAIL'} | expected=${row.price} got=${candidate?.price ?? null} score=${candidate?.confidence ?? null} | ${query.slice(0, 140)}`
    console.log(line)

    if (ok) passed += 1
    else {
      failures.push({
        document,
        row,
        query,
        got: candidate,
        answer: result.answer_text
      })
    }
    if (documentTested >= sampleSize) break
  }
}

for (const item of skipped) {
  console.log(`\nSKIP | ${item.document.vendor?.name ?? 'no vendor'} | ${item.document.filename} | ${item.reason}`)
}

for (const item of skippedRows.slice(0, 10)) {
  console.log(`\nSKIP ROW | ${item.document.filename} | ${item.reason} | ${buildQuery(item.row)}`)
}

const elapsedMs = Math.round(performance.now() - started)

if (failures.length) {
  console.error(`\neval:all-docs failed ${failures.length}/${tested} sampled cases in ${elapsedMs}ms`)
  for (const failure of failures.slice(0, 10)) {
    console.error(`- ${failure.document.filename}: expected row=${failure.row.id} price=${failure.row.price}; got row=${failure.got?.doc_item_id ?? null} price=${failure.got?.price ?? null}; query="${failure.query}"`)
  }
  process.exit(1)
}

console.log(`\neval:all-docs passed ${passed}/${tested} sampled cases in ${elapsedMs}ms; skipped ${skipped.length} documents with no indexed price rows and ${skippedRows.length} low-signal legacy rows`)
