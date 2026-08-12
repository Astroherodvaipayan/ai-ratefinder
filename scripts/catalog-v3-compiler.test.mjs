import test from 'node:test'
import assert from 'node:assert/strict'
import { createJiti } from 'jiti'

const jiti = createJiti(import.meta.url, { interopDefault: true })
const {
  analyzeSourceTableDeterministically,
  dedupeDocumentOffers,
  strictMoney
} = await jiti.import('../server/utils/catalog/compiler.ts')
const { extractSourceTables, findRepeatedSourceBlocks, findTruncatedSourceRows, splitEmbeddedSourceTables } = await jiti.import('../server/utils/catalog/sourceTables.ts')

function compile(grid, documentName = 'Vendor Price List.pdf', tableIndex = 0, title = null) {
  return analyzeSourceTableDeterministically({
    documentName,
    vendorName: 'Vendor',
    table: { page: 1, tableIndex, title: title ?? grid[0]?.join(' | ') ?? null, grid }
  })
}

test('recovers a product-by-size price matrix without explicit price columns', () => {
  const result = compile([
    ['Supreme Serene PP Low Noise Pipe'],
    ['40 mm', '50 mm', '75 mm'],
    ['Pipe 3 Mtr S/S', '614', '837', '1558'],
    ['Coupler', '72', '153', '291']
  ], 'SUPREME MRP LIST.pdf')

  assert.equal(result.audit.commercial, true)
  assert.equal(result.offers.length, 6)
  assert.deepEqual(result.offers.slice(0, 3).map(offer => offer.amount), [614, 837, 1558])
  assert.deepEqual(result.offers.slice(0, 3).map(offer => offer.source_column_label), ['40 mm', '50 mm', '75 mm'])
  assert.equal(result.audit.decisions.length, 6)
  assert.equal(result.audit.selected_price_cells, 6)
})

test('keeps leading pipe dimensions as identity and selects pressure-matrix prices', () => {
  const result = compile([
    ['AGRICULTURE PIPE FOR WATER SUPPLY'],
    ['PIPE 6 MTR', 'QUICKFIT PIPES', 'RINGFIT PIPES'],
    ['MM', 'INCH', '2.5 kg/cm2', '4 kg/cm2', '6 kg/cm2'],
    ['20', '1/2"', '', '175', '366'],
    ['25', '3/4"', '', '253', '271'],
    ['32', '1"', '', '387', '447'],
    ['63', '2"', '698', '1012', '1540']
  ], 'SUPREME MRP LIST.pdf')

  assert.deepEqual(result.offers.map(offer => offer.amount), [175, 366, 253, 271, 387, 447, 698, 1012, 1540])
  assert.equal(result.audit.decisions.filter(decision => decision.reason === 'identity_or_specification').length, 4)
  assert.ok(result.offers.every(offer => offer.source_row_label?.includes('MM')))
})

test('does not treat a technical specification table as a price list', () => {
  const result = compile([
    ['Technical dimensions'],
    ['Model', 'Width mm', 'Height mm'],
    ['A100', '120', '240'],
    ['A200', '160', '320']
  ], 'Product Catalogue.pdf')

  assert.equal(result.audit.commercial, false)
  assert.equal(result.offers.length, 0)
  assert.equal(result.audit.decisions.length, 4)
  assert.ok(result.audit.decisions.every(decision => decision.reason === 'non_commercial_table'))
})

test('preserves explicit MRP columns', () => {
  const result = compile([
    ['Item Description', 'MRP'],
    ['Inspection Chamber', '1880.00'],
    ['Manhole Cover', '22402.00']
  ], 'Vendor Catalogue.pdf')

  assert.deepEqual(result.offers.map(offer => offer.amount), [1880, 22402])
  assert.ok(result.audit.decisions.every(decision => decision.reason === 'selected_explicit_price'))
})

test('deduplicates repeated parsed rows while preserving different variants', () => {
  const first = compile([
    ['Description', '50 mm', '75 mm'],
    ['Coupler', '72', '153']
  ], 'Vendor Price List.pdf', 0).offers
  const repeated = compile([
    ['Description', '50 mm', '75 mm'],
    ['Coupler', '72', '153']
  ], 'Vendor Price List.pdf', 1).offers

  const reconciled = dedupeDocumentOffers([...first, ...repeated])
  assert.equal(reconciled.length, 2)
  assert.deepEqual(reconciled.map(offer => offer.amount), [72, 153])
})

test('recognizes textual cable variants as matrix price columns', () => {
  const result = compile([
    ['RR FR / FR-LSH / LSOH CABLES PER METER'],
    ['SIZE', 'FR', 'FR-LSH', 'LSOH'],
    ['10.00', '331.92', '343.49', '369.89'],
    ['16.00', '525.37', '543.70', '582.53']
  ], 'RR FLEXIBLE List FINAL.pdf')

  assert.equal(result.audit.matrix_likely, true)
  assert.deepEqual(result.offers.map(offer => offer.amount), [331.92, 343.49, 369.89, 525.37, 543.7, 582.53])
  assert.deepEqual(result.offers.slice(0, 3).map(offer => offer.source_column_label), ['FR', 'FR-LSH', 'LSOH'])
  assert.ok(result.offers.every(offer => offer.basis_unit === 'meter'))
})

test('preserves equal prices under separate multi-row textual variant headers', () => {
  const result = compile([
    ['SQ.MM', 'COND. CONST.', 'SINGLE CORE', '', '', ''],
    ['', '', 'FR', 'HRFR', 'FRLSH', 'HFFR (ZHFR)'],
    ['0.50', '16/0.20', '1970', '2050', '2050', '2090'],
    ['0.75', '24/0.20', '2650', '2750', '2750', '2860']
  ], 'KEI WIRE PRICE LIST.pdf', 0, 'Flexible cable - rate per 100 Mtrs')

  assert.equal(result.offers.length, 8)
  assert.deepEqual(result.offers.slice(0, 4).map(offer => offer.amount), [1970, 2050, 2050, 2090])
  assert.deepEqual(result.offers.slice(0, 4).map(offer => offer.facets.fire_rating), ['FR', 'HRFR', 'FRLSH', 'ZHFR'])
  assert.equal(dedupeDocumentOffers(result.offers).length, 8)
})

