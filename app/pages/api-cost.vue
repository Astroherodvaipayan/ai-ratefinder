<script setup lang="ts">
import { API_COST_MONTHLY_BUDGET_INR } from '~~/shared/billing'

definePageMeta({ layout: 'default' })

interface UsageSummary {
  month_start: string
  budget_inr: number
  top_up_amount_inr: number
  top_up_total_inr: number
  credit_limit_inr: number
  total_spend_inr: number
  remaining_inr: number
  balance_inr: number
  total_pages: number
  total_requests: number
  is_over_budget: boolean
  requires_payment: boolean
  has_payment_ref: boolean
  payment_refs: Array<{
    id: string
    reference_no: string
    amount_inr: number
    created_at: string
  }>
  rates: Array<{
    mode: string
    label: string
    price_per_1000_pages: number
    price_per_page: number
    pages: number
    requests: number
    spend_inr: number
  }>
}

const defaultUsage = (): UsageSummary => ({
  month_start: new Date().toISOString(),
  budget_inr: API_COST_MONTHLY_BUDGET_INR,
  top_up_amount_inr: API_COST_MONTHLY_BUDGET_INR,
  top_up_total_inr: 0,
  credit_limit_inr: API_COST_MONTHLY_BUDGET_INR,
  total_spend_inr: 0,
  remaining_inr: API_COST_MONTHLY_BUDGET_INR,
  balance_inr: API_COST_MONTHLY_BUDGET_INR,
  total_pages: 0,
  total_requests: 0,
  is_over_budget: false,
  requires_payment: false,
  has_payment_ref: false,
  payment_refs: [],
  rates: []
})

const { data: usageData, refresh, pending } = useFetch<UsageSummary>('/api/billing/usage', {
  default: defaultUsage,
  lazy: true
})
const usage = computed(() => usageData.value ?? defaultUsage())

const paymentOpen = ref(false)
const displayedParserRateInr = 0.61

const budgetPercent = computed(() => {
  const creditLimit = usage.value.credit_limit_inr || usage.value.budget_inr || API_COST_MONTHLY_BUDGET_INR
  return Math.min(100, Math.round((usage.value.total_spend_inr / creditLimit) * 100))
})

function formatInr(value: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2
  }).format(value)
}

function monthLabel(value: string) {
  return new Intl.DateTimeFormat('en-IN', {
    month: 'long',
    year: 'numeric'
  }).format(new Date(value))
}

function onPaid() {
  void refresh()
}

function refreshUsage() {
  void refresh()
}

watch(
  () => usage.value.requires_payment,
  (requiresPayment) => {
    if (requiresPayment) paymentOpen.value = true
  },
  { immediate: true }
)
</script>

