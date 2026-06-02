<script setup lang="ts">
definePageMeta({ layout: false })

const supabase = useSupabaseClient()
const user = useSupabaseUser()
const route = useRoute()

const status = ref<'confirming' | 'confirmed' | 'failed'>('confirming')
const error = ref<string | null>(null)

async function finishConfirm() {
  if (user.value) {
    status.value = 'confirmed'
    await navigateTo('/')
    return
  }

  const url = new URL(window.location.href)
  const code = typeof route.query.code === 'string'
    ? route.query.code
    : url.searchParams.get('code')
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''))
  const accessToken = hash.get('access_token')
  const refreshToken = hash.get('refresh_token')
  const authError = url.searchParams.get('error_description')
    || hash.get('error_description')
    || url.searchParams.get('error')
    || hash.get('error')

  if (authError) {
    error.value = authError
    status.value = 'failed'
    return
  }

  try {
    if (code) {
      const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)
      if (exchangeError) throw exchangeError
    } else if (accessToken && refreshToken) {
      const { error: sessionError } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken
      })
      if (sessionError) throw sessionError
    } else {
      const { data, error: sessionError } = await supabase.auth.getSession()
      if (sessionError) throw sessionError
      if (!data.session) throw new Error('Confirmation link did not include a valid session token.')
    }

    const { data, error: userError } = await supabase.auth.getUser()
    if (userError) throw userError
    if (!data.user) throw new Error('Confirmed, but no signed-in user session was created.')

    status.value = 'confirmed'
    window.history.replaceState({}, document.title, '/confirm')
    await navigateTo('/')
  } catch (err: any) {
    error.value = err?.message || 'Could not confirm your email.'
    status.value = 'failed'
  }
}

onMounted(finishConfirm)
</script>

<template>
  <div class="grid min-h-screen place-items-center bg-muted">
    <div class="w-full max-w-sm text-center text-sm text-muted">
      <template v-if="status === 'confirming'">
        <UIcon name="i-lucide-loader-2" class="animate-spin text-2xl text-toned" />
        <p class="mt-2">Confirming your session...</p>
      </template>

      <template v-else-if="status === 'failed'">
        <UIcon name="i-lucide-circle-alert" class="text-2xl text-error" />
        <p class="mt-2 text-default">Could not confirm your email.</p>
        <p class="mt-1 text-xs">{{ error }}</p>
        <UButton to="/login" class="mt-4" size="sm" variant="soft">
          Back to sign in
        </UButton>
      </template>
    </div>
  </div>
</template>