test('identifies KEI Conflame wire without leaking table headers into the product name', () => {
  const title = 'INDUSTRIAL MULTI STRAND CABLES | KEI PVC INSULATED INDUSTRIAL SINGLE CORE UNSHEATHED INDUSTRIAL MULTISTRAND CABLES WITH FR / FRLSH / HFFR (ZHFR) PROPERTIES, WITH FLEXIBLE BRIGHT ANNEALED BARE COPPER CONDUCTOR FOR VOLTAGE GRADE UPTO 1100 V | CONDUCTOR (AREA SQ.MM) | NO. & SIZE OF WIRE IN MM | CURRENT (AMPS) BUNCHED & ENCLOSED IN CONDUIT OR TRUNKING | Std. Coil Packing | No. of Coils | HOMECAB (FR) | CONFLAME (FRLSH) | BANFIRE (ZHFR / HFFR)'
  const result = compile([
    ['CONDUCTOR AREA SQ.MM', 'NO. & SIZE OF WIRE IN MM', 'CURRENT (AMPS) BUNCHED & ENCLOSED IN CONDUIT OR TRUNKING', 'Std. Coil Packing', 'No. of Coils', 'HOMECAB (FR) RATE PER COIL', 'HOMECAB RATE PER MTR', 'CONFLAME (FRLSH) RATE PER COIL', 'CONFLAME RATE PER MTR', 'BANFIRE (ZHFR / HFFR) RATE PER COIL', 'BANFIRE RATE PER MTR'],
    ['1.00 SQ.MM', '32/0.20', '11', '', '6', '10700', '35.67', '11160', '37.20', '11560', '38.53']
  ], 'KEI WIRE AND CABLE PRICE LIST DT.14.05.2026.pdf', 0, title)

  const offer = result.offers.find(candidate => candidate.amount === 11160)
  assert.ok(offer)
  assert.equal(offer.category, 'single_core_wire')
  assert.equal(offer.canonical_name, 'Conflame FRLSH single-core wire — 1 sq mm')
  assert.equal(offer.sku, null)
  assert.equal(offer.facets.conductor_stranding, '32/0.20 mm')
  assert.equal(offer.facets.current_a, 11)
  assert.equal(offer.basis_unit, 'coil')
})

test('keeps a generic size header aligned with transposed price values', () => {
  const result = compile([
    ['Size', '0.50mm', '0.75mm', '1.00mm', '1.50mm', '2.50mm'],
    ['Rate', '3139', '4478', '5643', '8139', '12966']
  ], 'RR Price List.pdf', 0, 'CCTV CAMERA CABLES')

  assert.deepEqual(result.offers.map(offer => offer.source_column_label), ['0.50mm', '0.75mm', '1.00mm', '1.50mm', '2.50mm'])
  assert.deepEqual(result.offers.map(offer => offer.amount), [3139, 4478, 5643, 8139, 12966])
})

test('rejects packing quantities beside explicit price columns', () => {
  const result = compile([
    ['SIZE', 'PRODUCT CODE', 'PRICE (₹)', 'BOX PKG', 'PRODUCT CODE', 'PRICE (₹)', 'BOX PKG'],
    ['6.0-12.0', 'DBW-01SS', '433.44', '224', 'DBF-01SS', '558.88', '200'],
    ['12.0-16.5', 'DBW-01S', '521.92', '168', 'DBF-01S', '601.44', '200']
  ], 'Vendor Price List.pdf')

  assert.deepEqual(result.offers.map(offer => offer.amount), [433.44, 558.88, 521.92, 601.44])
  assert.ok(result.audit.decisions.filter(decision => !decision.selected).every(decision => [224, 200, 168].includes(decision.amount)))
})

test('does not parse comma-separated dimension lists as money', () => {
  assert.equal(strictMoney('50,100,200,300,500,1000'), null)
  assert.equal(strictMoney('1,25,000'), null)
  assert.equal(strictMoney('125,000'), 125000)
})

test('does not quarantine legitimate repeated labels with different prices', () => {
  const first = compile([
    ['Description', 'MRP'],
    ['Coupler', '72']
  ], 'Vendor Price List.pdf', 0).offers
  const laterBand = compile([
    ['Description', 'MRP'],
    ['Coupler', '89']
  ], 'Vendor Price List.pdf', 0).offers.map(offer => ({ ...offer, source_row_index: 8 }))

  const reconciled = dedupeDocumentOffers([...first, ...laterBand])
  assert.deepEqual(reconciled.map(offer => offer.amount), [72, 89])
  assert.ok(reconciled.every(offer => !offer.validation_errors.includes('conflicting_price_for_identity')))
})

test('expands shared transposed prices to every product code and ignores pack rows', () => {
  const result = compile([
    ['COLOUR', 'MODULE', '1 Module', '2 Module'],
    ['Sea Blue', 'CODE', '668015BG', '668025BG'],
    ['Gold Black', 'CODE', '66801GBC', '66802GBC'],
    ['Unit Sale Price Rs per number', '', '319', '405'],
    ['Maximum Retail Price (Inclusive of all taxes) Rs.', '', '1595', '2025'],
    ['Standards Packing Quantity (Number)', '', '5', '5']
  ], 'Power Pricelist 2026.pdf', 0, 'COLOR PLATE WITH COLLAR')

  assert.equal(result.audit.selected_price_cells, 4)
  assert.equal(result.offers.length, 8)
  assert.deepEqual(result.offers.filter(offer => offer.facets.price_type === 'unit_sale_price').map(offer => offer.sku), [
    '668015BG', '66801GBC', '668025BG', '66802GBC'
  ])
  assert.ok(result.offers.filter(offer => offer.facets.price_type === 'unit_sale_price').every(offer => offer.basis_quantity === 1 && offer.basis_unit === 'piece'))
  assert.ok(result.offers.filter(offer => offer.facets.price_type === 'mrp').every(offer => offer.basis_quantity === 5 && offer.basis_unit === 'piece' && offer.package_type === 'box'))
  assert.ok(result.audit.decisions.filter(decision => decision.source_row_index === 5).every(decision => !decision.selected))
})

