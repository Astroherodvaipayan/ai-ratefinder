<script setup lang="ts">
definePageMeta({ layout: 'default' })

const route = useRoute()
const id = computed(() => route.params.id as string)

interface DocDetail {
  id: string; filename: string; status: string; page_count: number | null
  parsed_markdown: string | null; mime: string | null
  vendor: { id: string; name: string } | null
  items: Array<{
    id: string; raw_name: string; sku: string | null; unit: string | null
    price: number | null; moq: string | null; currency: string
    source_page: number | null
  }>
}

const { data: doc, refresh } = await useFetch<DocDetail>(() => `/api/documents/${id.value}`, {
  default: () => null as any
})

const fileUrl = ref<string | null>(null)
const showSource = ref(false)
async function openSource() {
  const res = await $fetch<{ url: string }>(`/api/documents/${id.value}/file`)
  fileUrl.value = res.url
  showSource.value = true
}

const router = useRouter()
async function destroy() {
  if (!confirm('Delete this document and all its rows?')) return
  await $fetch(`/api/documents/${id.value}`, { method: 'DELETE' })
  router.push('/library')
}

const formatInr = (n: number | null) =>
  n === null ? '' : new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 2
  }).format(n)
</script>

<template>
  <div v-if="doc" class="flex h-full flex-col">
    <header class="flex items-center justify-between border-b border-default px-6 py-4">
      <div class="min-w-0">
        <h1 class="truncate text-base font-semibold">{{ doc.filename }}</h1>
        <p class="text-xs text-muted">
          {{ doc.vendor?.name ?? 'Unassigned vendor' }} ·
          {{ doc.items.length }} items ·
          status: {{ doc.status }}
          <span v-if="doc.page_count"> · {{ doc.page_count }} pages</span>
        </p>
      </div>
      <div class="flex items-center gap-2">
        <UButton size="sm" variant="soft" icon="i-lucide-file-search" @click="openSource">
          View source
        </UButton>
        <UButton size="sm" color="error" variant="soft" icon="i-lucide-trash-2" @click="destroy">
          Delete
        </UButton>
      </div>
    </header>

    <div class="flex flex-1 overflow-hidden">
      <div class="flex-1 overflow-y-auto px-6 py-4">
        <table class="w-full text-sm">
          <thead class="sticky top-0 border-b border-default bg-default text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th class="py-2 pr-3">Product</th>
              <th class="py-2 pr-3">SKU</th>
              <th class="py-2 pr-3">Unit</th>
              <th class="py-2 pr-3">MOQ</th>
              <th class="py-2 pr-3 text-right">Price</th>
              <th class="py-2 pr-3 text-right">Page</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="i in doc.items" :key="i.id" class="border-b border-default">
              <td class="py-1.5 pr-3">{{ i.raw_name }}</td>
              <td class="py-1.5 pr-3 text-muted">{{ i.sku }}</td>
              <td class="py-1.5 pr-3 text-muted">{{ i.unit }}</td>
              <td class="py-1.5 pr-3 text-muted">{{ i.moq }}</td>
              <td class="py-1.5 pr-3 text-right tabular-nums">{{ formatInr(i.price) }}</td>
              <td class="py-1.5 pr-3 text-right text-muted">{{ i.source_page }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!doc.items.length" class="mt-6 text-sm text-muted">
          No rows extracted. The document may be empty or the extractor couldn't find a table.
        </p>
      </div>

      <UModal v-model="showSource">
        <template #content>
          <div class="h-[80vh]">
            <iframe v-if="fileUrl" :src="fileUrl" class="h-full w-full rounded border-0" />
          </div>
        </template>
      </UModal>
    </div>
  </div>
</template>
