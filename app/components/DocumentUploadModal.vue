<script setup lang="ts">
import { MAX_DOCUMENT_UPLOAD_LABEL } from '~~/shared/documentUpload'

const open = defineModel<boolean>('open', { default: false })

const props = withDefaults(defineProps<{
  initialVendorName?: string
  lockVendor?: boolean
}>(), {
  initialVendorName: '',
  lockVendor: false
})

const emit = defineEmits<{
  uploaded: []
}>()

const fileInput = ref<HTMLInputElement | null>(null)

const {
  vendorName,
  vendorNameError,
  isDragging,
  uploading,
  uploadError,
  budgetPaymentOpen,
  budgetUsage,
  uploadProgress,
  uploadPhase,
  uploadLabel,
  onPick,
  onDrop,
  reset
} = useDocumentUpload()

const successDismissMs = 4000

watch(uploadPhase, async (phase) => {
  if (phase !== 'queued') return
  emit('uploaded')
  await new Promise(resolve => setTimeout(resolve, successDismissMs))
  if (uploadPhase.value === 'queued' && open.value) {
    open.value = false
    reset()
  }
})

const accept = '.pdf,.png,.jpg,.jpeg,.webp,.xlsx,.xls'

function applyVendorPreset() {
  vendorName.value = props.initialVendorName.trim()
}

function close() {
  if (uploading.value) return
  open.value = false
  reset()
}

function openPicker() {
  if (!uploading.value) fileInput.value?.click()
}

watch(open, (isOpen) => {
  if (isOpen) {
    applyVendorPreset()
  } else {
    reset()
  }
})

watch(() => props.initialVendorName, () => {
  if (open.value) applyVendorPreset()
})

function onOverlayKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="upload-modal-title"
      @keydown="onOverlayKeydown"
    >
      <div
        class="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
        aria-hidden="true"
        @click="close"
      />

      <div
        class="relative w-full max-w-md rounded-2xl border border-default bg-default p-6 shadow-xl"
        @click.stop
      >
        <div class="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id="upload-modal-title" class="text-base font-semibold text-highlighted">
              Upload rate documents
            </h2>
            <p class="mt-1 text-xs text-muted">
              PDF, images, or Excel up to {{ MAX_DOCUMENT_UPLOAD_LABEL }}. Vendor name groups files in your library.
            </p>
          </div>
          <UButton
            icon="i-lucide-x"
            size="sm"
            variant="ghost"
            color="neutral"
            class="shrink-0 rounded-lg"
            :disabled="uploading"
            aria-label="Close"
            @click="close"
          />
        </div>

        <UFormField label="Vendor" required :error="uploadError && vendorNameError ? uploadError : undefined" class="mb-4">
          <UInput
            v-model="vendorName"
            placeholder="e.g. Acme Cables"
            size="sm"
            :disabled="uploading || lockVendor"
            required
          />
        </UFormField>

        <input
          ref="fileInput"
          type="file"
          multiple
          class="hidden"
          :accept="accept"
          :disabled="uploading"
          @change="onPick"
        >

        <button
          type="button"
          class="w-full cursor-pointer rounded-xl border-2 border-dashed transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlighted"
          :class="isDragging
            ? 'border-highlighted bg-muted'
            : 'border-default bg-muted hover:border-accented hover:bg-accented'"
          :disabled="uploading"
          @click="openPicker"
          @dragover.prevent="isDragging = true"
          @dragleave.prevent="isDragging = false"
          @drop="onDrop"
        >
          <div class="flex flex-col items-center px-6 py-8 text-center">
            <div
              class="grid place-items-center"
              :style="{ width: '240px', height: '240px' }"
            >
              <ClientOnly>
                <UploadAnimation
                  v-if="uploadPhase === 'queued'"
                  :key="`done-${uploadProgress}`"
                  :size="240"
                  :loop="false"
                />
                <UIcon
                  v-else-if="uploading"
                  name="i-lucide-loader-2"
                  class="size-12 animate-spin text-toned"
                />
                <UIcon
                  v-else
                  name="i-lucide-upload-cloud"
                  class="size-16 text-muted"
                />
                <template #fallback>
                  <UIcon name="i-lucide-upload-cloud" class="size-16 text-muted" />
                </template>
              </ClientOnly>
            </div>
            <p class="mt-2 text-sm font-medium text-highlighted">{{ uploadLabel }}</p>
            <p class="mt-1 text-xs text-muted">PDF · PNG · JPG · WebP · XLSX · {{ MAX_DOCUMENT_UPLOAD_LABEL }} max</p>
          </div>
        </button>

        <UProgress
          v-if="uploading || uploadPhase === 'queued'"
          :model-value="uploadProgress"
          class="mt-4"
          :status="uploadPhase === 'queued'"
        />

        <p v-if="uploadError" class="mt-3 text-xs text-error" role="alert">
          {{ uploadError }}
        </p>
      </div>
    </div>
  </Teleport>

  <ApiBudgetPaymentModal
    v-model:open="budgetPaymentOpen"
    :usage="budgetUsage"
    @paid="uploadError = null"
  />
</template>
