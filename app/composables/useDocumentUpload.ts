import {
  MAX_DOCUMENT_UPLOAD_BYTES,
  documentUploadSizeError
} from '~~/shared/documentUpload'
import {
  ApiBudgetExceededError,
  uploadDocumentDirect,
  type ApiBudgetUsage
} from '~/utils/directDocumentUpload'

export type UploadPhase = 'idle' | 'uploading' | 'queued'

export function useDocumentUpload(onComplete?: () => void | Promise<void>) {
  const vendorName = ref('')
  const isDragging = ref(false)
  const uploading = ref(false)
  const uploadError = ref<string | null>(null)
  const uploadProgress = ref(0)
  const uploadFilename = ref('')
  const uploadPhase = ref<UploadPhase>('idle')
  const budgetPaymentOpen = ref(false)
  const budgetUsage = ref<ApiBudgetUsage | null>(null)
  const vendorNameError = computed(() =>
    vendorName.value.trim() ? null : 'Vendor name is required.'
  )

  const uploadLabel = computed(() =>
    uploadPhase.value === 'uploading'
      ? `Uploading ${uploadFilename.value || 'document'} directly to storage…`
      : uploadPhase.value === 'queued'
        ? 'Upload complete. Reading and indexing in the background.'
        : 'Drop files here or click to browse'
  )

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
    if (vendorNameError.value) {
      uploadError.value = vendorNameError.value
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
      }
      uploadPhase.value = 'queued'
      await onComplete?.()
    } catch (err: unknown) {
      const e = err as { statusMessage?: string; message?: string; billing?: ApiBudgetUsage | null }
      if (err instanceof ApiBudgetExceededError || e?.billing) {
        budgetUsage.value = e.billing ?? null
        budgetPaymentOpen.value = true
      }
      uploadError.value = e?.statusMessage || e?.message || 'Upload failed'
      uploadPhase.value = 'idle'
    } finally {
      uploading.value = false
      uploadFilename.value = ''
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

  function reset() {
    uploadError.value = null
    uploadProgress.value = 0
    uploadPhase.value = 'idle'
    isDragging.value = false
  }

  return {
    vendorName,
    vendorNameError,
    isDragging,
    uploading,
    uploadError,
    budgetPaymentOpen,
    budgetUsage,
    uploadProgress,
    uploadFilename,
    uploadPhase,
    uploadLabel,
    uploadFiles,
    onPick,
    onDrop,
    reset
  }
}
