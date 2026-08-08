#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { createJiti } from 'jiti'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
  }
}

globalThis.createError = ({ statusCode, statusMessage }) =>
  Object.assign(new Error(statusMessage), { statusCode, statusMessage })

const archivePath = process.argv[2] ?? '/Users/krishnadvaipayan/Downloads/ai-ratefinder-chats-2026-08-06.json'
const outputPath = process.argv[3] ?? 'reports/search-v3-71-live-test.json'
const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NUXT_SUPABASE_SERVICE_ROLE_KEY
assert(supabaseUrl, 'SUPABASE_URL is required')
assert(serviceRoleKey, 'SUPABASE_SERVICE_ROLE_KEY is required')

const jiti = createJiti(import.meta.url, { interopDefault: true })
const { splitCatalogQueries } = await jiti.import('../server/utils/catalog/query.ts')
const { searchCatalogV2 } = await jiti.import('../server/utils/catalog/searchV2.ts')
const client = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
const archive = JSON.parse(readFileSync(archivePath, 'utf8'))
const messages = archive.chats.flatMap(chat => (chat.messages ?? [])
  .filter(message => message.role === 'user')
  .map(message => ({ chat: chat.title, query: message.content })))
assert.equal(messages.length, 71, 'The archived acceptance set must contain all 71 user messages')

const results = []
for (const [index, message] of messages.entries()) {
  const searches = []
  for (const query of splitCatalogQueries(message.query)) {
    searches.push(await searchCatalogV2({ client, message: query, limit: 100 }))
  }
  assert(searches.length > 0, `Message ${index + 1} produced no search request`)
  for (const search of searches) {
    assert.notEqual(search.match_method, 'sku', `Product-language query was routed as an SKU: ${message.query}`)
    assert(search.offers.length <= 12, `More than 12 cards returned for: ${message.query}`)
    for (const offer of search.offers) {
      assert(Number.isFinite(Number(offer.amount)) && Number(offer.amount) > 0, `Invalid amount for: ${message.query}`)
      assert(Number.isInteger(offer.source_row_index), `Missing source row for: ${message.query}`)
      assert(Number.isInteger(offer.source_col_index), `Missing source column for: ${message.query}`)
      assert(offer.source_excerpt?.trim(), `Missing source excerpt for: ${message.query}`)
      assert(offer.basis_quantity && offer.basis_unit, `Missing price basis for: ${message.query}`)
    }
  }
  results.push({
    number: index + 1,
    ...message,
    searches: searches.map(search => ({
      state: search.state,
      match_method: search.match_method,
      total_matches: search.total_matches,
      missing_facets: search.missing_facets,
      offers: search.offers.map(offer => ({
        sku: offer.sku,
        amount: offer.amount,
        basis_quantity: offer.basis_quantity,
        basis_unit: offer.basis_unit,
        fire_rating: offer.facets.fire_rating
      }))
    }))
  })
}

const byQuery = new Map(results.map(result => [result.query, result.searches[0]]))
expectPrice('300Sqmm*3Core Alu Cable 22kV Graded', 8390)
expectPrice('300Sqmm*3Core Alu Cable 3.8/6.6kV Graded', 7220)
expectPrice('3Pair Telephone Wire (90Mtr) 0.5mm', 3870)
expectPrice('63Amp 4P MCB', 2450, 'BA40630C')
expectPrice('20mm 4Way Junction Box', 28.75, 'PRCB 204')
expectPrice('16Sqmm*4Core Aluminium Armoured Cable 1.1kV Graded', 582)
expectPrice('300Sqmm*4Core Alu Arm Cable  1.1kV Graded', 6624)
expectPrice('4Sqmm*4Core Copper Arm Cable', 878)
expectPrice('Cat 6 305Mtr', 21384)
expectPrice('CAT-6 305 m', 21384)
for (const query of ['1.5Sqmm x 1Core Wire FRLsH', '2.5Sqmm X1Core Wire FRLsh', '1sqmm x 1Core wire Frlsh']) {
  const search = required(query)
  assert(search.offers.length > 0, `Expected an FRLSH offer for: ${query}`)
  assert(search.offers.every(offer => offer.fire_rating === 'FRLSH'), `Non-FRLSH variant leaked into: ${query}`)
}
for (const query of ['3Model Surface Box', '6 Model Surface Box', '12 Model Metal Box', '4 Model Metal Box']) {
  assert.notEqual(required(query).state, 'absent', `Existing modular box was not found: ${query}`)
}
assert.notEqual(required('CAT-6 Unarmoured').state, 'absent', 'CAT-6 punctuation changed product retrieval')

const flat = results.flatMap(result => result.searches)
const summary = {
  occurrences: results.length,
  unique_queries: new Set(results.map(result => result.query)).size,
  exact: flat.filter(result => result.state === 'exact').length,
  ambiguous: flat.filter(result => result.state === 'ambiguous').length,
  absent: flat.filter(result => result.state === 'absent').length,
  sku_routing_failures: flat.filter(result => result.match_method === 'sku').length,
  max_cards: Math.max(...flat.map(result => result.offers.length))
}
writeFileSync(outputPath, JSON.stringify({ generated_at: new Date().toISOString(), archive: archivePath, summary, results }, null, 2))
console.log(JSON.stringify({ status: 'PASS', output: outputPath, summary }))

function required(query) {
  const result = byQuery.get(query)
  assert(result, `Missing archived query: ${query}`)
  return result
}

function expectPrice(query, amount, sku = null) {
  const result = required(query)
  assert.notEqual(result.state, 'absent', `Expected a catalogue result for: ${query}`)
  assert(result.offers.some(offer => Number(offer.amount) === Number(amount)
    && (!sku || offer.sku === sku)), `Expected ${sku ? `${sku} at ` : ''}₹${amount} for: ${query}`)
}
