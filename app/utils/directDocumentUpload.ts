import * as tus from 'tus-js-client'
import {
  documentUploadSizeError,
  formatDocumentUploadBytes,
  MAX_DOCUMENT_UPLOAD_BYTES,
  MAX_DOCUMENT_UPLOAD_LABEL
} from '~~/shared/documentUpload'

const RESUMABLE_UPLOAD_THRESHOLD_BYTES = 6 * 1024 * 1024
const RESUMABLE_UPLOAD_CHUNK_BYTES = 6 * 1024 * 1024

interface DirectDocumentUploadOptions {
  vendorName?: string
  onProgress?: (progress: number) => void
}

interface UploadTarget {
  bucket: string
  storage_path: string
}

function encodeStoragePath(path: string) {
  return path.split('/').map(encodeURIComponent).join('/')
}

function getSupabaseConfig(supabase: any) {
  const cfg = useRuntimeConfig()
  const publicSupabase = cfg.public?.supabase as { url?: string; key?: string } | undefined
  const url = publicSupabase?.url ?? supabase.supabaseUrl
  const key = publicSupabase?.key ?? supabase.supabaseKey

  if (!url) throw new Error('Supabase URL is not configured')
  return { url: String(url).replace(/\/$/, ''), key: key ? String(key) : null }
}

function getResumableUploadEndpoint(url: string) {
  const parsed = new URL(url)
  if (parsed.hostname.endsWith('.supabase.co')) {
    const projectRef = parsed.hostname.split('.')[0]
    if (projectRef) return `https://${projectRef}.storage.supabase.co/storage/v1/upload/resumable`
  }

  return `${url}/storage/v1/upload/resumable`
}

function getStorageUploadErrorMessage(message: string, file: File) {
  const sizeLabel = formatDocumentUploadBytes(file.size)
  const cleanedMessage = message.trim() || 'Storage upload failed'
  const normalizedMessage = cleanedMessage.toLowerCase()

  if (
    normalizedMessage.includes('maximum size exceeded')
    || normalizedMessage.includes('exceeded the maximum')
    || normalizedMessage.includes('file size')
  ) {
    return `Supabase rejected ${file.name} (${sizeLabel}) because the project's global Storage file size limit is below this file. The app bucket is configured for ${MAX_DOCUMENT_UPLOAD_LABEL}, but Supabase's global limit takes precedence. Free projects are capped at 50MB; on Pro or higher, set Storage Settings > Global file size limit to ${MAX_DOCUMENT_UPLOAD_LABEL}.`
  }

  return `Storage rejected ${file.name} (${sizeLabel}): ${cleanedMessage}. App limit is ${MAX_DOCUMENT_UPLOAD_LABEL}; if this repeats, check the Supabase project/global storage upload limit.`
}

function uploadFileStandard(params: {
  url: string
  key: string | null
  accessToken: string
  bucket: string
  storagePath: string
  file: File
  onProgress?: (progress: number) => void
}) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const path = encodeStoragePath(params.storagePath)

    xhr.open('POST', `${params.url}/storage/v1/object/${encodeURIComponent(params.bucket)}/${path}`)
    xhr.setRequestHeader('Authorization', `Bearer ${params.accessToken}`)
    if (params.key) xhr.setRequestHeader('apikey', params.key)
    xhr.setRequestHeader('x-upsert', 'false')
    xhr.setRequestHeader('content-type', params.file.type || 'application/octet-stream')

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return
      params.onProgress?.(Math.min(95, Math.round((event.loaded / event.total) * 95)))
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        params.onProgress?.(96)
        resolve()
        return
      }

      try {
        const body = JSON.parse(xhr.responseText)
        const message = body.message || body.error || 'Storage upload failed'
        reject(new Error(getStorageUploadErrorMessage(String(message), params.file)))
      } catch {
        reject(new Error(getStorageUploadErrorMessage(xhr.statusText || 'Storage upload failed', params.file)))
      }
    }

    xhr.onerror = () => reject(new Error('Storage upload failed'))
    xhr.send(params.file)
  })
}

function uploadFileResumable(params: {
  url: string
  key: string | null
  accessToken: string
  bucket: string
  storagePath: string
  file: File
  onProgress?: (progress: number) => void
}) {
  return new Promise<void>((resolve, reject) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${params.accessToken}`,
      'x-upsert': 'false'
    }
    if (params.key) headers.apikey = params.key

    const upload = new tus.Upload(params.file, {
      endpoint: getResumableUploadEndpoint(params.url),
      headers,
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      chunkSize: RESUMABLE_UPLOAD_CHUNK_BYTES,
      metadata: {
        bucketName: params.bucket,
        objectName: params.storagePath,
        contentType: params.file.type || 'application/octet-stream',
        cacheControl: '3600'
      },
      onProgress(bytesUploaded, bytesTotal) {
        if (!bytesTotal) return
        params.onProgress?.(Math.min(95, Math.round((bytesUploaded / bytesTotal) * 95)))
      },
      onSuccess() {
        params.onProgress?.(96)
        resolve()
      },
      onError(error) {
        const response = error instanceof tus.DetailedError ? error.originalResponse : null
        const responseBody = response?.getBody()
        let message = error.message || 'Resumable storage upload failed'
        if (responseBody) {
          try {
            const parsed = JSON.parse(responseBody)
            message = parsed.message || parsed.error || message
          } catch {
            message = responseBody
          }
        }
        reject(new Error(getStorageUploadErrorMessage(message, params.file)))
      }
    })

    upload.findPreviousUploads()
      .then((previousUploads) => {
        const previousUpload = previousUploads[0]
        if (previousUpload) upload.resumeFromPreviousUpload(previousUpload)
        upload.start()
      })
      .catch((error) => reject(new Error(getStorageUploadErrorMessage(error?.message || 'Resumable storage upload failed', params.file))))
  })
}

function uploadFileToStorage(params: {
  url: string
  key: string | null
  accessToken: string
  bucket: string
  storagePath: string
  file: File
  onProgress?: (progress: number) => void
}) {
  if (params.file.size > RESUMABLE_UPLOAD_THRESHOLD_BYTES) {
    return uploadFileResumable(params)
  }

  return uploadFileStandard(params)
}

export async function uploadDocumentDirect(file: File, options: DirectDocumentUploadOptions = {}) {
  const vendorName = options.vendorName?.trim()
  if (!vendorName) {
    throw new Error('Vendor name is required before uploading documents.')
  }
  if (file.size > MAX_DOCUMENT_UPLOAD_BYTES) {
    throw new Error(documentUploadSizeError(file.name, file.size))
  }

  const user = useSupabaseUser()
  const supabase = useSupabaseClient()
  const { data } = await supabase.auth.getSession()
  const accessToken = data.session?.access_token

  if (!user.value?.id || !accessToken) {
    throw new Error('Please sign in again before uploading documents.')
  }

  const { url, key } = getSupabaseConfig(supabase)
  const target = await $fetch<UploadTarget>('/api/documents/upload-target', {
    method: 'POST',
    body: {
      filename: file.name,
      size: file.size,
      mime: file.type || null
    }
  })

  await uploadFileToStorage({
    url,
    key,
    accessToken,
    bucket: target.bucket,
    storagePath: target.storage_path,
    file,
    onProgress: options.onProgress
  })

  const doc = await $fetch('/api/documents', {
    method: 'POST',
    body: {
      filename: file.name,
      storage_path: target.storage_path,
      mime: file.type || null,
      size: file.size,
      vendor_name: vendorName
    }
  })

  options.onProgress?.(100)
  return doc
}
