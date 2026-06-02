import { MAX_DOCUMENT_UPLOAD_BYTES } from '~~/shared/documentUpload'
import { adminClient } from './supabase'

const UPLOAD_BUCKET = 'uploads'

export async function ensureUploadBucketLimit() {
  const client = adminClient()
  const options = {
    public: false,
    fileSizeLimit: MAX_DOCUMENT_UPLOAD_BYTES
  }

  const { data: bucket, error: getErr } = await client.storage.getBucket(UPLOAD_BUCKET)
  if (bucket) {
    const currentLimit = Number(bucket.file_size_limit ?? 0)
    if (bucket.public === false && currentLimit >= MAX_DOCUMENT_UPLOAD_BYTES) return
  } else if (getErr) {
    const message = getErr.message.toLowerCase()
    if (!message.includes('not found') && !message.includes('does not exist')) {
      throw createError({ statusCode: 500, statusMessage: getErr.message })
    }
  }

  const { error } = await client.storage.updateBucket(UPLOAD_BUCKET, options)
  if (!error) return

  const message = error.message.toLowerCase()
  if (!message.includes('not found') && !message.includes('does not exist')) {
    throw createError({ statusCode: 500, statusMessage: error.message })
  }

  const { error: createErr } = await client.storage.createBucket(UPLOAD_BUCKET, options)
  if (createErr) {
    throw createError({ statusCode: 500, statusMessage: createErr.message })
  }
}

export { UPLOAD_BUCKET }
