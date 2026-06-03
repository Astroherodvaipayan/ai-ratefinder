<script setup lang="ts">
import { hasAuthSession, navigateAfterAuth, waitForAuthSession } from '~/composables/useAuthSession'

definePageMeta({ layout: false })

const supabase = useSupabaseClient()
const email = ref('')
const password = ref('')
const error = ref<string | null>(null)
const loading = ref(false)
const showPassword = ref(false)
const emailTouched = ref(false)
const passwordTouched = ref(false)

const normalizedEmail = computed(() => email.value.trim())
const isEmailValid = computed(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail.value))
const passwordRules = computed(() => [
  { label: '8+ characters', met: password.value.length >= 8 },
  { label: 'Letter', met: /[A-Za-z]/.test(password.value) },
  { label: 'Number', met: /\d/.test(password.value) }
])
const passwordScore = computed(() => passwordRules.value.filter(rule => rule.met).length)
const passwordStrengthLabel = computed(() => {
  if (!password.value) return 'Required'
  if (passwordScore.value === 3) return 'Strong'
  if (passwordScore.value === 2) return 'Almost there'
  return 'Too weak'
})
const passwordStrengthClass = computed(() => {
  if (passwordScore.value === 3) return 'bg-highlighted'
  if (passwordScore.value === 2) return 'bg-primary'
  return 'bg-error'
})
const emailError = computed(() =>
  emailTouched.value && normalizedEmail.value && !isEmailValid.value
    ? 'Enter a valid work email.'
    : null
)
const passwordError = computed(() =>
  passwordTouched.value && password.value && password.value.length < 8
    ? 'Use at least 8 characters.'
    : null
)
const canSubmit = computed(() =>
  isEmailValid.value && password.value.length >= 8 && !loading.value
)

onMounted(async () => {
  if (await hasAuthSession(supabase)) {
    navigateAfterAuth('/chats')
  }
})

