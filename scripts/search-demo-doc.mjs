#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import { createJiti } from 'jiti'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

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

const cases = [
  ['copper compact', '6SqmmX2Core Cu Armoured Cable', 693],
  ['copper spaced', '10 sq mm x 4 core copper armoured cable', 2066],
  ['copper reordered', 'Copper armoured cable 4 core 6 sqmm', 1271],
  ['aluminium abbreviation', '10SqmmX2Core Al Armoured Cable', 344],
  ['aluminium spaced', '25 sqmm 4 core aluminium armoured cable', 690],
  ['aluminium 3.5 core', '35 sqmm 3.5 core aluminium armoured cable', 829],
  ['fr compact', '1.5Sqmm FR Wire 300Mtr', 16735],
  ['fr reordered', '300 mtr 2.5 sqmm fr wire', 27780],
  ['frls variant', '4Sqmm FRLs Wire 200Mtr', 28985],
  ['frlsh exact', '6 sqmm frlsh wire 200 meter', 43455],
  ['hffr', '1 sqmm hffr wire 300mtr', 12495],
  ['speaker', '1.5 sqmm oxygen free speaker wire 90 meter', 8300],
  ['telephone unarmoured', '2 pair telephone cable unarmoured 0.5mm 90 meter coil', 2635],
  ['telephone jellyfilled', '5 pair jellyfilled telephone cable unarmoured 0.5 mm', 156],
  ['screened', '10 sqmm 4 core unarmored screened cable', 148300]
]

const started = performance.now()
const failures = []

for (const [label, query, expectedPrice] of cases) {
  const result = await searchItems({
    client: supabase,
    tenantId: document.owner_id,
    documentId,
    message: query,
    limitPerItem: 100
  })
  const item = result.priced_items[0]
  const passed = Boolean(item && !item.needs_review && item.price === expectedPrice)
  const score = item?.confidence ?? result.unresolved_items[0]?.closest_candidates[0]?.confidence ?? null
  const got = item?.price ?? null

  console.log(`${passed ? 'PASS' : 'FAIL'} | ${label} | expected=${expectedPrice} got=${got} score=${score} | ${query}`)
  if (!passed) failures.push({ label, query, expectedPrice, got, score, result })
}

const elapsedMs = Math.round(performance.now() - started)

if (failures.length) {
  console.error(`eval:demo-doc failed ${failures.length}/${cases.length} cases for ${document.filename} in ${elapsedMs}ms`)
  process.exit(1)
}

console.log(`eval:demo-doc passed ${cases.length}/${cases.length} cases for ${document.filename} in ${elapsedMs}ms`)
