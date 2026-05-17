<script setup lang="ts">
definePageMeta({ layout: 'default' })

interface Quotation {
  id: string; title: string; customer: string | null; status: string
  discount_pct: number; gst_pct: number; freight: number
  updated_at: string
}

const { data: quotations, refresh } = await useFetch<Quotation[]>('/api/quotations', {
  default: () => []
})

const router = useRouter()
const newTitle = ref('')
async function createQuotation() {
  const q = await $fetch<Quotation>('/api/quotations', {
    method: 'POST',
    body: { title: newTitle.value.trim() || 'New quotation' }
  })
  newTitle.value = ''
  await refresh()
  router.push(`/quotations/${q.id}`)
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
      <p v-if="!quotations.length" class="text-sm text-muted">
        No quotations yet. Add items from chat or start one here.
      </p>
      <ul v-else class="space-y-2">
        <li v-for="q in quotations" :key="q.id">
          <NuxtLink
            :to="`/quotations/${q.id}`"
            class="flex items-center justify-between gap-3 rounded-lg border border-default px-4 py-3 hover:bg-accented"
          >
            <div>
              <div class="text-sm font-medium">{{ q.title }}</div>
              <div class="text-xs text-muted">
                {{ q.customer ?? 'No customer' }} ·
                disc {{ q.discount_pct }}% · GST {{ q.gst_pct }}%
              </div>
            </div>
            <UBadge :color="statusColor(q.status)" variant="soft">{{ q.status }}</UBadge>
          </NuxtLink>
        </li>
      </ul>
    </div>
  </div>
</template>