test('flags repeated multi-row parser blocks before release', () => {
  const block = [
    ['Description', '50 mm', '75 mm'],
    ['Pipe', '614', '837'],
    ['Coupler', '72', '153'],
    ['Elbow', '110', '240'],
    ['Tee', '160', '320']
  ]
  const diagnostics = findRepeatedSourceBlocks([{
    page: 10,
    tableIndex: 4,
    title: 'Pipe fittings',
    grid: [...block, ['Different row', '1', '2'], ...block]
  }])

  assert.equal(diagnostics.length, 1)
  assert.deepEqual(diagnostics[0], {
    source_page: 10,
    source_table_index: 4,
    first_row_index: 0,
    repeated_row_index: 6,
    row_count: 5
  })
})

test('flags parser output truncated part-way through a numeric matrix row', () => {
  const diagnostics = findTruncatedSourceRows([{
    page: 2,
    tableIndex: 3,
    title: 'Multicore cable prices',
    grid: [
      ['SQ.MM', 'COND. CONST.', '2CORE', '3CORE', '4CORE', '5CORE'],
      ['0.50', '16/0.20', '4640', '6500', '8420', '10560'],
      ['16.00', '126/']
    ]
  }])

  assert.deepEqual(diagnostics, [{
    source_page: 2,
    source_table_index: 3,
    source_row_index: 2,
    expected_columns: 6,
    actual_columns: 2
  }])
})

test('carries markdown rate and product context into dense table titles', () => {
  const tables = extractSourceTables(`
{2}------------------------------------------------

## INDUSTRIAL MULTI STRAND CABLES

(Rate in Rs. Per 100 Mtrs)

**KEI FLEXIBLE PVC INSULATED MULTICORE FR CABLES**

| SQ.MM | 2 CORE | 3 CORE |
|---|---:|---:|
| 1.50 | 11160 | 16120 |
`)

  assert.equal(tables.length, 1)
  assert.match(tables[0].title, /MULTICORE FR CABLES/)
  assert.match(tables[0].title, /Per 100 Mtrs/i)
})

test('does not quarantine a price merely because it equals a numeric facet', () => {
  const result = compile([
    ['Description', 'MRP'],
    ['20 Module Cover Plate', '20']
  ], 'Vendor Price List.pdf')

  assert.equal(result.offers.length, 1)
  assert.deepEqual(result.offers[0].validation_errors, [])
})

test('keeps repeated size and packing column groups aligned', () => {
  const result = compile([
    ['KEI TELEPHONE CABLES'],
    ['No. of Pairs', 'Size - mm', '90 Mtr.Packing', '100 Mtr.Packing', 'Size - mm', '90 Mtr.Packing', '100 Mtr.Packing'],
    ['1 Pair', '0.40', '1180', '1315', '0.50', '1750', '1945'],
    ['2 Pair', '0.40', '2200', '2440', '0.50', '3160', '3510']
  ], 'KEI Communication Price List.pdf')

  assert.deepEqual(result.offers.map(offer => offer.amount), [1180, 1315, 1750, 1945, 2200, 2440, 3160, 3510])
  assert.deepEqual(result.offers.slice(0, 4).map(offer => [offer.basis_quantity, offer.basis_unit]), [[90, 'meter'], [100, 'meter'], [90, 'meter'], [100, 'meter']])
  assert.ok(result.audit.decisions.filter(decision => [0.4, 0.5].includes(decision.amount)).every(decision => !decision.selected))
})

test('rejects interleaved matrix dimensions while preserving adjacent rates', () => {
  const result = compile([
    ['NO. OF CORES', '1.5 SQ. MM.', '2.5 SQ. MM.', 'CROSS SECTION IN SQ. MM.', '2 CORE', '3 CORE', '4 CORE'],
    ['2', '251.00', '353.00', '4', '487.00', '675.00', '878.00'],
    ['3', '319.00', '469.00', '6', '693.00', '978.00', '1271.00']
  ], 'Copper Armoured Cable Price List.pdf')

  assert.deepEqual(result.offers.map(offer => offer.amount), [251, 353, 487, 675, 878, 319, 469, 693, 978, 1271])
  assert.ok(result.audit.decisions.filter(decision => [2, 3, 4, 6].includes(decision.amount)).every(decision => !decision.selected))
  assert.ok(result.offers.every(offer => offer.basis_quantity === 1 && offer.basis_unit === 'meter'))
})

test('reads attached cable coil lengths and dotted packing abbreviations', () => {
  const coil = compile([
    ['CONDUCTOR AREA SQ. MM.', 'FR300 Mtrs. Coil', 'FRLSH200 Mtrs. Coil'],
    ['0.75', '8830', '9000']
  ], 'Industrial Cable Price List.pdf')
  assert.deepEqual(coil.offers.map(offer => [offer.basis_quantity, offer.basis_unit, offer.package_type]), [[300, 'meter', 'coil'], [200, 'meter', 'coil']])

  const modular = compile([
    ['Description', 'Cat No', 'MRP/Unit in ₹', 'Std. Pkg.(Nos.)'],
    ['25A Double Pole', 'AUC00202500', '1795', '1']
  ], 'Retail Product Pricelist.pdf')
  assert.deepEqual(modular.offers.map(offer => offer.amount), [1795])
})

test('distinguishes RJ modules and cover plates from data and power cables', () => {
  const result = compile([
    ['Description', 'Cat No', 'MRP in ₹'],
    ['RJ 45 Cat 6A 1M', 'CB95301TW45', '798'],
    ['8 Module CoverPlate Square', 'CB91208FB02', '2250']
  ], 'Retail Product Pricelist.pdf')

  assert.deepEqual(result.offers.map(offer => offer.category), ['socket', 'accessory'])
  assert.ok(result.offers.every(offer => offer.basis_quantity === 1 && offer.basis_unit === 'piece'))
})

