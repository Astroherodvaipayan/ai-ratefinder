<script setup lang="ts">
import { hasAuthSession, navigateAfterAuth, waitForAuthSession } from '~/composables/useAuthSession'

definePageMeta({ layout: false })

const supabase = useSupabaseClient()
const email = ref('')
const password = ref('')
const error = ref<string | null>(null)
const loading = ref(false)

onMounted(async () => {
  if (await hasAuthSession(supabase)) {
    navigateAfterAuth('/chats')
  }
})

async function submit() {
  loading.value = true
  error.value = null

  try {
    await $fetch('/api/auth/signup', {
      method: 'POST',
      body: { email: email.value, password: password.value }
    })

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.value,
      password: password.value
    })
    if (signInError) throw signInError

    await waitForAuthSession(supabase)
    navigateAfterAuth('/chats')
  } catch (err) {
    error.value = errorMessage(err)
    loading.value = false
  }
}

function errorMessage(err: unknown) {
  if (err && typeof err === 'object') {
    const maybeError = err as { statusMessage?: string, message?: string }
    return maybeError.statusMessage || maybeError.message || 'Could not create account.'
  }
  return 'Could not create account.'
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
          <h1 class="text-lg font-semibold">Create account</h1>
          <p class="text-xs text-muted">AI Ratefinder</p>
        </div>
        <UFormField label="Email">
          <UInput v-model="email" type="email" autocomplete="email" required />
        </UFormField>
        <UFormField label="Password" hint="Minimum 8 characters">
          <UInput v-model="password" type="password" minlength="8" autocomplete="new-password" required />
        </UFormField>
        <p v-if="error" class="text-xs text-error">{{ error }}</p>
        <UButton type="submit" :loading="loading" block>Create account</UButton>
        <p class="text-center text-xs text-muted">
          Have an account? <NuxtLink to="/login" class="font-medium text-highlighted underline-offset-2 hover:underline">Sign in</NuxtLink>
        </p>
      </form>
    </UCard>
  </div>
</template>
