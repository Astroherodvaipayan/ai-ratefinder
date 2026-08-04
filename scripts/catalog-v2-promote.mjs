#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
  }
}

const args = process.argv.slice(2)
const activate = args.includes('--activate')
const positional = args.filter(value => !value.startsWith('--'))
const [releaseId, artifactPath = 'tmp/catalog-v2-all.json'] = positional
if (!releaseId) throw new Error('Usage: catalog-v2-promote.mjs <release-id> [artifact] [--activate]')
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
}

const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'))
if (artifact.summary.quality_gate_passed !== true || artifact.summary.quality_failures !== 0) {
  throw new Error('Refusing to promote an artifact that did not pass its quality gate')
}
if (artifact.summary.offers_quarantined !== 0 || artifact.summary.reconstruction_failures !== 0) {
  throw new Error('Refusing to promote an artifact containing quarantined or unreconstructed offers')
}

const expected = artifact.documents.flatMap(document => document.offers.map(offer => ({
  owner_id: document.document.owner_id,
  document_id: document.document.id,
  vendor_id: document.document.vendor_id,
  ...offer,
  status: 'published',
  compiler_version: artifact.compiler_version
})))

const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
})
const { data: release, error: releaseError } = await client
  .from('catalog_releases')
  .select('id, compiler_version, status, documents_count, offers_published, offers_quarantined, reconstruction_failures')
  .eq('id', releaseId)
  .single()
if (releaseError) throw releaseError
if (release.status !== 'staging') throw new Error(`Release is ${release.status}; expected staging`)
if (release.compiler_version !== artifact.compiler_version) throw new Error('Compiler version mismatch')
if (release.documents_count !== artifact.summary.documents) throw new Error('Document count mismatch')
if (release.offers_published !== expected.length || release.offers_quarantined !== 0 || release.reconstruction_failures !== 0) {
  throw new Error('Release summary does not match the audited artifact')
}

const columns = [
  'owner_id', 'document_id', 'vendor_id', 'category', 'canonical_name', 'brand', 'sku', 'aliases', 'facets',
  'amount', 'currency', 'basis_quantity', 'basis_unit', 'package_type', 'moq', 'source_page',
  'source_table_index', 'source_row_index', 'source_col_index', 'source_table_title', 'source_row_label',
  'source_column_label', 'raw_price_value', 'source_excerpt', 'status', 'validation_errors', 'compiler_version'
]
const actual = []
for (let from = 0; ; from += 1000) {
  const { data, error } = await client
    .from('catalog_offers')
    .select(columns.join(','))
    .eq('release_id', releaseId)
    .order('id')
    .range(from, from + 999)
  if (error) throw error
  actual.push(...(data ?? []))
  if ((data ?? []).length < 1000) break
}
if (actual.length !== expected.length) throw new Error(`Stored ${actual.length} offers; expected ${expected.length}`)

const expectedHash = offerHash(expected, columns)
const actualHash = offerHash(actual, columns)
if (actualHash !== expectedHash) {
  const mismatch = firstMismatch(expected, actual, columns)
  throw new Error(`Stored offers differ from the audited artifact: ${JSON.stringify(mismatch)}`)
}

for (const offer of actual) {
  if (Number(offer.amount) <= 0) throw new Error(`Non-positive amount for ${offer.canonical_name}`)
  if (offer.currency !== 'INR') throw new Error(`Non-INR amount for ${offer.canonical_name}`)
  if (!offer.basis_quantity || !offer.basis_unit) throw new Error(`Missing purchase basis for ${offer.canonical_name}`)
  if (!offer.source_row_label && !offer.sku) throw new Error(`Missing product identity for ${offer.canonical_name}`)
}

if (activate) {
  const { error } = await client.rpc('activate_catalog_release', { target_release_id: releaseId })
  if (error) throw error
  const { data: activeRelease, error: activeError } = await client
    .from('catalog_releases')
    .select('id, status, activated_at')
    .eq('status', 'active')
    .single()
  if (activeError) throw activeError
  if (activeRelease.id !== releaseId) throw new Error('The verified release was not activated')
}

console.log(JSON.stringify({
  release_id: releaseId,
  artifact: artifactPath,
  offers_verified: actual.length,
  exact_row_hash: actualHash,
  activated: activate
}, null, 2))

function stable(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  }
  return value
}

function canonicalOffer(offer, selectedColumns) {
  return JSON.stringify(stable(Object.fromEntries(selectedColumns.map(column => {
    const value = column === 'amount' || column === 'basis_quantity'
      ? offer[column] === null ? null : Number(offer[column])
      : offer[column]
    return [column, value]
  }))))
}

function canonicalRows(rows, selectedColumns) {
  return rows.map(row => canonicalOffer(row, selectedColumns)).sort()
}

function offerHash(rows, selectedColumns) {
  return createHash('sha256').update(canonicalRows(rows, selectedColumns).join('\n')).digest('hex')
}

function firstMismatch(left, right, selectedColumns) {
  const expectedRows = canonicalRows(left, selectedColumns)
  const actualRows = canonicalRows(right, selectedColumns)
  for (let index = 0; index < Math.max(expectedRows.length, actualRows.length); index += 1) {
    if (expectedRows[index] !== actualRows[index]) {
      return { index, expected: expectedRows[index] ?? null, actual: actualRows[index] ?? null }
    }
  }
  return null
}