test('preserves explicit price headers across sparse product sections', () => {
  const result = compile([
    ['Item', 'Description', 'Unit Sale Price Rs per number', 'Standard Packing Quantity (Number)', 'Maximum Retail Price (Inclusive of all taxes) Rs.', 'Units in Master Packing (Number)'],
    ['RIDER - MINI MODULAR SP MCB (WHITE)', '', '', '', 'HSN Code : 85362030', ''],
    ['47106', '6A SP eCI MINI MCB', '365', '12', '4380', '144'],
    ['47107', '10A SP eCI MINI MCB', '365', '12', '4380', '144']
  ], 'Power Pricelist.pdf')

  assert.deepEqual(result.offers.map(offer => offer.amount), [365, 4380, 365, 4380])
  assert.deepEqual(result.offers.map(offer => offer.sku), ['47106', '47106', '47107', '47107'])
  assert.ok(result.offers.every(offer => offer.category === 'mcb'))
  assert.ok(result.audit.decisions.filter(decision => [12, 144].includes(decision.amount)).every(decision => !decision.selected))
})

test('uses numeric catalogue-code rows as transposed product identities', () => {
  const result = compile([
    ['MODULE', '1 Module', '2 Module', '3 Module'],
    ['Code', '48301', '48302', '48303'],
    ['Unit Sale Price Rs per number', '121', '121', '147'],
    ['Maximum Retail Price (Inclusive of all taxes) Rs.', '2420', '2420', '2940'],
    ['Standard Packing Quantity (Number)', '20', '20', '20']
  ], 'Power Pricelist.pdf', 0, 'SUITABLE FOR WOODEN BOX')

  assert.deepEqual(result.offers.map(offer => offer.sku), ['48301', '48302', '48303', '48301', '48302', '48303'])
  assert.deepEqual(result.offers.map(offer => offer.amount), [121, 121, 147, 2420, 2420, 2940])
  assert.ok(result.audit.decisions.filter(decision => decision.source_row_index === 1 || decision.source_row_index === 4).every(decision => !decision.selected))
})

test('does not guess matrix prices when parsed column headers are absent', () => {
  const result = compile([
    ['CONCEALED GI SHEET METAL BOXES'],
    ['21780', '1 or 2 Module', '7.9 x 7.5 x 4.6', '85389000', '70.00', '10']
  ], 'Box Price List.pdf', 0, 'CONCEALED GI SHEET METAL BOXES')

  assert.equal(result.offers.length, 0)
  assert.ok(result.audit.decisions.every(decision => !decision.selected))
})

test('KEI solar matrix publishes only rate columns and preserves cable size identity', () => {
  const rows = [
    ['1.50', '1000', '30', '60.00', '63.90', '25', '59.40'],
    ['2.50', '1000', '41', '94.40', '98.10', '35', '92.00'],
    ['4', '1000', '55', '132.80', '137.10', '45', '130.00'],
    ['6', '1000', '70', '199.00', '203.40', '58', '195.10'],
    ['10', '1000', '98', '335.60', '342.20', '80', '329.40'],
    ['16', '1000', '132', '532.10', '542.90', '106', '522.30'],
    ['25', '1000', '176', '----', '896.00', '135', '865.00'],
    ['35', '1000', '218', '----', '1246.00', '173', '1206.00'],
    ['50', '1000', '276', '----', '1772.00', '226', '1719.00'],
    ['70', '1000', '347', '----', '2462.00', '336', '2396.00'],
    ['95', '1000', '416', '----', '3327.00', '406', '3245.00'],
    ['120', '1000', '488', '----', '4193.00', '476', '4095.00'],
    ['150', '500', '566', '----', '5237.00', '555', '5116.00'],
    ['185', '500', '644', '----', '6465.00', '649', '6310.00'],
    ['240', '500', '775', '----', '8371.00', '781', '8178.00']
  ]
  const result = compile([
    ['PV SOLAR CABLES - PV1-F / H1Z2Z2-K / 2XY', '', '', '', '', '', ''],
    ['RATE(Rs.) PER MTR', '', '', '', '', '', ''],
    [
      'SIZE (AREA SQ.MM)',
      'STANDARD PACKING MTRS.',
      'KEI 1500 V DC Flexible Tinned Copper PV Cable',
      'KEI 1500 V DC Flexible Tinned Copper PV Cable',
      'KEI 1500 V DC Flexible Tinned Copper PV Cable',
      'KEI 1500 V DC Plain Flexible Copper PV Cable',
      'KEI 1500 V DC Plain Flexible Copper PV Cable'
    ],
    [
      'SIZE (AREA SQ.MM)',
      'STANDARD PACKING MTRS.',
      'Current Carrying (Amps) Capacity @ 60 Deg.C.',
      'TUV 2 Pfg 1169/08.2007 PV1-F',
      'EN/BSEN 50618 H1Z2Z2-K',
      'Current Carrying (Amps) Capacity @ 40 Deg.C.',
      'XLPE/PVC 2XY'
    ],
    ...rows
  ], 'KEI WIRE AND CABLE PRICE LIST.pdf', 0, 'LP NO. KEI/SOLAR/LP/26-27/01 DT. 20.04.2026')

  assert.equal(result.audit.selected_price_cells, 36)
  assert.equal(result.offers.length, 36)
  assert.ok(result.audit.decisions.filter(decision => [1, 2, 5].includes(decision.source_col_index)).every(decision => !decision.selected))
  assert.ok(result.offers.every(offer => typeof offer.facets.size_sqmm === 'number'))
  assert.ok(result.offers.every(offer => !offer.facets.current_range))
  assert.ok(result.offers.every(offer => offer.basis_quantity === 1 && offer.basis_unit === 'meter'))
  assert.deepEqual(result.offers.filter(offer => offer.source_row_index === 4).map(offer => offer.amount), [60, 63.9, 59.4])
})

