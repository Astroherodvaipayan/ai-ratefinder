<script setup lang="ts">
definePageMeta({ layout: 'default' })

const route = useRoute()
const id = computed(() => route.params.id as string)

interface DocDetail {
  id: string; filename: string; status: string; page_count: number | null
  parsed_markdown: string | null; mime: string | null; parsed_with_internal?: boolean
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
const fileMime = ref<string | null>(null)
const activeView = ref<'source' | 'markdown' | 'rows'>('source')
const reparsing = ref(false)
const reparseError = ref<string | null>(null)

const isImageSource = computed(() => fileMime.value?.startsWith('image/') ?? false)
const isProcessing = computed(() => doc.value && ['uploading', 'ocr', 'extracting'].includes(doc.value.status))
const markdownText = computed(() => doc.value?.parsed_markdown?.trim() || '')

async function loadSource() {
  if (fileUrl.value) return
  const res = await $fetch<{ url: string; mime?: string | null }>(`/api/documents/${id.value}/file`)
  fileUrl.value = res.url
  fileMime.value = res.mime ?? null
}

const router = useRouter()
async function destroy() {
  if (!confirm('Delete this document and all its rows?')) return
  await $fetch(`/api/documents/${id.value}`, { method: 'DELETE' })
  router.push('/library')
}

async function reparseDocument() {
  if (reparsing.value || isProcessing.value) return
  reparsing.value = true
  reparseError.value = null
  try {
    await $fetch(`/api/documents/${id.value}/reparse`, { method: 'POST' })
    await refresh()
    if (!pollTimer) {
      pollTimer = setInterval(async () => {
        await refresh()
        if (!isProcessing.value && pollTimer) {
          clearInterval(pollTimer)
          pollTimer = null
        }
      }, 3000)
    }
  } catch (err: any) {
    reparseError.value = err?.statusMessage || err?.message || 'Reparse failed'
  } finally {
    reparsing.value = false
  }
}

const formatInr = (n: number | null) =>
  n === null ? '' : new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 2
  }).format(n)

let pollTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  loadSource().catch(() => {})
  if (isProcessing.value) {
    pollTimer = setInterval(async () => {
      await refresh()
      if (!isProcessing.value && pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }, 3000)
  }
})

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <div v-if="doc" class="flex h-full flex-col">
    <header class="flex items-center justify-between border-b border-default px-6 py-4">
      <div class="min-w-0">
        <h1 class="flex min-w-0 items-center gap-1.5 text-base font-semibold">
          <UIcon
            v-if="doc.parsed_with_internal"
            name="i-lucide-star"
            class="shrink-0 text-primary"
            aria-label="Parsed internally"
          />
          <span class="truncate">{{ doc.filename }}</span>
        </h1>
        <p class="text-xs text-muted">
          {{ doc.vendor?.name ?? 'Unassigned vendor' }} ·
          {{ doc.items.length }} items ·
          status: {{ doc.status }}
          <span v-if="doc.page_count"> · {{ doc.page_count }} pages</span>
        </p>
      </div>
      <div class="flex items-center gap-2">
        <UButton
          size="sm"
          variant="soft"
          icon="i-lucide-refresh-cw"
          :loading="reparsing"
          :disabled="isProcessing"
          @click="reparseDocument"
        >
          Reparse
        </UButton>
        <UButton size="sm" color="error" variant="soft" icon="i-lucide-trash-2" @click="destroy">
          Delete
        </UButton>
      </div>
    </header>

    <p v-if="reparseError" class="border-b border-error bg-error/10 px-6 py-2 text-xs text-error">
      {{ reparseError }}
    </p>

    <div class="flex flex-1 overflow-hidden">
      <div class="flex flex-1 flex-col overflow-hidden">
        <div class="flex items-center gap-2 border-b border-default px-6 py-3">
          <UButton
            size="sm"
            :variant="activeView === 'source' ? 'solid' : 'ghost'"
            icon="i-lucide-file-search"
            @click="activeView = 'source'; loadSource()"
          >
            Source
          </UButton>
          <UButton
            size="sm"
            :variant="activeView === 'markdown' ? 'solid' : 'ghost'"
            icon="i-lucide-file-code"
            @click="activeView = 'markdown'"
          >
            Document markdown
          </UButton>
          <UButton
            size="sm"
            :variant="activeView === 'rows' ? 'solid' : 'ghost'"
            icon="i-lucide-table-2"
            @click="activeView = 'rows'"
          >
            Extracted rows
          </UButton>
        </div>

        <div class="flex-1 overflow-hidden">
          <div v-if="activeView === 'source'" class="h-full bg-elevated">
            <div v-if="!fileUrl" class="grid h-full place-items-center text-sm text-muted">
              Loading source file...
            </div>
            <img
              v-else-if="isImageSource"
              :src="fileUrl"
              :alt="doc.filename"
              class="mx-auto h-full max-w-full object-contain"
            >
            <iframe
              v-else
              :src="fileUrl"
              class="h-full w-full border-0"
              title="Source document"
            />
          </div>

          <div v-else-if="activeView === 'markdown'" class="h-full overflow-y-auto px-6 py-4">
            <pre
              v-if="markdownText"
              class="whitespace-pre-wrap rounded-lg border border-default bg-elevated p-4 text-xs leading-5"
            >{{ markdownText }}</pre>
            <div v-else class="mt-10 text-sm text-muted">
              <p v-if="isProcessing">
                Reading is still running. This view will fill with markdown as soon as it is saved.
              </p>
              <p v-else>
                No markdown was saved for this document.
              </p>
            </div>
          </div>

          <div v-else class="h-full overflow-y-auto px-6 py-4">
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
              No rows extracted. The source and markdown can still be reviewed from the other tabs.
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
