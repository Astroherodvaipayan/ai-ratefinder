import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { serverSupabaseUser, serverSupabaseClient } from '#supabase/server'
import { getHeader } from 'h3'
import type { H3Event } from 'h3'

/** Per-request Supabase client bound to the signed-in user (RLS-respecting). */
export async function userClient(event: H3Event): Promise<SupabaseClient> {
  const token = bearerToken(event)
  if (token) return bearerClient(token)

  return await serverSupabaseClient(event) as unknown as SupabaseClient
}

export async function requireUser(event: H3Event) {
  const user = await serverSupabaseUser(event).catch(async () => {
    const token = bearerToken(event)
    if (!token) return null

    const { data, error } = await bearerClient(token).auth.getUser(token)
    if (error) return null
    return data.user
  })
  if (!user) {
    throw createError({ statusCode: 401, statusMessage: 'Not authenticated' })
  }
  return user
}

function bearerToken(event: H3Event) {
  const header = getHeader(event, 'authorization') ?? ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || null
}

function bearerClient(token: string): SupabaseClient {
  const cfg = useRuntimeConfig()
  const publicSupabase = cfg.public?.supabase as { url?: string; key?: string } | undefined
  const url = publicSupabase?.url ?? process.env.SUPABASE_URL
  const key = publicSupabase?.key ?? process.env.SUPABASE_KEY
  if (!url || !key) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Supabase public credentials are missing'
    })
  }

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false
    },
    global: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  })
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
