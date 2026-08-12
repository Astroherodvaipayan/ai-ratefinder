import test from 'node:test'
import assert from 'node:assert/strict'
import { createJiti } from 'jiti'

const jiti = createJiti(import.meta.url, { interopDefault: true })
const { cataloguePresentation } = await jiti.import('../app/utils/cataloguePresentation.ts')

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
})
