<script setup lang="ts">
definePageMeta({ layout: 'default' })

const route = useRoute()
const id = computed(() => route.params.id as string)
const user = useSupabaseUser()

interface CardItem {
  kind?: 'offer' | 'search_notice'
  requested_query?: string
  corrected_query?: string | null
  match_state?: 'exact' | 'ambiguous' | 'absent'
  match_method?: 'sku' | 'facets' | 'none'
  understood_facets?: Record<string, string | number | boolean>
  missing_facets?: string[]
  suggestions?: SearchSuggestion[]
  refinements?: SearchRefinement[]
  catalog_offer_id?: string | null
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
  variant_label?: string | null
  price_basis?: PriceBasis | null
  requested_quantity?: RequestedQuantity | null
  alternatives?: CandidateAlternative[]
}
interface SearchSuggestion {
  label: string
  query: string
  reason: 'sku' | 'spelling' | 'closest' | 'refinement'
  sku?: string | null
}
interface SearchRefinement {
  facet: string
  options: Array<{ label: string, value: string | number | boolean, query: string }>
}
interface ComposerSuggestion {
  id: string
  label: string
  query: string
  sku: string | null
  brand: string | null
  category: string
  amount: number
  basis: string | null
}
interface PriceBasis {
  source_price: number
  source_basis_quantity: number
  source_basis_unit: string | null
  source_basis_pack_unit: string | null
  source_basis_label: string | null
  effective_unit_price: number
  effective_unit: string | null
}
interface RequestedQuantity {
  value: number
  unit: string | null
  raw: string
}
interface CandidateAlternative {
  catalog_offer_id?: string | null
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
  variant_label?: string | null
  price_basis?: PriceBasis | null
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
const exporting = ref(false)
const toast = useToast()

const input = ref('')
const sending = ref(false)
const composerSuggestions = ref<ComposerSuggestion[]>([])
const suggestionsLoading = ref(false)
const activeSuggestionIndex = ref(-1)
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
  composerSuggestions.value = []
  activeSuggestionIndex.value = -1
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
  if (composerSuggestions.value.length) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      activeSuggestionIndex.value = (activeSuggestionIndex.value + 1) % composerSuggestions.value.length
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      activeSuggestionIndex.value = activeSuggestionIndex.value <= 0
        ? composerSuggestions.value.length - 1
        : activeSuggestionIndex.value - 1
      return
    }
    if (event.key === 'Escape') {
      composerSuggestions.value = []
      activeSuggestionIndex.value = -1
      return
    }
    if (event.key === 'Enter' && activeSuggestionIndex.value >= 0) {
      event.preventDefault()
      void chooseComposerSuggestion(composerSuggestions.value[activeSuggestionIndex.value]!)
      return
    }
  }
  if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
  event.preventDefault()
  send()
}

let suggestionTimer: ReturnType<typeof setTimeout> | null = null
let suggestionRequest = 0
watch(input, (value) => {
  if (suggestionTimer) clearTimeout(suggestionTimer)
  const query = value.trim()
  if (sending.value || query.length < 2) {
    composerSuggestions.value = []
    activeSuggestionIndex.value = -1
    return
  }
  const request = ++suggestionRequest
  suggestionTimer = setTimeout(async () => {
    suggestionsLoading.value = true
    try {
      const response = await $fetch<{ suggestions: ComposerSuggestion[] }>('/api/catalog/suggestions', {
        query: {
          q: query,
          vendor_id: selectedVendorId.value || undefined,
          document_id: selectedDocumentId.value || undefined
        }
      })
      if (request !== suggestionRequest) return
      composerSuggestions.value = response.suggestions
      activeSuggestionIndex.value = -1
    } catch {
      if (request === suggestionRequest) composerSuggestions.value = []
    } finally {
      if (request === suggestionRequest) suggestionsLoading.value = false
    }
  }, 220)
})

async function chooseComposerSuggestion(suggestion: ComposerSuggestion) {
  input.value = suggestion.query
  composerSuggestions.value = []
  activeSuggestionIndex.value = -1
  await nextTick()
  await send()
}

