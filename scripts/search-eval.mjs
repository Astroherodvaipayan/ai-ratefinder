#!/usr/bin/env node
import { createJiti } from 'jiti'
import assert from 'node:assert/strict'

const jiti = createJiti(import.meta.url)
const { parseUserItemQuery } = await jiti.import('../server/utils/search/parseUserItemQuery.ts')
const { scoreCandidates } = await jiti.import('../server/utils/search/scoreCandidates.ts')
const { buildLegacyStructuredRecallQueries } = await jiti.import('../server/utils/search/generateCandidates.ts')
const { canonicalizeExtractedRows, canonicalizeGridTable } = await jiti.import('../server/utils/extraction/canonicalizeTable.ts')
const { priceRecordsFromCanonicalTables } = await jiti.import('../server/utils/extraction/priceCellRecords.ts')

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

const precisionWayParsed = parseUserItemQuery('20mm 4Way Junction')
assert(
  precisionWayParsed.attribute_hints.some(hint => hint.name === 'way' && hint.value === '4'),
  'compact way wording should expose the junction way count'
)

const catalogueCodeParsed = parseUserItemQuery('Switch 6A One-way - 1 Module C5110.01')
assert(
  catalogueCodeParsed.product_terms.includes('C5110.01'),
  'catalogue/model codes should be preserved as product terms'
)

const spacedCodeParsed = parseUserItemQuery('PRCS 19H 19 RATEMtr.')
assert(
  spacedCodeParsed.product_terms.includes('PRCS19H'),
  'spaced catalogue/model codes should be preserved in compact form'
)

