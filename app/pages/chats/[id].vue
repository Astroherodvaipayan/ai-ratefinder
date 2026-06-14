<script setup lang="ts">
definePageMeta({ layout: 'default' })

const route = useRoute()
const id = computed(() => route.params.id as string)
const user = useSupabaseUser()

interface CardItem {
  doc_item_id: string | null
  doc_price_item_id?: string | null
  product_name: string
  sku: string | null
  unit: string | null
  price: number | null
  moq: string | null
  currency: string
  vendor: string
  source_document?: string
  source_page: number | null
  confidence: number
  needs_review?: boolean
  matched_table?: string | null
  matched_row?: string | null
  matched_column?: string | null
  match_explanation?: string | null
  suggested_query?: string | null
  requested_quantity?: RequestedQuantity | null
  alternatives?: CandidateAlternative[]
}
interface RequestedQuantity {
  value: number
  unit: string | null
  raw: string
}
interface CandidateAlternative {
  doc_item_id: string | null
  doc_price_item_id?: string | null
  description: string
  sku: string | null
  unit: string | null
  price: number
  currency: string
  vendor: string | null
  source_document: string
  source_page: number | null
  confidence: number
  needs_review: boolean
  suggested_query?: string | null
}
interface Message {
  id: string; role: 'user' | 'assistant'
  content: string; items: CardItem[] | null; created_at: string
  quotation_id?: string | null
}
interface Chat { id: string; title: string; quotation_id: string | null }
interface Quotation { id: string; title: string }
interface Doc {
  id: string; filename: string; status: string; created_at: string
  vendor: { id: string; name: string } | null
}

const { data: chat, refresh: refreshChat } = useFetch<Chat | null>(
  () => `/api/chats/${id.value}`,
  { default: () => null, lazy: true, immediate: Boolean(user.value) }
)
const { data: messages, refresh } = useFetch<Message[]>(
  () => `/api/chats/${id.value}/messages`,
  { default: () => [], lazy: true, immediate: Boolean(user.value) }
)
const { data: quotations, refresh: refreshQuotations } = useFetch<Quotation[]>(
  '/api/quotations', { default: () => [], lazy: true, immediate: Boolean(user.value), watch: false }
)
const { data: docs, refresh: refreshDocs } = useFetch<Doc[]>('/api/documents', {
  default: () => [],
  lazy: true,
  immediate: Boolean(user.value),
  watch: false
})

const uploadOpen = ref(false)

