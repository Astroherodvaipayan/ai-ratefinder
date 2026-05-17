<script setup lang="ts">
definePageMeta({ layout: 'default' })

const route = useRoute()
const jobId = computed(() => route.params.id as string)

interface Job {
  id: string; kind: string; status: string; title: string
  vendor_id: string | null; source_path: string | null
}
interface Vendor { id: string; name: string }
interface JobMessage {
  id: string; role: 'user' | 'assistant' | 'tool'
  content: string | null; data: any; created_at: string
}

const { data: job, refresh: refreshJob } = await useFetch<Job>(() => `/api/jobs/${jobId.value}`, {
  default: () => null as any
})
const { data: messages, refresh: refreshMessages } = await useFetch<JobMessage[]>(
  () => `/api/jobs/${jobId.value}/messages`,
  { default: () => [] }
)
const { data: vendors, refresh: refreshVendors } = await useFetch<Vendor[]>('/api/vendors', {
  default: () => []
})

const selectedVendor = ref<string | null>(job.value?.vendor_id ?? null)
const newVendorName = ref('')

async function createVendor() {
  if (!newVendorName.value.trim()) return
  const v = await $fetch<Vendor>('/api/vendors', {
    method: 'POST',
    body: { name: newVendorName.value.trim() }
  })
  newVendorName.value = ''
  await refreshVendors()
  selectedVendor.value = v.id
}

const fileInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const uploadError = ref<string | null>(null)

async function handleUpload(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (job.value?.kind === 'ingest_price_list' && !selectedVendor.value) {
    uploadError.value = 'Pick a vendor first.'
    return
  }
  uploadError.value = null
  uploading.value = true

  const form = new FormData()
  form.append('file', file, file.name)

  try {
    // For price-list jobs, persist the vendor on the job first.
    if (job.value?.kind === 'ingest_price_list' && selectedVendor.value && !job.value.vendor_id) {
      await $fetch(`/api/jobs/${jobId.value}`, {
        method: 'PATCH',
        body: { vendor_id: selectedVendor.value }
      })
    }
    await $fetch(`/api/jobs/${jobId.value}/ingest`, { method: 'POST', body: form })
    await Promise.all([refreshJob(), refreshMessages()])
  } catch (err: any) {
    uploadError.value = err?.statusMessage || err?.message || 'Upload failed'
  } finally {
    uploading.value = false
    if (input) input.value = ''
  }
}

async function runMatch() {
  await $fetch('/api/match', { method: 'POST', body: { job_id: jobId.value } })
  await refreshMessages()
}

const needsVendor = computed(() => job.value?.kind === 'ingest_price_list' && !job.value?.vendor_id)
</script>

<template>
  <div v-if="job" class="flex h-full flex-col">
    <header class="flex items-center justify-between border-b border-default px-6 py-3">
      <div>
        <div class="text-sm font-medium">{{ job.title }}</div>
        <div class="text-xs text-muted">
          {{ job.kind.replace(/_/g, ' ') }} · status: {{ job.status }}
        </div>
      </div>
      <UButton
        v-if="job.kind === 'ingest_boq' && job.status === 'ready'"
        size="sm"
        icon="i-lucide-wand-2"
        @click="runMatch"
      >
        Run SKU matcher
      </UButton>
    </header>

    <div class="flex-1 space-y-4 overflow-y-auto px-6 py-6">
      <div
        v-for="m in messages"
        :key="m.id"
        :class="m.role === 'user'
          ? 'ml-auto max-w-[80%] rounded-lg bg-primary/10 px-4 py-2'
          : 'mr-auto max-w-[90%] rounded-lg bg-elevated px-4 py-2'"
      >
        <div class="text-[10px] uppercase tracking-wide text-muted">{{ m.role }}</div>
        <div v-if="m.content" class="whitespace-pre-wrap text-sm">{{ m.content }}</div>

        <div v-if="m.data?.kind === 'price_rows'" class="mt-3">
          <UTable
            :rows="m.data.rows"
            :columns="[
              { key: 'raw_name', label: 'Product' },
              { key: 'sku',      label: 'SKU' },
              { key: 'unit',     label: 'Unit' },
              { key: 'price',    label: 'Price' }
            ]"
          />
        </div>

        <div v-if="m.data?.kind === 'boq_lines'" class="mt-3">
          <UTable
            :rows="m.data.lines"
            :columns="[
              { key: 'line_no',     label: '#' },
              { key: 'description', label: 'Description' },
              { key: 'qty',         label: 'Qty' },
              { key: 'unit',        label: 'Unit' }
            ]"
          />
        </div>

        <div v-if="m.data?.kind === 'match_results'" class="mt-3 space-y-2">
          <div v-for="r in m.data.results" :key="r.id" class="rounded border border-default px-3 py-2">
            <div class="flex items-center justify-between">
              <div class="text-sm">{{ r.query }}</div>
              <UBadge
                :color="r.status === 'auto' ? 'success' : r.status === 'suggested' ? 'warning' : 'neutral'"
                variant="soft"
                size="xs"
              >
                {{ r.status }}
              </UBadge>
            </div>
            <div v-if="r.hits.length" class="mt-1 text-xs text-muted">
              Top: {{ r.hits[0].canonical_name }} (score {{ r.hits[0].score.toFixed(2) }})
            </div>
          </div>
        </div>
      </div>

      <div v-if="!messages.length" class="mx-auto max-w-md rounded-lg border border-dashed border-default p-6 text-center text-sm text-muted">
        Drop a file below to get started.
      </div>
    </div>

    <footer class="border-t border-default bg-elevated px-6 py-4">
      <div v-if="needsVendor" class="mb-3 flex items-end gap-2">
        <USelectMenu
          v-model="selectedVendor"
          :items="vendors"
          value-key="id"
          label-key="name"
          placeholder="Pick a vendor"
          class="w-64"
        />
        <UInput v-model="newVendorName" placeholder="Or create vendor…" class="w-48" />
        <UButton size="sm" variant="soft" @click="createVendor">Create</UButton>
      </div>

      <div class="flex items-center gap-3">
        <input
          ref="fileInput"
          type="file"
          class="hidden"
          accept=".pdf,.png,.jpg,.jpeg,.webp,.xlsx,.xls"
          @change="handleUpload"
        >
        <UButton
          icon="i-lucide-upload"
          :loading="uploading"
          :disabled="needsVendor && !selectedVendor"
          @click="fileInput?.click()"
        >
          Upload {{ job.kind === 'ingest_boq' ? 'BOQ' : 'price list' }}
        </UButton>
        <span v-if="uploadError" class="text-xs text-error">{{ uploadError }}</span>
        <span v-else class="text-xs text-muted">
          PDF, image, or Excel · Chandra 2 will OCR it
        </span>
      </div>
    </footer>
  </div>
</template>
