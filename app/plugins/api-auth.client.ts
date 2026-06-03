export default defineNuxtPlugin(() => {
  const baseFetch = globalThis.$fetch
  const supabase = useSupabaseClient()
  const session = useSupabaseSession()
  let cachedAccessToken: string | null | undefined = session.value?.access_token ?? undefined

  supabase.auth.onAuthStateChange((_event, nextSession) => {
    cachedAccessToken = nextSession?.access_token ?? null
  })

  async function accessToken() {
    if (cachedAccessToken !== undefined) return cachedAccessToken

    const { data } = await supabase.auth.getSession()
    cachedAccessToken = data.session?.access_token ?? null
    return cachedAccessToken
  }

  globalThis.$fetch = baseFetch.create({
    async onRequest({ request, options }) {
      const url = typeof request === 'string'
        ? request
        : request instanceof Request
          ? request.url
          : String(request)

      const isLocalApi = url.startsWith('/api/')
        || url.startsWith(`${window.location.origin}/api/`)
      if (!isLocalApi) return

      const token = await accessToken()
      if (!token) return

      const headers = new Headers(options.headers as HeadersInit | undefined)
      if (!headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`)
      }
      options.headers = headers
    }
  }) as typeof baseFetch
})
