import type { AppliedAlias } from './normalizeAliases'
import type { ParsedUserItemQuery } from './parseUserItemQuery'
import type { PriceCandidate } from './generateCandidates'
import { compactText, normalizeSearchText, normalizeUnit, tokenize } from './text'

export interface ScoredCandidate {
  candidate: PriceCandidate
  score: number
  confidence_label: 'Matched' | 'Needs review' | 'Not reliable enough'
  matched_fields: string[]
  missing_fields: string[]
  conflicting_fields: string[]
  aliases_used: AppliedAlias[]
  needs_review: boolean
}

const WEIGHTS = {
  numericAttribute: 0.24,
  unit: 0.08,
  productTerm: 0.18,
  rowHeader: 0.12,
  columnHeader: 0.1,
  parentHeader: 0.07,
  tableTitle: 0.06,
  sectionTitle: 0.07,
  vendor: 0.05,
  priceValidity: 0.08,
  parserConfidence: 0.04,
  sourcePage: 0.03,
  aliasConfidence: 0.02,
  recency: 0.02,
  recall: 0.04,
  exactStructured: 0.07,
  rowIdentity: 0.32,
  numericIdentity: 0.14
} as const

const IDENTITY_STOP = new Set([
  'a', 'and', 'as', 'code', 'for', 'hsn', 'is', 'per', 'price', 'rate', 'the'
])

function containsAll(haystack: string, needles: string[]) {
  return needles.length > 0 && needles.every(needle => haystack.includes(normalizeSearchText(needle)))
}

function containsAny(haystack: string, needles: string[]) {
  return needles.some(needle => tokenAwareMatch(haystack, needle))
}

function tokenAwareMatch(normalizedHaystack: string, needle: string) {
  const normalizedNeedle = normalizeSearchText(needle)
  if (!normalizedNeedle) return false
  const tokens = normalizedHaystack.split(' ').filter(Boolean)
  if (/^[a-z]+$/.test(normalizedNeedle)) {
    return tokens.some(token =>
      token === normalizedNeedle
      || token === `${normalizedNeedle}s`
      || normalizedNeedle === `${token}s`
      || (normalizedNeedle === 'frls' && token === 'frlsh')
      || (normalizedNeedle === 'armored' && token === 'armoured')
      || (normalizedNeedle === 'unarmored' && token === 'unarmoured')
    )
  }
  return normalizedHaystack.includes(normalizedNeedle)
}

function attributeMatches(parsed: ParsedUserItemQuery, candidate: PriceCandidate) {
  const matched: string[] = []
  const missing: string[] = []
  const conflicting: string[] = []
  const haystack = normalizeSearchText([
    candidate.searchable_text,
    candidate.product_text,
    candidate.sku_text,
    candidate.description_text,
    candidate.row_headers.join(' '),
    candidate.column_headers.join(' ')
  ].filter(Boolean).join(' '))

  for (const hint of parsed.attribute_hints) {
    const candidateAttrs = candidate.attributes_json.filter(attr => attr.name === hint.name)
    const textMatch = hasTokenPhrase(haystack, normalizeSearchText(`${hint.value} ${hint.unit ?? hint.name}`))
      || (hint.name === 'cores' && hasTokenPhrase(haystack, normalizeSearchText(`${hint.value} core`)))
    const attrMatch = candidateAttrs.some(attr =>
      Number(attr.value) === Number(hint.value)
      && (!hint.unit || !attr.unit || normalizeUnit(attr.unit) === normalizeUnit(hint.unit))
    )
    if (attrMatch || textMatch) matched.push(`${hint.name}:${hint.value}${hint.unit ? ` ${hint.unit}` : ''}`)
    else if (candidateAttrs.length) conflicting.push(`${hint.name}:${hint.value}`)
    else missing.push(`${hint.name}:${hint.value}`)
  }

  return { matched, missing, conflicting }
}

function hasTokenPhrase(normalizedHaystack: string, normalizedNeedle: string) {
  const haystackTokens = normalizedHaystack.split(' ').filter(Boolean)
  const needleTokens = normalizedNeedle.split(' ').filter(Boolean)
  if (!needleTokens.length) return false

  for (let index = 0; index <= haystackTokens.length - needleTokens.length; index++) {
    const matched = needleTokens.every((token, offset) => haystackTokens[index + offset] === token)
    if (matched) return true
  }
  return false
}

function recencyBoost(candidate: PriceCandidate) {
  if (!candidate.source_uploaded_at) return 0
  const time = Date.parse(candidate.source_uploaded_at)
  if (!Number.isFinite(time)) return 0
  const ageDays = Math.max(0, (Date.now() - time) / 86_400_000)
  return Math.max(0, 1 - ageDays / 730)
}

