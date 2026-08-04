#!/usr/bin/env node
import { createJiti } from 'jiti'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}
const archivePath = option('archive', '/Users/krishnadvaipayan/Downloads/ai-ratefinder-chats-2026-07-12.json')
const artifactPath = option('artifact', 'tmp/catalog-v2-all.json')
const expectedPath = option('expected', 'scripts/fixtures/search-v2-full-chat-replay.json')
const outputPath = option('output', 'tmp/search-v2-full-chat-replay.json')

const jiti = createJiti(import.meta.url, { interopDefault: true })
const { parseCatalogQuery, splitCatalogQueries } = await jiti.import('../server/utils/catalog/query.ts')
const { resolveCatalogOffers } = await jiti.import('../server/utils/catalog/searchV2.ts')
const { strictMoney } = await jiti.import('../server/utils/catalog/compiler.ts')
const archive = JSON.parse(readFileSync(archivePath, 'utf8'))
const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'))
const expectations = JSON.parse(readFileSync(expectedPath, 'utf8'))

const offers = artifact.documents.flatMap(document => document.offers
  .filter(offer => !offer.validation_errors.length)
  .map((offer, index) => ({
    id: `${document.document.id}:${index}`,
    document_id: document.document.id,
    vendor_id: document.document.vendor_id,
    documents: { filename: document.document.filename },
    ...offer
  })))

const occurrences = []
for (const [chatIndex, chat] of archive.chats.entries()) {
  for (const message of chat.messages ?? []) {
    if (message.role !== 'user') continue
    for (const queryText of splitCatalogQueries(message.content)) {
      occurrences.push({ chatIndex, chat, message, queryText })
    }
  }
}

const results = []
for (const occurrence of occurrences) {
  const expected = expectations[occurrence.queryText]
  const query = parseCatalogQuery(occurrence.queryText)
  const result = query.category
    ? resolveCatalogOffers(query, offers)
    : {
        query,
        state: 'ambiguous',
        offers: [],
        missing_facets: ['category'],
        explanation: 'Specify a supported product family before catalogue retrieval.'
      }
  const failures = []
  if (!expected) failures.push('missing_expected_case')
  if (expected && result.state !== expected.state) failures.push(`state:${result.state}!=${expected.state}`)
  for (const facet of expected?.missing ?? []) {
    if (!result.missing_facets.includes(facet)) failures.push(`missing_facet_not_reported:${facet}`)
  }
  for (const price of expected?.prices ?? []) {
    if (!result.offers.some(offer => Number(offer.amount) === Number(price))) failures.push(`expected_price_not_returned:${price}`)
  }
  for (const sku of expected?.skus ?? []) {
    if (!result.offers.some(offer => normalize(offer.sku) === normalize(sku))) failures.push(`expected_sku_not_returned:${sku}`)
  }
  for (const offer of result.offers) {
    if (strictMoney(offer.raw_price_value) !== Number(offer.amount)) failures.push(`source_reconstruction:${offer.id}`)
    if (!Number.isInteger(offer.source_row_index) || !Number.isInteger(offer.source_col_index)) failures.push(`missing_coordinate:${offer.id}`)
    if (!offer.source_excerpt?.trim()) failures.push(`missing_source_excerpt:${offer.id}`)
  }
  results.push({
    status: failures.length ? 'FAIL' : 'PASS',
    failures,
    chat_number: occurrence.chatIndex + 1,
    chat_title: occurrence.chat.title,
    message_id: occurrence.message.id,
    query: occurrence.queryText,
    parsed: { category: query.category, facets: query.facets, basis: [query.requested_basis_quantity, query.requested_basis_unit] },
    expected_state: expected?.state ?? null,
    actual_state: result.state,
    missing_facets: result.missing_facets,
    offers: result.offers.map(offer => ({
      id: offer.id,
      name: offer.canonical_name,
      sku: offer.sku,
      brand: offer.brand,
      facets: offer.facets,
      amount: offer.amount,
      currency: offer.currency,
      basis_quantity: offer.basis_quantity,
      basis_unit: offer.basis_unit,
      document: Array.isArray(offer.documents) ? offer.documents[0]?.filename : offer.documents?.filename,
      page: offer.source_page,
      table: offer.source_table_index,
      row: offer.source_row_index,
      column: offer.source_col_index,
      raw_price_value: offer.raw_price_value
    }))
  })
}

const archivedQueries = new Set(results.map(result => result.query))
const unusedExpectations = Object.keys(expectations).filter(query => !archivedQueries.has(query))
const failures = results.filter(result => result.status === 'FAIL')
const report = {
  generated_at: new Date().toISOString(),
  archive: archivePath,
  artifact: artifactPath,
  chats: archive.chats.length,
  query_occurrences: results.length,
  unique_queries: archivedQueries.size,
  passed: results.length - failures.length,
  failed: failures.length,
  unused_expectations: unusedExpectations,
  results
}
mkdirSync(outputPath.split('/').slice(0, -1).join('/') || '.', { recursive: true })
writeFileSync(outputPath, JSON.stringify(report, null, 2))
for (const result of results) {
  console.log(JSON.stringify({
    status: result.status,
    chat: result.chat_number,
    query: result.query,
    state: result.actual_state,
    missing: result.missing_facets,
    prices: [...new Set(result.offers.map(offer => offer.amount))],
    failures: result.failures
  }))
}
console.log(JSON.stringify({ output: outputPath, chats: report.chats, occurrences: report.query_occurrences, unique: report.unique_queries, passed: report.passed, failed: report.failed }))
if (unusedExpectations.length || failures.length) process.exit(1)

function normalize(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, '')
}