const input = ref('')
const sending = ref(false)
const error = ref<string | null>(null)
const scroller = ref<HTMLElement | null>(null)
const composer = ref<HTMLTextAreaElement | null>(null)
const promptIndex = ref(0)
const selectedVendorId = ref('')
const selectedDocumentId = ref('')
const rotatingPrompts = [
  'Ask for a SKU, brand, size, or BOQ line.',
  'Compare rates across vendors with source pages.',
  'Pick a vendor folder, then ask for exact prices.',
  'Add cited rates straight into a proforma invoice.'
]
const vendors = computed(() => {
  const byId = new Map<string, { id: string; name: string }>()
  for (const doc of docs.value) {
    if (doc.vendor) byId.set(doc.vendor.id, doc.vendor)
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
})
const scopedDocs = computed(() =>
  docs.value
    .filter(doc => doc.status === 'parsed')
    .filter(doc => !selectedVendorId.value || doc.vendor?.id === selectedVendorId.value)
)
const selectedVendorLabel = computed(() =>
  vendors.value.find(vendor => vendor.id === selectedVendorId.value)?.name || 'All vendors'
)
const selectedDocumentLabel = computed(() =>
  docs.value.find(doc => doc.id === selectedDocumentId.value)?.filename || 'All documents'
)
const scopeMenuUi = {
  content: 'min-w-[var(--reka-dropdown-menu-trigger-width)] max-w-[min(520px,calc(100vw-32px))] rounded-2xl border border-default/80 bg-default p-1.5 shadow-lg ring-1 ring-default/50',
  viewport: 'max-h-80 overflow-y-auto',
  group: 'p-0.5',
  item: 'rounded-xl px-3 py-2.5 text-sm',
  itemLeadingIcon: 'text-toned',
  itemLabel: 'truncate'
}
const vendorMenuItems = computed(() => [[
  {
    label: 'All vendors',
    icon: 'i-lucide-layers',
    color: 'primary' as const,
    active: !selectedVendorId.value,
    onSelect: () => {
      selectedVendorId.value = ''
      selectedDocumentId.value = ''
    }
  },
  ...vendors.value.map(vendor => ({
    label: vendor.name,
    icon: 'i-lucide-store',
    color: 'primary' as const,
    active: selectedVendorId.value === vendor.id,
    onSelect: () => {
      selectedVendorId.value = vendor.id
    }
  }))
]])
const documentMenuItems = computed(() => [[
  {
    label: 'All documents',
    icon: 'i-lucide-files',
    color: 'primary' as const,
    active: !selectedDocumentId.value,
    onSelect: () => {
      selectedDocumentId.value = ''
    }
  },
  ...scopedDocs.value.map(doc => ({
    label: `${doc.vendor?.name ? `${doc.vendor.name} · ` : ''}${doc.filename}`,
    icon: 'i-lucide-file-text',
    color: 'primary' as const,
    active: selectedDocumentId.value === doc.id,
    onSelect: () => {
      selectedDocumentId.value = doc.id
    }
  }))
]])

watch(selectedVendorId, () => {
  if (selectedDocumentId.value && !scopedDocs.value.some(doc => doc.id === selectedDocumentId.value)) {
    selectedDocumentId.value = ''
  }
})

watch(user, async (value) => {
  if (!value) {
    chat.value = null
    messages.value = []
    quotations.value = []
    docs.value = []
    return
  }

  await Promise.all([
    refreshChat(),
    refresh(),
    refreshQuotations(),
    refreshDocs()
  ])
})

async function send() {
  if (!user.value) {
    await navigateTo('/login')
    return
  }

  const content = input.value.trim()
  if (!content || sending.value) return
  sending.value = true
  error.value = null
  // Optimistic user message
  const optimisticId = 'tmp-' + Date.now()
  messages.value = [
    ...messages.value,
    { id: optimisticId, role: 'user', content, items: null, created_at: new Date().toISOString() }
  ]
  input.value = ''
  await nextTick()
  scrollToBottom()

  try {
    const assistant = await $fetch<Message>(`/api/chats/${id.value}/messages`, {
      method: 'POST',
      body: {
        content,
        vendor_id: selectedVendorId.value || undefined,
        document_id: selectedDocumentId.value || undefined
      }
    })
    messages.value = [...messages.value, assistant]
    if (chat.value?.title === 'New chat') {
      chat.value = { ...chat.value, title: content.slice(0, 60) }
    }
    void Promise.all([
      refreshChat(),
      refreshQuotations(),
      refreshNuxtData('sidebar-chats')
    ])
    await nextTick()
    scrollToBottom()
  } catch (err: any) {
    messages.value = messages.value.filter(message => message.id !== optimisticId)
    error.value = err?.statusMessage || err?.message || 'Failed to send'
  } finally {
    sending.value = false
  }
}

function onComposerKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
  event.preventDefault()
  send()
}

function scrollToBottom() {
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
}

const showAddMenu = ref<string | null>(null) // doc_item_id
const newQuotationTitle = ref('')

function isQuoteReady(item: Pick<CardItem, 'confidence' | 'needs_review'>) {
  return !item.needs_review && item.confidence >= 0.85
}

function statusLabel(item: Pick<CardItem, 'confidence' | 'needs_review'>) {
  if (isQuoteReady(item)) return 'Ready to quote'
  if (item.confidence >= 0.65) return 'Review first'
  return 'Not safe to quote'
}

function messageHasAutoQuotedItems(message: Message) {
  return Boolean(message.items?.some(item => isQuoteReady(item)))
}

function alternativeAsCardItem(base: CardItem, alternative: CandidateAlternative): CardItem {
  return {
    doc_item_id: alternative.doc_item_id,
    doc_price_item_id: alternative.doc_price_item_id,
    product_name: alternative.description,
    sku: alternative.sku,
    unit: alternative.unit,
    price: alternative.price,
    moq: null,
    currency: alternative.currency,
    vendor: alternative.vendor ?? base.vendor,
    source_document: alternative.source_document,
    source_page: alternative.source_page,
    confidence: alternative.confidence,
    needs_review: alternative.needs_review,
    matched_table: null,
    matched_row: null,
    matched_column: null,
    match_explanation: alternative.needs_review
      ? 'Possible match: confirm before adding.'
      : 'Possible match from the uploaded document.',
    requested_quantity: base.requested_quantity ?? null
  }
}

