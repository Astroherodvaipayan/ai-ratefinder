<script setup lang="ts">
definePageMeta({ layout: false })

const supabase = useSupabaseClient()
const user = useSupabaseUser()
const email = ref('')
const password = ref('')
const error = ref<string | null>(null)
const loading = ref(false)

watchEffect(() => { if (user.value) navigateTo('/') })

async function submit() {
  loading.value = true
  error.value = null
  const { error: err } = await supabase.auth.signInWithPassword({
    email: email.value,
    password: password.value
  })
  loading.value = false
  if (err) error.value = err.message
}
</script>

<template>
  <div class="grid min-h-screen place-items-center bg-elevated">
    <UCard class="w-full max-w-sm">
      <form class="space-y-4" @submit.prevent="submit">
        <div>
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
          No account? <NuxtLink to="/signup" class="text-primary">Sign up</NuxtLink>
        </p>
      </form>
    </UCard>
  </div>
</template>
