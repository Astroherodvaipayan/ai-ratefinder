#!/usr/bin/env node
import { createJiti } from 'jiti'
import assert from 'node:assert/strict'

const jiti = createJiti(import.meta.url)
const { parseUserItemQuery } = await jiti.import('../server/utils/search/parseUserItemQuery.ts')
const { scoreCandidates } = await jiti.import('../server/utils/search/scoreCandidates.ts')

const baseCandidate = {
  doc_price_item_id: 'fixture-price-1p5-fr-wire',
  doc_item_id: 'fixture-legacy-1p5-fr-wire',
  document_id: 'fixture-document',
  vendor_id: 'fixture-vendor',
  vendor: 'Fixture Vendor',
  source_document: 'Fixture Wire Price List',
  source_uploaded_at: '2026-01-01T00:00:00.000Z',
  source_page: 8,
  source_table_id: 'fixture-table',
  source_row_index: 12,
  source_col_index: 4,
  section_breadcrumb: ['FR Wire'],
  table_title: 'FR Wire Coils',
  row_headers: ['1.5 sqmm FR wire'],
  column_headers: ['300 meter coil'],
  parent_headers: ['Copper conductor'],
  nearby_notes: ['Coil length 300 meter'],
  raw_cell_value: '1120',
  normalized_price: 1120,
  currency: 'INR',
  unit: 'coil',
  moq: null,
  product_text: 'FR Wire 1.5 sqmm 300 meter coil',
  sku_text: '1.5 sqmm',
  description_text: 'FR Wire 1.5 sqmm 300 meter coil',
  attributes_json: [
    { name: 'size', value: '1.5', unit: 'sqmm' },
    { name: 'length', value: '300', unit: 'meter' }
  ],
  searchable_text: 'Vendor: Fixture Vendor. Document: Fixture Wire Price List. Page: 8. Section: FR Wire. Row: 1.5 sqmm FR wire. Column: 300 meter coil. Rate: 1120 INR per coil.',
  normalized_search_text: 'fixture vendor wire price list fr wire 1.5 sqmm 300 meter coil 1120 inr',
  source_confidence: 0.9,
  parser_name: 'fixture',
  recall_path: 'fixture',
  recall_score: 1
}

const mutations = [
  '1.5Sqmm FR Wire 300Mtr',
  '1.5 SQ MM fr wire 300 mtrs',
  '300Mtr 1.5Sqmm FR Wire',
  'fr wire 1.5sqmm 300 meter',
  'Fixture Vendor 1.5Sqmm 300Mtr FR Wire',
  '1.5sqmm frwire 300mtr'
]

for (const query of mutations) {
  const parsed = parseUserItemQuery(query)
  const [scored] = scoreCandidates({ parsed, candidates: [baseCandidate] })
  assert(scored, `${query}: expected a scored candidate`)
  assert.equal(scored.candidate.doc_price_item_id, baseCandidate.doc_price_item_id, `${query}: selected record changed`)
  assert(
    scored.score >= 0.75,
    `${query}: mutation score ${scored.score} below 0.75`
  )
}

const pasted = ['6SqmmX2Core', '1.5Sqmm FR Wire 300Mtr'].join('\n')
const parsedPasted = parseUserItemQuery(pasted)
assert(parsedPasted.attribute_hints.length >= 2, 'multi-item pasted query should expose deterministic attributes')

const singleCoreMutations = [
  '4Sqmm*SC Red wire',
  '4 sqmm single core red wire',
  '2 bdl 4SqmmXSC red wire'
]

for (const query of singleCoreMutations) {
  const parsed = parseUserItemQuery(query)
  assert(
    parsed.attribute_hints.some(hint => hint.name === 'cores' && hint.value === '1'),
    `${query}: expected single-core attribute`
  )
}

const salesQuantityParsed = parseUserItemQuery('2 boxes 6Amp Switch')
assert.deepEqual(
  salesQuantityParsed.requested_quantities[0],
  { value: 2, unit: 'box', raw: '2 boxes' },
  'boxes should be treated as ordered quantity'
)

console.log(`eval:mutations passed ${mutations.length + 5} mutation cases`)
