import test from 'node:test'
import assert from 'node:assert/strict'
import { createJiti } from 'jiti'

globalThis.createError = ({ statusCode, statusMessage }) => Object.assign(new Error(statusMessage), { statusCode, statusMessage })

const jiti = createJiti(import.meta.url, { interopDefault: true })
const { normalizeCatalogSku, parseCatalogQuery } = await jiti.import('../server/utils/catalog/query.ts')
const { repairCatalogOfferIdentity, resolveCatalogOffers } = await jiti.import('../server/utils/catalog/searchV2.ts')
const { catalogChatResponse } = await jiti.import('../server/utils/catalog/chatResponse.ts')

function offer(overrides = {}) {
  return {
    id: 'offer-1',
    document_id: 'document-1',
    vendor_id: null,
    category: 'other',
    canonical_name: 'Product',
    brand: 'Vendor',
    sku: null,
    aliases: [],
    facets: {},
    amount: 100,
    currency: 'INR',
    basis_quantity: 1,
    basis_unit: 'piece',
    package_type: null,
    moq: null,
    source_page: 1,
    source_table_index: 0,
    source_row_index: 1,
    source_col_index: 2,
    source_table_title: 'Price list',
    source_row_label: 'Product',
    source_column_label: 'Rate',
    raw_price_value: '100',
    source_excerpt: 'Product | 100',
    documents: { filename: 'Vendor Price List.pdf' },
    ...overrides
  }
}

test('normalizes formatted, spaced, and numeric SKUs into one searchable identity', () => {
  assert.equal(normalizeCatalogSku('BA-40630-C'), 'ba40630c')
  assert.equal(normalizeCatalogSku('PRCB 204'), 'prcb204')
  assert.deepEqual(parseCatalogQuery('BA40630C').sku_candidates, ['ba40630c'])
  assert.deepEqual(parseCatalogQuery('PRCB 204').sku_candidates, ['prcb204'])
  assert.deepEqual(parseCatalogQuery('47106').sku_candidates, ['47106'])
  assert.deepEqual(parseCatalogQuery('SKU: AC21104MW').sku_candidates, ['ac21104mw'])
})

test('never routes product vocabulary through SKU search', () => {
  for (const query of [
    '3Pair Telephone Wire (90Mtr) 0.5mm',
    'CAT-6 305 m',
    '12 Model Metal Box',
    '20mm HMS Pipe'
  ]) {
    assert.deepEqual(parseCatalogQuery(query).sku_candidates, [], query)
  }
})

test('normalizes box, bare wire, pipe, and networking product categories', () => {
  assert.equal(parseCatalogQuery('12 Model Metal Box').category, 'modular_box')
  assert.equal(parseCatalogQuery('3Model Surface Box').category, 'modular_box')
  assert.equal(parseCatalogQuery('1.5 Sqmm 1Core 100 mtr').category, 'single_core_wire')
  assert.equal(parseCatalogQuery('20mm HMS Pipe').category, 'conduit')
  assert.equal(parseCatalogQuery('1/2 Inch Copper Coated Networking cable').category, 'data_cable')
  assert.deepEqual(
    [parseCatalogQuery('CAT-6 305 m').requested_basis_quantity, parseCatalogQuery('CAT-6 305 m').requested_basis_unit],
    [305, 'meter']
  )
})

test('an exact SKU identifies a product without requiring a category', () => {
  const parsed = parseCatalogQuery('BA40630C')
  const result = resolveCatalogOffers(parsed, [offer({
    category: 'mcb',
    canonical_name: '63A C Curve Four Pole MCB BA40630C',
    sku: 'BA40630C',
    facets: { current_a: 63, poles: 4, curve: 'C' },
    amount: 2450
  })], { identityMatched: true, matchMethod: 'sku' })

  assert.equal(result.state, 'exact')
  assert.equal(result.match_method, 'sku')
  assert.equal(result.offers[0].sku, 'BA40630C')
})

test('repairs source-backed cable facets from the final row and column identity', () => {
  const repaired = repairCatalogOfferIdentity(offer({
    category: 'power_cable',
    canonical_name: 'Copper armoured cables 1.5 SQ.MM 2 CORE 3 CORE 4 CORE 4 SQ.MM — 4 CORE',
    source_row_label: '4 SQ.MM — 4 CORE',
    facets: { conductor_material: 'copper', armour: 'armoured', size_sqmm: 1.5, cores: 2 },
    amount: 878,
    basis_unit: 'meter'
  }))

  assert.equal(repaired.facets.size_sqmm, 4)
  assert.equal(repaired.facets.cores, 4)
})

test('source-column variants override noisy row headers without corrupting stored facets', () => {
  const repaired = repairCatalogOfferIdentity(offer({
    category: 'single_core_wire',
    canonical_name: 'FR 300 FRLSH 300 HFFR 300 1.5 SQ.MM — HFFR 300 Mtrs. Coil',
    source_row_label: 'FR 300 FRLSH 300 HFFR 300 1.5 SQ.MM',
    source_column_label: 'HFFR 300 Mtrs. Coil',
    sku: 'HFFR 300',
    facets: { cores: 1, size_sqmm: 1.5, fire_rating: 'HFFR' },
    basis_quantity: 300,
    basis_unit: 'meter',
    package_type: 'coil'
  }))

  assert.equal(repaired.facets.fire_rating, 'HFFR')
})

