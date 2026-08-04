#!/usr/bin/env node
import { createJiti } from 'jiti'
import { readFileSync } from 'node:fs'

const jiti = createJiti(import.meta.url, { interopDefault: true })
const { parseCatalogQuery } = await jiti.import('../server/utils/catalog/query.ts')
const { resolveCatalogOffers } = await jiti.import('../server/utils/catalog/searchV2.ts')

const files = [
  'tmp/catalog-v2-kei-rg6.json',
  'tmp/catalog-v2-orient-armoured.json',
  'tmp/catalog-v2-lk-mcb.json',
  'tmp/catalog-v2-precision-junction.json',
  'tmp/catalog-v2-kei-wire.json'
]

const offers = files.flatMap(file => {
  const artifact = JSON.parse(readFileSync(file, 'utf8'))
  return artifact.offers
    .filter(offer => offer.validation_errors.length === 0)
    .map((offer, index) => ({
      id: `${file}:${index}`,
      document_id: artifact.document.id,
      vendor_id: null,
      ...offer
    }))
})

const cases = [
  {
    query: 'CAT 6 Armoured',
    state: 'absent',
    verify: result => result.offers.length === 0
  },
  {
    query: 'TV Cable RG 6',
    state: 'ambiguous',
    verify: result => result.offers.length === 4
      && result.offers.every(offer => offer.facets.standard === 'RG-6')
      && result.missing_facets.includes('conductor_material')
      && result.missing_facets.includes('price_basis')
  },
  {
    query: '63Amp 4Pole MCB',
    state: 'exact',
    verify: result => result.offers.length === 1
      && result.offers[0].sku === 'BA40630C'
      && result.offers[0].amount === 2450
  },
  {
    query: '20mm 4Way Junction Box',
    state: 'exact',
    verify: result => result.offers.length === 1
      && result.offers[0].sku === 'PRCB 204'
      && result.offers[0].amount === 28.75
  },
  {
    query: '16Sqmm*4Core Aluminium Armoured Cable',
    state: 'exact',
    verify: result => result.offers.length === 1
      && result.offers[0].amount === 582
  },
  {
    query: '1sqmm x 1Core wire FRLSH',
    state: 'exact',
    verify: result => result.offers.length === 1
      && result.offers[0].amount === 10710
      && result.offers[0].basis_quantity === 300
      && result.offers[0].basis_unit === 'meter'
  }
]

let failed = 0
for (const test of cases) {
  const parsed = parseCatalogQuery(test.query)
  const result = resolveCatalogOffers(parsed, offers)
  const passed = result.state === test.state && test.verify(result)
  if (!passed) failed += 1
  console.log(JSON.stringify({
    status: passed ? 'PASS' : 'FAIL',
    query: test.query,
    parsed: { category: parsed.category, facets: parsed.facets },
    expected_state: test.state,
    actual_state: result.state,
    offers: result.offers.map(offer => ({ name: offer.canonical_name, sku: offer.sku, amount: offer.amount, facets: offer.facets })),
    missing_facets: result.missing_facets
  }))
}

console.log(JSON.stringify({ total: cases.length, passed: cases.length - failed, failed }))
if (failed) process.exit(1)
