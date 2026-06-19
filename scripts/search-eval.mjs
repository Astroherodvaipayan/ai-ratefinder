#!/usr/bin/env node
import { createJiti } from 'jiti'
import assert from 'node:assert/strict'

const jiti = createJiti(import.meta.url)
const { parseUserItemQuery } = await jiti.import('../server/utils/search/parseUserItemQuery.ts')
const { scoreCandidates } = await jiti.import('../server/utils/search/scoreCandidates.ts')
const { buildLegacyStructuredRecallQueries } = await jiti.import('../server/utils/search/generateCandidates.ts')

const candidate = {
  doc_price_item_id: 'fixture-price-6sqmm-2core',
  doc_item_id: 'fixture-legacy-6sqmm-2core',
  document_id: 'fixture-document',
  vendor_id: 'fixture-vendor',
  vendor: 'Fixture Vendor',
  source_document: 'Fixture Price List',
  source_uploaded_at: '2026-01-01T00:00:00.000Z',
  source_page: 5,
  source_table_id: 'fixture-table',
  source_row_index: 6,
  source_col_index: 2,
  section_breadcrumb: ['XLPE Armoured Cables with Copper Conductor'],
  table_title: 'XLPE Armoured Cables with Copper Conductor',
  row_headers: ['6 sqmm'],
  column_headers: ['2 core'],
  parent_headers: ['Copper conductor'],
  nearby_notes: ['Rates per meter'],
  raw_cell_value: '693',
  normalized_price: 693,
  currency: 'INR',
  unit: 'meter',
  moq: null,
  product_text: 'XLPE Armoured Cables with Copper Conductor 6 sqmm 2 core',
  sku_text: '6 sqmm',
  description_text: 'XLPE Armoured Cables with Copper Conductor 6 sqmm 2 core',
  attributes_json: [
    { name: 'size', value: '6', unit: 'sqmm' },
    { name: 'cores', value: '2' }
  ],
  searchable_text: 'Vendor: Fixture Vendor. Document: Fixture Price List. Page: 5. Section: XLPE Armoured Cables with Copper Conductor. Row: 6 sqmm. Column: 2 core. Rate: 693 INR per meter.',
  normalized_search_text: 'fixture vendor fixture price list xlpe armoured cables copper conductor 6 sqmm 2 core 693 inr meter',
  source_confidence: 0.9,
  parser_name: 'fixture',
  recall_path: 'fixture',
  recall_score: 1
}

const cases = [
  { query: '6SqmmX2Core copper armoured cable', expected_price: 693, expected_unit: 'meter', expected_confidence_min: 0.85 },
  { query: '6 sq mm x 2 core copper armoured cable', expected_price: 693, expected_unit: 'meter', expected_confidence_min: 0.85 },
  { query: '6SQMM 2C cu armoured cable', expected_price: 693, expected_unit: 'meter', expected_confidence_min: 0.85 },
  { query: 'XLPE copper 6 sqmm 2 core rate', expected_price: 693, expected_unit: 'meter', expected_confidence_min: 0.85 }
]

for (const testCase of cases) {
  const parsed = parseUserItemQuery(testCase.query)
  const [scored] = scoreCandidates({ parsed, candidates: [candidate] })
  assert(scored, `${testCase.query}: expected a scored candidate`)
  assert.equal(scored.candidate.normalized_price, testCase.expected_price, `${testCase.query}: price changed`)
  assert.equal(scored.candidate.unit, testCase.expected_unit, `${testCase.query}: unit changed`)
  assert(
    scored.score >= testCase.expected_confidence_min,
    `${testCase.query}: score ${scored.score} below ${testCase.expected_confidence_min}`
  )
  assert.equal(scored.confidence_label, 'Matched', `${testCase.query}: should be high confidence`)
}

const legacyParsed = parseUserItemQuery('6SqmmX2Core Cu Armoured Cable')
const recallTerms = buildLegacyStructuredRecallQueries(legacyParsed).map(query => query.terms.join(' '))
assert(
  recallTerms.some(terms => /\b2 core\b/.test(terms) && /\bcopper\b/.test(terms)),
  'legacy recall must search spaced core forms like "2 core" with material terms'
)
assert(
  recallTerms.some(terms => /\b2core\b/.test(terms)),
  'legacy recall must also search compact core forms like "2core"'
)

const switchQuantityParsed = parseUserItemQuery('12 nos 6Amp Switch')
assert.deepEqual(
  switchQuantityParsed.requested_quantities[0],
  { value: 12, unit: 'piece', raw: '12 nos' },
  'nos should be treated as ordered quantity'
)
assert(
  !switchQuantityParsed.attribute_hints.some(hint => hint.name === 'piece'),
  'sales units such as nos should not become product attributes'
)

const packetQuantityParsed = parseUserItemQuery('3 PKT blank plate')
assert.deepEqual(
  packetQuantityParsed.requested_quantities[0],
  { value: 3, unit: 'packet', raw: '3 PKT' },
  'PKT should normalize to packet as an ordered quantity'
)

