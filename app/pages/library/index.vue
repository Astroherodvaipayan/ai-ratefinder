<script setup lang="ts">
import {
  MAX_DOCUMENT_UPLOAD_BYTES,
  MAX_DOCUMENT_UPLOAD_LABEL,
  documentUploadSizeError
} from '~~/shared/documentUpload'
import { uploadDocumentDirect } from '~/utils/directDocumentUpload'

definePageMeta({ layout: 'default' })

interface Doc {
  id: string; owner_id: string; filename: string; mime: string | null; size: number | null
  status: string; page_count: number | null; error: string | null
  created_at: string; item_count: number; parsed_with_internal?: boolean
  vendor: { id: string; name: string } | null
}

const user = useSupabaseUser()
const { data: docs, refresh } = useFetch<Doc[]>('/api/documents', { default: () => [], lazy: true })

const fileInput = ref<HTMLInputElement | null>(null)
const vendorName = ref('')
const isDragging = ref(false)
const uploading = ref(false)
const uploadError = ref<string | null>(null)
const reparseError = ref<string | null>(null)
const vendorEditError = ref<string | null>(null)
const reparsingIds = ref<string[]>([])
const savingVendorIds = ref<string[]>([])
const uploadProgress = ref(0)
const uploadFilename = ref('')
const uploadPhase = ref<'idle' | 'uploading' | 'queued'>('idle')
const uploadLabel = computed(() =>
  uploadPhase.value === 'uploading'
    ? `Uploading ${uploadFilename.value || 'document'} directly to storage...`
    : uploadPhase.value === 'queued'
      ? 'Upload complete. Reading and indexing are running in the background.'
      : 'Drop to upload'
)
const hasProcessingDocs = computed(() =>
  docs.value.some(d => ['uploading', 'ocr', 'extracting'].includes(d.status))
)
const trimmedVendorName = computed(() => vendorName.value.trim())
const groupedDocs = computed(() => {
  const groups = new Map<string, Doc[]>()
  for (const doc of docs.value) {
    const vendor = doc.vendor?.name || 'Unassigned vendor'
    groups.set(vendor, [...(groups.get(vendor) ?? []), doc])
  }
  return [...groups.entries()].map(([vendor, items]) => ({ vendor, items }))
})

let pollTimer: ReturnType<typeof setInterval> | null = null

