#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import { createJiti } from 'jiti'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
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
assert(supabaseUrl, 'SUPABASE_URL is required')
assert(serviceRoleKey, 'SUPABASE_SERVICE_ROLE_KEY is required')

const sampleSize = Number(process.env.SEARCH_DOC_TRIAL_SAMPLE_SIZE ?? 8)
const maxCuratedPerDoc = Number(process.env.SEARCH_DOC_TRIAL_CURATED_SIZE ?? 10)
const failOnAny = process.env.SEARCH_DOC_TRIAL_FAIL_ON_ANY === '1'
const outputPath = process.env.SEARCH_DOC_TRIAL_OUTPUT ?? 'tmp/search-doc-trials.json'
const skipDocumentRe = process.env.SEARCH_DOC_TRIAL_SKIP_RE
  ? new RegExp(process.env.SEARCH_DOC_TRIAL_SKIP_RE, 'i')
  : null

const jiti = createJiti(import.meta.url, { interopDefault: true })
const { searchItems } = await jiti.import('../server/utils/search/searchItems.ts')
const { normalizeSearchText, uniqueText } = await jiti.import('../server/utils/search/text.ts')
const { FULL_KITTING_PRODUCT_VENDORS } = await jiti.import('../server/utils/search/fullKittingKnowledge.ts')
const supabase = createClient(supabaseUrl, serviceRoleKey)

function docLabel(doc) {
  return `${doc.vendor?.name ?? 'no vendor'} | ${doc.filename}`
}

function normalize(value) {
  return normalizeSearchText(value ?? '')
}

function samePrice(actual, expected) {
  return Math.abs(Number(actual) - Number(expected)) < 0.0001
}

function cleanQueryText(value) {
  return (value ?? '')
    .replace(/\bVendor:\s*/gi, ' ')
    .replace(/\bDocument:\s*/gi, ' ')
    .replace(/\bPage:\s*\d+/gi, ' ')
    .replace(/\b(?:Rate|MRP|Price):?\s*[\d,.]+(?:\s*(?:INR|Rs\.?|₹))?/gi, ' ')
    .replace(/\b(?:SUPREME MRP LIST|PRICE LIST|Pricelist|Price List)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function removeDocumentNoise(value, doc) {
  let out = cleanQueryText(value)
  const noise = uniqueText([
    doc.filename,
    doc.filename?.replace(/\.[^.]+$/, ''),
    doc.vendor?.name,
    'PRICE LIST BY THE SUPREME INDUSTRIES LTD MUMBAI'
  ].filter(Boolean))
  for (const item of noise) {
    const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(escaped, 'gi'), ' ')
  }
  return out.replace(/\s+/g, ' ').trim()
}

function queryFromPriceRow(row, doc) {
  const columnSignals = (row.column_headers ?? [])
    .filter(value => value && !/^(?:mrp|rate|price|amount|rs|inr)$/i.test(value))
    .filter(value => !/^\d+(?:\.\d+)?$/.test(value))
  const parts = uniqueText([
    row.sku_text,
    row.product_text,
    ...(row.row_headers ?? []),
    ...columnSignals,
    row.unit && !String(row.product_text ?? '').toLowerCase().includes(String(row.unit).toLowerCase())
      ? row.unit
      : null
  ])
  const compact = removeDocumentNoise(parts.join(' '), doc)
  const fallback = removeDocumentNoise(row.description_text || row.searchable_text || row.product_text || row.sku_text, doc)
  return (compact || fallback).slice(0, 180).trim()
}

function curatedQueriesFor(doc) {
  const vendor = normalize(doc.vendor?.name)
  const filename = normalize(doc.filename)
  if (!vendor && !filename) return []
  return FULL_KITTING_PRODUCT_VENDORS
    .filter(item => {
      const itemVendor = normalize(item.vendor)
      const vendorMatches = Boolean(
        vendor
        && (vendor === itemVendor || vendor.includes(itemVendor) || itemVendor.includes(vendor))
      )
      return itemVendor
        && (vendorMatches || filename.includes(itemVendor))
    })
    .map(item => ({ type: 'curated', query: item.product }))
    .slice(0, maxCuratedPerDoc)
}

function priceRowQueriesFor(rows, doc) {
  const seen = new Set()
  const out = []
  for (const row of rows) {
    const query = queryFromPriceRow(row, doc)
    if (!query || query.length < 3) continue
    const key = normalize(query)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({
      type: 'indexed',
      query,
      expected_doc_price_item_id: row.id,
      expected_price: Number(row.normalized_price),
      expected_unit: row.unit ?? null,
      expected_sku: row.sku_text ?? null,
      source_page: row.source_page ?? null
    })
    if (out.length >= sampleSize) break
  }
  return out
}

async function loadDocuments() {
  const { data, error } = await supabase
    .from('documents')
    .select('id, owner_id, filename, status, created_at, vendor:vendor_id(name)')
    .eq('status', 'parsed')
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []).filter(doc => {
    if (!skipDocumentRe) return true
    return !skipDocumentRe.test(`${doc.vendor?.name ?? ''} ${doc.filename ?? ''}`)
  })
}

async function loadPriceRows(documentId) {
  const { data, error } = await supabase
    .from('doc_price_items')
    .select('id, source_page, row_headers, column_headers, product_text, sku_text, description_text, searchable_text, normalized_price, unit')
    .eq('document_id', documentId)
    .not('normalized_price', 'is', null)
    .order('source_page', { ascending: true, nullsFirst: false })
    .order('source_row_index', { ascending: true, nullsFirst: false })
    .order('source_col_index', { ascending: true, nullsFirst: false })
    .limit(Math.max(sampleSize * 5, 80))
  if (error) throw error
  return data ?? []
}

