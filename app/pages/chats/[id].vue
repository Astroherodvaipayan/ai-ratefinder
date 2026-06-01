<script setup lang="ts">
definePageMeta({ layout: 'default' })

const route = useRoute()
const id = computed(() => route.params.id as string)

interface CardItem {
  doc_item_id: string
  product_name: string
  sku: string | null
  unit: string | null
  price: number | null
  moq: string | null
  vendor: string
  source_page: number | null
  confidence: number
}
interface Message {
  id: string; role: 'user' | 'assistant'
  content: string; items: CardItem[] | null; created_at: string
}
interface Quotation { id: string; title: string }

const { data: messages, refresh } = await useFetch<Message[]>(
  () => `/api/chats/${id.value}/messages`,
  { default: () => [] }
)
const { data: quotations, refresh: refreshQuotations } = await useFetch<Quotation[]>(
  '/api/quotations', { default: () => [] }
)

const input = ref('')
const sending = ref(false)
const error = ref<string | null>(null)
const scroller = ref<HTMLElement | null>(null)

async function send() {
  const content = input.value.trim()
  if (!content || sending.value) return
  sending.value = true
  error.value = null
  // Optimistic user message
  messages.value = [
    ...messages.value,
    { id: 'tmp-' + Date.now(), role: 'user', content, items: null, created_at: new Date().toISOString() }
  ]
  input.value = ''
  await nextTick()
  scrollToBottom()

  try {
    await $fetch<Message>(`/api/chats/${id.value}/messages`, {
      method: 'POST', body: { content }
    })
    await refresh()
    await nextTick()
    scrollToBottom()
  } catch (err: any) {
    error.value = err?.statusMessage || err?.message || 'Failed to send'
  } finally {
    sending.value = false
  }
}

function scrollToBottom() {
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
}

const showAddMenu = ref<string | null>(null) // doc_item_id
const newQuotationTitle = ref('')

async function addToQuotation(item: CardItem, quotationId: string | null) {
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
    body: { doc_item_id: item.doc_item_id, qty: 1 }
  })
  showAddMenu.value = null
  // Light toast via console for now
  console.info('Added', item.product_name, 'to quotation', qid)
}

async function viewSource(item: CardItem) {
  const res = await $fetch<{ url: string }>(`/api/doc_items/${item.doc_item_id}/file`)
    .catch(() => null)
  if (res?.url) window.open(res.url, '_blank')
}

const formatInr = (n: number | null) =>
  n === null ? '—' : new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 2
  }).format(n)

const confidenceColor = (c: number) =>
  c >= 0.85 ? 'success' : c >= 0.6 ? 'warning' : 'neutral'

onMounted(scrollToBottom)
watch(messages, () => nextTick(scrollToBottom))
</script>

<template>
  <div class="flex h-full flex-col">
    <header class="border-b border-default px-6 py-3">
      <div class="text-sm font-medium">Chat with your docs</div>
      <div class="text-xs text-muted">Ask a question — answers cite the source doc + page.</div>
    </header>

    <div ref="scroller" class="flex-1 space-y-6 overflow-y-auto px-6 py-6">
      <div
        v-if="!messages.length"
        class="mx-auto mt-12 max-w-md rounded-lg border border-dashed border-default p-6 text-center text-sm text-muted"
      >
        Try: <i>"what is the price of polycab 2.5mm wire?"</i>
      </div>

      <div v-for="m in messages" :key="m.id">
        <!-- USER bubble (right) -->
        <div v-if="m.role === 'user'" class="flex justify-end">
          <div class="max-w-[75%] whitespace-pre-wrap rounded-2xl bg-primary px-4 py-2 text-sm text-inverted">
            {{ m.content }}
          </div>
        </div>

        <!-- ASSISTANT (left) -->
        <div v-else class="space-y-3">
          <div class="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-elevated px-4 py-2 text-sm">
            {{ m.content }}
          </div>

          <div v-if="m.items?.length" class="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <UCard
              v-for="it in m.items"
              :key="it.doc_item_id"
              class="text-sm"
            >
              <template #header>
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0 font-medium">{{ it.product_name }}</div>
                  <UBadge :color="confidenceColor(it.confidence)" variant="soft" size="xs">
                    {{ (it.confidence * 100).toFixed(0) }}%
                  </UBadge>
                </div>
              </template>

              <dl class="grid grid-cols-[80px_1fr] gap-y-1 text-xs">
                <dt class="text-muted">Price</dt>
                <dd class="font-medium">{{ formatInr(it.price) }}</dd>
                <dt class="text-muted">Unit</dt><dd>{{ it.unit ?? '—' }}</dd>
                <dt class="text-muted">MOQ</dt><dd>{{ it.moq ?? '—' }}</dd>
                <dt class="text-muted">SKU</dt><dd>{{ it.sku ?? '—' }}</dd>
                <dt class="text-muted">Vendor</dt><dd>{{ it.vendor }}</dd>
                <dt class="text-muted">Page</dt><dd>{{ it.source_page ?? '—' }}</dd>
              </dl>

              <template #footer>
                <div class="flex items-center justify-between gap-2">
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
                    <UButton size="xs" variant="soft" icon="i-lucide-plus">
                      Add to quotation
                    </UButton>
                  </UDropdownMenu>
                  <UButton size="xs" variant="ghost" icon="i-lucide-external-link" @click="viewSource(it)">
                    View source
                  </UButton>
                </div>
              </template>
            </UCard>
          </div>
        </div>
      </div>

      <div v-if="sending" class="flex items-center gap-2 text-xs text-muted">
        <UIcon name="i-lucide-loader-2" class="animate-spin" />
        Searching your library and asking Gemini…
      </div>
    </div>

    <footer class="border-t border-default bg-elevated px-6 py-4">
      <p v-if="error" class="mb-2 text-xs text-error">{{ error }}</p>
      <form class="flex gap-2" @submit.prevent="send">
        <UInput
          v-model="input"
          placeholder="Ask about a product, price, or MOQ…"
          size="lg"
          class="flex-1"
          :disabled="sending"
        />
        <UButton type="submit" :loading="sending" icon="i-lucide-send">
          Send
        </UButton>
      </form>
    </footer>
  </div>
</template>
