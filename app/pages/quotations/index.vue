<script setup lang="ts">
definePageMeta({ layout: 'default' })

interface Quotation {
  id: string; title: string; customer: string | null; status: string
  discount_pct: number; gst_pct: number; freight: number
  updated_at: string
}

const { data: quotations, refresh } = useFetch<Quotation[]>('/api/quotations', {
  lazy: true,
  default: () => []
})

const router = useRouter()
const newTitle = ref('')
const deletingId = ref<string | null>(null)
const deleteError = ref('')

async function createQuotation() {
  const q = await $fetch<Quotation>('/api/quotations', {
    method: 'POST',
    body: { title: newTitle.value.trim() || 'New quotation' }
  })
  newTitle.value = ''
  quotations.value = [q, ...quotations.value]
  void refresh()
  router.push(`/quotations/${q.id}`)
}

async function deleteQuotation(q: Quotation) {
  if (!confirm(`Delete "${q.title}"?`)) return

  deletingId.value = q.id
  deleteError.value = ''
  try {
    await $fetch(`/api/quotations/${q.id}`, { method: 'DELETE' })
    quotations.value = quotations.value.filter(item => item.id !== q.id)
    void refresh()
  } catch (err: any) {
    deleteError.value = err?.statusMessage || err?.message || 'Could not delete quotation.'
  } finally {
    deletingId.value = null
  }
}

const statusColor = (s: string) =>
  s === 'sent' ? 'success' : s === 'archived' ? 'neutral' : 'warning'
</script>

<template>
  <div class="flex h-full flex-col">
    <header class="flex items-center justify-between border-b border-default px-6 py-4">
      <h1 class="text-base font-semibold">Quotations</h1>
      <div class="flex items-center gap-2">
        <UInput v-model="newTitle" placeholder="Title" size="sm" class="w-56" />
        <UButton icon="i-lucide-plus" size="sm" @click="createQuotation">New</UButton>
      </div>
    </header>

    <div class="flex-1 overflow-y-auto px-6 py-4">
      <p v-if="deleteError" class="mb-3 text-sm text-error">{{ deleteError }}</p>
      <p v-if="!quotations.length" class="text-sm text-muted">
        No quotations yet. Add items from chat or start one here.
      </p>
      <ul v-else class="space-y-2">
        <li v-for="q in quotations" :key="q.id">
          <div class="flex items-center gap-2 rounded-lg border border-default px-3 py-3 transition hover:bg-accented">
            <NuxtLink
              :to="`/quotations/${q.id}`"
              class="flex min-w-0 flex-1 items-center justify-between gap-3"
            >
              <div class="min-w-0">
                <div class="truncate text-sm font-medium">{{ q.title }}</div>
                <div class="truncate text-xs text-muted">
                  {{ q.customer ?? 'No customer' }} ·
                  disc {{ q.discount_pct }}% · GST {{ q.gst_pct }}%
                </div>
              </div>
              <UBadge :color="statusColor(q.status)" variant="soft" class="shrink-0">{{ q.status }}</UBadge>
            </NuxtLink>
            <UButton
              size="sm"
              color="error"
              variant="soft"
              icon="i-lucide-trash-2"
              :loading="deletingId === q.id"
              :disabled="Boolean(deletingId)"
              :aria-label="`Delete ${q.title}`"
              title="Delete quotation"
              @click="deleteQuotation(q)"
            />
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>