test('KEI single-core coil table rejects amperage and coil-count columns', () => {
  const result = compile([
    [
      'CONDUCTOR (AREA SQ.MM)', 'NO. & SIZE OF WIRE IN MM', 'CURRENT (AMPS)',
      'Std. Coil Packing', 'No. of Coils', 'HOMECAB (FR)', 'HOMECAB (FR)',
      'CONFLAME (FRLSH)', 'CONFLAME (FRLSH)', 'BANFIRE (ZHFR / HFFR)', 'BANFIRE (ZHFR / HFFR)'
    ],
    [
      'CONDUCTOR (AREA SQ.MM)', 'NO. & SIZE OF WIRE IN MM', 'CURRENT (AMPS)',
      'Std. Coil Packing', 'No. of Coils', 'RATE PER COIL', 'RATE PER MTR.',
      'RATE PER COIL', 'RATE PER MTR.', 'RATE PER COIL', 'RATE PER MTR.'
    ],
    ['0.50', '16/0.20', '4', '300Mtr.', '12', '5900', '19.67', '6140', '20.47', '', ''],
    ['0.75', '24/0.20', '7', '300Mtr.', '8', '7950', '26.50', '8250', '27.50', '8570', '28.57'],
    ['1.00', '32/0.20', '11', '300Mtr.', '6', '10270', '34.23', '10710', '35.70', '11110', '37.03'],
    ['1.50', '30/0.25', '14', '300Mtr.', '4', '15740', '52.47', '16270', '54.23', '16720', '55.73'],
    ['2.50', '50/0.25', '19', '300Mtr.', '3', '25560', '85.20', '26440', '88.13', '27050', '90.17'],
    ['4.00', '56/0.30', '26', '200Mtr.', '3', '25430', '127.15', '26310', '131.55', '26800', '134.00'],
    ['6.00', '84/0.30', '31', '200Mtr.', '2', '38840', '194.20', '40170', '200.85', '40780', '203.90']
  ], 'KEI WIRE AND CABLE PRICE LIST.pdf', 0, 'INDUSTRIAL MULTI STRAND CABLES')

  assert.equal(result.audit.selected_price_cells, 40)
  assert.equal(result.offers.length, 40)
  assert.ok(result.audit.decisions.filter(decision => [0, 2, 4].includes(decision.source_col_index)).every(decision => !decision.selected))
  assert.ok(result.offers.every(offer => typeof offer.facets.size_sqmm === 'number'))
  assert.ok(result.offers.every(offer => !offer.facets.current_range))
})

test('document and price-list reference numbers never become product current ranges', () => {
  const result = compile([
    ['SIZE (SQ.MM)', 'RATE PER MTR'],
    ['1.50', '60.00']
  ], 'KEI WIRE PRICE LIST 20.04.2026.pdf', 0, 'LP NO. KEI/SOLAR/LP/26-27/01')

  assert.equal(result.offers.length, 1)
  assert.equal(result.offers[0].facets.current_range, undefined)
  assert.equal(result.offers[0].facets.size_sqmm, 1.5)
})

test('recovers headerless price-and-pack rows only from a stable commercial schema', () => {
  const boxes = compile([
    ['CONCEALED GI SHEET METAL BOXES', '', '', '', '', ''],
    ['21780', '1 or 2 Module', '7.9 x 7.5 x 4.6', '85389000', '70.00', '10'],
    ['21452', '3 Module', '7.9 x 9.9 x 4.6', '85389000', '99.00', '10'],
    ['21791', '4 Module', '7.9 x 13.5 x 5.2', '85389000', '119.00', '10']
  ], 'BOX PRICE LIST.pdf', 0, 'CONCEALED GI SHEET METAL BOXES')

  assert.deepEqual(boxes.offers.map(offer => offer.amount), [70, 99, 119])
  assert.deepEqual(boxes.offers.map(offer => offer.sku), ['21780', '21452', '21791'])
  assert.ok(boxes.audit.decisions.filter(decision => [85389000, 10].includes(decision.amount)).every(decision => !decision.selected))

  const legrand = compile([
    ['IP 30 - IK 08', '', '', '', ''],
    ['5076 60', '4 way', '8+12', '6131', '1'],
    ['5076 61', '6 way', '8+18', '7605', '1'],
    ['5076 62', '8 way', '8+24', '8981', '1']
  ], 'Legrand Price List.pdf', 0, 'Distribution boards')

  assert.deepEqual(legrand.offers.map(offer => offer.amount), [6131, 7605, 8981])

  const legrandSockets = compile([
    ['', '', '', ''],
    ['6755 51', '6A - Socket - with Shutter - 3 Pin - ISI - 2 Module', '310', '20/200'],
    ['6755 55', '6/16A - Socket - with Shutter - 3 Pin - Combine - ISI - 2 Module', '476', '10/100']
  ], 'Legrand Price List April 2026.pdf', 0, 'Indian Standard Sockets')

  assert.equal(legrandSockets.audit.commercial, true)
  assert.ok(legrandSockets.audit.commercial_reasons.includes('stable_headerless_price_schema'))
  assert.deepEqual(legrandSockets.offers.map(offer => offer.amount), [310, 476])
  assert.deepEqual(legrandSockets.offers.map(offer => offer.sku), ['6755 51', '6755 55'])
  assert.ok(legrandSockets.offers.every(offer => offer.basis_quantity === 1 && offer.basis_unit === 'piece'))
  assert.equal(legrandSockets.offers[1].category, 'socket')
  assert.equal(legrandSockets.offers[1].facets.combined, true)
  assert.equal(legrandSockets.offers[1].facets.modules, 2)
  assert.equal(legrandSockets.offers[1].facets.pins, 3)

  const headerlessAccessories = compile([
    ['', '', '', ''],
    ['AC3406MW', 'USB Charger - Power Delivery - 30 Watts - Type C + C - 2 Module', '10610', '1/10'],
    ['AC3401MW', 'USB Charger - Power Delivery - 45 Watts - Type C - 2 Module', '13690', '1/10']
  ], 'Legrand Price List April 2026.pdf', 0, 'USB Chargers')

  assert.equal(headerlessAccessories.offers.length, 2)
  assert.ok(headerlessAccessories.offers.every(offer => offer.basis_quantity === 1 && offer.basis_unit === 'piece'))
  assert.ok(headerlessAccessories.offers.every(offer => offer.facets.price_basis_inferred === true))
  assert.ok(headerlessAccessories.offers.every(offer => offer.validation_errors.length === 0))
})