async function submit() {
  emailTouched.value = true
  passwordTouched.value = true
  if (!canSubmit.value) {
    error.value = 'Enter a valid email and an 8+ character password.'
    return
  }

  loading.value = true
  error.value = null

  try {
    await $fetch('/api/auth/signup', {
      method: 'POST',
      body: { email: normalizedEmail.value, password: password.value }
    })

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: normalizedEmail.value,
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
  <div class="min-h-dvh bg-muted px-4 py-6 text-highlighted sm:px-6 lg:px-8">
    <div class="mx-auto grid min-h-[calc(100dvh-48px)] w-full max-w-6xl items-center gap-6 lg:grid-cols-[1fr_440px]">
      <section class="hidden min-h-[560px] flex-col justify-between rounded-lg border border-default bg-default p-8 shadow-sm ring-1 ring-inset ring-default/60 lg:flex">
        <div>
          <NuxtLink to="/login" class="inline-flex items-center gap-2 text-sm font-semibold tracking-tight text-highlighted">
            <BrandLogo size="sm" />
            AI Ratefinder
          </NuxtLink>

          <div class="mt-14 max-w-xl">
            <p class="text-sm font-medium text-toned">Vendor price intelligence</p>
            <h1 class="mt-3 text-4xl font-semibold leading-tight tracking-tight">
              Find rates faster from the documents your team already has.
            </h1>
            <p class="mt-4 max-w-lg text-base leading-7 text-muted">
              Create your workspace, upload price lists, and start asking for cited vendor rates without digging through files.
            </p>
          </div>
        </div>

        <div class="grid gap-3">
          <div class="flex items-start gap-3 rounded-lg border border-default bg-muted px-4 py-3">
            <span class="grid size-9 shrink-0 place-items-center rounded-lg bg-default text-highlighted ring-1 ring-default">
              <UIcon name="i-lucide-file-up" />
            </span>
            <div>
              <p class="text-sm font-medium text-highlighted">Upload vendor lists</p>
              <p class="mt-1 text-sm leading-6 text-muted">Keep PDFs and spreadsheets in one searchable library.</p>
            </div>
          </div>
          <div class="flex items-start gap-3 rounded-lg border border-default bg-muted px-4 py-3">
            <span class="grid size-9 shrink-0 place-items-center rounded-lg bg-default text-highlighted ring-1 ring-default">
              <UIcon name="i-lucide-message-square" />
            </span>
            <div>
              <p class="text-sm font-medium text-highlighted">Ask for exact rates</p>
              <p class="mt-1 text-sm leading-6 text-muted">Search by item, vendor, document, MOQ, or context.</p>
            </div>
          </div>
          <div class="flex items-start gap-3 rounded-lg border border-default bg-muted px-4 py-3">
            <span class="grid size-9 shrink-0 place-items-center rounded-lg bg-default text-highlighted ring-1 ring-default">
              <UIcon name="i-lucide-file-check-2" />
            </span>
            <div>
              <p class="text-sm font-medium text-highlighted">Build quotations</p>
              <p class="mt-1 text-sm leading-6 text-muted">Turn searched rows into cleaner proformas with fewer manual checks.</p>
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
            <p class="text-sm font-medium text-toned">Start your workspace</p>
            <h2 class="mt-2 text-2xl font-semibold tracking-tight text-highlighted">Create your account</h2>
            <p class="mt-2 text-sm leading-6 text-muted">
              Add price documents, search them with AI, and create vendor-ready quotations.
            </p>
          </div>
        </div>

        <form class="space-y-5" novalidate @submit.prevent="submit">
          <div class="space-y-2">
            <label for="signup-email" class="text-sm font-medium text-highlighted">Email</label>
            <div
              class="flex min-h-11 items-center gap-2 rounded-lg border bg-muted px-3 text-sm transition focus-within:border-highlighted focus-within:bg-default focus-within:ring-2 focus-within:ring-highlighted/10"
              :class="emailError ? 'border-error/60' : 'border-default'"
            >
              <UIcon name="i-lucide-mail" class="shrink-0 text-muted" />
              <input
                id="signup-email"
                v-model="email"
                type="email"
                autocomplete="email"
                required
                class="h-11 min-w-0 flex-1 bg-transparent text-highlighted outline-none placeholder:text-muted"
                placeholder="you@company.com"
                :aria-invalid="Boolean(emailError)"
                aria-describedby="signup-email-error"
                @blur="emailTouched = true"
              >
            </div>
            <p v-if="emailError" id="signup-email-error" class="text-xs text-error">{{ emailError }}</p>
          </div>

          <div class="space-y-2">
            <div class="flex items-center justify-between gap-3">
              <label for="signup-password" class="text-sm font-medium text-highlighted">Password</label>
              <span class="text-xs text-muted">{{ passwordStrengthLabel }}</span>
            </div>
            <div
              class="flex min-h-11 items-center gap-2 rounded-lg border bg-muted px-3 text-sm transition focus-within:border-highlighted focus-within:bg-default focus-within:ring-2 focus-within:ring-highlighted/10"
              :class="passwordError ? 'border-error/60' : 'border-default'"
            >
              <UIcon name="i-lucide-lock-keyhole" class="shrink-0 text-muted" />
              <input
                id="signup-password"
                v-model="password"
                :type="showPassword ? 'text' : 'password'"
                minlength="8"
                autocomplete="new-password"
                required
                class="h-11 min-w-0 flex-1 bg-transparent text-highlighted outline-none placeholder:text-muted"
                placeholder="At least 8 characters"
                :aria-invalid="Boolean(passwordError)"
                aria-describedby="signup-password-error signup-password-rules"
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
            <div class="grid grid-cols-3 gap-1" aria-hidden="true">
              <span
                v-for="index in 3"
                :key="index"
                class="h-1 rounded-full transition"
                :class="index <= passwordScore ? passwordStrengthClass : 'bg-accented'"
              />
            </div>
            <div id="signup-password-rules" class="flex flex-wrap gap-2">
              <span
                v-for="rule in passwordRules"
                :key="rule.label"
                class="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs"
                :class="rule.met ? 'border-default bg-muted text-toned' : 'border-default bg-default text-muted'"
              >
                <UIcon :name="rule.met ? 'i-lucide-check' : 'i-lucide-circle'" class="text-[10px]" />
                {{ rule.label }}
              </span>
            </div>
            <p v-if="passwordError" id="signup-password-error" class="text-xs text-error">{{ passwordError }}</p>
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
            Create account
          </UButton>

          <p class="text-center text-sm text-muted">
            Have an account?
            <NuxtLink to="/login" class="font-medium text-highlighted underline-offset-2 hover:underline">
              Sign in
            </NuxtLink>
          </p>
        </form>
      </section>
    </div>
  </div>
</template>
