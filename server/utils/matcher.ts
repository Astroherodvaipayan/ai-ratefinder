/**
 * SKU matcher — pure Postgres approach.
 *
 *   candidate score = 0.5 * ts_rank_cd(search_doc, plainto_tsquery)
 *                   + 0.5 * similarity(canonical_name, query)
 *
 * Confidence buckets (caller's decision):
 *   ≥ 0.85  auto
 *   0.6 – 0.85  suggest
 *   < 0.6  manual
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface MatchHit {
  product_id: string
  canonical_name: string
  unit: string | null
  score: number
}

export async function matchProducts(
  client: SupabaseClient,
  query: string,
  limit = 10
): Promise<MatchHit[]> {
  const { data, error } = await client.rpc('rf_match_products', {
    q: query,
    lim: limit
  })
  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message })
  }
  return (data ?? []) as MatchHit[]
}