async function submitSearchQuery(query: string) {
  input.value = query
  await nextTick()
  await send()
}

function prettyFacet(value: string) {
  return value.replace(/_/g, ' ')
}

function facetChip(name: string, value: string | number | boolean) {
  if (name === 'current_a') return `${value}A`
  if (name === 'size_sqmm') return `${value} sqmm`
  if (name === 'cores') return `${value} core`
  if (name === 'poles') return `${value} pole`
  if (name === 'pairs') return `${value} pair`
  if (name === 'modules') return `${value} module`
  if (name === 'ways') return `${value} way`
  if (name === 'breaking_capacity_ka') return `${value}kA`
  if (name === 'curve') return `${value} curve`
  return String(value)
}

function noticeSuggestions(item: CardItem) {
  return (item.suggestions ?? []).filter(suggestion => suggestion.reason !== 'spelling')
}

function scrollToBottom() {
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
}

const showAddMenu = ref<string | null>(null) // doc_item_id
const newQuotationTitle = ref('')
const reviewConfirmation = ref<{ item: CardItem, quotationId: string | null } | null>(null)
const confirmingReview = ref(false)

const reviewDestination = computed(() => {
  const quotationId = reviewConfirmation.value?.quotationId
  if (!quotationId) return newQuotationTitle.value.trim() || 'New quotation'
  return quotations.value.find(quotation => quotation.id === quotationId)?.title || 'Selected quotation'
})

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
    catalog_offer_id: alternative.catalog_offer_id,
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
    variant_label: alternative.variant_label ?? null,
    price_basis: alternative.price_basis ?? null,
    requested_quantity: base.requested_quantity ?? null
  }
}

function quoteQuantity(item: Pick<CardItem, 'requested_quantity'>) {
  return item.requested_quantity?.value && Number.isFinite(item.requested_quantity.value)
    ? item.requested_quantity.value
    : 1
}

async function addToQuotation(item: CardItem, quotationId: string | null, reviewConfirmed = false) {
  if (!item.catalog_offer_id && !item.doc_price_item_id && !item.doc_item_id) {
    error.value = 'This price candidate has no source record and cannot be added.'
    return
  }
  if (item.confidence < 0.65 && !item.needs_review) {
    error.value = 'This candidate is below the quotation threshold. Open the source or choose a stronger alternative before adding it.'
    return
  }
  if (!isQuoteReady(item) && !reviewConfirmed) {
    reviewConfirmation.value = { item, quotationId }
    return
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
    body: item.catalog_offer_id
      ? { catalog_offer_id: item.catalog_offer_id, qty: quoteQuantity(item), requested_unit: item.requested_quantity?.unit ?? null, review_confirmed: !isQuoteReady(item) }
      : item.doc_price_item_id
        ? { doc_price_item_id: item.doc_price_item_id, qty: quoteQuantity(item), requested_unit: item.requested_quantity?.unit ?? null, review_confirmed: !isQuoteReady(item) }
        : { doc_item_id: item.doc_item_id, qty: quoteQuantity(item), requested_unit: item.requested_quantity?.unit ?? null, review_confirmed: !isQuoteReady(item) }
  })
  showAddMenu.value = null
  // Light toast via console for now
  console.info('Added', item.product_name, 'to quotation', qid)
}

function closeReviewConfirmation() {
  if (!confirmingReview.value) reviewConfirmation.value = null
}

function onReviewConfirmationOpenChange(value: boolean) {
  if (!value) closeReviewConfirmation()
}

async function confirmReviewAddition() {
  const pending = reviewConfirmation.value
  if (!pending || confirmingReview.value) return

  confirmingReview.value = true
  try {
    await addToQuotation(pending.item, pending.quotationId, true)
    reviewConfirmation.value = null
    toast.add({
      title: 'Added to quotation',
      description: 'The item was added with review confirmation recorded.',
      icon: 'i-lucide-circle-check'
    })
  } catch (err: any) {
    toast.add({
      title: 'Could not add item',
      description: err?.data?.statusMessage || err?.message || 'Please try again.',
      color: 'error',
      icon: 'i-lucide-circle-alert'
    })
  } finally {
    confirmingReview.value = false
  }
}

