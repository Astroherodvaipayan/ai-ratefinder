import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { serverSupabaseUser, serverSupabaseClient } from '#supabase/server'
import type { H3Event } from 'h3'

/** Per-request Supabase client bound to the signed-in user (RLS-respecting). */
export async function userClient(event: H3Event): Promise<SupabaseClient> {
  return await serverSupabaseClient(event) as unknown as SupabaseClient
}

export async function requireUser(event: H3Event) {
  const user = await serverSupabaseUser(event)
  if (!user) {
    throw createError({ statusCode: 401, statusMessage: 'Not authenticated' })
  }
  return user
}

/** Service-role client — bypasses RLS. Use sparingly, server-only. */
export function adminClient(): SupabaseClient {
  const cfg = useRuntimeConfig()
  const url = cfg.public?.supabase?.url as string | undefined
                ?? process.env.SUPABASE_URL
  const key = cfg.supabaseServiceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Supabase admin credentials are missing'
    })
  }
  return createClient(url, key, { auth: { persistSession: false } })
}