function startPolling() {
  if (!import.meta.client) return
  if (pollTimer) return
  pollTimer = setInterval(async () => {
    await refresh()
    if (!hasProcessingDocs.value && pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }, 3000)
}

function statusProgress(status: string) {
  if (status === 'uploading') return 15
  if (status === 'ocr') return 45
  if (status === 'extracting') return 78
  return status === 'parsed' ? 100 : 0
}

function statusText(status: string) {
  if (status === 'ocr') return 'Reading document'
  if (status === 'extracting') return 'Indexing price rows'
  if (status === 'uploading') return 'Uploading'
  return status
}

function canManageDocument(doc: Pick<Doc, 'owner_id'>) {
  return Boolean(user.value?.id && doc.owner_id === user.value.id)
}

async function uploadOneFile(file: File): Promise<void> {
  if (file.size > MAX_DOCUMENT_UPLOAD_BYTES) {
    throw new Error(documentUploadSizeError(file.name, file.size))
  }

  await uploadDocumentDirect(file, {
    vendorName: vendorName.value,
    onProgress: (progress) => {
      uploadProgress.value = progress
    }
  })
}

async function uploadFiles(files: FileList | File[]) {
  uploadError.value = null
  if (!trimmedVendorName.value) {
    uploadError.value = 'Vendor name is required before uploading documents.'
    uploadProgress.value = 0
    uploadPhase.value = 'idle'
    return
  }

  const selected = Array.from(files)
  const oversized = selected.find(file => file.size > MAX_DOCUMENT_UPLOAD_BYTES)
  if (oversized) {
    uploadError.value = documentUploadSizeError(oversized.name, oversized.size)
    uploadProgress.value = 0
    uploadPhase.value = 'idle'
    return
  }

  uploading.value = true
  uploadPhase.value = 'uploading'
  uploadProgress.value = 0
  try {
    for (const [index, f] of selected.entries()) {
      uploadFilename.value = selected.length > 1
        ? `${f.name} (${index + 1}/${selected.length})`
        : f.name
      uploadProgress.value = 0
      await uploadOneFile(f)
      await refresh()
    }
    uploadPhase.value = 'queued'
    startPolling()
    setTimeout(() => {
      if (uploadPhase.value === 'queued') uploadPhase.value = 'idle'
    }, 1800)
  } catch (err: any) {
    uploadError.value = err?.statusMessage || err?.message || 'Upload failed'
  } finally {
    uploading.value = false
    uploadFilename.value = ''
  }
}

async function reparseDocument(doc: Doc) {
  if (!canManageDocument(doc)) {
    reparseError.value = 'Only the uploader can reparse this shared document.'
    return
  }
  if (reparsingIds.value.includes(doc.id)) return
  reparseError.value = null
  reparsingIds.value = [...reparsingIds.value, doc.id]
  try {
    await $fetch(`/api/documents/${doc.id}/reparse`, { method: 'POST' })
    await refresh()
    startPolling()
  } catch (err: any) {
    reparseError.value = err?.statusMessage || err?.message || 'Reparse failed'
  } finally {
    reparsingIds.value = reparsingIds.value.filter(id => id !== doc.id)
  }
}

async function editDocumentVendor(doc: Doc) {
  if (!canManageDocument(doc)) {
    vendorEditError.value = 'Only the uploader can edit this shared document.'
    return
  }
  if (savingVendorIds.value.includes(doc.id)) return
  vendorEditError.value = null
  const nextName = prompt('Vendor name', doc.vendor?.name ?? '')?.trim()
  if (nextName === undefined) return
  if (!nextName) {
    vendorEditError.value = 'Vendor name is required.'
    return
  }
  if (nextName === doc.vendor?.name) return

  savingVendorIds.value = [...savingVendorIds.value, doc.id]
  try {
    const updated = await $fetch<{ id: string; vendor: { id: string; name: string } }>(`/api/documents/${doc.id}`, {
      method: 'PATCH',
      body: { vendor_name: nextName }
    })
    docs.value = docs.value.map(item =>
      item.id === doc.id ? { ...item, vendor: updated.vendor } : item
    )
    await refresh()
  } catch (err: any) {
    vendorEditError.value = err?.statusMessage || err?.message || 'Could not update vendor.'
  } finally {
    savingVendorIds.value = savingVendorIds.value.filter(id => id !== doc.id)
  }
}

function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files?.length) {
    uploadFiles(input.files)
    input.value = ''
  }
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  isDragging.value = false
  if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files)
}

const statusColor = (s: string) =>
  s === 'parsed' ? 'success'
  : s === 'failed' ? 'error'
  : 'warning'

