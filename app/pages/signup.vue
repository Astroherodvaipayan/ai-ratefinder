<script setup lang="ts">
definePageMeta({ layout: false })

const supabase = useSupabaseClient()
const user = useSupabaseUser()
const email = ref('')
const password = ref('')
const error = ref<string | null>(null)
const sent = ref(false)
const loading = ref(false)

watchEffect(() => { if (user.value) navigateTo('/') })

async function submit() {
  loading.value = true
  error.value = null
  const { error: err } = await supabase.auth.signUp({
    email: email.value,
    password: password.value,
    options: { emailRedirectTo: `${window.location.origin}/confirm` }
  })
  loading.value = false
  if (err) { error.value = err.message; return }
  sent.value = true
}
</script>

<template>
  <div class="grid min-h-screen place-items-center bg-muted">
    <UCard class="w-full max-w-sm">
      <form v-if="!sent" class="space-y-4" @submit.prevent="submit">
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
        <UButton type="submit" :loading="loading" block>Sign up</UButton>
        <p class="text-center text-xs text-muted">
          Have an account? <NuxtLink to="/login" class="font-medium text-highlighted underline-offset-2 hover:underline">Sign in</NuxtLink>
        </p>
      </form>
      <div v-else class="space-y-2 text-center">
        <UIcon name="i-lucide-mail-check" class="text-3xl text-toned" />
        <p class="text-sm">Check your inbox to confirm your email.</p>
      </div>
    </UCard>
  </div>
</template>
