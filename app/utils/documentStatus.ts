export const DOCUMENT_PROCESSING_STALE_MS = 30 * 60 * 1000

const PROCESSING_STATUSES = new Set(['uploading', 'ocr', 'extracting'])

export interface DocumentStatusSource {
  status: string
  updated_at?: string | null
}

export function isProcessingDocument(doc: DocumentStatusSource) {
  return PROCESSING_STATUSES.has(doc.status)
}

export function isDocumentStalled(doc: DocumentStatusSource, now = Date.now()) {
  if (!isProcessingDocument(doc) || !doc.updated_at) return false
  const updatedAt = Date.parse(doc.updated_at)
  return Number.isFinite(updatedAt) && now - updatedAt >= DOCUMENT_PROCESSING_STALE_MS
}

export function isDocumentActivelyProcessing(doc: DocumentStatusSource, now = Date.now()) {
  return isProcessingDocument(doc) && !isDocumentStalled(doc, now)
}

export function documentStatusLabel(doc: DocumentStatusSource) {
  if (isDocumentStalled(doc)) return 'stalled'
  return doc.status
}

export function documentStageLabel(status: string) {
  if (status === 'ocr') return 'Reading document'
  if (status === 'extracting') return 'Indexing price rows'
  if (status === 'uploading') return 'Uploading document'
  return status
}
