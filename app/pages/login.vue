<script setup lang="ts">
definePageMeta({ layout: false })

const supabase = useSupabaseClient()
const user = useSupabaseUser()
const session = useSupabaseSession()
const route = useRoute()
const email = ref('')
const password = ref('')
const error = ref<string | null>(null)
const loading = ref(false)

function redirectTarget() {
  const redirect = route.query.redirect
  return typeof redirect === 'string' && redirect.startsWith('/')
    ? redirect
    : '/chats'
}

watchEffect(() => {
  if (user.value || session.value) navigateTo(redirectTarget())
})

async function submit() {
  loading.value = true
  error.value = null
  const { data, error: err } = await supabase.auth.signInWithPassword({
    email: email.value,
    password: password.value
  })
  loading.value = false
  if (err) {
    error.value = err.message
    return
  }

  const { data: savedSession, error: sessionError } = await supabase.auth.getSession()
  if (sessionError || !savedSession.session) {
    error.value = sessionError?.message || 'Signed in, but the browser session was not saved. Please try again.'
    return
  }

  session.value = savedSession.session
  user.value = savedSession.session.user ?? data.user
  window.location.assign(redirectTarget())
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
