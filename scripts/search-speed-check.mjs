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

const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NUXT_SUPABASE_SERVICE_ROLE_KEY
assert(supabaseUrl, 'SUPABASE_URL is required')
assert(serviceRoleKey, 'SUPABASE_SERVICE_ROLE_KEY is required')

const jiti = createJiti(import.meta.url, { interopDefault: true })
const { searchItems } = await jiti.import('../server/utils/search/searchItems.ts')
const supabase = createClient(supabaseUrl, serviceRoleKey)
const documentId = process.env.SEARCH_EVAL_DOCUMENT_ID ?? 'd0813a72-1cec-46c4-9350-e2b69397e9df'
const maxAvgMs = Number(process.env.SEARCH_SPEED_MAX_AVG_MS ?? 900)
const maxP95Ms = Number(process.env.SEARCH_SPEED_MAX_P95_MS ?? 1600)

const { data: document, error: documentError } = await supabase
  .from('documents')
  .select('id, owner_id, filename')
  .eq('id', documentId)
  .single()
if (documentError) throw documentError

const queries = [
  '6SqmmX2Core Cu Armoured Cable',
  '6 sq mm x 4 core copper armoured cable',
  '10SqmmX4Core Al Armoured Cable',
  '1Sqmm FR Wire 300Mtr',
  '4Sqmm FRLs Wire 200Mtr',
  '2 pair telephone cable unarmoured 0.5mm 90 meter coil',
  '5 pair jellyfilled telephone cable unarmoured 0.5 mm',
  [
    '6SqmmX2Core Cu Armoured Cable',
    '10SqmmX4Core Cu Armoured Cable',
    '1.5Sqmm FR Wire 300Mtr',
    '4Sqmm FRLs Wire 200Mtr'
  ].join('\n')
]

const timings = []
for (const query of queries) {
  const started = performance.now()
  const result = await searchItems({
    client: supabase,
    tenantId: document.owner_id,
    documentId,
    message: query,
    limitPerItem: 80
  })
  const elapsed = performance.now() - started
  timings.push(elapsed)
  const priced = result.priced_items.length
  const unresolved = result.unresolved_items.length
  console.log(`${Math.round(elapsed)}ms | priced=${priced} unresolved=${unresolved} | ${query.split(/\n/)[0]}${query.includes('\n') ? ' ...' : ''}`)
}

const sorted = [...timings].sort((a, b) => a - b)
const avg = timings.reduce((sum, value) => sum + value, 0) / timings.length
const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0

console.log(`search:speed avg=${Math.round(avg)}ms p95=${Math.round(p95)}ms cases=${queries.length} document="${document.filename}"`)

if (avg > maxAvgMs || p95 > maxP95Ms) {
  console.error(`search:speed failed thresholds avg<=${maxAvgMs}ms p95<=${maxP95Ms}ms`)
  process.exit(1)
}
