export const MAX_DOCUMENT_UPLOAD_BYTES = 100 * 1024 * 1024
export const MAX_DOCUMENT_UPLOAD_LABEL = '100MB'

export function formatDocumentUploadBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B'

  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)}${units[unitIndex]}`
}

export function documentUploadSizeError(filename: string, bytes: number) {
  return `${filename} is ${formatDocumentUploadBytes(bytes)}. Upload documents must be ${MAX_DOCUMENT_UPLOAD_LABEL} or smaller.`
}