function identityTokens(value: string) {
  return tokenize(value)
    .flatMap(token => normalizeSearchText(token).split(' '))
    .filter(token =>
      token
      && !IDENTITY_STOP.has(token)
      && token !== 'sqmm'
      && token !== 'mm'
    )
}

function numericIdentityTokens(value: string) {
  const tokens = normalizeSearchText(value).split(' ').filter(Boolean)
  const out: string[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    const previous = tokens[index - 1]
    if (!/^\d+(?:\.\d+)?$/.test(token)) continue
    if (previous && /^(?:qty|quantity)$/.test(previous)) continue
    out.push(token)
  }
  return out
}

function labelFor(score: number): ScoredCandidate['confidence_label'] {
  if (score >= 0.85) return 'Matched'
  if (score >= 0.65) return 'Needs review'
  return 'Not reliable enough'
}

export function scoreCandidate(params: {
  parsed: ParsedUserItemQuery
  candidate: PriceCandidate
  aliasesUsed?: AppliedAlias[]
  duplicatePenalty?: number
}): ScoredCandidate {
  const { parsed, candidate } = params
  const matched_fields: string[] = []
  const missing_fields: string[] = []
  const conflicting_fields: string[] = []
  let score = 0

  const searchable = normalizeSearchText(candidate.searchable_text)
  const compactSearchable = compactText(candidate.searchable_text)
  const rowText = normalizeSearchText(candidate.row_headers.join(' '))
  const colText = normalizeSearchText(candidate.column_headers.join(' '))
  const parentText = normalizeSearchText(candidate.parent_headers.join(' '))
  const tableText = normalizeSearchText(candidate.table_title)
  const sectionText = normalizeSearchText(candidate.section_breadcrumb.join(' '))
  const productTokens = parsed.product_terms.length
    ? parsed.product_terms
    : tokenize(parsed.normalized_query).filter(token =>
      !parsed.units.includes(token)
      && token !== 'core'
      && token !== 'sqmm'
      && token !== 'meter'
      && !/^\d+(?:\.\d+)?$/.test(token)
    )
  let productMatchRatio = productTokens.length ? 0 : 1
  const candidateIdentityText = normalizeSearchText([
    candidate.product_text,
    candidate.sku_text,
    candidate.unit,
    candidate.description_text,
    candidate.row_headers.join(' '),
    candidate.column_headers.join(' ')
  ].filter(Boolean).join(' '))

  const attrs = attributeMatches(parsed, candidate)
  if (parsed.attribute_hints.length) {
    const ratio = attrs.matched.length / parsed.attribute_hints.length
    score += WEIGHTS.numericAttribute * ratio
    if (attrs.matched.length) matched_fields.push(...attrs.matched.map(value => `attribute:${value}`))
    if (attrs.missing.length) missing_fields.push(...attrs.missing.map(value => `attribute:${value}`))
    if (attrs.conflicting.length) conflicting_fields.push(...attrs.conflicting.map(value => `attribute:${value}`))
  }

  const sizeHint = parsed.attribute_hints.find(hint => hint.name === 'size')
  const candidateSize = candidate.attributes_json.find(attr => attr.name === 'size')
  if (sizeHint && candidateSize && Number(sizeHint.value) !== Number(candidateSize.value)) {
    const querySize = Number(sizeHint.value)
    const rowSize = Number(candidateSize.value)
    if (Number.isFinite(querySize) && Number.isFinite(rowSize)) {
      const distanceRatio = Math.abs(querySize - rowSize) / Math.max(querySize, rowSize, 1)
      score += Math.max(0, 0.08 - distanceRatio * 0.1)
    }
  }

  if (parsed.requested_unit) {
    const candidateUnit = normalizeUnit(candidate.unit)
    const requestedUnit = normalizeUnit(parsed.requested_unit)
    if (candidateUnit === requestedUnit || (!candidateUnit && containsAny(searchable, [parsed.requested_unit]))) {
      score += WEIGHTS.unit
      matched_fields.push(`unit:${parsed.requested_unit}`)
    } else {
      if (candidateUnit) {
        score -= 0.25
        conflicting_fields.push(`unit:${candidate.unit}`)
      }
      missing_fields.push(`unit:${parsed.requested_unit}`)
    }
  } else if (candidate.unit) {
    score += WEIGHTS.unit * 0.5
  }

  if (productTokens.length) {
    const matchedTerms = productTokens.filter(term => {
      const normalizedTerm = normalizeSearchText(term)
      if (/^[a-z]+$/.test(normalizedTerm)) return tokenAwareMatch(searchable, normalizedTerm)
      return searchable.includes(normalizedTerm) || compactSearchable.includes(compactText(normalizedTerm))
    })
    productMatchRatio = matchedTerms.length / productTokens.length
    score += WEIGHTS.productTerm * productMatchRatio
    if (matchedTerms.length) matched_fields.push(`terms:${matchedTerms.join(',')}`)
    const missingTerms = productTokens.filter(term => !matchedTerms.includes(term))
    if (missingTerms.length) missing_fields.push(`terms:${missingTerms.join(',')}`)
  }

  if (containsAny(rowText, productTokens)) {
    score += WEIGHTS.rowHeader
    matched_fields.push('row_headers')
  }
  if (containsAny(colText, productTokens) || parsed.attribute_hints.some(hint => colText.includes(normalizeSearchText(hint.raw)))) {
    score += WEIGHTS.columnHeader
    matched_fields.push('column_headers')
  }
  if (containsAny(parentText, productTokens)) {
    score += WEIGHTS.parentHeader
    matched_fields.push('parent_headers')
  }
  if (containsAny(tableText, productTokens)) {
    score += WEIGHTS.tableTitle
    matched_fields.push('table_title')
  }
  if (containsAny(sectionText, productTokens) || containsAll(sectionText, parsed.attribute_hints.map(hint => hint.value))) {
    score += WEIGHTS.sectionTitle
    matched_fields.push('section_breadcrumb')
  }
  if (candidate.vendor && containsAny(normalizeSearchText(candidate.vendor), parsed.vendor_terms)) {
    score += WEIGHTS.vendor
    matched_fields.push('vendor')
  }
  if (Number.isFinite(candidate.normalized_price) && candidate.normalized_price > 0) {
    score += WEIGHTS.priceValidity
    matched_fields.push('price')
  }
  if (candidate.source_page !== null && candidate.source_page !== undefined) {
    score += WEIGHTS.sourcePage
    matched_fields.push('source_page')
  }

  score += WEIGHTS.parserConfidence * Math.max(0, Math.min(1, candidate.source_confidence))
  score += WEIGHTS.recency * recencyBoost(candidate)
  score += WEIGHTS.recall * Math.max(0, Math.min(1, candidate.recall_score))

  const scoringQuery = parsed.normalized_match_query || parsed.normalized_query
  const queryIdentityTokens = uniqueIdentityTokens(identityTokens(scoringQuery))
  const candidateIdentityTokens = uniqueIdentityTokens(identityTokens(candidateIdentityText))
  if (parsed.product_terms.length && queryIdentityTokens.length >= 3) {
    const matchedIdentity = queryIdentityTokens.filter(token => tokenAwareMatch(candidateIdentityText, token))
    const identityRatio = matchedIdentity.length / queryIdentityTokens.length
    score += WEIGHTS.rowIdentity * identityRatio
    if (identityRatio >= 0.85) matched_fields.push('row_identity')
    else {
      score -= Math.min(0.22, (1 - identityRatio) * 0.22)
      if (identityRatio < 0.7) missing_fields.push('row_identity')
    }
    if (identityRatio >= 0.95 && attrs.conflicting.length === 0 && productMatchRatio >= 0.6) {
      score += 0.08
      matched_fields.push('exact_row_identity')
    }
  }

  if (queryIdentityTokens.length >= 3 && candidateIdentityTokens.length > queryIdentityTokens.length * 1.8) {
    const extraIdentityTokens = candidateIdentityTokens.filter(token =>
      !queryIdentityTokens.some(queryToken => tokenAwareMatch(normalizeSearchText(queryToken), token))
    )
    const extraIdentityRatio = extraIdentityTokens.length / candidateIdentityTokens.length
    if (extraIdentityRatio > 0.45) {
      score -= Math.min(0.18, extraIdentityRatio * 0.22)
      if (extraIdentityTokens.some(token => /^\d+(?:\.\d+)?$/.test(token))) {
        missing_fields.push('concise_identity')
      }
    }
  }

  const queryNumericIdentityTokens = uniqueIdentityTokens(numericIdentityTokens(scoringQuery))
  if (queryNumericIdentityTokens.length >= 2) {
    const matchedNumericIdentity = queryNumericIdentityTokens.filter(token => tokenAwareMatch(candidateIdentityText, token))
    const numericIdentityRatio = matchedNumericIdentity.length / queryNumericIdentityTokens.length
    score += WEIGHTS.numericIdentity * numericIdentityRatio
    if (numericIdentityRatio >= 0.9) matched_fields.push('numeric_identity')
    else {
      score -= Math.min(0.28, (1 - numericIdentityRatio) * 0.45)
      missing_fields.push('numeric_identity')
    }
  }

  if (
    parsed.attribute_hints.length >= 2
    && parsed.product_terms.length > 0
    && attrs.matched.length === parsed.attribute_hints.length
    && attrs.missing.length === 0
    && attrs.conflicting.length === 0
    && productMatchRatio >= 0.75
  ) {
    score += WEIGHTS.exactStructured
    matched_fields.push('exact_structured_match')
  }

  const aliasesUsed = params.aliasesUsed ?? []
  if (aliasesUsed.length) {
    const minAlias = Math.min(...aliasesUsed.map(alias => alias.confidence))
    score += WEIGHTS.aliasConfidence * minAlias
    matched_fields.push('aliases')
    if (minAlias < 0.85) missing_fields.push('alias_review')
  }

  score -= Math.min(0.5, attrs.conflicting.reduce((total, field) => {
    if (/^(?:size|cores|length):/.test(field)) return total + 0.24
    return total + 0.1
  }, 0))
  score -= Math.min(0.24, attrs.missing.length * 0.06)
  if (attrs.conflicting.length) score = Math.min(score, 0.78)
  const hasExactRowIdentity = matched_fields.includes('exact_row_identity')
  if (attrs.missing.length && parsed.attribute_hints.length && !hasExactRowIdentity) score = Math.min(score, 0.84)
  if (
    !hasExactRowIdentity
    && missing_fields.some(field => field.startsWith('terms:') || field === 'numeric_identity')
  ) {
    score = Math.min(score, 0.84)
  }
  if (/\bper meter\b/.test(normalizeSearchText(parsed.normalized_query)) && /\bcoil\b/.test(candidateIdentityText)) {
    score -= 0.12
    conflicting_fields.push('unit:coil')
  }
  if (parsed.product_terms.some(term => /^(?:armoured|armored)$/.test(term)) && !tokenAwareMatch(candidateIdentityText, 'armoured')) {
    score = Math.min(score, 0.64)
    missing_fields.push('terms:armoured')
  }
  if (parsed.product_terms.includes('copper') && tokenAwareMatch(candidateIdentityText, 'aluminium') && !tokenAwareMatch(candidateIdentityText, 'copper')) {
    score = Math.min(score, 0.64)
    conflicting_fields.push('material:aluminium')
  }
  if (parsed.product_terms.includes('aluminium') && tokenAwareMatch(candidateIdentityText, 'copper') && !tokenAwareMatch(candidateIdentityText, 'aluminium')) {
    score = Math.min(score, 0.64)
    conflicting_fields.push('material:copper')
  }
  if (!parsed.product_terms.some(term => term === 'speaker') && tokenAwareMatch(candidateIdentityText, 'speaker')) {
    score -= 0.6
    conflicting_fields.push('product:speaker')
  }
  score -= params.duplicatePenalty ?? 0
  score = Math.max(0, Math.min(1, Number(score.toFixed(4))))

  const confidence_label = labelFor(score)
  return {
    candidate,
    score,
    confidence_label,
    matched_fields,
    missing_fields,
    conflicting_fields,
    aliases_used: aliasesUsed,
    needs_review: confidence_label !== 'Matched'
  }
}