function quoteQuantity(item: Pick<CardItem, 'requested_quantity'>) {
  return item.requested_quantity?.value && Number.isFinite(item.requested_quantity.value)
    ? item.requested_quantity.value
    : 1
}

async function addToQuotation(item: CardItem, quotationId: string | null) {
  if (!item.doc_price_item_id && !item.doc_item_id) {
    error.value = 'This price candidate has no source record and cannot be added.'
    return
  }
  if (!isQuoteReady(item)) {
    const confirmed = window.confirm(
      'This match needs review before it goes into the quotation. Add it anyway?'
    )
    if (!confirmed) return
  }

  let qid = quotationId
  if (!qid) {
    const q = await $fetch<Quotation>('/api/quotations', {
      method: 'POST',
      body: { title: newQuotationTitle.value.trim() || 'New quotation' }
    })
    qid = q.id
    newQuotationTitle.value = ''
    await refreshQuotations()
  }
  await $fetch(`/api/quotations/${qid}/items`, {
    method: 'POST',
    body: item.doc_price_item_id
      ? { doc_price_item_id: item.doc_price_item_id, qty: quoteQuantity(item), review_confirmed: !isQuoteReady(item) }
      : { doc_item_id: item.doc_item_id, qty: quoteQuantity(item), review_confirmed: !isQuoteReady(item) }
  })
  showAddMenu.value = null
  // Light toast via console for now
  console.info('Added', item.product_name, 'to quotation', qid)
}

async function addAlternativeToQuotation(base: CardItem, alternative: CandidateAlternative, quotationId: string | null) {
  if (alternative.confidence < 0.65) {
    error.value = 'Low-confidence alternatives cannot be added to a quotation.'
    return
  }
  await addToQuotation(alternativeAsCardItem(base, alternative), quotationId)
}

async function openProforma() {
  if (chat.value?.quotation_id) await navigateTo(`/quotations/${chat.value.quotation_id}`)
}

function sourceHref(item: Pick<CardItem, 'doc_price_item_id' | 'doc_item_id'>) {
  const sourceId = item.doc_price_item_id || item.doc_item_id
  return sourceId ? `/api/doc_items/${sourceId}/file?redirect=1` : null
}

function formatMoney(n: number | null, currency = 'INR') {
  if (n === null) return '—'
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: currency || 'INR',
      maximumFractionDigits: 2
    }).format(n)
  } catch {
    return `${currency || 'INR'} ${new Intl.NumberFormat('en-IN', {
      maximumFractionDigits: 2
    }).format(n)}`
  }
}

const sourceLabel = (item: CardItem) =>
  [item.source_document, item.source_page ? `p.${item.source_page}` : null]
    .filter(Boolean)
    .join(' · ') || '—'

const quantityLabel = (item: Pick<CardItem, 'requested_quantity'>) =>
  item.requested_quantity
    ? `${new Intl.NumberFormat('en-IN').format(item.requested_quantity.value)} ${item.requested_quantity.unit ?? ''}`.trim()
    : null

const confidenceColor = (c: number) =>
  c >= 0.85 ? 'success' : c >= 0.6 ? 'warning' : 'neutral'

const scopeSummary = computed(() => {
  const doc = docs.value.find(d => d.id === selectedDocumentId.value)
  const vendor = vendors.value.find(v => v.id === selectedVendorId.value)
  if (doc) return doc.filename
  if (vendor) return vendor.name
  return 'All parsed documents'
})
const activePrompt = computed(() => rotatingPrompts[promptIndex.value % rotatingPrompts.length])
let promptTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  scrollToBottom()
  composer.value?.focus()
  promptTimer = setInterval(() => {
    promptIndex.value = (promptIndex.value + 1) % rotatingPrompts.length
  }, 3500)
})
onBeforeUnmount(() => {
  if (promptTimer) clearInterval(promptTimer)
})
watch(messages, () => nextTick(scrollToBottom))

async function onDocumentsUploaded() {
  await refreshDocs()
}
</script>

