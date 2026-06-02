import type { SupabaseClient } from '@supabase/supabase-js'

export const PARSER_MODES = ['auto', 'internal', 'chandra'] as const
export type ParserMode = typeof PARSER_MODES[number]

export function isParserMode(value: unknown): value is ParserMode {
  return typeof value === 'string' && PARSER_MODES.includes(value as ParserMode)
}

export async function getParserMode(client: SupabaseClient, ownerId: string): Promise<ParserMode> {
  const { data, error } = await client
    .from('user_settings')
    .select('parser_mode')
    .eq('owner_id', ownerId)
    .maybeSingle()

  if (error) {
    console.warn('Could not read parser mode; defaulting to auto', error.message)
    return 'auto'
  }

  return isParserMode(data?.parser_mode) ? data.parser_mode : 'auto'
}

export async function setParserMode(
  client: SupabaseClient,
  ownerId: string,
  parserMode: ParserMode
): Promise<ParserMode> {
  const { error } = await client
    .from('user_settings')
    .upsert({
      owner_id: ownerId,
      parser_mode: parserMode,
      updated_at: new Date().toISOString()
    }, { onConflict: 'owner_id' })

  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message })
  }

  return parserMode
}
