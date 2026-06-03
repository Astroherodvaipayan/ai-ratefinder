import type { Session, SupabaseClient } from '@supabase/supabase-js'

/** Wait until Supabase has persisted a session after sign-in/sign-up. */
export async function waitForAuthSession(
  supabase: SupabaseClient,
  timeoutMs = 12_000
): Promise<Session> {
  const existing = await supabase.auth.getSession()
  if (existing.data.session) return existing.data.session

  return await new Promise<Session>((resolve, reject) => {
    const timer = setTimeout(() => {
      subscription.unsubscribe()
      reject(new Error('Sign-in timed out. Please try again.'))
    }, timeoutMs)

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!session) return
      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') {
        clearTimeout(timer)
        subscription.unsubscribe()
        resolve(session)
      }
    })
  })
}

/** Full navigation so SSR picks up auth cookies on the next page. */
export function navigateAfterAuth(path: string) {
  if (import.meta.client) {
    window.location.assign(path)
    return
  }
  return navigateTo(path, { external: true })
}

/** True when composables or Supabase client report a signed-in session. */
export async function hasAuthSession(supabase: SupabaseClient) {
  const user = useSupabaseUser()
  const session = useSupabaseSession()
  if (user.value || session.value) return true

  if (!import.meta.client) return false

  const { data } = await supabase.auth.getSession()
  if (!data.session) return false

  session.value = data.session
  user.value = data.session.user
  return true
}
