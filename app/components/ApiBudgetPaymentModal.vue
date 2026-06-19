<script setup lang="ts">
import { API_COST_MONTHLY_BUDGET_INR } from '~~/shared/billing'

interface BillingUsage {
  budget_inr: number
  top_up_amount_inr?: number
  credit_limit_inr?: number
  total_spend_inr: number
  remaining_inr?: number
  balance_inr?: number
  requires_payment?: boolean
  total_pages: number
  total_requests: number
}

const open = defineModel<boolean>('open', { default: false })
const props = defineProps<{
  usage?: BillingUsage | null
}>()
const emit = defineEmits<{
  paid: []
}>()

const referenceNo = ref('')
const submitting = ref(false)
const error = ref('')

const budget = computed(() => props.usage?.budget_inr ?? API_COST_MONTHLY_BUDGET_INR)
const topUpAmount = computed(() => props.usage?.top_up_amount_inr ?? API_COST_MONTHLY_BUDGET_INR)
const creditLimit = computed(() => props.usage?.credit_limit_inr ?? budget.value)
const spend = computed(() => props.usage?.total_spend_inr ?? 0)
const balance = computed(() => props.usage?.balance_inr ?? props.usage?.remaining_inr ?? Math.max(0, creditLimit.value - spend.value))
const overage = computed(() => Math.max(0, -balance.value))
const requiresPayment = computed(() => props.usage?.requires_payment ?? balance.value <= 0)

function formatInr(value: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2
  }).format(value)
}

async function submitReference() {
  error.value = ''
  const reference = referenceNo.value.trim()
  if (reference.length < 3) {
    error.value = 'Enter the payment reference number.'
    return
  }

  submitting.value = true
  try {
    await $fetch('/api/billing/payment-ref', {
      method: 'POST',
      body: {
        reference_no: reference,
        amount_inr: topUpAmount.value
      }
    })
    referenceNo.value = ''
    open.value = false
    emit('paid')
  } catch (err: any) {
    error.value = err?.statusMessage || err?.message || 'Could not save payment reference.'
  } finally {
    submitting.value = false
  }
}

watch(open, (value) => {
  if (value) error.value = ''
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-[60] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="api-budget-title"
    >
      <div class="absolute inset-0 bg-black/45 backdrop-blur-[2px]" @click="open = false" />
      <div class="relative w-full max-w-lg rounded-2xl border border-default bg-default p-6 shadow-xl">
        <div class="flex items-start justify-between gap-3">
          <div>
            <h2 id="api-budget-title" class="text-base font-semibold text-highlighted">
              {{ requiresPayment ? 'API credit exhausted' : 'Add API top-up reference' }}
            </h2>
            <p class="mt-1 text-sm text-muted">
              {{ requiresPayment ? 'Uploads are paused until a top-up reference is added.' : 'Record a payment reference for this billing month.' }}
            </p>
          </div>
          <UButton icon="i-lucide-x" variant="ghost" size="sm" aria-label="Close" @click="open = false" />
        </div>

        <div class="mt-5 grid gap-5 sm:grid-cols-[180px_1fr]">
          <div class="rounded-xl border border-default bg-white p-3">
            <img src="/billing/payment-qr.jpg" alt="Payment QR code" class="aspect-square w-full object-contain">
          </div>
          <div class="space-y-4">
            <div class="grid grid-cols-2 gap-2 text-sm">
              <div class="rounded-lg border border-default p-3">
                <p class="text-xs text-muted">Top-up amount</p>
                <p class="mt-1 font-semibold tabular-nums">{{ formatInr(topUpAmount) }}</p>
              </div>
              <div class="rounded-lg border border-default p-3">
                <p class="text-xs text-muted">Used</p>
                <p class="mt-1 font-semibold tabular-nums">{{ formatInr(spend) }}</p>
              </div>
              <div class="rounded-lg border border-default p-3">
                <p class="text-xs text-muted">Available credit</p>
                <p class="mt-1 font-semibold tabular-nums">{{ formatInr(creditLimit) }}</p>
              </div>
              <div class="rounded-lg border border-default p-3">
                <p class="text-xs text-muted">{{ requiresPayment ? 'Shortfall' : 'Balance' }}</p>
                <p class="mt-1 font-semibold tabular-nums">{{ formatInr(requiresPayment ? overage : balance) }}</p>
              </div>
            </div>

            <UFormField label="Payment reference number" :error="error">
              <UInput
                v-model="referenceNo"
                placeholder="UPI / bank reference no."
                :disabled="submitting"
                @keydown.enter.prevent="submitReference"
              />
            </UFormField>
            <UButton
              block
              color="primary"
              :loading="submitting"
              icon="i-lucide-check"
              @click="submitReference"
            >
              Save reference and continue
            </UButton>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
