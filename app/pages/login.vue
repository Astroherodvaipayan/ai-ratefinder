<script setup lang="ts">
import { hasAuthSession, navigateAfterAuth, waitForAuthSession } from '~/composables/useAuthSession'

definePageMeta({ layout: false })

const supabase = useSupabaseClient()
const route = useRoute()
const email = ref('')
const password = ref('')
const error = ref<string | null>(null)
const loading = ref(false)
const showPassword = ref(false)
const emailTouched = ref(false)
const passwordTouched = ref(false)

const normalizedEmail = computed(() => email.value.trim())
const isEmailValid = computed(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail.value))
const emailError = computed(() =>
  emailTouched.value && normalizedEmail.value && !isEmailValid.value
    ? 'Enter a valid email.'
    : null
)
const passwordError = computed(() =>
  passwordTouched.value && !password.value
    ? 'Enter your password.'
    : null
)
const canSubmit = computed(() =>
  isEmailValid.value && Boolean(password.value) && !loading.value
)

function redirectTarget() {
  const redirect = route.query.redirect
  return typeof redirect === 'string' && redirect.startsWith('/')
    ? redirect
    : '/chats'
}

async function postLoginTarget() {
  const target = redirectTarget()
  return target
}

onMounted(async () => {
  if (await hasAuthSession(supabase)) {
    navigateAfterAuth(await postLoginTarget())
  }
})

