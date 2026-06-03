import type { SupabaseClient } from '@supabase/supabase-js'

export const PARSER_MODES = ['auto', 'internal', 'chandra', 'sarvam'] as const
export type ParserMode = typeof PARSER_MODES[number]

export const SARVAM_LANGUAGES = [
  'en-IN',
  'hi-IN',
  'bn-IN',
  'gu-IN',
  'kn-IN',
  'ml-IN',
  'mr-IN',
  'or-IN',
  'pa-IN',
  'ta-IN',
  'te-IN',
  'ur-IN',
  'as-IN',
  'bodo-IN',
  'doi-IN',
  'ks-IN',
  'kok-IN',
  'mai-IN',
  'mni-IN',
  'ne-IN',
  'sa-IN',
  'sat-IN',
  'sd-IN'
] as const
export type SarvamLanguage = typeof SARVAM_LANGUAGES[number]

export function isParserMode(value: unknown): value is ParserMode {
  return typeof value === 'string' && PARSER_MODES.includes(value as ParserMode)
}

export function isSarvamLanguage(value: unknown): value is SarvamLanguage {
  return typeof value === 'string' && SARVAM_LANGUAGES.includes(value as SarvamLanguage)
}

export async function getParserSettings(client: SupabaseClient, ownerId: string): Promise<{
  parser_mode: ParserMode
  sarvam_language: SarvamLanguage
}> {
  const { data, error } = await client
    .from('user_settings')
    .select('parser_mode, sarvam_language')
    .eq('owner_id', ownerId)
    .maybeSingle()

  if (error) {
    if (error.message.includes('sarvam_language')) {
      const fallback = await getParserMode(client, ownerId)
      return { parser_mode: fallback, sarvam_language: 'en-IN' }
    }
    console.warn('Could not read parser settings; defaulting to auto', error.message)
    return { parser_mode: 'auto', sarvam_language: 'en-IN' }
  }

  return {
    parser_mode: isParserMode(data?.parser_mode) ? data.parser_mode : 'auto',
    sarvam_language: isSarvamLanguage(data?.sarvam_language) ? data.sarvam_language : 'en-IN'
  }
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

export async function setParserSettings(
  client: SupabaseClient,
  ownerId: string,
  settings: {
    parser_mode: ParserMode
    sarvam_language?: SarvamLanguage
  }
): Promise<{ parser_mode: ParserMode; sarvam_language: SarvamLanguage }> {
  const existing = settings.sarvam_language
    ? null
    : await getParserSettings(client, ownerId)
  const sarvamLanguage = settings.sarvam_language ?? existing?.sarvam_language ?? 'en-IN'
  const { error } = await client
    .from('user_settings')
    .upsert({
      owner_id: ownerId,
      parser_mode: settings.parser_mode,
      sarvam_language: sarvamLanguage,
      updated_at: new Date().toISOString()
    }, { onConflict: 'owner_id' })

  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message })
  }

  return { parser_mode: settings.parser_mode, sarvam_language: sarvamLanguage }
}

export async function setParserMode(
  client: SupabaseClient,
  ownerId: string,
  parserMode: ParserMode
): Promise<ParserMode> {
  return (await setParserSettings(client, ownerId, { parser_mode: parserMode })).parser_mode
}
