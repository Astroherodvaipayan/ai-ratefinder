export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  future: { compatibilityVersion: 4 },

  modules: [
    '@nuxt/ui',
    '@nuxtjs/supabase',
    '@vueuse/nuxt'
  ],

  css: ['~/assets/css/main.css'],

  supabase: {
    redirectOptions: {
      login: '/login',
      callback: '/confirm',
      include: undefined,
      exclude: ['/login', '/signup', '/confirm'],
      saveRedirectToCookie: true
    },
    // Default PKCE + SSR cookies (do not use implicit flow — it breaks cookie sessions).
    clientOptions: {}
  },

  runtimeConfig: {
    datalabApiKey: '',
    geminiApiKey: '',
    supabaseServiceRoleKey: '',
    public: {
      appName: 'AI Ratefinder'
    }
  },

  typescript: { strict: true },

  nitro: {
    experimental: { tasks: true }
  }
})
