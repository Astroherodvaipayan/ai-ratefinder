import type { ScoredCandidate } from './scoreCandidates'

export function sourceCitation(scored: ScoredCandidate | null) {
  if (!scored) return null
  const candidate = scored.candidate
  return {
    doc_price_item_id: candidate.doc_price_item_id,
    doc_item_id: candidate.doc_item_id,
    source_document: candidate.source_document,
    source_page: candidate.source_page,
    source_table_id: candidate.source_table_id,
    source_row_index: candidate.source_row_index,
    source_col_index: candidate.source_col_index,
    table_title: candidate.table_title,
    row_headers: candidate.row_headers,
    column_headers: candidate.column_headers,
    parent_headers: candidate.parent_headers
  }
}

export function explainMatch(params: {
  query: string
  scored: ScoredCandidate | null
  alternatives: ScoredCandidate[]
}) {
  const best = params.scored
  return {
    query: params.query,
    best_candidate: best?.candidate ?? null,
    alternatives: params.alternatives.map(item => ({
      candidate: item.candidate,
      confidence_score: item.score,
      confidence_label: item.confidence_label,
      source_citation: sourceCitation(item)
    })),
    confidence_score: best?.score ?? 0,
    confidence_label: best?.confidence_label ?? 'Not reliable enough',
    matched_fields: best?.matched_fields ?? [],
    missing_fields: best?.missing_fields ?? [],
    conflicting_fields: best?.conflicting_fields ?? [],
    aliases_used: best?.aliases_used ?? [],
    source_citation: sourceCitation(best),
    needs_review: best?.needs_review ?? true
  }
}