const workbookCableParsed = parseUserItemQuery('25Sqmm*3.5Core XLPE Cu Armoured Cabel')
assert(
  workbookCableParsed.attribute_hints.some(hint => hint.name === 'size' && hint.value === '25' && hint.unit === 'sqmm'),
  'workbook cable query should expose size'
)
assert(
  workbookCableParsed.attribute_hints.some(hint => hint.name === 'cores' && hint.value === '3.5'),
  'workbook cable query should expose decimal core count'
)
assert(
  workbookCableParsed.product_terms.includes('cable'),
  'Cabel typo should normalize to cable'
)
assert(
  workbookCableParsed.vendor_terms.includes('polycab'),
  'known unique workbook cable should infer Polycab as a vendor hint'
)

const singleCoreParsed = parseUserItemQuery('4Sqmm*SC Red wire')
assert(
  singleCoreParsed.attribute_hints.some(hint => hint.name === 'cores' && hint.value === '1'),
  'SC should parse as single core in cable/wire context'
)

const hillsParsed = parseUserItemQuery('wardrobe sensor')
assert(
  hillsParsed.vendor_terms.includes('hills'),
  'workbook typo Scensior should still let wardrobe sensor infer Hills'
)

const legacyOrientStyleCandidate = {
  ...candidate,
  doc_price_item_id: null,
  doc_item_id: 'fixture-legacy-orient-6sqmm-2core',
  source_page: null,
  source_table_id: null,
  source_row_index: null,
  source_col_index: null,
  section_breadcrumb: ['Fixture Vendor', 'Fixture Price List'],
  table_title: 'Fixture Price List',
  row_headers: ['COPPER ARMOURED CABLES • 2XWY/2XFY 6 2 CORE', '6'],
  column_headers: ['2 CORE'],
  parent_headers: ['Fixture Vendor'],
  unit: '2 CORE',
  product_text: 'COPPER ARMOURED CABLES • 2XWY/2XFY 6 2 CORE',
  sku_text: '6',
  description_text: 'COPPER ARMOURED CABLES • 2XWY/2XFY 6 2 CORE',
  searchable_text: 'Fixture Vendor Fixture Price List COPPER ARMOURED CABLES 2XWY 2XFY 6 2 CORE 6 2 CORE 693',
  normalized_search_text: 'fixture vendor fixture price list copper armoured cables 2xwy 2xfy 6 2 core 6 2 core 693',
  source_confidence: 0.78,
  parser_name: 'legacy-doc-items',
  recall_path: 'legacy_indexed_sql',
  recall_score: 0.92
}
const [legacyScored] = scoreCandidates({ parsed: legacyParsed, candidates: [legacyOrientStyleCandidate] })
assert(legacyScored, 'legacy Orient-style candidate should be scored')
assert.equal(legacyScored.candidate.normalized_price, 693, 'legacy Orient-style price changed')
assert(
  legacyScored.score >= 0.85,
  `legacy Orient-style score ${legacyScored.score} below high-confidence threshold`
)

const vagueParsed = parseUserItemQuery('6SqmmX2Core')
const [vagueScored] = scoreCandidates({ parsed: vagueParsed, candidates: [legacyOrientStyleCandidate] })
assert(vagueScored, 'vague numeric-only cable candidate should be scored')
assert(
  vagueScored.score < 0.85,
  `vague numeric-only query should not auto-match, got ${vagueScored.score}`
)

const workbookCableCandidate = {
  ...candidate,
  doc_price_item_id: 'fixture-price-polycab-25sqmm-3p5core',
  doc_item_id: 'fixture-legacy-polycab-25sqmm-3p5core',
  vendor: 'Polycab',
  row_headers: ['25 sqmm'],
  column_headers: ['3.5 core'],
  parent_headers: ['Copper conductor'],
  table_title: 'XLPE Copper Armoured Cable',
  unit: 'meter',
  product_text: '25 sqmm 3.5 core XLPE Copper Armoured Cable',
  sku_text: '25 sqmm',
  description_text: '25 sqmm 3.5 core XLPE Copper Armoured Cable',
  attributes_json: [
    { name: 'size', value: '25', unit: 'sqmm' },
    { name: 'cores', value: '3.5' }
  ],
  searchable_text: 'Vendor: Polycab. Section: XLPE Copper Armoured Cable. Row: 25 sqmm. Column: 3.5 core. Rate: 100 INR per meter.',
  normalized_search_text: 'polycab xlpe copper armoured cable 25 sqmm 3.5 core 100 inr meter',
  normalized_price: 100
}
const [workbookCableScored] = scoreCandidates({ parsed: workbookCableParsed, candidates: [workbookCableCandidate] })
assert(
  workbookCableScored.score >= 0.85,
  `workbook 3.5 core cable should match confidently, got ${workbookCableScored.score}`
)

const unarmouredParsed = parseUserItemQuery('6 sqmm 2 core copper unarmoured cable')
const [armouredForUnarmoured] = scoreCandidates({ parsed: unarmouredParsed, candidates: [candidate] })
assert(
  armouredForUnarmoured.score < 0.65,
  `unarmoured query should not auto-accept armoured candidate, got ${armouredForUnarmoured.score}`
)

console.log(`eval:search passed ${cases.length + 14} deterministic cases`)
