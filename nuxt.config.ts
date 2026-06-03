export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  future: { compatibilityVersion: 4 },
  app: {
    head: {
      link: [
        { rel: 'icon', type: 'image/png', href: '/brand/rj-logo.png' },
        { rel: 'apple-touch-icon', href: '/brand/rj-logo.png' }
      ]
    }
  },

  modules: [
    '@nuxt/ui',
    '@nuxtjs/supabase',
    '@vueuse/nuxt'
  ],

  css: ['~/assets/css/main.css'],

  vite: {
    optimizeDeps: {
      include: ['tus-js-client']
    }
  },

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
    sarvamApiKey: '',
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