test('UTP catalogue rows are searchable as unarmoured and reject crossed coaxial SKUs', () => {
  const repaired = repairCatalogOfferIdentity(offer({
    category: 'data_cable',
    canonical_name: 'UTP CAT-6 — LAN CABLES 305 MTRS.',
    source_row_label: 'UTP CAT-6',
    source_column_label: 'LAN CABLES 305 MTRS.',
    sku: 'RG-11F',
    facets: { standard: 'CAT-6' },
    basis_quantity: 305,
    basis_unit: 'meter'
  }))

  assert.equal(repaired.facets.armour, 'unarmoured')
  assert.equal(repaired.sku, null)
})

test('recovers 3 x 300 high-voltage cable identity and uses the final voltage column', () => {
  const parsed = parseCatalogQuery('HT XLPE armoured aluminium 6.6 KV 11 KV 22 KV 33 KV 3 x 300 — 22 KV')
  assert.equal(parsed.category, 'power_cable')
  assert.equal(parsed.facets.cores, 3)
  assert.equal(parsed.facets.size_sqmm, 300)
  assert.equal(parsed.facets.voltage_grade, '22KV')
  assert.equal(parseCatalogQuery('300 sqmm 3 core aluminium armoured 3.8/6.6kV').facets.voltage_grade, '6.6KV')
})

test('treats an MCB box as a distribution board instead of an MCB or busbar', () => {
  assert.equal(parseCatalogQuery('4Way MCB Box').category, 'distribution_board')
})

test('never labels a conflicting technical facet as exact and offers an explicit alternative', () => {
  const parsed = parseCatalogQuery('5A socket')
  const result = resolveCatalogOffers(parsed, [offer({
    category: 'socket',
    canonical_name: '6A 3 Pin Socket',
    facets: { current_a: 6, pins: 3 },
    sku: 'SOCKET6A'
  })])

  assert.equal(result.state, 'absent')
  assert.equal(result.offers.length, 0)
  assert.equal(result.alternatives.length, 1)
  assert.deepEqual(result.alternatives[0].differing_facets, ['current_a'])
  assert.match(result.suggestions[0].label, /differs in current a/i)
})

test('returns refinements when exact catalogue rows differ by a missing commercial facet', () => {
  const parsed = parseCatalogQuery('63A 4 pole MCB')
  const result = resolveCatalogOffers(parsed, [
    offer({ id: 'c', category: 'mcb', canonical_name: '63A 4 Pole C Curve MCB', facets: { current_a: 63, poles: 4, curve: 'C' }, sku: 'MCB-C' }),
    offer({ id: 'd', category: 'mcb', canonical_name: '63A 4 Pole D Curve MCB', facets: { current_a: 63, poles: 4, curve: 'D' }, sku: 'MCB-D' })
  ])

  assert.equal(result.state, 'ambiguous')
  assert.ok(result.missing_facets.includes('curve'))
  assert.deepEqual(result.refinements.find(item => item.facet === 'curve')?.options.map(option => option.label), ['C curve', 'D curve'])
})

test('treats an unavailable requested pack as a choice instead of a missing product', () => {
  const parsed = parseCatalogQuery('1.5 Sqmm 1Core 100 mtr FRLSH')
  const result = resolveCatalogOffers(parsed, [offer({
    category: 'single_core_wire',
    canonical_name: '1.5 SQ.MM FRLSH 300 Mtrs. Coil',
    source_row_label: '1.5 SQ.MM',
    source_column_label: 'FRLSH 300 Mtrs. Coil',
    facets: { cores: 1, size_sqmm: 1.5, fire_rating: 'FRLSH' },
    basis_quantity: 300,
    basis_unit: 'meter',
    package_type: 'coil'
  })])

  assert.equal(result.state, 'ambiguous')
  assert.ok(result.missing_facets.includes('price_basis'))
  assert.equal(result.total_matches, 1)
  assert.match(result.explanation, /requested price basis is not published/i)
})

test('caps broad result cards while retaining the full match count', () => {
  const parsed = parseCatalogQuery('10 Amp Switch')
  const offers = Array.from({ length: 20 }, (_, index) => offer({
    id: `switch-${index}`,
    category: 'switch',
    canonical_name: `10A Switch ${index}`,
    sku: `SW-${index}`,
    facets: { current_a: 10, modules: index % 2 + 1 },
    amount: 100 + index
  }))
  const result = resolveCatalogOffers(parsed, offers)

  assert.equal(result.total_matches, 20)
  assert.equal(result.offers.length, 12)
  assert.equal(result.state, 'ambiguous')
})

test('chat cards keep the source pack basis and expose search guidance', () => {
  const parsed = parseCatalogQuery('2Model Box')
  const result = resolveCatalogOffers(parsed, [offer({
    category: 'modular_box',
    canonical_name: 'Metal Flush Box 2 Module',
    facets: { modules: 2, variant: 'metal flush' },
    amount: 170,
    basis_quantity: 1,
    basis_unit: 'piece'
  })])
  const response = catalogChatResponse([result])
  const notice = response.items.find(item => item.kind === 'search_notice')
  const card = response.items.find(item => item.kind === 'offer')

  assert.equal(notice.corrected_query, '2 Module Box')
  assert.equal(card.price_basis.source_basis_label, 'piece')
  assert.equal(card.price_basis.effective_unit_price, 170)
})