const noisyDocumentParsed = parseUserItemQuery('1.50 Cabel 01-05-2026.pdf SIZESQ. MM. 1.50 RATE PER100 MTRS. meter')
assert(
  !noisyDocumentParsed.product_terms.some(term => /pdf|per100|cable01|sizesq/i.test(term)),
  'document dates, filenames, and rate-basis text should not become product/code terms'
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

const precisionFixtureTable = canonicalizeGridTable({
  grid: [
    ['SR.NO.', 'PRODUCTCODE', 'SIZE', 'STANDARD PACK', 'STANDARD PACK', 'RATEPc'],
    ['SR.NO.', 'PRODUCTCODE', 'OD(mm)', 'Pc./Box', 'Pc./Carton', 'RATEPc'],
    ['53', 'PRCB 201', '20', '20', '600', '23.25'],
    ['55', 'PRCB 203', '20', '20', '600', '27.25'],
    ['56', 'PRCB 204', '20', '20', '600', '28.75']
  ],
  sourcePage: 4,
  tableIndex: 0,
  tableTitle: 'SR.NO.',
  sectionBreadcrumb: ['Precision', 'Precision price list'],
  parserName: 'fixture',
  parserConfidence: 0.78
})
const precisionRecords = priceRecordsFromCanonicalTables({
  tenant_id: 'fixture-tenant',
  document_id: 'fixture-doc',
  vendor_id: 'fixture-vendor',
  vendor_name: 'Precision',
  document_title: 'Precision price list',
  source_uploaded_at: '2026-03-19T00:00:00.000Z',
  tables: [precisionFixtureTable]
})
assert.equal(precisionRecords.length, 3, 'Precision pack rows should emit only RATEPc prices')
const fourWayRecord = precisionRecords.find(record => record.sku_text === 'PRCB 204')
assert(fourWayRecord, 'PRCB 204 should be indexed')
assert.equal(fourWayRecord.normalized_price, 28.75, 'PRCB 204 should use RATEPc, not pack/carton quantity')
assert.match(fourWayRecord.searchable_text, /20mm 4Way Junction/i, 'PRCB 204 should gain natural product identity')
assert.equal(fourWayRecord.unit, 'piece', 'RATEPc should infer piece unit')

const precisionConduitTable = canonicalizeGridTable({
  grid: [
    ['# 14', 'PRCS 19M', '19', '100 x 3m', '300', '-', '30.00'],
    ['16', 'PRCS 20M', '20', '100 x 3m', '300', '-', '31.50'],
    ['18', 'PRCS 25M', '25', '100 x 3m', '300', '-', '44.50']
  ],
  sourcePage: 3,
  tableIndex: 1,
  tableTitle: '# 14',
  sectionBreadcrumb: ['Precision', 'Precision price list'],
  parserName: 'fixture',
  parserConfidence: 0.78
})
const conduitRecords = priceRecordsFromCanonicalTables({
  tenant_id: 'fixture-tenant',
  document_id: 'fixture-doc',
  vendor_id: 'fixture-vendor',
  vendor_name: 'Precision',
  document_title: 'Precision price list',
  source_uploaded_at: '2026-03-19T00:00:00.000Z',
  tables: [precisionConduitTable]
})
const conduit20 = conduitRecords.find(record => record.sku_text === 'PRCS 20M')
assert(conduit20, 'PRCS 20M should be indexed from a weak-header table')
assert.equal(conduit20.normalized_price, 31.50, 'PRCS 20M should use the rightmost rate cell')
assert.match(conduit20.searchable_text, /20mm Conduit pipe MMS/i, 'PRCS 20M should gain conduit identity')
assert.equal(conduit20.unit, 'meter', 'PRCS conduit rates should infer meter unit')

const specOnlyTable = canonicalizeGridTable({
  grid: [
    ['Description', 'Current Rating', 'Catalogue No.', 'MOQ'],
    ['Fixture Switch', '6', '6730 06', '20'],
    ['Fixture Socket', '16', '6730 16', '10']
  ],
  sourcePage: 1,
  tableIndex: 2,
  tableTitle: 'Fixture spec table',
  sectionBreadcrumb: ['Fixture'],
  parserName: 'fixture',
  parserConfidence: 0.78
})
const specOnlyRecords = priceRecordsFromCanonicalTables({
  tenant_id: 'fixture-tenant',
  document_id: 'fixture-doc',
  vendor_id: 'fixture-vendor',
  vendor_name: 'Fixture',
  document_title: 'Fixture spec table',
  source_uploaded_at: '2026-03-19T00:00:00.000Z',
  tables: [specOnlyTable]
})
assert.equal(specOnlyRecords.length, 0, 'spec/current/catalogue/MOQ cells should not be indexed as prices')

const nonItemRowsTable = canonicalizeGridTable({
  grid: [
    ['Description', 'Rate'],
    ['RG-59', '3900'],
    ['Subtotal', '19394.78'],
    ['GST', '3491.06'],
    ['Grand Total', '22885.83']
  ],
  sourcePage: 1,
  tableIndex: 4,
  tableTitle: 'Quote totals and model numbers',
  sectionBreadcrumb: ['Fixture'],
  parserName: 'fixture',
  parserConfidence: 0.78
})
const nonItemRecords = priceRecordsFromCanonicalTables({
  tenant_id: 'fixture-tenant',
  document_id: 'fixture-doc',
  vendor_id: 'fixture-vendor',
  vendor_name: 'Fixture',
  document_title: 'Fixture non item rows',
  source_uploaded_at: '2026-03-19T00:00:00.000Z',
  tables: [nonItemRowsTable]
})
assert(
  nonItemRecords.every(record => record.normalized_price > 0),
  'model numbers such as RG-59 should not become negative price records'
)
assert(
  !nonItemRecords.some(record => /subtotal|gst|grand total/i.test(record.description_text ?? '')),
  'subtotal/GST/grand-total rows should not be indexed as item prices'
)

const norisysStyleTable = canonicalizeGridTable({
  grid: [
    ['Cat No.', 'Description', 'Rate'],
    ['C5110.01', 'Switch 6A One-way - 1 Module', '168']
  ],
  sourcePage: 12,
  tableIndex: 5,
  tableTitle: 'Norisys switches',
  sectionBreadcrumb: ['Norisys', 'Switches'],
  parserName: 'fixture',
  parserConfidence: 0.78
})
const norisysRecords = priceRecordsFromCanonicalTables({
  tenant_id: 'fixture-tenant',
  document_id: 'fixture-doc',
  vendor_id: 'fixture-vendor',
  vendor_name: 'Norisys',
  document_title: 'Norisys switches',
  source_uploaded_at: '2026-03-19T00:00:00.000Z',
  tables: [norisysStyleTable]
})
const norisysSwitch = norisysRecords.find(record => record.sku_text === 'C5110.01')
assert(norisysSwitch, 'catalogue/model code should be promoted into sku_text')

const matrixRateTable = canonicalizeGridTable({
  grid: [
    ['Size', '2 Core', '3 Core'],
    ['6 sqmm', '693', '935'],
    ['10 sqmm', '1070', '1450']
  ],
  sourcePage: 2,
  tableIndex: 3,
  tableTitle: 'XLPE Copper Armoured Cables',
  sectionBreadcrumb: ['Fixture', 'Rates per meter'],
  parserName: 'fixture',
  parserConfidence: 0.78
})
const matrixRecords = priceRecordsFromCanonicalTables({
  tenant_id: 'fixture-tenant',
  document_id: 'fixture-doc',
  vendor_id: 'fixture-vendor',
  vendor_name: 'Fixture',
  document_title: 'Fixture cable rates',
  source_uploaded_at: '2026-03-19T00:00:00.000Z',
  tables: [matrixRateTable]
})
assert.equal(matrixRecords.length, 4, 'matrix rate tables should still index numeric price cells')

const legacySpreadsheetTables = canonicalizeExtractedRows({
  rows: [
    {
      raw_name: 'Polycab 2.5mm Wire',
      sku: 'PC-W25-100',
      unit: 'Meter',
      moq: '100',
      currency: 'INR',
      price: 45.5,
      source_page: null
    },
    {
      raw_name: 'Anchor Roma Fan',
      sku: 'AN-FAN-48',
      unit: 'Piece',
      moq: '10',
      currency: 'INR',
      price: 2450,
      source_page: null
    }
  ],
  documentTitle: 'sample-prices.csv',
  vendorName: 'Fixture',
  parserName: 'fixture',
  parserConfidence: 0.72
})
const legacySpreadsheetRecords = priceRecordsFromCanonicalTables({
  tenant_id: 'fixture-tenant',
  document_id: 'fixture-doc',
  vendor_id: 'fixture-vendor',
  vendor_name: 'Fixture',
  document_title: 'sample-prices.csv',
  source_uploaded_at: '2026-03-19T00:00:00.000Z',
  tables: legacySpreadsheetTables
})
assert.equal(legacySpreadsheetRecords.length, 2, 'legacy spreadsheet rows with mm in product names should emit rate records')

function candidateFromRecord(record) {
  return {
    doc_price_item_id: 'fixture-price',
    doc_item_id: null,
    document_id: record.document_id,
    vendor_id: record.vendor_id,
    vendor: 'Precision',
    source_document: 'Precision price list',
    source_uploaded_at: record.source_uploaded_at,
    source_page: record.source_page,
    source_table_id: record.source_table_id,
    source_row_index: record.source_row_index,
    source_col_index: record.source_col_index,
    section_breadcrumb: record.section_breadcrumb,
    table_title: record.table_title,
    row_headers: record.row_headers,
    column_headers: record.column_headers,
    parent_headers: record.parent_headers,
    nearby_notes: record.nearby_notes,
    raw_cell_value: record.raw_cell_value,
    normalized_price: record.normalized_price,
    currency: record.currency,
    unit: record.unit,
    moq: record.moq,
    product_text: record.product_text,
    sku_text: record.sku_text,
    description_text: record.description_text,
    attributes_json: record.attributes_json,
    searchable_text: record.searchable_text,
    normalized_search_text: record.normalized_search_text,
    source_confidence: record.source_confidence,
    parser_name: record.parser_name,
    recall_path: 'fixture',
    recall_score: 1
  }
}

const [fourWayScored] = scoreCandidates({
  parsed: parseUserItemQuery('20mm 4Way Junction'),
  candidates: [candidateFromRecord(fourWayRecord)]
})
assert(
  fourWayScored.score >= 0.85,
  `Precision natural junction query should match confidently, got ${fourWayScored.score}`
)

const [conduitScored] = scoreCandidates({
  parsed: parseUserItemQuery('20mm Conduit pipe MMS'),
  candidates: [candidateFromRecord(conduit20)]
})
assert(
  conduitScored.score >= 0.85,
  `Precision natural conduit query should match confidently, got ${conduitScored.score}`
)

const [oneWayScored] = scoreCandidates({
  parsed: parseUserItemQuery('20mm 1Way Junction'),
  candidates: precisionRecords.map(candidateFromRecord)
})
assert.equal(oneWayScored.candidate.sku_text, 'PRCB 201', '1Way junction should select PRCB 201')
assert.equal(oneWayScored.candidate.normalized_price, 23.25, '1Way junction should use PRCB 201 RATEPc')
assert(
  oneWayScored.score >= 0.85,
  `Precision 1Way junction should match confidently, got ${oneWayScored.score}`
)

const [norisysSwitchScored] = scoreCandidates({
  parsed: catalogueCodeParsed,
  candidates: [{
    ...candidateFromRecord(norisysSwitch),
    vendor: 'Norisys',
    source_document: 'Norisys switches'
  }]
})
assert(
  norisysSwitchScored.score >= 0.85,
  `one-way switch query should not be penalized as a junction, got ${norisysSwitchScored.score}`
)
assert(
  !norisysSwitchScored.conflicting_fields.includes('product_family:junction'),
  'one-way switch must not trigger junction product-family conflict'
)

const schneiderCodeParsed = parseUserItemQuery('A9N2P06BGN AC Miniature Circuit Breakers Rated Current 10A B Curve')
const schneiderExactCandidate = {
  ...candidate,
  doc_price_item_id: 'fixture-schneider-a9n2p06bgn',
  normalized_price: 1857,
  sku_text: 'A9N2P06BGN',
  product_text: 'A9N2P06BGN AC Miniature Circuit Breakers Rated Current 10A B Curve',
  description_text: 'A9N2P06BGN AC Miniature Circuit Breakers Rated Current 10A B Curve',
  searchable_text: 'A9N2P06BGN AC Miniature Circuit Breakers Rated Current 10A B Curve 1857 INR',
  normalized_search_text: 'a 9 n 2 p 06 bgn ac miniature circuit breakers rated current 10 a b curve 1857 inr',
  attributes_json: []
}
const schneiderSiblingCandidate = {
  ...schneiderExactCandidate,
  doc_price_item_id: 'fixture-schneider-a9n1p06bgn',
  normalized_price: 589,
  sku_text: 'A9N1P06BGN',
  product_text: 'A9N1P06BGN AC Miniature Circuit Breakers Rated Current 6A B Curve',
  description_text: 'A9N1P06BGN AC Miniature Circuit Breakers Rated Current 6A B Curve',
  searchable_text: 'A9N1P06BGN AC Miniature Circuit Breakers Rated Current 6A B Curve 589 INR',
  normalized_search_text: 'a 9 n 1 p 06 bgn ac miniature circuit breakers rated current 6 a b curve 589 inr'
}
const [schneiderCodeScored] = scoreCandidates({
  parsed: schneiderCodeParsed,
  candidates: [schneiderSiblingCandidate, schneiderExactCandidate]
})
assert.equal(schneiderCodeScored.candidate.sku_text, 'A9N2P06BGN', 'exact catalogue code should beat nearby sibling codes')
assert(
  schneiderCodeScored.score >= 0.85,
  `exact catalogue code should score confidently, got ${schneiderCodeScored.score}`
)

const [numericCodeScored] = scoreCandidates({
  parsed: parseUserItemQuery('66101 Standard ROMA 10AX 1Way Switch 1 Module'),
  candidates: [{
    ...candidate,
    doc_price_item_id: 'fixture-power-66101',
    normalized_price: 160,
    sku_text: '66101',
    product_text: '66101 Standard ROMA 10AX 1Way Switch 1 Module',
    description_text: '66101 Standard ROMA 10AX 1Way Switch 1 Module',
    searchable_text: '66101 Standard ROMA 10AX 1Way Switch 1 Module 160 INR',
    normalized_search_text: '66101 standard roma 10 ax 1 way switch 1 module 160 inr',
    attributes_json: [{ name: 'way', value: '1' }]
  }]
})
assert(
  numericCodeScored.score >= 0.85,
  `numeric catalogue code should lift exact row above auto-match threshold, got ${numericCodeScored.score}`
)

const [numericAlphaCodeScored] = scoreCandidates({
  parsed: parseUserItemQuery('66501S ROMA Silver series 100W Step Fan Regulator 1 Module'),
  candidates: [{
    ...candidate,
    doc_price_item_id: 'fixture-power-66501s',
    normalized_price: 838,
    sku_text: '66501S',
    product_text: '66501S ROMA Silver series 100W Step Fan Regulator 1 Module',
    description_text: '66501S ROMA Silver series 100W Step Fan Regulator 1 Module',
    searchable_text: '66501S ROMA Silver series 100W Step Fan Regulator 1 Module 838 INR',
    normalized_search_text: '66501 s roma silver series 100 w step fan regulator 1 module 838 inr',
    attributes_json: []
  }]
})
assert(
  numericAlphaCodeScored.score >= 0.85,
  `numeric-alpha catalogue code should lift exact row above auto-match threshold, got ${numericAlphaCodeScored.score}`
)

const [spacedPrecisionCodeScored] = scoreCandidates({
  parsed: spacedCodeParsed,
  candidates: [
    {
      ...candidate,
      doc_price_item_id: 'fixture-prcs19l',
      normalized_price: 26.25,
      sku_text: 'PRCS 19L',
      product_text: 'PRCS 19L 19 RATEMtr.',
      description_text: 'PRCS 19L 19 RATEMtr.',
      searchable_text: 'PRCS 19L 19 RATEMtr. 26.25 INR',
      normalized_search_text: 'prcs 19 l 19 ratemtr 26.25 inr',
      attributes_json: []
    },
    {
      ...candidate,
      doc_price_item_id: 'fixture-prcs19h',
      normalized_price: 40.5,
      sku_text: 'PRCS 19H',
      product_text: 'PRCS 19H 19 RATEMtr.',
      description_text: 'PRCS 19H 19 RATEMtr.',
      searchable_text: 'PRCS 19H 19 RATEMtr. 40.5 INR',
      normalized_search_text: 'prcs 19 h 19 ratemtr 40.5 inr',
      attributes_json: []
    }
  ]
})
assert.equal(spacedPrecisionCodeScored.candidate.sku_text, 'PRCS 19H', 'spaced exact code should beat sibling Precision codes')
assert(
  spacedPrecisionCodeScored.score >= 0.85,
  `spaced exact code should score confidently, got ${spacedPrecisionCodeScored.score}`
)

const ambiguousDuplicateRows = scoreCandidates({
  parsed: parseUserItemQuery('1.50 cable rate per 100 meter'),
  candidates: [
    {
      ...candidate,
      doc_price_item_id: 'fixture-duplicate-low',
      normalized_price: 12835,
      sku_text: '1.50',
      product_text: 'SIZESQ. MM. 1.50 RATE PER100 MTRS.',
      description_text: 'SIZESQ. MM. 1.50 RATE PER100 MTRS.',
      searchable_text: 'Cable SIZESQ. MM. 1.50 RATE PER100 MTRS. 12835 INR',
      normalized_search_text: 'cable sizesq mm 1.50 rate per100 mtrs 12835 inr',
      attributes_json: [{ name: 'length', value: '100', unit: 'meter' }]
    },
    {
      ...candidate,
      doc_price_item_id: 'fixture-duplicate-high',
      normalized_price: 122100,
      sku_text: '1.50',
      product_text: 'SIZESQ. MM. 1.50 RATE PER100 MTRS.',
      description_text: 'SIZESQ. MM. 1.50 RATE PER100 MTRS.',
      searchable_text: 'Cable SIZESQ. MM. 1.50 RATE PER100 MTRS. 122100 INR',
      normalized_search_text: 'cable sizesq mm 1.50 rate per100 mtrs 122100 inr',
      attributes_json: [{ name: 'length', value: '100', unit: 'meter' }]
    }
  ]
})
assert(
  ambiguousDuplicateRows.every(item => item.score < 0.85 && item.needs_review),
  'duplicate row identities with different prices should be capped for review'
)

const [weakGenericScored] = scoreCandidates({
  parsed: parseUserItemQuery('ITEM Cabel CO-AXIAL CABLES RATE PER COIL ITEM'),
  candidates: [{
    ...candidate,
    doc_price_item_id: 'fixture-generic-coaxial',
    normalized_price: 9415,
    sku_text: 'RG-11',
    product_text: 'CO-AXIAL CABLES RATE PER COIL',
    description_text: 'RG-11 CO-AXIAL CABLES RATE PER COIL',
    searchable_text: 'RG-11 CO-AXIAL CABLES RATE PER COIL 9415 INR',
    normalized_search_text: 'rg 11 co axial cables rate per coil 9415 inr',
    attributes_json: []
  }]
})
assert(
  weakGenericScored.score < 0.85 && weakGenericScored.needs_review,
  'generic table/category queries without item identity should not auto-match'
)

console.log(`eval:search passed ${cases.length + 39} deterministic cases`)