function uniqueIdentityTokens(values: string[]) {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const key = value.replace(/^0+(\d)/, '$1')
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

function candidateSpecificityLength(candidate: PriceCandidate) {
  return uniqueIdentityTokens(identityTokens([
    candidate.product_text,
    candidate.sku_text,
    candidate.unit,
    candidate.description_text,
    candidate.row_headers.join(' '),
    candidate.column_headers.join(' ')
  ].filter(Boolean).join(' '))).length
}

export function scoreCandidates(params: {
  parsed: ParsedUserItemQuery
  candidates: PriceCandidate[]
  aliasesUsed?: AppliedAlias[]
}): ScoredCandidate[] {
  const duplicateGroups = new Map<string, number>()
  for (const candidate of params.candidates) {
    const key = normalizeSearchText([
      candidate.product_text,
      candidate.sku_text,
      candidate.unit,
      candidate.normalized_price
    ].filter(Boolean).join(' '))
    duplicateGroups.set(key, (duplicateGroups.get(key) ?? 0) + 1)
  }

  return params.candidates
    .map(candidate => {
      const key = normalizeSearchText([
        candidate.product_text,
        candidate.sku_text,
        candidate.unit,
        candidate.normalized_price
      ].filter(Boolean).join(' '))
      const duplicatePenalty = (duplicateGroups.get(key) ?? 0) > 1 ? 0.03 : 0
      return scoreCandidate({
        parsed: params.parsed,
        candidate,
        aliasesUsed: params.aliasesUsed,
        duplicatePenalty
      })
    })
    .sort((a, b) =>
      b.score - a.score
      || candidateSpecificityLength(a.candidate) - candidateSpecificityLength(b.candidate)
      || (b.candidate.source_confidence - a.candidate.source_confidence)
      || String(b.candidate.source_uploaded_at ?? '').localeCompare(String(a.candidate.source_uploaded_at ?? ''))
      || String(a.candidate.doc_price_item_id ?? a.candidate.doc_item_id).localeCompare(String(b.candidate.doc_price_item_id ?? b.candidate.doc_item_id))
    )
}
