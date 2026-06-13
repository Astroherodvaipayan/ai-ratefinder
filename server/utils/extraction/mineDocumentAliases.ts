import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeSearchText, uniqueText } from '../search/text'

interface AliasCandidate {
  alias_text: string
  canonical_text: string
  confidence: number
  evidence: Record<string, unknown>
}

const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bsq\.?\s*mm\b/gi, 'sqmm'],
  [/\bmtrs?\.?\b/gi, 'meter'],
  [/\bmetres?\b/gi, 'meter'],
  [/\bpcs?\.?\b/gi, 'piece'],
  [/\bnos?\.?\b/gi, 'piece']
]

export function mineAliasesFromText(text: string): AliasCandidate[] {
  const candidates: AliasCandidate[] = []
  for (const [pattern, canonical] of ABBREVIATIONS) {
    for (const match of text.matchAll(pattern)) {
      const alias = match[0]?.trim()
      if (!alias) continue
      candidates.push({
        alias_text: alias,
        canonical_text: canonical,
        confidence: 0.9,
        evidence: { reason: 'document abbreviation', normalized: normalizeSearchText(alias) }
      })
    }
  }

  for (const match of text.matchAll(/\b([A-Z][A-Z0-9./-]{2,})\s*\(([^)a-z]{2,})\)/g)) {
    const canonical = match[1]?.trim()
    const alias = match[2]?.trim()
    if (!alias || !canonical) continue
    candidates.push({
      alias_text: alias,
      canonical_text: canonical,
      confidence: 0.72,
      evidence: { reason: 'document parenthetical abbreviation' }
    })
  }

  return candidates
}

export async function persistDocumentAliases(params: {
  client: SupabaseClient
  tenantId: string
  vendorId: string | null
  documentId: string
  text: string
}) {
  const candidates = mineAliasesFromText(params.text)
  if (!candidates.length) return 0

  const rows = uniqueText(candidates.map(candidate => `${candidate.alias_text}\t${candidate.canonical_text}`))
    .map((key) => {
      const [aliasText, canonicalText] = key.split('\t')
      const candidate = candidates.find(item => item.alias_text === aliasText && item.canonical_text === canonicalText)!
      return {
        tenant_id: params.tenantId,
        vendor_id: params.vendorId,
        document_id: params.documentId,
        alias_text: candidate.alias_text,
        canonical_text: candidate.canonical_text,
        scope: 'document',
        confidence: candidate.confidence,
        source: 'document_mined',
        evidence: candidate.evidence
      }
    })

  const { error } = await params.client
    .from('search_aliases')
    .insert(rows)

  if (error) {
    console.warn('Could not persist mined aliases', error.message)
    return 0
  }
  return rows.length
}