<template>
  <div class="relative flex h-full min-h-0 flex-col bg-default">
    <header
      v-if="messages.length"
      class="z-10 border-b border-default/70 bg-default/75 px-4 py-3 backdrop-blur-xl sm:px-6"
    >
      <div class="mx-auto flex max-w-5xl items-center justify-between gap-3">
        <div class="min-w-0">
          <h1 class="truncate text-sm font-semibold">Chat with your price library</h1>
          <p class="truncate text-xs text-muted">
            Scope: {{ scopeSummary }}
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <UButton
            size="sm"
            variant="soft"
            color="neutral"
            icon="i-lucide-upload"
            @click="uploadOpen = true"
          >
            Upload
          </UButton>
          <UButton
            v-if="chat?.quotation_id"
            size="sm"
            variant="soft"
            icon="i-lucide-file-text"
            @click="openProforma"
          >
            Open proforma
          </UButton>
        </div>
      </div>
    </header>

    <div
      ref="scroller"
      class="min-h-0 flex-1 overflow-y-auto px-4 py-8 sm:px-6"
      :class="!messages.length ? 'pb-64' : ''"
    >
      <div class="mx-auto flex max-w-4xl flex-col gap-7">
      <div v-for="m in messages" :key="m.id" class="w-full">
        <div v-if="m.role === 'user'" class="flex justify-end">
          <div class="max-w-[82%] whitespace-pre-wrap rounded-[22px] bg-accented px-4 py-2.5 text-sm leading-6 text-highlighted ring-1 ring-inset ring-default sm:max-w-[70%]">
            {{ m.content }}
          </div>
        </div>

        <div v-else class="space-y-4">
          <div class="flex gap-3">
            <div class="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full border border-default/70 bg-default/70 shadow-sm">
              <UIcon name="i-lucide-sparkles" class="text-sm text-toned" />
            </div>
            <div class="min-w-0 flex-1">
              <div class="whitespace-pre-wrap text-sm leading-6 text-highlighted">
                {{ m.content }}
              </div>
            </div>
          </div>

          <div v-if="m.items?.length" class="ml-0 grid grid-cols-1 gap-3 sm:ml-11 lg:grid-cols-2">
            <article
              v-for="it in m.items"
              :key="it.doc_price_item_id || it.doc_item_id || it.product_name"
              class="rounded-2xl border bg-default/90 p-4 text-sm shadow-sm"
              :class="it.needs_review ? 'border-warning/60 ring-1 ring-warning/20' : 'border-default/70'"
            >
              <div class="flex items-start justify-between gap-3">
                <h3 class="min-w-0 text-sm font-medium leading-5">{{ it.product_name }}</h3>
                <div class="flex shrink-0 flex-col items-end gap-1">
                  <UBadge v-if="it.needs_review" :color="confidenceColor(it.confidence)" variant="soft" size="xs">
                    Review
                  </UBadge>
                  <UBadge :color="it.needs_review ? 'warning' : 'success'" variant="subtle" size="xs">
                    {{ statusLabel(it) }}
                  </UBadge>
                </div>
              </div>

              <div class="mt-3 flex items-baseline gap-2">
                <span class="text-xl font-semibold tabular-nums">{{ formatMoney(it.price, it.currency) }}</span>
                <span class="text-xs text-muted">{{ it.unit ?? 'unit not stated' }}</span>
              </div>
              <p v-if="quantityLabel(it)" class="mt-1 text-xs text-muted">
                Requested quantity: {{ quantityLabel(it) }}
              </p>

              <p
                v-if="it.needs_review"
                class="mt-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
              >
                Review required before quotation. This was not auto-added.
              </p>

              <dl class="mt-4 grid grid-cols-[72px_1fr] gap-y-1.5 text-xs">
                <dt class="text-muted">MOQ</dt><dd class="min-w-0 break-words">{{ it.moq ?? '—' }}</dd>
                <dt class="text-muted">SKU</dt><dd class="min-w-0 break-words">{{ it.sku ?? '—' }}</dd>
                <dt class="text-muted">Vendor</dt><dd class="min-w-0 break-words">{{ it.vendor }}</dd>
                <dt class="text-muted">Source</dt><dd class="min-w-0 break-words">{{ sourceLabel(it) }}</dd>
                <dt v-if="it.matched_table" class="text-muted">Table</dt>
                <dd v-if="it.matched_table" class="min-w-0 break-words">{{ it.matched_table }}</dd>
                <dt v-if="it.matched_row || it.matched_column" class="text-muted">Match</dt>
                <dd v-if="it.matched_row || it.matched_column" class="min-w-0 break-words">
                  {{ [it.matched_row, it.matched_column].filter(Boolean).join(' · ') }}
                </dd>
                <dt v-if="it.match_explanation" class="text-muted">Note</dt>
                <dd v-if="it.match_explanation" class="min-w-0 break-words">{{ it.match_explanation }}</dd>
                <dt v-if="it.needs_review && it.suggested_query" class="text-muted">Did you mean</dt>
                <dd v-if="it.needs_review && it.suggested_query" class="min-w-0 break-words">{{ it.suggested_query }}</dd>
              </dl>

              <details
                v-if="it.alternatives?.length"
                class="mt-4 rounded-lg border border-default/70 bg-muted/40 px-3 py-2 text-xs"
              >
                <summary class="cursor-pointer select-none font-medium text-toned">
                  Other possible matches ({{ it.alternatives.length }})
                </summary>
                <div class="mt-3 space-y-3">
                  <div
                    v-for="alt in it.alternatives"
                    :key="alt.doc_price_item_id || alt.doc_item_id || `${alt.description}-${alt.price}`"
                    class="rounded-md border border-default/60 bg-default/70 p-3"
                  >
                    <div class="flex items-start justify-between gap-3">
                      <p class="min-w-0 leading-5 text-highlighted">{{ alt.description }}</p>
                      <UBadge :color="alt.confidence >= 0.85 ? 'success' : 'warning'" variant="soft" size="xs">
                        {{ alt.confidence >= 0.85 ? 'Ready' : 'Review' }}
                      </UBadge>
                    </div>
                    <div class="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <span class="font-medium tabular-nums">
                        {{ formatMoney(alt.price, alt.currency) }}
                        <span class="font-normal text-muted">{{ alt.unit ?? '' }}</span>
                      </span>
                      <UDropdownMenu
                        v-if="alt.confidence >= 0.65"
                        :items="[[
                          ...quotations.map(q => ({
                            label: q.title,
                            icon: 'i-lucide-file-text',
                            onSelect: () => addAlternativeToQuotation(it, alt, q.id)
                          })),
                          { label: 'New quotation…', icon: 'i-lucide-plus',
                            onSelect: () => addAlternativeToQuotation(it, alt, null) }
                        ]]"
                      >
                        <UButton size="xs" variant="ghost" icon="i-lucide-check">
                          Use
                        </UButton>
                      </UDropdownMenu>
                    </div>
                    <p class="mt-1 text-muted">
                      {{ [alt.vendor, alt.source_document, alt.source_page ? `p.${alt.source_page}` : null].filter(Boolean).join(' · ') || 'Source not stated' }}
                    </p>
                    <p v-if="alt.suggested_query" class="mt-1 text-muted">
                      Did you mean: {{ alt.suggested_query }}
                    </p>
                  </div>
                </div>
              </details>

              <div class="mt-4 flex flex-wrap items-center justify-between gap-2">
                <UDropdownMenu
                  :items="[[
                    ...quotations.map(q => ({
                      label: q.title,
                      icon: 'i-lucide-file-text',
                      onSelect: () => addToQuotation(it, q.id)
                    })),
                    { label: 'New quotation…', icon: 'i-lucide-plus',
                      onSelect: () => addToQuotation(it, null) }
                  ]]"
                >
                  <UButton size="xs" variant="soft" :color="it.needs_review ? 'warning' : 'primary'" icon="i-lucide-plus">
                    {{ it.needs_review ? 'Confirm & add' : 'Add' }}
                  </UButton>
                </UDropdownMenu>
                <a
                  v-if="sourceHref(it)"
                  :href="sourceHref(it)!"
                  class="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted transition hover:bg-muted hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlighted"
                >
                  <UIcon name="i-lucide-external-link" />
                  Source
                </a>
              </div>
            </article>
          </div>

          <div
            v-if="messageHasAutoQuotedItems(m) && chat?.quotation_id"
            class="ml-0 flex items-center justify-between gap-3 rounded-2xl border border-default/70 bg-default/90 px-4 py-3 text-xs shadow-sm sm:ml-11"
          >
            <span class="text-muted">Draft proforma invoice updated with these cited items.</span>
            <UButton size="xs" variant="soft" icon="i-lucide-file-text" @click="openProforma">
              Review
            </UButton>
          </div>
        </div>
      </div>

      <div v-if="sending" class="flex items-center gap-3 text-sm text-muted">
        <span class="grid size-8 place-items-center rounded-full border border-default/70 bg-default/70">
          <UIcon name="i-lucide-loader-2" class="animate-spin" />
        </span>
        Searching indexed price rows…
      </div>
      </div>
    </div>

    <footer
      class="px-4 sm:px-6"
      :class="messages.length
        ? 'border-t border-default/70 bg-default/75 py-4 backdrop-blur-xl'
        : 'absolute inset-x-0 top-1/2 z-20 -translate-y-1/2 py-0'"
    >
      <form class="mx-auto max-w-4xl" aria-label="Ask AI Ratefinder" @submit.prevent="send">
        <p
          v-if="!messages.length"
          class="relative mb-8 block -translate-y-[20%] text-center text-lg font-medium tracking-tight text-highlighted transition-opacity"
          aria-live="polite"
        >
          {{ activePrompt }}
        </p>
        <p v-if="error" class="mb-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
          {{ error }}
        </p>

        <div class="rounded-[28px] border border-default bg-default p-2 shadow-md ring-1 ring-inset ring-default/60">
          <div class="flex flex-wrap items-center gap-2 px-1 pb-2 sm:px-2">
            <UButton
              type="button"
              size="sm"
              variant="soft"
              color="neutral"
              icon="i-lucide-upload"
              class="h-10 shrink-0 rounded-full px-3"
              aria-label="Upload documents"
              @click="uploadOpen = true"
            >
              <span class="hidden sm:inline">Upload</span>
            </UButton>

            <UDropdownMenu :items="vendorMenuItems" :ui="scopeMenuUi">
              <button
                type="button"
                class="flex h-10 min-w-0 flex-1 items-center justify-between gap-3 rounded-full border border-default bg-muted px-3 text-left text-xs transition hover:bg-accented focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlighted sm:min-w-44"
                aria-label="Choose vendor scope"
              >
                <span class="flex min-w-0 items-center gap-2">
                  <UIcon name="i-lucide-store" class="shrink-0 text-toned" />
                  <span class="truncate">{{ selectedVendorLabel }}</span>
                </span>
                <UIcon name="i-lucide-chevron-down" class="shrink-0 text-muted" />
              </button>
            </UDropdownMenu>

            <UDropdownMenu :items="documentMenuItems" :ui="scopeMenuUi">
              <button
                type="button"
                class="flex h-10 min-w-0 flex-[1.4] items-center justify-between gap-3 rounded-full border border-default bg-muted px-3 text-left text-xs transition hover:bg-accented focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlighted sm:min-w-56"
                aria-label="Choose document scope"
              >
                <span class="flex min-w-0 items-center gap-2">
                  <UIcon name="i-lucide-file-search" class="shrink-0 text-toned" />
                  <span class="truncate">{{ selectedDocumentLabel }}</span>
                </span>
                <UIcon name="i-lucide-chevron-down" class="shrink-0 text-muted" />
              </button>
            </UDropdownMenu>
          </div>

          <div class="flex items-end gap-2">
            <label for="chat-composer" class="sr-only">Ask about a product, price, MOQ, vendor, or quotation</label>
            <textarea
              id="chat-composer"
              ref="composer"
              v-model="input"
              rows="1"
              class="max-h-36 min-h-12 flex-1 resize-none bg-transparent px-3 py-3 text-sm leading-6 outline-none placeholder:text-muted"
              placeholder="Ask for rates, compare vendors, or build a proforma…"
              :disabled="sending"
              @keydown="onComposerKeydown"
            />
            <UButton
              type="submit"
              :loading="sending"
              :disabled="!input.trim()"
              icon="i-lucide-arrow-up"
              class="mb-1 rounded-full"
              aria-label="Send message"
            />
          </div>
        </div>
      </form>
    </footer>

    <LazyDocumentUploadModal v-model:open="uploadOpen" @uploaded="onDocumentsUploaded" />
  </div>
</template>
