import { documentUploadSizeError } from '~~/shared/documentUpload'

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

function uploadFileToStorage(params: {
  url: string
  key: string | null
  accessToken: string
  storagePath: string
  file: File
  onProgress?: (progress: number) => void
}) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const path = encodeStoragePath(params.storagePath)

    xhr.open('POST', `${params.url}/storage/v1/object/uploads/${path}`)
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
        reject(new Error(
          String(message).toLowerCase().includes('exceeded the maximum allowed size')
            ? documentUploadSizeError(params.file.name, params.file.size)
            : message
        ))
      } catch {
        reject(new Error(xhr.statusText || 'Storage upload failed'))
      }
    }

    xhr.onerror = () => reject(new Error('Storage upload failed'))
    xhr.send(params.file)
  })
}

export async function uploadDocumentDirect(file: File, options: DirectDocumentUploadOptions = {}) {
  const vendorName = options.vendorName?.trim()
  if (!vendorName) {
    throw new Error('Vendor name is required before uploading documents.')
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