const humanSize = (n: number | null) => {
  if (!n) return ''
  const kb = n / 1024
  return kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(0)} KB`
}

onMounted(() => {
  if (hasProcessingDocs.value) startPolling()
})

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <div
    class="flex h-full flex-col"
    :class="isDragging ? 'bg-muted' : ''"
    @dragover.prevent="isDragging = true"
    @dragleave.prevent="isDragging = false"
    @drop="onDrop"
  >
    <header class="border-b border-default/80 px-6 py-5">
      <div class="mx-auto flex max-w-3xl flex-col items-center gap-3 text-center">
        <div class="min-w-0">
          <h1 class="text-base font-semibold">Library</h1>
          <p class="text-xs text-muted">Drop weekly vendor rate docs up to {{ MAX_DOCUMENT_UPLOAD_LABEL }}. Vendor name is required.</p>
        </div>
        <div class="flex w-full max-w-md flex-col items-center gap-2">
          <UFormField label="Vendor" required :error="uploadError && !trimmedVendorName ? uploadError : undefined" class="w-full max-w-56 text-left">
            <UInput v-model="vendorName" placeholder="e.g. Acme Cables" size="sm" required />
          </UFormField>
          <input
            ref="fileInput"
            type="file"
            multiple
            class="hidden"
            accept=".pdf,.png,.jpg,.jpeg,.webp,.xlsx,.xls"
            @change="onPick"
          >
          <UButton
            icon="i-lucide-upload"
            :loading="uploading"
            class="h-9 min-w-36 justify-center rounded-lg"
            @click="fileInput?.click()"
          >
            Upload
          </UButton>
        </div>
      </div>
    </header>

    <p v-if="uploadError || reparseError || vendorEditError" class="border-b border-error bg-error/10 px-6 py-2 text-xs text-error">
      {{ uploadError || reparseError || vendorEditError }}
    </p>

    <div class="flex-1 overflow-y-auto px-6 py-4">
      <div
        v-if="!docs.length"
        class="mx-auto mt-16 max-w-md rounded-xl border border-dashed border-default bg-muted p-8 text-center text-sm text-muted"
      >
        <ClientOnly>
          <UploadAnimation :size="200" />
          <template #fallback>
            <UIcon name="i-lucide-upload-cloud" class="text-3xl text-muted" />
          </template>
        </ClientOnly>
        <p class="mt-2">No documents yet.</p>
        <p>Drag PDFs, images, or Excel files up to {{ MAX_DOCUMENT_UPLOAD_LABEL }} here.</p>
        <UButton
          icon="i-lucide-upload"
          :loading="uploading"
          class="mx-auto mt-4 rounded-lg"
          @click="fileInput?.click()"
        >
          Upload document
        </UButton>
      </div>

      <div v-else class="space-y-6">
        <section v-for="group in groupedDocs" :key="group.vendor" class="space-y-2">
          <div class="flex items-center justify-between border-b border-default/80 pb-2">
            <h2 class="flex items-center gap-2 text-sm font-semibold">
              <UIcon name="i-lucide-folder" class="text-toned" />
              {{ group.vendor }}
            </h2>
            <span class="text-xs text-muted">
              {{ group.items.length }} document{{ group.items.length === 1 ? '' : 's' }}
            </span>
          </div>

          <ul class="space-y-2">
            <li
              v-for="d in group.items"
              :key="d.id"
            >
              <div class="flex items-center gap-3 rounded-xl border border-default/80 bg-default px-4 py-3 transition hover:bg-accented hover:shadow-sm">
                <NuxtLink :to="`/library/${d.id}`" class="min-w-0 flex-1">
                <div class="flex items-center justify-between gap-3">
                  <div class="min-w-0">
                    <div class="flex min-w-0 items-center gap-1.5">
                      <UIcon
                        v-if="d.parsed_with_internal"
                        name="i-lucide-star"
                        class="shrink-0 text-primary"
                        aria-label="Parsed internally"
                      />
                      <div class="truncate text-sm font-medium">{{ d.filename }}</div>
                    </div>
                    <div class="mt-0.5 truncate text-xs text-muted">
                      {{ d.item_count }} item{{ d.item_count === 1 ? '' : 's' }} ·
                      {{ humanSize(d.size) }}
                      <span v-if="d.page_count"> · {{ d.page_count }} pages</span>
                    </div>
                  </div>
                  <UBadge :color="statusColor(d.status)" variant="soft" size="sm">
                    {{ d.status }}
                  </UBadge>
                </div>
                <p v-if="d.error" class="mt-1 text-xs text-error">{{ d.error }}</p>
                <div v-if="['uploading', 'ocr', 'extracting'].includes(d.status)" class="mt-3">
                  <div class="mb-1 flex items-center justify-between text-xs text-muted">
                    <span>{{ statusText(d.status) }}</span>
                    <span>{{ statusProgress(d.status) }}%</span>
                  </div>
                  <UProgress :model-value="statusProgress(d.status)" size="sm" />
                </div>
                </NuxtLink>
                <UButton
                  v-if="canManageDocument(d)"
                  size="xs"
                  variant="soft"
                  icon="i-lucide-tag"
                  :loading="savingVendorIds.includes(d.id)"
                  aria-label="Edit document vendor"
                  @click="editDocumentVendor(d)"
                >
                  Vendor
                </UButton>
                <UButton
                  v-if="canManageDocument(d)"
                  size="xs"
                  variant="soft"
                  icon="i-lucide-refresh-cw"
                  :loading="reparsingIds.includes(d.id)"
                  :disabled="['uploading', 'ocr', 'extracting'].includes(d.status)"
                  aria-label="Reparse document"
                  @click="reparseDocument(d)"
                >
                  Reparse
                </UButton>
              </div>
            </li>
          </ul>
        </section>
      </div>
    </div>

    <div
      v-if="isDragging || uploading || uploadPhase === 'queued'"
      class="pointer-events-none absolute inset-0 grid place-items-center bg-muted/80 text-highlighted"
    >
      <div class="rounded-lg border-2 border-dashed border-default bg-default px-8 py-6 text-center text-sm font-medium shadow-lg">
        <ClientOnly>
          <UploadAnimation :size="240" />
          <template #fallback>
            <UIcon name="i-lucide-upload-cloud" class="text-4xl" />
          </template>
        </ClientOnly>
        <p class="mt-2">{{ uploadLabel }}</p>
        <UProgress
          v-if="uploading || uploadPhase === 'queued'"
          :model-value="uploadProgress"
          status
          class="mt-4 w-72"
        />
      </div>
    </div>
  </div>
</template>
