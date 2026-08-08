import type { CatalogOfferRow, CatalogSearchResult } from './searchV2'

export function catalogChatResponse(results: CatalogSearchResult[]) {
  const lines = results.map((result) => {
    const correction = result.query.corrected_text
      ? ` Interpreted as “${result.query.corrected_text}”.`
      : ''
    if (result.state === 'absent') {
      const alternatives = result.suggestions.filter(suggestion => suggestion.reason === 'closest').length
      return `• ${result.query.raw}: no published offer matches every specified detail. No substitute was used.${alternatives ? ` ${alternatives} catalogue-backed suggestion${alternatives === 1 ? '' : 's'} available below.` : ''}${correction}`
    }
    if (result.state === 'ambiguous') {
      return `• ${result.query.raw}: choose ${result.missing_facets.map(prettyFacet).join(', ')} to narrow ${result.offers.length} matching offer${result.offers.length === 1 ? '' : 's'}.${correction}`
    }
    const method = result.match_method === 'sku' ? ' by exact SKU' : ''
    return `• ${result.query.raw}: found ${result.offers.length} source-backed offer${result.offers.length === 1 ? '' : 's'}${method}.${correction}`
  })

  return {
    answerText: lines.join('\n'),
    items: results.flatMap(result => [
      ...(needsSearchNotice(result) ? [searchNotice(result)] : []),
      ...result.offers.map(offer => chatItem(result, offer))
    ])
  }
}

function chatItem(result: CatalogSearchResult, offer: CatalogOfferRow) {
  const sourceDocument = Array.isArray(offer.documents)
    ? offer.documents[0]?.filename
    : offer.documents?.filename
  const basisQuantity = Number(offer.basis_quantity ?? 1)
  const basisLabel = [basisQuantity === 1 ? null : basisQuantity, offer.basis_unit, offer.package_type]
    .filter(Boolean)
    .join(' ')
  const requiresChoice = result.state !== 'exact' || result.offers.length > 1

  return {
    kind: 'offer',
    requested_query: result.query.raw,
    match_state: result.state,
    match_method: result.match_method,
    understood_facets: result.query.facets,
    catalog_offer_id: offer.id,
    doc_price_item_id: null,
    doc_item_id: null,
    product_name: displayName(offer),
    sku: offer.sku,
    unit: basisLabel || offer.basis_unit,
    price: offer.amount,
    moq: offer.moq,
    currency: 'INR',
    vendor: offer.brand ?? 'Unknown vendor',
    source_document: sourceDocument ?? 'Unknown document',
    source_page: offer.source_page,
    confidence: result.state === 'exact' ? 1 : 0.5,
    needs_review: requiresChoice,
    matched_table: offer.source_table_title,
    matched_row: offer.source_row_label,
    matched_column: offer.source_column_label,
    match_explanation: result.state === 'exact'
      ? `Exact catalogue facets; amount copied from source row ${offer.source_row_index + 1}, column ${offer.source_col_index + 1}.`
      : result.explanation,
    suggested_query: null,
    variant_label: facetLabel(offer),
    price_basis: {
      source_price: offer.amount,
      source_basis_quantity: basisQuantity,
      source_basis_unit: offer.basis_unit,
      source_basis_pack_unit: offer.package_type,
      source_basis_label: basisLabel || offer.basis_unit,
      effective_unit_price: offer.basis_unit ? Math.round((offer.amount / basisQuantity) * 100) / 100 : offer.amount,
      effective_unit: offer.basis_unit
    },
    requested_quantity: null,
    alternatives: []
  }
}

function needsSearchNotice(result: CatalogSearchResult) {
  return Boolean(
    result.query.corrected_text
    || result.state !== 'exact'
    || result.suggestions.length
    || result.refinements.length
  )
}

function searchNotice(result: CatalogSearchResult) {
  return {
    kind: 'search_notice',
    requested_query: result.query.raw,
    corrected_query: result.query.corrected_text,
    match_state: result.state,
    match_method: result.match_method,
    understood_facets: result.query.facets,
    missing_facets: result.missing_facets,
    suggestions: result.suggestions,
    refinements: result.refinements,
    catalog_offer_id: null,
    doc_price_item_id: null,
    doc_item_id: null,
    product_name: result.state === 'absent'
      ? 'No exact catalogue match'
      : result.state === 'ambiguous'
        ? 'Choose a specification'
        : 'Search wording corrected',
    sku: null,
    unit: null,
    price: null,
    moq: null,
    currency: 'INR',
    vendor: '',
    source_document: '',
    source_page: null,
    confidence: 0,
    needs_review: false,
    matched_table: null,
    matched_row: null,
    matched_column: null,
    match_explanation: result.explanation,
    suggested_query: result.query.corrected_text,
    variant_label: null,
    price_basis: null,
    requested_quantity: null,
    alternatives: []
  }
}

function displayName(offer: CatalogOfferRow) {
  const facets = offer.facets
  const parts = [
    facets.size_sqmm !== undefined ? `${facets.size_sqmm} sqmm` : null,
    facets.current_a !== undefined ? `${facets.current_a}A` : null,
    facets.cores !== undefined ? `${facets.cores} core` : null,
    facets.poles !== undefined ? `${facets.poles} pole` : null,
    facets.pairs !== undefined ? `${facets.pairs} pair` : null,
    facets.standard,
    facets.conductor_material,
    facets.armour,
    facets.fire_rating,
    offer.category.replace(/_/g, ' '),
    offer.sku
  ].filter(value => value !== null && value !== undefined && value !== '')
  return parts.join(' ') || offer.canonical_name
}

function facetLabel(offer: CatalogOfferRow) {
  return Object.entries(offer.facets)
    .filter(([name]) => name !== 'price_basis_inferred')
    .map(([name, value]) => `${name.replace(/_/g, ' ')}: ${value}`)
    .join(' · ')
}

function prettyFacet(value: string) {
  return value.replace(/_/g, ' ')
}
