#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import { existsSync, readFileSync } from 'node:fs'

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
  }
}

const args = process.argv.slice(2)
const activate = args.includes('--activate')
if (activate) throw new Error('Direct activation is disabled; import to staging, then use catalog:v2:promote after verification')
const artifactPath = args.find(value => !value.startsWith('--')) ?? 'tmp/catalog-v2-all.json'
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
}

const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'))
if (!artifact.compiler_version || !Array.isArray(artifact.documents)) throw new Error('Invalid catalogue artifact')
if (artifact.summary.reconstruction_failures !== 0) throw new Error('Refusing to import an artifact with source reconstruction failures')
if (artifact.summary.quality_gate_passed !== true || Number(artifact.summary.quality_failures ?? 0) !== 0) {
  throw new Error('Refusing to import an artifact that has not passed catalogue coverage and recall quality gates')
}

const offers = artifact.documents.flatMap(document => document.offers.map(offer => ({
  release_id: null,
  owner_id: document.document.owner_id,
  document_id: document.document.id,
  vendor_id: document.document.vendor_id,
  ...offer,
  status: offer.validation_errors.length ? 'quarantined' : 'published',
  compiler_version: artifact.compiler_version
})))
const expectedPublished = offers.filter(offer => offer.status === 'published').length
const expectedQuarantined = offers.length - expectedPublished
if (expectedPublished !== artifact.summary.offers_published || expectedQuarantined !== artifact.summary.offers_quarantined) {
  throw new Error('Artifact summary does not match its offer rows')
}
if (expectedQuarantined !== 0) throw new Error('Refusing to import a production catalogue release containing quarantined offers')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
})
const { data: release, error: releaseError } = await supabase
  .from('catalog_releases')
  .insert({
    compiler_version: artifact.compiler_version,
    status: 'staging',
    documents_count: artifact.summary.documents,
    offers_published: expectedPublished,
    offers_quarantined: expectedQuarantined,
    reconstruction_failures: artifact.summary.reconstruction_failures
  })
  .select('id')
  .single()
if (releaseError || !release) throw releaseError ?? new Error('Could not create catalogue release')

try {
  for (let from = 0; from < offers.length; from += 250) {
    const rows = offers.slice(from, from + 250).map(offer => ({ ...offer, currency: 'INR', release_id: release.id }))
    const { error } = await supabase.from('catalog_offers').insert(rows)
    if (error) throw error
  }

  const { count, error: countError } = await supabase
    .from('catalog_offers')
    .select('id', { count: 'exact', head: true })
    .eq('release_id', release.id)
  if (countError) throw countError
  if (count !== offers.length) throw new Error(`Imported ${count} rows; expected ${offers.length}`)

  console.log(JSON.stringify({
    release_id: release.id,
    compiler_version: artifact.compiler_version,
    rows_imported: count,
    offers_published: expectedPublished,
    offers_quarantined: expectedQuarantined,
    activated: false
  }, null, 2))
} catch (error) {
  await supabase.from('catalog_releases').delete().eq('id', release.id).eq('status', 'staging')
  throw error
}
