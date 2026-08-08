<script setup lang="ts">
const props = defineProps<{
  userId?: string
}>()

const RELEASE_ID = 'catalogue-search-v3-2026-08-08'
const ACTIVE_UNTIL = Date.parse('2026-08-18T00:00:00+05:30')
const open = ref(false)

const updates = [
  {
    icon: 'i-lucide-database',
    title: 'Catalogue updated',
    description: 'Search across 24,888 published, source-backed offers from the active catalogue.'
  },
  {
    icon: 'i-lucide-scan-search',
    title: 'Search V3 is live',
    description: 'Product wording and exact SKUs are handled separately for safer, more reliable matching.'
  },
  {
    icon: 'i-lucide-message-circle-question',
    title: 'Helpful clarification',
    description: 'Choose a brand, grade, construction, SKU, or pack size when more than one offer fits.'
  },
  {
    icon: 'i-lucide-badge-check',
    title: 'Validated on real searches',
    description: 'V3 passed all 71 archived searches with no false product-to-SKU routing.'
  }
]

function localDateKey(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function releaseStorageKey(date = new Date()) {
  return `ratefinder:release-seen:${RELEASE_ID}:${props.userId ?? 'anonymous'}:${localDateKey(date)}`
}

function showIfEligible() {
  if (!import.meta.client || !props.userId || Date.now() >= ACTIVE_UNTIL) {
    open.value = false
    return
  }
  open.value = localStorage.getItem(releaseStorageKey()) !== '1'
}

function dismiss() {
  if (import.meta.client && props.userId) localStorage.setItem(releaseStorageKey(), '1')
  open.value = false
}

function onOpenChange(value: boolean) {
  if (value) open.value = true
  else dismiss()
}

watch(() => props.userId, showIfEligible)
onMounted(showIfEligible)
</script>

<template>
  <UModal
    :open="open"
    title="Catalogue and Search V3 are live"
    description="A larger active catalogue and safer product matching are now available in AI RateFinder."
    :ui="{
      overlay: 'bg-gray-950/60 backdrop-blur-[2px]',
      content: 'sm:max-w-xl',
      header: 'p-5 sm:p-6',
      title: 'text-lg font-semibold tracking-tight sm:text-xl',
      description: 'mt-1.5 max-w-md text-sm leading-6 text-muted',
      close: 'size-11 rounded-lg',
      body: 'px-5 pb-5 sm:px-6 sm:pb-6',
      footer: 'flex-col-reverse items-stretch gap-3 border-t border-default px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6'
    }"
    @update:open="onOpenChange"
  >
    <template #body>
      <div class="mb-5 flex items-center gap-3 rounded-xl bg-primary/8 px-4 py-3 ring-1 ring-inset ring-primary/15">
        <span class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-inverted shadow-sm">
          <UIcon name="i-lucide-sparkles" class="size-5" aria-hidden="true" />
        </span>
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <p class="font-semibold text-highlighted">Production update</p>
            <UBadge size="sm" color="primary" variant="soft">New</UBadge>
          </div>
          <p class="mt-0.5 text-sm leading-5 text-muted">Active catalogue release: 4 August 2026.</p>
        </div>
      </div>

      <ul class="grid gap-3 sm:grid-cols-2" aria-label="Product updates">
        <li
          v-for="update in updates"
          :key="update.title"
          class="rounded-xl border border-default bg-muted/45 p-4"
        >
          <UIcon :name="update.icon" class="size-5 text-primary" aria-hidden="true" />
          <h3 class="mt-2 text-sm font-semibold text-highlighted">{{ update.title }}</h3>
          <p class="mt-1 text-sm leading-5 text-muted">{{ update.description }}</p>
        </li>
      </ul>
    </template>

    <template #footer>
      <p class="text-center text-xs leading-5 text-muted sm:text-left">
        Shown on your first app visit each day through 17 August 2026.
      </p>
      <UButton
        label="Got it"
        icon="i-lucide-check"
        size="md"
        class="min-h-11 justify-center rounded-lg px-5"
        @click="dismiss"
      />
    </template>
  </UModal>
</template>