function evaluateIndexed(queryCase, result) {
  const exact = result.priced_items.find(item =>
    item.doc_price_item_id === queryCase.expected_doc_price_item_id
    && samePrice(item.price, queryCase.expected_price)
  )
  if (exact) {
    return exact.needs_review || exact.confidence < 0.85
      ? { ok: true, safe: true, item: exact, status: 'safe_review', reason: 'exact row matched but needs review' }
      : { ok: true, safe: true, item: exact, status: 'pass', reason: null }
  }

  const samePriceItem = result.priced_items.find(item => samePrice(item.price, queryCase.expected_price))
  if (samePriceItem) {
    return samePriceItem.needs_review || samePriceItem.confidence < 0.85
      ? { ok: true, safe: true, item: samePriceItem, status: 'safe_review', reason: 'same price but different row; needs review' }
      : { ok: true, safe: true, item: samePriceItem, status: 'pass', reason: 'same price but different row' }
  }

  const first = result.priced_items[0] ?? result.unresolved_items[0]?.closest_candidates?.[0] ?? null
  if (!first) {
    return { ok: true, safe: true, item: null, status: 'safe_unresolved', reason: result.unresolved_items[0]?.reason ?? 'no match' }
  }
  if (first.needs_review || first.confidence < 0.85) {
    return { ok: true, safe: true, item: first, status: 'safe_review', reason: 'closest candidate needs review' }
  }
  return { ok: false, safe: false, item: first, status: 'unsafe_fail', reason: 'wrong high-confidence price' }
}

function evaluateCurated(result) {
  const item = result.priced_items[0] ?? null
  if (!item) {
    return { ok: true, safe: true, item: null, status: 'safe_unresolved', reason: result.unresolved_items[0]?.reason ?? 'no match' }
  }
  if (item.needs_review || item.confidence < 0.85) {
    return { ok: true, safe: true, item, status: 'safe_review', reason: 'matched but needs review' }
  }
  return { ok: true, safe: true, item, status: 'pass', reason: null }
}

async function runCase(doc, queryCase) {
  const started = performance.now()
  const result = await searchItems({
    client: supabase,
    tenantId: doc.owner_id,
    documentId: doc.id,
    message: queryCase.query,
    limitPerItem: 180
  })
  const elapsed_ms = Math.round(performance.now() - started)
  const evaluated = queryCase.type === 'indexed'
    ? evaluateIndexed(queryCase, result)
    : evaluateCurated(result)
  const item = evaluated.item
  return {
    ...queryCase,
    ok: evaluated.ok,
    safe: evaluated.safe,
    status: evaluated.status,
    reason: evaluated.reason,
    elapsed_ms,
    got: item
      ? {
          doc_price_item_id: item.doc_price_item_id ?? null,
          doc_item_id: item.doc_item_id ?? null,
          description: item.description,
          sku: item.sku,
          price: item.price,
          unit: item.unit,
          confidence: item.confidence,
          needs_review: item.needs_review,
          source_page: item.source_page
        }
      : null,
    unresolved_count: result.unresolved_items.length,
    priced_count: result.priced_items.length
  }
}

async function main() {
  const docs = await loadDocuments()
  const report = []
  let total = 0
  let passed = 0
  let failed = 0
  let safeReview = 0
  let safeUnresolved = 0
  let skipped = 0

  for (const doc of docs) {
    const rows = await loadPriceRows(doc.id)
    const cases = [
      ...curatedQueriesFor(doc),
      ...priceRowQueriesFor(rows, doc)
    ]
    const uniqueCases = []
    const seen = new Set()
    for (const item of cases) {
      const key = `${item.type}:${normalize(item.query)}`
      if (seen.has(key)) continue
      seen.add(key)
      uniqueCases.push(item)
    }

    console.log(`\nDOC | ${docLabel(doc)} | cases=${uniqueCases.length} | price_rows=${rows.length}`)
    if (!uniqueCases.length) {
      skipped += 1
      report.push({ document: doc, skipped: true, cases: [] })
      console.log('SKIP | no curated or indexed query cases')
      continue
    }

    const results = []
    for (const queryCase of uniqueCases) {
      total += 1
      const result = await runCase(doc, queryCase)
      results.push(result)
      if (result.status === 'pass') passed += 1
      else if (result.status === 'safe_review') safeReview += 1
      else if (result.status === 'safe_unresolved') safeUnresolved += 1
      else failed += 1
      const got = result.got
      const expected = queryCase.type === 'indexed' ? ` expected=${queryCase.expected_price}` : ''
      const actual = got ? ` got=${got.price} score=${got.confidence} review=${got.needs_review}` : ' got=null'
      const label = result.status === 'pass'
        ? 'PASS'
        : result.status === 'safe_review'
          ? 'SAFE_REVIEW'
          : result.status === 'safe_unresolved'
            ? 'SAFE_UNRESOLVED'
            : 'UNSAFE_FAIL'
      console.log(`${label} | ${queryCase.type} |${expected}${actual} | ${queryCase.query.slice(0, 120)}`)
    }

    report.push({ document: doc, skipped: false, cases: results })
  }

  const summary = { total, passed, safe_review: safeReview, safe_unresolved: safeUnresolved, unsafe_failed: failed, skipped_documents: skipped, generated_at: new Date().toISOString() }
  const artifact = { summary, documents: report }
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, JSON.stringify(artifact, null, 2))
  console.log(`\nsearch:doc-trials summary pass=${passed}; safe_review=${safeReview}; safe_unresolved=${safeUnresolved}; unsafe_failed=${failed}; total=${total}; skipped_documents=${skipped}`)
  console.log(`report: ${outputPath}`)

  if (failOnAny && failed) process.exit(1)
}

await main()
