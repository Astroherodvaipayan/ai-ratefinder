export default defineNuxtPlugin(() => {
  const baseFetch = globalThis.$fetch

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

      const supabase = useSupabaseClient()
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token
      if (!token) return

      const headers = new Headers(options.headers as HeadersInit | undefined)
      if (!headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`)
      }
      options.headers = headers
    }
  }) as typeof baseFetch
})