async function addAlternativeToQuotation(base: CardItem, alternative: CandidateAlternative, quotationId: string | null) {
  if (alternative.confidence < 0.65 && !alternative.needs_review) {
    error.value = 'Low-confidence alternatives cannot be added to a quotation.'
    return
  }
  await addToQuotation(alternativeAsCardItem(base, alternative), quotationId)
}

async function openProforma() {
  if (chat.value?.quotation_id) await navigateTo(`/quotations/${chat.value.quotation_id}`)
}

async function exportCurrentChat() {
  if (!chat.value || exporting.value) return
  exporting.value = true
  try {
    await downloadChatExport(chat.value.id, chat.value.title)
    toast.add({
      title: 'Chat export ready',
      description: `“${chat.value.title}” downloaded.`,
      icon: 'i-lucide-circle-check'
    })
  } catch (err: any) {
    toast.add({
      title: 'Export failed',
      description: err?.message || 'Please try again.',
      color: 'error',
      icon: 'i-lucide-circle-alert'
    })
  } finally {
    exporting.value = false
  }
}

function sourceHref(item: Pick<CardItem, 'doc_price_item_id' | 'doc_item_id'>) {
  const sourceId = item.doc_price_item_id || item.doc_item_id
  return sourceId ? `/source/${sourceId}` : null
}

function formatMoney(n: number | null, _currency = 'INR') {
  if (n === null) return '—'
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2
  }).format(n)
}

const sourceLabel = (item: CardItem) =>
  [item.source_document, item.source_page ? `p.${item.source_page}` : null]
    .filter(Boolean)
    .join(' · ') || '—'

const quantityLabel = (item: Pick<CardItem, 'requested_quantity'>) =>
  item.requested_quantity
    ? `${new Intl.NumberFormat('en-IN').format(item.requested_quantity.value)} ${item.requested_quantity.unit ?? ''}`.trim()
    : null

const sourceRateBasis = (item: Pick<CardItem, 'unit' | 'price_basis'>) =>
  item.price_basis?.source_basis_label || item.unit || null

const effectiveRateLabel = (item: Pick<CardItem, 'price' | 'currency' | 'price_basis'>) => {
  const basis = item.price_basis
  if (!basis?.effective_unit || !item.price) return null
  if (basis.source_basis_quantity === 1 && basis.effective_unit_price === item.price) return null
  return `${formatMoney(basis.effective_unit_price, item.currency)} / ${basis.effective_unit}`
}

const confidenceLabel = (confidence: number) => `${Math.round(confidence * 100)}%`

const hasRawSecondCheck = (item: Pick<CardItem, 'match_explanation'>) =>
  Boolean(item.match_explanation?.toLowerCase().includes('raw document second-check'))