<template>
  <div class="flex h-full flex-col overflow-y-auto bg-default">
    <header class="border-b border-default px-6 py-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 class="text-base font-semibold text-highlighted">API Cost</h1>
          <p class="mt-1 text-sm text-muted">
            Monthly parser usage for {{ monthLabel(usage.month_start) }}.
          </p>
        </div>
        <div class="flex items-center gap-2">
          <UButton
            icon="i-lucide-refresh-cw"
            variant="soft"
            :loading="pending"
            @click="refreshUsage"
          >
            Refresh
          </UButton>
          <UButton
            v-if="usage.requires_payment"
            color="primary"
            icon="i-lucide-qr-code"
            @click="paymentOpen = true"
          >
            Top up to continue
          </UButton>
        </div>
      </div>
    </header>

    <main class="mx-auto w-full max-w-6xl space-y-6 px-6 py-6">
      <section class="grid gap-4 md:grid-cols-2">
        <div class="rounded-[24px] border border-default bg-default p-6 shadow-sm">
          <p class="text-sm font-medium text-muted">Total Spend</p>
          <p class="mt-5 text-4xl font-semibold tracking-tight text-highlighted tabular-nums">
            {{ formatInr(usage.total_spend_inr) }}
          </p>
        </div>
        <div class="rounded-[24px] border border-default bg-default p-6 shadow-sm">
          <p class="text-sm font-medium text-muted">No. of Pages</p>
          <p class="mt-5 text-4xl font-semibold tracking-tight text-highlighted tabular-nums">
            {{ usage.total_pages }}
          </p>
          <p class="mt-2 text-sm text-muted">{{ formatInr(displayedParserRateInr) }} per page</p>
        </div>
      </section>

      <section class="rounded-xl border border-default bg-default p-5 shadow-sm">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 class="text-sm font-semibold text-highlighted">API Credit</h2>
            <p class="mt-1 text-sm text-muted">
              {{ formatInr(usage.total_spend_inr) }} used of {{ formatInr(usage.credit_limit_inr) }} available.
              {{ usage.requires_payment ? `Top up ${formatInr(usage.top_up_amount_inr)} to continue.` : `${formatInr(usage.remaining_inr)} balance remaining.` }}
            </p>
          </div>
          <UBadge :color="usage.requires_payment ? 'error' : 'success'" variant="soft">
            {{ usage.requires_payment ? 'Top up required' : 'Uploads enabled' }}
          </UBadge>
        </div>
        <UProgress class="mt-4" :model-value="budgetPercent" :color="budgetPercent >= 100 ? 'error' : 'primary'" />
        <div class="mt-4 grid gap-3 text-sm sm:grid-cols-3">
          <div class="rounded-lg border border-default p-3">
            <p class="text-xs text-muted">Monthly credit</p>
            <p class="mt-1 font-semibold tabular-nums">{{ formatInr(usage.budget_inr) }}</p>
          </div>
          <div class="rounded-lg border border-default p-3">
            <p class="text-xs text-muted">Top-ups recorded</p>
            <p class="mt-1 font-semibold tabular-nums">{{ formatInr(usage.top_up_total_inr) }}</p>
          </div>
          <div class="rounded-lg border border-default p-3">
            <p class="text-xs text-muted">Balance</p>
            <p class="mt-1 font-semibold tabular-nums">{{ formatInr(usage.balance_inr) }}</p>
          </div>
        </div>
      </section>

      <section class="grid gap-4 lg:grid-cols-[260px_1fr]">
        <div class="rounded-xl border border-default bg-default p-5 shadow-sm">
          <h2 class="text-sm font-semibold text-highlighted">Payment QR</h2>
          <div class="mt-4 rounded-xl border border-default bg-white p-3">
            <img src="/billing/payment-qr.jpg" alt="Payment QR code" class="aspect-square w-full object-contain">
          </div>
          <UButton
            class="mt-4"
            block
            icon="i-lucide-plus"
            color="primary"
            variant="soft"
            @click="paymentOpen = true"
          >
            Add reference
          </UButton>
        </div>
        <div class="rounded-xl border border-default bg-default p-5 shadow-sm">
          <h2 class="text-sm font-semibold text-highlighted">Payment References</h2>
          <div v-if="usage.payment_refs.length" class="mt-4 divide-y divide-default rounded-lg border border-default">
            <div
              v-for="ref in usage.payment_refs"
              :key="ref.id"
              class="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
            >
              <div>
                <p class="font-medium text-highlighted">{{ ref.reference_no }}</p>
                <p class="text-xs text-muted">{{ new Date(ref.created_at).toLocaleString('en-IN') }}</p>
              </div>
              <span class="font-semibold tabular-nums">{{ formatInr(ref.amount_inr) }}</span>
            </div>
          </div>
          <p v-else class="mt-4 rounded-lg border border-dashed border-default px-4 py-8 text-center text-sm text-muted">
            No top-up reference has been added for this billing month.
          </p>
        </div>
      </section>
    </main>

    <ApiBudgetPaymentModal
      v-model:open="paymentOpen"
      :usage="usage"
      @paid="onPaid"
    />
  </div>
</template>
