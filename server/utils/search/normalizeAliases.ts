import type { SupabaseClient } from '@supabase/supabase-js'
import type { ParsedUserItemQuery } from './parseUserItemQuery'
import { normalizeSearchText } from './text'

export interface AppliedAlias {
  alias_text: string
  canonical_text: string
  confidence: number
  source: string
  scope: string
}

export interface AliasNormalizationResult {
  query: ParsedUserItemQuery
  aliases_used: AppliedAlias[]
  low_confidence_aliases: AppliedAlias[]
}

const BUILT_IN_ALIASES: AppliedAlias[] = [
  { alias_text: 'sq mm', canonical_text: 'sqmm', confidence: 0.98, source: 'seed', scope: 'global' },
  { alias_text: 'sq.mm', canonical_text: 'sqmm', confidence: 0.98, source: 'seed', scope: 'global' },
  { alias_text: 'mtr', canonical_text: 'meter', confidence: 0.95, source: 'seed', scope: 'global' },
  { alias_text: 'mtrs', canonical_text: 'meter', confidence: 0.95, source: 'seed', scope: 'global' },
  { alias_text: 'pc', canonical_text: 'piece', confidence: 0.9, source: 'seed', scope: 'global' },
  { alias_text: 'pcs', canonical_text: 'piece', confidence: 0.9, source: 'seed', scope: 'global' }
]

async function loadAliases(params: {
  client: SupabaseClient
  tenantId: string
  vendorId?: string | null
  documentId?: string | null
}) {
  const visibility = [
    'tenant_id.is.null',
    `tenant_id.eq.${params.tenantId}`,
    params.documentId ? `document_id.eq.${params.documentId}` : null
  ].filter(Boolean).join(',')
  const { data, error } = await params.client
    .from('search_aliases')
    .select('alias_text, canonical_text, confidence, source, scope, vendor_id, document_id')
    .or(visibility)
    .gte('confidence', 0.35)
    .order('confidence', { ascending: false })
    .limit(500)

  if (error) return BUILT_IN_ALIASES

  return [
    ...BUILT_IN_ALIASES,
    ...(data ?? []).flatMap((row: any) => {
      if (row.scope === 'vendor' && params.vendorId && row.vendor_id !== params.vendorId) return []
      if (row.scope === 'document' && params.documentId && row.document_id !== params.documentId) return []
      if (row.scope === 'document' && !params.documentId) return []
      return [{
        alias_text: row.alias_text,
        canonical_text: row.canonical_text,
        confidence: Number(row.confidence ?? 0.5),
        source: row.source,
        scope: row.scope
      }]
    })
  ]
}

function applyAliasText(text: string, alias: AppliedAlias) {
  const aliasNorm = normalizeSearchText(alias.alias_text)
  if (!aliasNorm) return text
  const pattern = new RegExp(`(^|\\s)${aliasNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'gi')
  return text.replace(pattern, `$1${normalizeSearchText(alias.canonical_text)}`)
}

export async function normalizeAliases(params: {
  client: SupabaseClient
  tenantId: string
  parsed: ParsedUserItemQuery
  vendorId?: string | null
  documentId?: string | null
}): Promise<AliasNormalizationResult> {
  const aliases = await loadAliases(params)
  let normalizedQuery = params.parsed.normalized_query
  const aliasesUsed: AppliedAlias[] = []
  const lowConfidence: AppliedAlias[] = []

  for (const alias of aliases) {
    const before = normalizedQuery
    normalizedQuery = applyAliasText(normalizedQuery, alias)
    if (before === normalizedQuery) continue
    if (alias.confidence >= 0.65) aliasesUsed.push(alias)
    else lowConfidence.push(alias)
  }

  return {
    query: {
      ...params.parsed,
      normalized_query: normalizedQuery,
      product_terms: params.parsed.product_terms.map(term => {
        let out = normalizeSearchText(term)
        for (const alias of aliases.filter(item => item.confidence >= 0.65)) out = applyAliasText(out, alias)
        return out
      })
    },
    aliases_used: aliasesUsed,
    low_confidence_aliases: lowConfidence
  }
}