test('realigns an explicit price header when descriptions occupy an extra data column', () => {
  const result = compile([
    ['Cat no.', 'Description', 'Price(Rs.)'],
    ['C525A.01', 'Motor Starter 0.60 A - 1.00 A', '1/8 HP Pump', '1153.00'],
    ['C525B.01', 'Motor Starter 0.90 A - 1.50 A', '1/4 HP Pump', '1153.00']
  ], 'Norisys Price List.pdf')

  assert.deepEqual(result.offers.map(offer => offer.amount), [1153, 1153])
  assert.deepEqual(result.offers.map(offer => offer.sku), ['C525A.01', 'C525B.01'])
})

test('treats Type A and Type B size headers as price variants, not dimensions', () => {
  const result = compile([
    ['Item', 'TYPE A', 'TYPE A', 'TYPE B', 'TYPE B'],
    ['Item', '75 mm', '90 mm', '75 mm', '90 mm'],
    ['Pipe 10 ft (3mtr) S/S', '440', '644', '796', '952'],
    ['Pipe 10 ft (3mtr) D/S', '493', '664', '853', '1035']
  ], 'SUPREME MRP LIST.pdf')

  assert.equal(result.offers.length, 8)
  assert.deepEqual(result.offers.slice(0, 4).map(offer => offer.amount), [440, 644, 796, 952])
  assert.deepEqual(result.offers.slice(0, 4).map(offer => offer.source_column_label), [
    'TYPE A 75 mm', 'TYPE A 90 mm', 'TYPE B 75 mm', 'TYPE B 90 mm'
  ])
})

test('keeps lighting and dimensional specification tables non-commercial', () => {
  const lighting = compile([
    ['Model', 'Wattage', 'CCT', 'IP Rating', 'Beam Angle', 'CRI', 'Lumens'],
    ['HL-12 CORE', '12W', '3K/4K/6K', 'IP20', '120°', '80', '1320LM'],
    ['HL-18 CORE', '18W', '3K/4K/6K', 'IP20', '120°', '80', '1980LM']
  ], 'HILLS CATALOG.pdf')
  assert.equal(lighting.audit.commercial, false)
  assert.equal(lighting.offers.length, 0)

  const dimensions = compile([
    ['Nominal Size (mm)', 'Outside Diameter (mm)', 'Inside Diameter Min. (mm)'],
    ['20', '20', '17.4'],
    ['25', '25', '22.1']
  ], 'Precision Electrical Pricelist.pdf', 0, 'DIMENSIONS OF ROUND CONDUIT PVC PIPES')
  assert.equal(dimensions.audit.commercial, false)
  assert.equal(dimensions.offers.length, 0)
})

test('does not require prices when the explicit price column says On Request', () => {
  const result = compile([
    ['Description', 'No of Modules Per Row', 'Unit MRP'],
    ['4 Tier 40 Modules', '10', 'On Request'],
    ['4 Tier 56 Modules', '14', 'On Request']
  ], 'Schneider Price List.pdf')

  assert.equal(result.offers.length, 0)
  assert.ok(result.audit.decisions.every(decision => decision.reason === 'identity_or_specification'))
})

test('product descriptions containing dimensions do not veto an explicit MRP column', () => {
  const result = compile([
    ['Description', 'DimensionsW X H X D(mm)', 'Std Pack', 'Cat No', 'MRP in ₹'],
    ['GI Metal Box - 1/2 Module 1.2mm & 50mm Depth', '73 X 78 X 50', '10', 'CB91102WM1250', '175'],
    ['GI Metal Box - 3 Module 1.2mm & 50mm Depth', '99 X 78 X 50', '10', 'CB91103WM1250', '215']
  ], 'Retail Product Pricelist.pdf')

  assert.deepEqual(result.offers.map(offer => offer.amount), [175, 215])
  assert.ok(result.offers.every(offer => offer.category === 'modular_box'))
  assert.ok(result.audit.decisions.filter(decision => decision.amount === 10).every(decision => !decision.selected))
})

test('singleton product sections preserve the active commercial column schema', () => {
  const result = compile([
    ['Item', 'Description', 'No. of Ways', 'Unit Sale Price Rs per number', 'Standard Packing Quantity (Number)', 'Maximum Retail Price Rs.'],
    ['TPN VERTICAL DOUBLE DOOR DB', '', '', 'HSN Code : 85371000', '', ''],
    ['98317', '4 WAY VERTICAL', '4', '13324', '1', '13324'],
    ['98318', '6 WAY TPN VERTICAL', '6', '15068', '1', '15068']
  ], 'Power Pricelist.pdf')

  assert.deepEqual(result.offers.map(offer => offer.amount), [13324, 13324, 15068, 15068])
  assert.ok(result.offers.every(offer => offer.category === 'distribution_board'))
  assert.ok(result.audit.decisions.filter(decision => [1, 4, 6].includes(decision.amount)).every(decision => !decision.selected))
})

test('HTML tables inherit a page-local price basis only when their own basis is absent', () => {
  const tables = extractSourceTables(`
    <p class="page-number">02</p>
    <table><tr><th>RATE PER 100 METERS</th></tr><tr><td>SIZE</td><td>2 CORE</td></tr><tr><td>0.5</td><td>5040</td></tr></table>
    <figcaption>BUILDING MANAGEMENT SYSTEM CABLE</figcaption>
    <table><tr><th>Cores</th><th>0.5 sq.mm</th></tr><tr><td>2</td><td>8860</td></tr></table>
    <table><tr><th>3 Mtr Length</th><th>75 mm</th></tr><tr><td>Sch-40</td><td>4875</td></tr></table>
  `)

  assert.match(tables[1].title, /RATE PER 100 METERS/i)
  assert.match(tables[2].title, /3 Mtr Length/i)
  assert.doesNotMatch(tables[2].title, /RATE PER 100 METERS/i)
})

