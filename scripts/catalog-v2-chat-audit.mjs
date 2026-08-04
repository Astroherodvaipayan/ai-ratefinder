#!/usr/bin/env node
import { createJiti } from 'jiti'
import { readFileSync } from 'node:fs'

const jiti = createJiti(import.meta.url, { interopDefault: true })
const { parseCatalogQuery } = await jiti.import('../server/utils/catalog/query.ts')
const { resolveCatalogOffers } = await jiti.import('../server/utils/catalog/searchV2.ts')
const artifact = JSON.parse(readFileSync('tmp/catalog-v2-all.json', 'utf8'))
const acceptance = JSON.parse(readFileSync('tmp/search-v2-acceptance.json', 'utf8'))

const offers = artifact.documents.flatMap(document => document.offers
  .filter(offer => !offer.validation_errors.length)
  .map((offer, index) => ({
    id: `${document.document.id}:${index}`,
    document_id: document.document.id,
    vendor_id: document.document.vendor_id,
    ...offer
  })))

let passed = 0
const results = []
for (const test of acceptance.cases) {
  const query = parseCatalogQuery(test.query)
  const result = resolveCatalogOffers(query, offers)
  const stateMatches = result.state === test.expected_state
  const requiredMatches = result.offers.every(offer => requiredFacetsMatch(test.required_facets ?? {}, offer))
  const forbiddenClear = result.offers.every(offer => forbiddenFacetsClear(test.forbidden_facets ?? {}, offer))
  const priceMatches = test.expected_price === undefined
    || result.offers.some(offer => Number(offer.amount) === Number(test.expected_price))
  const skuMatches = test.expected_sku === undefined
    || result.offers.some(offer => normalize(offer.sku) === normalize(test.expected_sku))
  const ok = stateMatches && requiredMatches && forbiddenClear && priceMatches && skuMatches
  if (ok) passed += 1
  results.push({
    status: ok ? 'PASS' : 'FAIL',
    query: test.query,
    expected_state: test.expected_state,
    actual_state: result.state,
    parsed: { category: query.category, facets: query.facets, basis: [query.requested_basis_quantity, query.requested_basis_unit] },
    missing_facets: result.missing_facets,
    offers: result.offers.slice(0, 12).map(offer => ({
      category: offer.category,
      name: offer.canonical_name,
      sku: offer.sku,
      facets: offer.facets,
      amount: offer.amount,
      basis: [offer.basis_quantity, offer.basis_unit]
    }))
  })
}

for (const result of results) console.log(JSON.stringify(result))
console.log(JSON.stringify({ total: results.length, passed, failed: results.length - passed }))
if (passed !== results.length) process.exit(1)

function requiredFacetsMatch(required, offer) {
  return Object.entries(required).every(([key, expected]) => {
    const actual = key === 'category'
      ? offer.category
      : key === 'length_m' && offer.basis_unit === 'meter'
        ? offer.basis_quantity
        : offer.facets[key]
    return normalize(actual) === normalize(expected)
  })
}

function forbiddenFacetsClear(forbidden, offer) {
  return Object.entries(forbidden).every(([key, forbiddenValue]) => {
    const actual = key === 'category' ? offer.category : offer.facets[key]
    return normalize(actual) !== normalize(forbiddenValue)
  })
}

function normalize(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, '')
}
