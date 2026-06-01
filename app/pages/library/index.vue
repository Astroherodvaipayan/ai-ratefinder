<script setup lang="ts">
definePageMeta({ layout: 'default' })

interface Doc {
  id: string; filename: string; mime: string | null; size: number | null
  status: string; page_count: number | null; error: string | null
  created_at: string; item_count: number
  vendor: { id: string; name: string } | null
}

const { data: docs, refresh } = await useFetch<Doc[]>('/api/documents', { default: () => [] })

const fileInput = ref<HTMLInputElement | null>(null)
const vendorName = ref('')
const isDragging = ref(false)
const uploading = ref(false)
const uploadError = ref<string | null>(null)

async function uploadFiles(files: FileList | File[]) {
  uploadError.value = null
  uploading.value = true
  try {
    for (const f of Array.from(files)) {
      const form = new FormData()
      form.append('file', f, f.name)
      if (vendorName.value.trim()) form.append('vendor_name', vendorName.value.trim())
      await $fetch('/api/documents', { method: 'POST', body: form })
      await refresh()
    }
  } catch (err: any) {
    uploadError.value = err?.statusMessage || err?.message || 'Upload failed'
  } finally {
    uploading.value = false
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
</script>

<template>
  <div
    class="flex h-full flex-col"
    :class="isDragging ? 'bg-primary/5' : ''"
    @dragover.prevent="isDragging = true"
    @dragleave.prevent="isDragging = false"
    @drop="onDrop"
  >
    <header class="flex items-center justify-between border-b border-default px-6 py-4">
      <div>
        <h1 class="text-base font-semibold">Library</h1>
        <p class="text-xs text-muted">Drop price docs anywhere. We OCR with Chandra 2 and index them.</p>
      </div>
      <div class="flex items-center gap-2">
        <UInput v-model="vendorName" placeholder="Vendor (optional)" size="sm" class="w-44" />
        <input
          ref="fileInput"
          type="file"
          multiple
          class="hidden"
          accept=".pdf,.png,.jpg,.jpeg,.webp,.xlsx,.xls"
          @change="onPick"
        >
        <UButton icon="i-lucide-upload" :loading="uploading" @click="fileInput?.click()">
          Upload
        </UButton>
      </div>
    </header>

    <p v-if="uploadError" class="border-b border-error bg-error/10 px-6 py-2 text-xs text-error">
      {{ uploadError }}
    </p>

    <div class="flex-1 overflow-y-auto px-6 py-4">
      <div
        v-if="!docs.length"
        class="mx-auto mt-16 max-w-md rounded-lg border border-dashed border-default p-8 text-center text-sm text-muted"
      >
        <UIcon name="i-lucide-upload-cloud" class="text-3xl text-muted" />
        <p class="mt-2">No documents yet.</p>
        <p>Drag PDFs, images, or Excel files here, or click <b>Upload</b>.</p>
      </div>

      <ul v-else class="space-y-2">
        <li
          v-for="d in docs"
          :key="d.id"
        >
          <NuxtLink
            :to="`/library/${d.id}`"
            class="block rounded-lg border border-default px-4 py-3 hover:bg-accented"
          >
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <div class="truncate text-sm font-medium">{{ d.filename }}</div>
                <div class="mt-0.5 truncate text-xs text-muted">
                  {{ d.vendor?.name ?? 'Unassigned vendor' }} ·
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
          </NuxtLink>
        </li>
      </ul>
    </div>

    <div
      v-if="isDragging"
      class="pointer-events-none absolute inset-0 grid place-items-center bg-primary/10 text-primary"
    >
      <div class="rounded-lg border-2 border-dashed border-primary px-8 py-6 text-sm font-medium">
        Drop to upload
      </div>
    </div>
  </div>
</template>