test('plumbing fittings and roof-water hardware receive defensible per-piece categories', () => {
  const fittings = compile([
    ['CPVC Fittings Sch 80', 'CPVC Fittings Sch 80', 'CPVC Fittings Sch 80'],
    ['Coupling', '879.00', '1252.00'],
    ['End Caps', '541.00', '805.00']
  ], 'ASTRAL PRICE LIST.pdf')
  assert.ok(fittings.offers.every(offer => offer.category === 'conduit'))
  assert.ok(fittings.offers.every(offer => offer.basis_quantity === 1 && offer.basis_unit === 'piece'))

  const hardware = compile([
    ['Dimensions DN', '140 mm', '180 mm'],
    ['SUPPORT BRACKET', '45', '83'],
    ['CLAMP', '25', '39']
  ], 'ASTRAL PRICE LIST.pdf', 0, 'RAINWAY HALF ROUND PIPING SYSTEM')
  assert.ok(hardware.offers.every(offer => offer.category === 'accessory'))
  assert.ok(hardware.offers.every(offer => offer.basis_quantity === 1 && offer.basis_unit === 'piece'))
})

test('an OCR-joined schedule number is never treated as a pipe length', () => {
  const result = compile([
    ['Description', '15 mm', '20 mm'],
    ['ASTM Pipe Sch 400 Mtr', '222', '300']
  ], 'ASTRAL PRICE LIST.pdf', 0, 'PVC PIPES & FITTINGS')

  assert.ok(result.offers.every(offer => offer.basis_quantity === 1 && offer.basis_unit === 'piece'))
  assert.ok(result.offers.every(offer => offer.basis_quantity !== 400))
})

test('side-by-side matrices use the nearest local product and aligned part number', () => {
  const result = compile([
    ['Dimensions DN', '40', '50', 'Dimensions DN', '40', '50'],
    ['SINGLE SOCKETED PIPE (L = 3 m)', '1404', '1844', 'BEND 45', '176', '353'],
    ['PART NO.', 'M241270304', 'M241270305', 'BEND 87.5', 'M242001104', 'M242001105'],
    ['DOUBLE SOCKETED PIPE (L = 3 m)', '1558', '1916', 'BEND 87.5', '349', '418'],
    ['PART NO.', 'M241280304', 'M241280305', 'END PLUG', 'M242001204', 'M242001205'],
    ['SINGLE SOCKETED PIPE (L = 1 ft)', '396', '188', 'END PLUG', '61', '277'],
    ['PART NO.', 'M241271104', 'M241271105', 'END PLUG', 'M242002904', 'M242002905']
  ], 'ASTRAL PRICE LIST.pdf')

  const endPlugs = result.offers.filter(offer => offer.source_row_index === 5 && offer.source_col_index >= 4)
  assert.deepEqual(endPlugs.map(offer => [offer.canonical_name, offer.amount, offer.sku]), [
    ['END PLUG — 40', 61, 'M242002904'],
    ['END PLUG — 50', 277, 'M242002905']
  ])
  assert.ok(result.offers.filter(offer => offer.source_row_index === 1 && offer.source_col_index >= 4)
    .every(offer => offer.canonical_name.startsWith('BEND 45')))
})

test('embedded numeric dimension bands are headers, not prices', () => {
  const result = compile([
    ['Dimensions DN', '75', '110', 'Dimensions DN', '110', 'Dimensions DN', '5" & 7"', 'Dimensions DN', '6"', '7"'],
    ['P TRAP BODY', '1341', '1654', 'S TRAP', '3304', 'KNOB WITH RUBBER RING', '32', 'PARTITION WITH RUBBER RING', '97', '103'],
    ['PART NO.', 'M242003507', 'M242003509', 'PART NO.', 'F242003709', 'PART NO.', 'M242005100', 'PART NO.', 'M242005000R', 'M242006100R'],
    ['Dimensions DN', '110/75', 'Dimensions DN', '110', 'Dimensions DN', 'GRAMS', '100', '250', '500', ''],
    ['PLAIN FLOOR TRAP', '840', 'CLEAN OUT', '517', 'LUBRICANT', '27', '59', '102', '', '']
  ], 'ASTRAL PRICE LIST.pdf')

  assert.ok(result.audit.decisions.filter(decision => decision.source_row_index === 3).every(decision => !decision.selected))
  assert.ok(!result.offers.some(offer => offer.source_row_index === 3))
})

test('accepts OCR markdown separators with narrow two-dash columns', () => {
  const tables = extractSourceTables(`
{9}------------------------------------------------

| Product | 40 mm | 50 mm | |
|---------|-------|-------|--|
| Pipe | 4833.00 | 7935.00 | |
  `)

  assert.equal(tables.length, 1)
  assert.deepEqual(tables[0].grid[1].slice(0, 3), ['Pipe', '4833.00', '7935.00'])
})

test('rejects package weights that merely repeat aligned SKU suffixes', () => {
  const result = compile([
    ['Dimensions DN', '100', '250', '500', 'Dimensions DN', '6 inch', '7 inch'],
    ['LUBRICANT', '100', '250', '500', 'PARTITION WITH KNOB', '99', '109'],
    ['PART NO.', 'STINS-100', 'STINS-250', 'STINS-500', 'PART NO.', 'M482005000R', 'M482006100R']
  ], 'ASTRAL PRICE LIST.pdf')

  assert.ok(result.audit.decisions.filter(decision => decision.source_col_index >= 1 && decision.source_col_index <= 3)
    .every(decision => !decision.selected))
})

test('prefers an explicit item code and labels unit versus pack MRP offers', () => {
  const result = compile([
    ['Item', 'Description', 'HSN', 'Unit Sale Price Rs per number', 'Standard Packing Quantity (Number)', 'Maximum Retail Price (Inclusive of all taxes) Rs.'],
    ['21011', '10AX1 Way Switch 100W SBL Load', '85361010', '73', '20', '1460']
  ], 'Anchor Classic.pdf', 0, '16A,20A,25A Switch not suggested for geyser load')

  assert.deepEqual(result.offers.map(offer => ({
    sku: offer.sku,
    category: offer.category,
    canonical_name: offer.canonical_name,
    amount: offer.amount,
    basis_quantity: offer.basis_quantity,
    price_type: offer.facets.price_type,
    current_a: offer.facets.current_a
  })), [
    { sku: '21011', category: 'switch', canonical_name: '10AX 1 Way Switch 100W SBL Load', amount: 73, basis_quantity: 1, price_type: 'unit_sale_price', current_a: 10 },
    { sku: '21011', category: 'switch', canonical_name: '10AX 1 Way Switch 100W SBL Load', amount: 1460, basis_quantity: 20, price_type: 'mrp', current_a: 10 }
  ])
})

