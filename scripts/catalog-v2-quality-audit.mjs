#!/usr/bin/env node
import { readFileSync } from 'node:fs'

const artifactPath = process.argv[2] ?? 'tmp/catalog-v2-all.json'
const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'))
const allOffers = artifact.documents.flatMap(document => document.offers
  .map(offer => ({ ...offer, document: document.document.filename })))
const offers = allOffers.filter(offer => !offer.validation_errors.length)
const quarantinedOffers = allOffers.filter(offer => offer.validation_errors.length)

const failures = []
if (artifact.summary.quality_gate_passed !== true) failures.push({ reason: 'artifact_quality_gate_not_passed' })
if (offers.length !== artifact.summary.offers_published) failures.push({ reason: 'published_offer_summary_mismatch' })
if (quarantinedOffers.length !== artifact.summary.offers_quarantined) failures.push({ reason: 'quarantined_offer_summary_mismatch' })
if (quarantinedOffers.length > 0) failures.push({ reason: 'artifact_contains_quarantined_offers', count: quarantinedOffers.length })
for (const document of artifact.documents) {
  for (const failure of document.quality_failures ?? []) {
    failures.push({ reason: failure.reason, document: document.document.filename, details: failure })
  }
  for (const audit of document.table_audits ?? []) {
    if (audit.decisions.length !== audit.numeric_cells) {
      failures.push({ reason: 'numeric_cell_accounting_mismatch', document: document.document.filename, table_index: audit.source_table_index })
    }
    if (!audit.price_gate || typeof audit.price_gate.requires_price_candidate !== 'boolean') {
      failures.push({ reason: 'missing_price_gate_evidence', document: document.document.filename, table_index: audit.source_table_index })
    } else if (audit.price_gate.requires_price_candidate && audit.selected_price_cells === 0) {
      failures.push({ reason: 'commercial_table_without_price_candidates', document: document.document.filename, table_index: audit.source_table_index })
    }
  }
}
for (const offer of offers) {
  if (Number(offer.raw_price_value.replace(/[,\s]|\/-/g, '')) !== Number(offer.amount)) {
    failures.push({ reason: 'source_reconstruction', offer })
  }
  if (!offer.source_row_label && !offer.sku) failures.push({ reason: 'missing_product_identity', offer })
  if (/^\s*\d+(?:\.\d+)?\s*$/.test(offer.canonical_name)) failures.push({ reason: 'numeric_only_name', offer })
  if (/\b(?:current\s*(?:carrying|rating|capacity|amps?)|amps?|sizesq|sqmm|standard\s*pack|standardpacking|std\.?\s*(?:pack|pkg)|packing\s*(?:quantity|qty)|pack\s*qty|no\.?\s*of\s*coils?|conductor\s*construction|mw)\b/i.test(offer.source_column_label ?? '')) {
    failures.push({ reason: 'specification_column_published', offer })
  }
}

const summary = {
  artifact: artifactPath,
  published_offers: offers.length,
  quarantined_offers: artifact.summary.offers_quarantined,
  reconstruction_failures: artifact.summary.reconstruction_failures,
  quality_failures: failures.length
}
console.log(JSON.stringify(summary, null, 2))
for (const failure of failures.slice(0, 30)) {
  console.error(JSON.stringify({
    reason: failure.reason,
    category: failure.offer?.category,
    name: failure.offer?.canonical_name,
    amount: failure.offer?.amount,
    facets: failure.offer?.facets,
    source_column: failure.offer?.source_column_label,
    document: failure.offer?.document ?? failure.document,
    details: failure.details,
    table_index: failure.table_index
  }))
}
if (artifact.summary.reconstruction_failures || failures.length) process.exit(1)
