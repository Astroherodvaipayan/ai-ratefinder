import test from 'node:test'
import assert from 'node:assert/strict'
import { createJiti } from 'jiti'

const jiti = createJiti(import.meta.url, { interopDefault: true })
const {
  catalogueCategoryFilterLabel,
  cataloguePresentation,
  groupCatalogueRows,
  quarantineReasonLabel
} = await jiti.import('../app/utils/cataloguePresentation.ts')

test('turns the noisy KEI wire record into a customer-readable identity', () => {
  const result = cataloguePresentation({
    category: 'conduit',
    canonical_name: 'conductor area sqmm no. size of wire in mm current amps bunched enclosed in conduit or trunking std. coil packing no. of coils homecab fr conflame frlsh banfire zhfr / hffr 1.00 SQ.MM 32/0.20 — CONFLAME (FRLSH) RATE PER COIL',
    brand: 'KEI',
    sku: 'MM 32',
    facets: { size_sqmm: 1, fire_rating: 'FRLSH' },
    basis_quantity: 1,
    basis_unit: 'coil',
    source_table_title: 'INDUSTRIAL MULTI STRAND CABLES | SINGLE CORE UNSHEATHED INDUSTRIAL MULTISTRAND CABLES WITH FLEXIBLE BRIGHT ANNEALED BARE COPPER CONDUCTOR | CONDUCTOR AREA SQ.MM | NO. & SIZE OF WIRE IN MM | CURRENT (AMPS) BUNCHED & ENCLOSED IN CONDUIT OR TRUNKING | HOMECAB (FR) | CONFLAME (FRLSH) | BANFIRE (ZHFR / HFFR)',
    source_row_label: '1.00 SQ.MM 32/0.20',
    source_column_label: 'CONFLAME (FRLSH) RATE PER COIL',
    source_row_index: 4,
    source_excerpt: 'row 4: [0] 1.00 | [1] 32/0.20 | [2] 11 | [3] | [4] 6 | [5] 10700 | [6] 35.67 | [7] 11160',
    vendor: { name: 'KEI' }
  })

  assert.equal(result.title, 'KEI Conflame FRLSH Industrial single-core wire · 1 sq mm')
  assert.equal(result.categoryLabel, 'Single-core wire')
  assert.equal(result.sku, null)
  assert.deepEqual(result.attributes, ['32 strands × 0.20 mm', '11 A', 'Copper conductor'])
  assert.equal(result.priceTypeLabel, 'Quoted price')
})

test('turns Anchor switch price columns into one readable product with two labeled prices', () => {
  const base = {
    document_id: 'anchor-document',
    category: 'mcb',
    canonical_name: 'switches isi 21055 10A Bell Push With Neon — Unit Sale Price Rs per number',
    brand: null,
    sku: '21055',
    facets: { current_a: 10, price_type: 'unit_sale_price' },
    basis_quantity: 1,
    basis_unit: 'piece',
    source_table_title: '16A,20A,25A Switch not suggested for geyser load. Instead MCB/Motor Starter must be used.',
    source_row_label: 'switches isi 21055 10A Bell Push With Neon',
    source_column_label: 'Unit Sale Price Rs per number',
    source_table_index: 54,
    source_row_index: 7,
    source_col_index: 3,
    source_excerpt: 'row 7: [0] 21055 | [1] 10A Bell Push With Neon | [2] 85361010 | [3] 206 | [4] 20 | [5] 4120',
    vendor: null
  }
  const unit = { ...base, id: 'unit' }
  const mrp = {
    ...base,
    id: 'mrp',
    canonical_name: 'switches isi 21055 10A Bell Push With Neon — Maximum Retail Price (Inclusive of all taxes) Rs.',
    facets: { current_a: 10, price_type: 'mrp' },
    basis_quantity: 20,
    source_column_label: 'Maximum Retail Price (Inclusive of all taxes) Rs.',
    source_col_index: 5
  }

  assert.deepEqual(cataloguePresentation(unit), {
    title: '10 A bell push with neon',
    categoryLabel: 'Switch',
    sku: '21055',
    attributes: [],
    priceTypeLabel: 'Unit price'
  })
  assert.equal(cataloguePresentation(mrp).priceTypeLabel, 'Pack MRP')

  const groups = groupCatalogueRows([mrp, unit])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].primary.id, 'unit')
  assert.deepEqual(groups[0].offers.map(offer => offer.id), ['unit', 'mrp'])
})

test('uses buyer-facing dropdown labels', () => {
  assert.equal(catalogueCategoryFilterLabel('mcb'), 'Miniature circuit breakers (MCB)')
  assert.equal(catalogueCategoryFilterLabel('single_core_wire'), 'Single-core wires')
  assert.equal(quarantineReasonLabel('missing_price_basis'), 'Price unit or pack size missing')
  assert.equal(quarantineReasonLabel('missing_required_facet:current_a'), 'Required specification missing: current a')
})

test('does not merge different matrix variants or mistake an advisory warning for product identity', () => {
  const shared = {
    document_id: 'matrix-document',
    category: 'mcb',
    brand: null,
    sku: null,
    facets: {},
    basis_quantity: 1,
    basis_unit: 'piece',
    source_table_title: 'Switch not suggested for geyser load. Instead MCB must be used.',
    source_row_label: '32A SP MCB C Curve',
    source_column_label: 'Unit MRP',
    source_excerpt: 'row 4: [0] 32A SP MCB C Curve | [1] 211 | [2] 635',
    source_table_index: 2,
    source_row_index: 4,
    vendor: null
  }
  const first = { ...shared, id: 'first', canonical_name: '32A SP MCB C Curve — 6 kA', source_col_index: 1 }
  const second = { ...shared, id: 'second', canonical_name: '32A SP MCB C Curve — 10 kA', source_col_index: 2 }

  assert.equal(cataloguePresentation(first).categoryLabel, 'MCB')
  assert.equal(groupCatalogueRows([first, second]).length, 2)
})