test('splits an overlaid right-hand price matrix from its neighboring table', () => {
  const [parent, screened] = splitEmbeddedSourceTables([{
    page: 2,
    tableIndex: 0,
    title: 'Flexible cables',
    grid: [
      ['Size', 'Single core', '2 core', '3 core', '4 core', '5 core', '', '', ''],
      ['6.00', '20400', '44700', '65200', '86100', '121900', 'POLYCAB UNARMOURED SCREENED CABLES', '', ''],
      ['10.00', '34915', '76600', '112500', '148300', '210600', 'CORES', '16/.20 MM.', '80/.20 MM.'],
      ['16.00', '54900', '117500', '172100', '227600', '319100', '', '0.5 Sq. Mm.', '2.5 Sq. Mm.'],
      ['25.00', '89100', '197200', '288400', '382400', '507800', '2', '13800', '37800'],
      ['35.00', '122100', '274100', '402300', '533000', '706900', '3', '16300', '49500'],
      ['50.00', '174200', '388900', '573000', '757700', '1009100', '4', '19500', '63100']
    ]
  }])

  assert.equal(screened.title, 'POLYCAB UNARMOURED SCREENED CABLES')
  assert.deepEqual(screened.grid.at(-1), ['4', '19500', '63100'])
  assert.ok(parent.grid.slice(1).every(row => !row.includes('13800') && !row.includes('37800')))
})

test('keeps a normal catalogue header instead of treating it as a product section', () => {
  const result = compile([
    ['', 'Cat.Nos', 'Description', 'MRP*', '', ''],
    ['', '', '', '₹ / Unit', 'Pack', ''],
    ['Standard length 2 meters; Price per meter', '', '', '', '', ''],
    ['Trunking', '', '', '', '', ''],
    ['6380 38', '6380 38', 'DLP-S TRK+CVR 100X502M', '1435', '12 (1)', ''],
    ['6380 08', '6380 08', 'DLP-S Separation Partition', '336', '32 (1)', ''],
    ['Joints', '', '', '', '', ''],
    ['6380 36', '6380 36', 'DLP-S Body Joint 100X50', '160', '10', '']
  ], 'Legrand Price List.pdf')

  assert.deepEqual(result.offers.map(offer => offer.amount), [1435, 336, 160])
  assert.deepEqual(result.offers.map(offer => offer.sku), ['6380 38', '6380 08', '6380 36'])
  assert.deepEqual(result.offers.map(offer => [offer.basis_quantity, offer.basis_unit]), [
    [1, 'meter'], [1, 'meter'], [1, 'unit']
  ])
})

test('preserves an explicit trailing MRP column after an identity header', () => {
  const result = compile([
    ['DB Type', 'Description', 'No. of Modules Incomer + Outgoing', 'Cat. Nos.', 'M.R.P. (₹) Per Unit', ''],
    ['IP 43 - Metal Door', '', '', '', '', ''],
    ['SPN', '6 way', '2', '4', 'DESPN006DDTV', '5835'],
    ['', '8 way', '2', '6', 'DESPN008DDTV', '6275']
  ], 'EXORA ESP Price List.pdf')

  assert.deepEqual(result.offers.map(offer => offer.amount), [5835, 6275])
  assert.deepEqual(result.offers.map(offer => offer.sku), ['DESPN006DDTV', 'DESPN008DDTV'])
})

test('quotes list, net, and line-total amounts with their correct meter bases', () => {
  const result = compile([
    ['SR-NO', 'DESCRIPTION', 'Unit', 'Qty', 'LP', 'Make', 'Discount', 'Net', 'AMOUNT'],
    ['1', '4SqmmX2Core Copper Armoured Cable', 'MTR', '135', '487', 'Polycab', '70.5', '143.665', '19,394.78']
  ], 'Customer Quotation.pdf')

  assert.deepEqual(result.offers.map(offer => ({
    amount: offer.amount,
    basis_quantity: offer.basis_quantity,
    basis_unit: offer.basis_unit,
    price_type: offer.facets.price_type
  })), [
    { amount: 487, basis_quantity: 1, basis_unit: 'meter', price_type: 'list_price' },
    { amount: 143.665, basis_quantity: 1, basis_unit: 'meter', price_type: 'net_price' },
    { amount: 19394.78, basis_quantity: 135, basis_unit: 'meter', price_type: 'line_total' }
  ])
  assert.ok(!result.offers.some(offer => offer.amount === 70.5))
})

test('inherits a rate header through cable-size variants', () => {
  const result = compile([
    ['No. of Pair & Size', 'Rate Per 90 Meter Coil', '', 'Rate Per Meter'],
    ['', 'Unarmoured', 'Unarmoured', 'Armoured'],
    ['', '0.4 MM.', '0.5 MM.', '0.5 MM.'],
    ['1 Pair', '1010.00', '1390.00', '-----'],
    ['2 Pair', '1725.00', '2635.00', '-----']
  ], 'Telephone Cable Price List.pdf')

  assert.deepEqual(result.offers.map(offer => offer.amount), [1010, 1390, 1725, 2635])
  assert.ok(result.offers.every(offer => offer.category === 'telephone_cable'))
})

test('a sparse repeated dimensions band is never compiled as a price', () => {
  const result = compile([
    ['Dimensions DN', '', '', '110', '', '', 'Dimensions DN', '', '', '110x75'],
    ['', 'BEND 45 WITH 50MM VENT', '', '', '710.00', '', '', 'REDUCER BEND 45 WITH 50MM VENT', '', '781.00']
  ], 'ASTRAL PRICE List.pdf')

  assert.deepEqual(result.offers.map(offer => offer.amount), [710, 781])
  assert.ok(!result.offers.some(offer => offer.amount === 110))
})
