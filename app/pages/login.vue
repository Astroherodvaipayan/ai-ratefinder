<script setup lang="ts">
import { hasAuthSession, navigateAfterAuth, waitForAuthSession } from '~/composables/useAuthSession'

definePageMeta({ layout: false })

const supabase = useSupabaseClient()
const route = useRoute()
const email = ref('')
const password = ref('')
const error = ref<string | null>(null)
const loading = ref(false)

interface LandingChat { id: string }

function redirectTarget() {
  const redirect = route.query.redirect
  return typeof redirect === 'string' && redirect.startsWith('/')
    ? redirect
    : '/chats'
}

async function postLoginTarget() {
  const target = redirectTarget()
  if (target !== '/chats') return target

  try {
    const chat = await $fetch<LandingChat>('/api/chats/landing')
    return chat.id ? `/chats/${chat.id}` : target
  } catch {
    return target
  }
}

onMounted(async () => {
  if (await hasAuthSession(supabase)) {
    navigateAfterAuth(await postLoginTarget())
  }
})

async function submit() {
  loading.value = true
  error.value = null
  try {
    const { data, error: err } = await supabase.auth.signInWithPassword({
      email: email.value,
      password: password.value
    })
    if (err) {
      error.value = err.message
      return
    }

    await waitForAuthSession(supabase, 4_000, data.session)
    navigateAfterAuth(await postLoginTarget())
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Could not sign in. Please try again.'
  } finally {
    if (import.meta.client && !error.value) {
      // Keep loading state until the browser navigates away.
      const stillHere = () => window.location.pathname.startsWith('/login')
      if (stillHere()) loading.value = false
    } else {
      loading.value = false
    }
  }
}
</script>

<template>
  <div class="grid min-h-screen place-items-center bg-muted">
    <UCard class="w-full max-w-sm">
      <form class="space-y-4" @submit.prevent="submit">
        <div class="flex flex-col items-center text-center">
          <span class="mb-3 grid size-10 place-items-center rounded-lg border border-default bg-muted text-highlighted">
            <UIcon name="i-lucide-search-check" class="text-lg" />
          </span>
          <h1 class="text-lg font-semibold">Sign in</h1>
          <p class="text-xs text-muted">AI Ratefinder</p>
        </div>
        <UFormField label="Email">
          <UInput v-model="email" type="email" autocomplete="email" required />
        </UFormField>
        <UFormField label="Password">
          <UInput v-model="password" type="password" autocomplete="current-password" required />
        </UFormField>
        <p v-if="error" class="text-xs text-error">{{ error }}</p>
        <UButton type="submit" :loading="loading" block>Sign in</UButton>
        <p class="text-center text-xs text-muted">
          No account? <NuxtLink to="/signup" class="font-medium text-highlighted underline-offset-2 hover:underline">Sign up</NuxtLink>
        </p>
      </form>
    </UCard>
  </div>
</template>