function reviewSummary(item: CardItem) {
  if (!item.needs_review) return item.match_explanation || null
  if (hasRawSecondCheck(item)) {
    return 'Indexed price row matched, and raw document text supports it.'
  }
  return 'Confirm the source row before adding this to a quotation.'
}

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
  if (suggestionTimer) clearTimeout(suggestionTimer)
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
            icon="i-lucide-download"
            :loading="exporting"
            :disabled="exporting || !chat"
            aria-label="Export this chat"
            @click="exportCurrentChat"
          >
            <span class="hidden sm:inline">Export</span>
          </UButton>
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
            <template
              v-for="it in m.items"
              :key="it.catalog_offer_id || it.doc_price_item_id || it.doc_item_id || `${it.kind}-${it.requested_query}-${it.product_name}`"
            >
              <aside
                v-if="it.kind === 'search_notice'"
                class="rounded-xl border border-primary/25 bg-primary/5 p-4 text-sm lg:col-span-2"
                :aria-label="it.product_name"
              >
                <div class="flex items-start gap-3">
                  <span class="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                    <UIcon :name="it.match_state === 'absent' ? 'i-lucide-search-x' : 'i-lucide-list-filter'" />
                  </span>
                  <div class="min-w-0 flex-1">
                    <h3 class="font-semibold text-highlighted">{{ it.product_name }}</h3>
                    <p v-if="it.match_explanation" class="mt-1 leading-5 text-muted">
                      {{ it.match_explanation }}
                    </p>

                    <div v-if="Object.keys(it.understood_facets ?? {}).length" class="mt-3">
                      <p class="text-xs font-medium text-toned">Understood</p>
                      <div class="mt-2 flex flex-wrap gap-2">
                        <UBadge
                          v-for="(value, name) in it.understood_facets"
                          :key="name"
                          color="primary"
                          variant="subtle"
                          size="sm"
                        >
                          {{ facetChip(String(name), value) }}
                        </UBadge>
                      </div>
                    </div>

                    <p v-if="it.corrected_query" class="mt-3 text-xs text-toned">
                      Showing corrected wording:
                      <button
                        type="button"
                        class="min-h-11 rounded-md px-2 font-semibold text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                        @click="submitSearchQuery(it.corrected_query!)"
                      >
                        {{ it.corrected_query }}
                      </button>
                    </p>

                    <div v-for="refinement in it.refinements ?? []" :key="refinement.facet" class="mt-3">
                      <p class="text-xs font-medium capitalize text-toned">
                        Choose {{ prettyFacet(refinement.facet) }}
                      </p>
                      <div class="mt-2 flex flex-wrap gap-2">
                        <UButton
                          v-for="option in refinement.options"
                          :key="`${refinement.facet}-${option.value}`"
                          type="button"
                          size="sm"
                          variant="soft"
                          color="primary"
                          class="min-h-11"
                          @click="submitSearchQuery(option.query)"
                        >
                          {{ option.label }}
                        </UButton>
                      </div>
                    </div>

                    <div v-if="noticeSuggestions(it).length" class="mt-3">
                      <p class="text-xs font-medium text-toned">Did you mean</p>
                      <div class="mt-2 grid gap-2 sm:grid-cols-2">
                        <button
                          v-for="suggestion in noticeSuggestions(it)"
                          :key="suggestion.query"
                          type="button"
                          class="min-h-11 rounded-lg border border-default bg-default px-3 py-2 text-left text-xs leading-5 text-highlighted transition hover:border-primary/50 hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                          @click="submitSearchQuery(suggestion.query)"
                        >
                          {{ suggestion.label }}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </aside>
            <article
              v-else
              class="rounded-xl border border-default/70 bg-default/95 p-4 text-sm shadow-sm"
            >
              <div class="flex items-start justify-between gap-3">
                <h3 class="min-w-0 text-sm font-medium leading-5">{{ it.product_name }}</h3>
                <div class="flex shrink-0 flex-col items-end gap-1">
                  <UBadge v-if="it.needs_review" color="neutral" variant="soft" size="xs">
                    {{ confidenceLabel(it.confidence) }} match
                  </UBadge>
                  <UBadge :color="it.needs_review ? 'primary' : 'success'" variant="subtle" size="xs">
                    {{ statusLabel(it) }}
                  </UBadge>
                </div>
              </div>

              <div class="mt-3 flex items-baseline gap-2">
                <span class="text-xl font-semibold tabular-nums">{{ formatMoney(it.price, it.currency) }}</span>
                <span class="text-xs text-muted">
                  {{ sourceRateBasis(it) ? `/ ${sourceRateBasis(it)}` : 'unit not stated' }}
                </span>
              </div>
              <p v-if="effectiveRateLabel(it)" class="mt-1 text-xs font-medium text-toned">
                Effective rate: {{ effectiveRateLabel(it) }}
              </p>
              <p v-if="it.variant_label" class="mt-1 text-xs font-medium text-highlighted">
                Variant: {{ it.variant_label }}
              </p>
              <p v-if="quantityLabel(it)" class="mt-1 text-xs text-muted">
                Requested quantity: {{ quantityLabel(it) }}
              </p>

              <div
                v-if="it.needs_review"
                class="mt-3 rounded-lg border border-default/70 bg-muted/40 px-3 py-2 text-xs"
              >
                <div class="flex items-center gap-2 font-medium text-highlighted">
                  <UIcon name="i-lucide-search-check" class="shrink-0 text-toned" />
                  <span>Needs confirmation</span>
                  <UBadge
                    v-if="hasRawSecondCheck(it)"
                    color="success"
                    variant="subtle"
                    size="xs"
                    class="ml-auto"
                  >
                    Source checked
                  </UBadge>
                </div>
                <p class="mt-1 leading-5 text-muted">
                  {{ reviewSummary(it) }}
                </p>
              </div>

              <div class="mt-4 grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
                <div class="min-w-0 rounded-lg bg-muted/40 px-3 py-2">
                  <p class="text-muted">SKU</p>
                  <p class="mt-0.5 break-words font-medium text-highlighted">{{ it.sku ?? '—' }}</p>
                </div>
                <div class="min-w-0 rounded-lg bg-muted/40 px-3 py-2">
                  <p class="text-muted">Vendor</p>
                  <p class="mt-0.5 break-words font-medium text-highlighted">{{ it.vendor }}</p>
                </div>
                <div class="min-w-0 rounded-lg bg-muted/40 px-3 py-2">
                  <p class="text-muted">Source</p>
                  <p class="mt-0.5 break-words font-medium text-highlighted">{{ sourceLabel(it) }}</p>
                </div>
              </div>

              <details class="mt-3 rounded-lg border border-default/70 bg-muted/25 px-3 py-2 text-xs">
                <summary class="flex cursor-pointer select-none items-center justify-between gap-3 font-medium text-toned">
                  <span class="inline-flex items-center gap-2">
                    <UIcon name="i-lucide-list-checks" class="text-muted" />
                    Source details
                  </span>
                  <span class="text-muted">{{ it.matched_table || 'Evidence' }}</span>
                </summary>
                <dl class="mt-3 grid grid-cols-[76px_1fr] gap-y-1.5">
                  <dt class="text-muted">MOQ</dt><dd class="min-w-0 break-words">{{ it.moq ?? '—' }}</dd>
                  <dt class="text-muted">SKU</dt><dd class="min-w-0 break-words">{{ it.sku ?? '—' }}</dd>
                  <dt class="text-muted">Vendor</dt><dd class="min-w-0 break-words">{{ it.vendor }}</dd>
                  <dt class="text-muted">Source</dt><dd class="min-w-0 break-words">{{ sourceLabel(it) }}</dd>
                  <dt v-if="it.variant_label" class="text-muted">Variant</dt>
                  <dd v-if="it.variant_label" class="min-w-0 break-words">{{ it.variant_label }}</dd>
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
              </details>

              <details
                v-if="it.alternatives?.length"
                class="mt-3 rounded-lg border border-default/70 bg-muted/25 px-3 py-2 text-xs"
              >
                <summary class="flex cursor-pointer select-none items-center justify-between gap-3 font-medium text-toned">
                  <span class="inline-flex items-center gap-2">
                    <UIcon name="i-lucide-columns-3" class="text-muted" />
                    Compare rows
                  </span>
                  <span class="text-muted">{{ it.alternatives.length }} options</span>
                </summary>
                <div class="mt-3 space-y-3">
                  <div
                    v-for="alt in it.alternatives"
                    :key="alt.doc_price_item_id || alt.doc_item_id || `${alt.description}-${alt.price}`"
                    class="rounded-md border border-default/60 bg-default/70 p-3"
                  >
                    <div class="flex items-start justify-between gap-3">
                      <p class="min-w-0 leading-5 text-highlighted">{{ alt.description }}</p>
                      <UBadge :color="alt.confidence >= 0.85 ? 'success' : 'neutral'" variant="soft" size="xs">
                        {{ confidenceLabel(alt.confidence) }}
                      </UBadge>
                    </div>
                    <div class="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <span class="font-medium tabular-nums">
                        {{ formatMoney(alt.price, alt.currency) }}
                        <span class="font-normal text-muted">
                          {{ sourceRateBasis(alt) ? `/ ${sourceRateBasis(alt)}` : '' }}
                        </span>
                      </span>
                      <span v-if="effectiveRateLabel(alt)" class="text-xs text-muted">
                        Effective {{ effectiveRateLabel(alt) }}
                      </span>
                      <span v-if="alt.variant_label" class="text-xs font-medium text-toned">
                        Variant: {{ alt.variant_label }}
                      </span>
                      <UDropdownMenu
                        v-if="alt.needs_review || alt.confidence >= 0.65"
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
                          Use this row
                        </UButton>
                      </UDropdownMenu>
                    </div>
                    <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted">
                      <span>
                        {{ [alt.vendor, alt.source_document, alt.source_page ? `p.${alt.source_page}` : null].filter(Boolean).join(' · ') || 'Source not stated' }}
                      </span>
                      <NuxtLink
                        v-if="sourceHref(alt)"
                        :to="sourceHref(alt)!"
                        class="inline-flex items-center gap-1 font-medium text-toned transition hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlighted"
                      >
                        <UIcon name="i-lucide-external-link" />
                        Source
                      </NuxtLink>
                    </div>
                    <p v-if="alt.suggested_query" class="mt-1 text-muted">
                      Did you mean: {{ alt.suggested_query }}
                    </p>
                  </div>
                </div>
              </details>

              <div class="mt-4 flex flex-wrap items-center justify-between gap-2">
                <UDropdownMenu
                  v-if="it.needs_review || it.confidence >= 0.65"
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
                  <UButton size="xs" variant="soft" color="primary" icon="i-lucide-plus">
                    {{ it.needs_review ? 'Confirm & add' : 'Add' }}
                  </UButton>
                </UDropdownMenu>
                <UButton
                  v-else
                  size="xs"
                  variant="soft"
                  color="neutral"
                  icon="i-lucide-lock"
                  disabled
                >
                  Source only
                </UButton>
                <NuxtLink
                  v-if="sourceHref(it)"
                  :to="sourceHref(it)!"
                  class="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted transition hover:bg-muted hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlighted"
                >
                  <UIcon name="i-lucide-external-link" />
                  Source
                </NuxtLink>
              </div>
            </article>
            </template>
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

        <div class="relative rounded-[28px] border border-default bg-default p-2 shadow-md ring-1 ring-inset ring-default/60">
          <div
            v-if="composerSuggestions.length || suggestionsLoading"
            id="catalog-search-suggestions"
            role="listbox"
            aria-label="Catalogue suggestions"
            class="absolute inset-x-0 bottom-full z-30 mb-3 max-h-[min(420px,55vh)] overflow-y-auto rounded-2xl border border-default bg-default p-2 shadow-xl ring-1 ring-default/60"
          >
            <div v-if="suggestionsLoading && !composerSuggestions.length" class="flex min-h-12 items-center gap-2 px-3 text-sm text-muted">
              <UIcon name="i-lucide-loader-2" class="animate-spin" />
              Finding catalogue codes and products…
            </div>
            <button
              v-for="(suggestion, index) in composerSuggestions"
              :id="`catalog-suggestion-${index}`"
              :key="suggestion.id"
              type="button"
              role="option"
              :aria-selected="activeSuggestionIndex === index"
              class="flex min-h-12 w-full items-start justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
              :class="activeSuggestionIndex === index ? 'bg-primary/10' : ''"
              @mousedown.prevent
              @click="chooseComposerSuggestion(suggestion)"
            >
              <span class="min-w-0">
                <span class="block truncate text-sm font-medium text-highlighted">{{ suggestion.label }}</span>
                <span class="mt-0.5 block text-xs capitalize text-muted">{{ prettyFacet(suggestion.category) }}</span>
              </span>
              <span class="shrink-0 text-right">
                <span class="block text-sm font-semibold tabular-nums text-highlighted">{{ formatMoney(suggestion.amount) }}</span>
                <span v-if="suggestion.basis" class="block text-xs text-muted">/ {{ suggestion.basis }}</span>
              </span>
            </button>
          </div>

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
              role="combobox"
              aria-autocomplete="list"
              aria-controls="catalog-search-suggestions"
              :aria-expanded="Boolean(composerSuggestions.length || suggestionsLoading)"
              :aria-activedescendant="activeSuggestionIndex >= 0 ? `catalog-suggestion-${activeSuggestionIndex}` : undefined"
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

    <UModal
      :open="Boolean(reviewConfirmation)"
      title="Add review-required match?"
      description="This result is not quote-ready yet. Confirm that you want to add it for manual review."
      :dismissible="!confirmingReview"
      :ui="{
        overlay: 'bg-gray-950/60 backdrop-blur-[2px]',
        content: 'sm:max-w-lg',
        header: 'p-5 sm:p-6',
        title: 'text-lg font-semibold tracking-tight',
        description: 'mt-1.5 text-sm leading-6 text-muted',
        close: 'size-11 rounded-lg',
        body: 'px-5 pb-5 sm:px-6 sm:pb-6',
        footer: 'flex-col-reverse items-stretch gap-2 border-t border-default px-5 py-4 sm:flex-row sm:justify-end sm:px-6'
      }"
      @update:open="onReviewConfirmationOpenChange"
    >
      <template v-if="reviewConfirmation" #body>
        <div class="rounded-xl border border-warning/30 bg-warning/10 p-4">
          <div class="flex items-start gap-3">
            <span class="grid size-10 shrink-0 place-items-center rounded-lg bg-warning/15 text-warning">
              <UIcon name="i-lucide-triangle-alert" class="size-5" aria-hidden="true" />
            </span>
            <div class="min-w-0">
              <p class="font-semibold text-highlighted">Manual review required</p>
              <p class="mt-1 text-sm leading-6 text-muted">
                Check the cited source before sending this quotation to a customer.
              </p>
            </div>
          </div>
        </div>

        <dl class="mt-4 grid grid-cols-[92px_1fr] gap-x-3 gap-y-2 rounded-xl border border-default bg-muted/35 p-4 text-sm">
          <dt class="text-muted">Product</dt>
          <dd class="min-w-0 break-words font-medium text-highlighted">{{ reviewConfirmation.item.product_name }}</dd>
          <dt class="text-muted">Price</dt>
          <dd class="font-semibold tabular-nums text-highlighted">
            {{ formatMoney(reviewConfirmation.item.price, reviewConfirmation.item.currency) }}
            <span class="font-normal text-muted">
              {{ sourceRateBasis(reviewConfirmation.item) ? `/ ${sourceRateBasis(reviewConfirmation.item)}` : '' }}
            </span>
          </dd>
          <dt class="text-muted">Source</dt>
          <dd class="min-w-0 break-words text-highlighted">{{ sourceLabel(reviewConfirmation.item) }}</dd>
          <dt class="text-muted">Destination</dt>
          <dd class="min-w-0 break-words text-highlighted">{{ reviewDestination }}</dd>
        </dl>

        <NuxtLink
          v-if="sourceHref(reviewConfirmation.item)"
          :to="sourceHref(reviewConfirmation.item)!"
          class="mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-primary transition hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          @click="closeReviewConfirmation"
        >
          <UIcon name="i-lucide-external-link" aria-hidden="true" />
          Open cited source first
        </NuxtLink>
      </template>

      <template #footer>
        <UButton
          label="Cancel"
          color="neutral"
          variant="soft"
          size="md"
          class="min-h-11 justify-center rounded-lg px-5"
          :disabled="confirmingReview"
          @click="closeReviewConfirmation"
        />
        <UButton
          label="Add for review"
          icon="i-lucide-plus"
          color="warning"
          size="md"
          class="min-h-11 justify-center rounded-lg px-5"
          :loading="confirmingReview"
          :disabled="confirmingReview"
          @click="confirmReviewAddition"
        />
      </template>
    </UModal>

    <LazyDocumentUploadModal v-model:open="uploadOpen" @uploaded="onDocumentsUploaded" />
  </div>
</template>