async function submit() {
  emailTouched.value = true
  passwordTouched.value = true
  if (!canSubmit.value) {
    error.value = 'Enter your email and password to sign in.'
    return
  }

  loading.value = true
  error.value = null
  try {
    const { data, error: err } = await supabase.auth.signInWithPassword({
      email: normalizedEmail.value,
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
  <div class="min-h-dvh bg-muted px-4 py-6 text-highlighted sm:px-6 lg:px-8">
    <div class="mx-auto grid min-h-[calc(100dvh-48px)] w-full max-w-6xl items-center gap-6 lg:grid-cols-[1fr_440px]">
      <section class="hidden min-h-[560px] flex-col justify-between rounded-lg border border-default bg-default p-8 shadow-sm ring-1 ring-inset ring-default/60 lg:flex">
        <div>
          <NuxtLink to="/login" class="inline-flex items-center gap-2 text-sm font-semibold tracking-tight text-highlighted">
            <BrandLogo size="sm" />
            AI Ratefinder
          </NuxtLink>

          <div class="mt-14 max-w-xl">
            <p class="text-sm font-medium text-toned">Back to your workspace</p>
            <h1 class="mt-3 text-4xl font-semibold leading-tight tracking-tight">
              Continue searching vendor rates with your saved context.
            </h1>
            <p class="mt-4 max-w-lg text-base leading-7 text-muted">
              Pick up chats, review parsed documents, and export cleaner proforma invoices from one focused workspace.
            </p>
          </div>
        </div>

        <div class="grid gap-3">
          <div class="flex items-start gap-3 rounded-lg border border-default bg-muted px-4 py-3">
            <span class="grid size-9 shrink-0 place-items-center rounded-lg bg-default text-highlighted ring-1 ring-default">
              <UIcon name="i-lucide-history" />
            </span>
            <div>
              <p class="text-sm font-medium text-highlighted">Resume active chats</p>
              <p class="mt-1 text-sm leading-6 text-muted">Return to quoted items, document scope, and vendor comparisons.</p>
            </div>
          </div>
          <div class="flex items-start gap-3 rounded-lg border border-default bg-muted px-4 py-3">
            <span class="grid size-9 shrink-0 place-items-center rounded-lg bg-default text-highlighted ring-1 ring-default">
              <UIcon name="i-lucide-library" />
            </span>
            <div>
              <p class="text-sm font-medium text-highlighted">Search your library</p>
              <p class="mt-1 text-sm leading-6 text-muted">Use uploaded price lists and vendor documents without reloading them.</p>
            </div>
          </div>
          <div class="flex items-start gap-3 rounded-lg border border-default bg-muted px-4 py-3">
            <span class="grid size-9 shrink-0 place-items-center rounded-lg bg-default text-highlighted ring-1 ring-default">
              <UIcon name="i-lucide-file-output" />
            </span>
            <div>
              <p class="text-sm font-medium text-highlighted">Export proformas</p>
              <p class="mt-1 text-sm leading-6 text-muted">Keep quotations moving with totals, GST, freight, and cited rates.</p>
            </div>
          </div>
        </div>
      </section>

      <section class="mx-auto w-full max-w-md rounded-lg border border-default bg-default p-5 shadow-sm ring-1 ring-inset ring-default/60 sm:p-7">
        <div class="mb-8">
          <NuxtLink to="/login" class="inline-flex items-center gap-2 text-sm font-semibold tracking-tight text-highlighted lg:hidden">
            <BrandLogo size="sm" />
            AI Ratefinder
          </NuxtLink>
          <div class="mt-8 lg:mt-0">
            <p class="text-sm font-medium text-toned">Welcome back</p>
            <h2 class="mt-2 text-2xl font-semibold tracking-tight text-highlighted">Sign in to AI Ratefinder</h2>
            <p class="mt-2 text-sm leading-6 text-muted">
              Open your chats, document library, vendors, and proforma invoices.
            </p>
          </div>
        </div>

        <form class="space-y-5" novalidate @submit.prevent="submit">
          <div class="space-y-2">
            <label for="login-email" class="text-sm font-medium text-highlighted">Email</label>
            <div
              class="flex min-h-11 items-center gap-2 rounded-lg border bg-muted px-3 text-sm transition focus-within:border-highlighted focus-within:bg-default focus-within:ring-2 focus-within:ring-highlighted/10"
              :class="emailError ? 'border-error/60' : 'border-default'"
            >
              <UIcon name="i-lucide-mail" class="shrink-0 text-muted" />
              <input
                id="login-email"
                v-model="email"
                type="email"
                autocomplete="email"
                required
                class="h-11 min-w-0 flex-1 bg-transparent text-highlighted outline-none placeholder:text-muted"
                placeholder="you@company.com"
                :aria-invalid="Boolean(emailError)"
                aria-describedby="login-email-error"
                @blur="emailTouched = true"
              >
            </div>
            <p v-if="emailError" id="login-email-error" class="text-xs text-error">{{ emailError }}</p>
          </div>

          <div class="space-y-2">
            <label for="login-password" class="text-sm font-medium text-highlighted">Password</label>
            <div
              class="flex min-h-11 items-center gap-2 rounded-lg border bg-muted px-3 text-sm transition focus-within:border-highlighted focus-within:bg-default focus-within:ring-2 focus-within:ring-highlighted/10"
              :class="passwordError ? 'border-error/60' : 'border-default'"
            >
              <UIcon name="i-lucide-lock-keyhole" class="shrink-0 text-muted" />
              <input
                id="login-password"
                v-model="password"
                :type="showPassword ? 'text' : 'password'"
                autocomplete="current-password"
                required
                class="h-11 min-w-0 flex-1 bg-transparent text-highlighted outline-none placeholder:text-muted"
                placeholder="Your password"
                :aria-invalid="Boolean(passwordError)"
                aria-describedby="login-password-error"
                @blur="passwordTouched = true"
              >
              <button
                type="button"
                class="grid size-9 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-accented hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlighted"
                :aria-label="showPassword ? 'Hide password' : 'Show password'"
                @click="showPassword = !showPassword"
              >
                <UIcon :name="showPassword ? 'i-lucide-eye-off' : 'i-lucide-eye'" />
              </button>
            </div>
            <p v-if="passwordError" id="login-password-error" class="text-xs text-error">{{ passwordError }}</p>
          </div>

          <div v-if="error" class="flex items-start gap-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2.5 text-sm text-error">
            <UIcon name="i-lucide-circle-alert" class="mt-0.5 shrink-0" />
            <p>{{ error }}</p>
          </div>

          <UButton
            type="submit"
            :loading="loading"
            :disabled="!canSubmit"
            block
            class="h-11 rounded-lg"
          >
            Sign in
          </UButton>

          <p class="text-center text-sm text-muted">
            No account?
            <NuxtLink to="/signup" class="font-medium text-highlighted underline-offset-2 hover:underline">
              Sign up
            </NuxtLink>
          </p>
        </form>
      </section>
    </div>
  </div>
</template>
