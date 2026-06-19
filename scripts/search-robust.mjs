#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import { createJiti } from 'jiti'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
  }
}

globalThis.createError = ({ statusCode, statusMessage }) =>
  Object.assign(new Error(statusMessage), { statusCode, statusMessage })

const documentId = process.env.SEARCH_EVAL_DOCUMENT_ID ?? 'd0813a72-1cec-46c4-9350-e2b69397e9df'
const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NUXT_SUPABASE_SERVICE_ROLE_KEY

assert(supabaseUrl, 'SUPABASE_URL is required')
assert(serviceRoleKey, 'SUPABASE_SERVICE_ROLE_KEY is required')

const jiti = createJiti(import.meta.url, { interopDefault: true })
const { searchItems } = await jiti.import('../server/utils/search/searchItems.ts')
const supabase = createClient(supabaseUrl, serviceRoleKey)

const { data: document, error: documentError } = await supabase
  .from('documents')
  .select('id, owner_id, filename')
  .eq('id', documentId)
  .single()

if (documentError) throw documentError

const positiveCases = [
  ['symbol punctuation', '6 sq.mm × 2C CU armoured cable please', 693],
  ['quantity prefix', 'qty 12 - 10 sqmm 4 core al armoured', 537],
  ['single-letter meter', 'oxygen free speaker wire 1.5 sq.mm rate per 90m', 8300],
  ['hyphenated unarmoured', '2 pair telephone un-armoured cable 0.5mm', 2635],
  ['noisy frls', 'need rate: 4SQMM FRLS wire 200 mtrs', 28985]
]

const negativeCases = [
  ['missing material/product family', '6SqmmX2Core'],
  ['numeric-only speaker-ish query', '1.5 sqmm 90 meter'],
  ['conflicting materials', '6 sqmm 2 core aluminium copper armoured cable'],
  ['nonsense product', 'give price for unicorn cable 999 sqmm']
]

let passed = 0
let failed = 0

for (const [label, query, expectedPrice] of positiveCases) {
  const result = await searchItems({
    client: supabase,
    tenantId: document.owner_id,
    documentId,
    message: query,
    limitPerItem: 100
  })
  const item = result.priced_items[0]
  const ok = Boolean(item && !item.needs_review && item.price === expectedPrice)
  console.log(`${ok ? 'PASS' : 'FAIL'} | positive | ${label} | expected=${expectedPrice} got=${item?.price ?? null} score=${item?.confidence ?? null}`)
  if (ok) passed += 1
  else failed += 1
}

for (const [label, query] of negativeCases) {
  const result = await searchItems({
    client: supabase,
    tenantId: document.owner_id,
    documentId,
    message: query,
    limitPerItem: 100
  })
  const autoPriced = result.priced_items.some(item => !item.needs_review && item.confidence >= 0.85)
  const top = result.priced_items[0] ?? result.unresolved_items[0]?.closest_candidates[0]
  console.log(`${!autoPriced ? 'PASS' : 'FAIL'} | negative | ${label} | top=${top?.price ?? null} score=${top?.confidence ?? null}`)
  if (!autoPriced) passed += 1
  else failed += 1
}

if (failed) {
  console.error(`eval:robust failed ${failed}/${positiveCases.length + negativeCases.length} cases for ${document.filename}`)
  process.exit(1)
}

console.log(`eval:robust passed ${passed}/${positiveCases.length + negativeCases.length} cases for ${document.filename}`)
