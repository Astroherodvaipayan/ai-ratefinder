import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  MAX_DOCUMENT_UPLOAD_BYTES,
  documentUploadSizeError
} from '~~/shared/documentUpload'
import { ensureUploadBucketLimit } from '../../utils/uploadBucket'

const Body = z.object({
  filename: z.string().min(1),
  size: z.number().finite().nonnegative(),
  mime: z.string().nullable().optional()
})

function safeStorageFilename(filename: string) {
  const cleaned = filename
    .replace(/[^\w.\- ()]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')

  return cleaned || 'document'
}

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = Body.parse(await readBody(event))

  if (body.size > MAX_DOCUMENT_UPLOAD_BYTES) {
    throw createError({
      statusCode: 413,
      statusMessage: documentUploadSizeError(body.filename, body.size)
    })
  }

  await ensureUploadBucketLimit()

  return {
    bucket: 'uploads',
    storage_path: `${user.id}/${randomUUID()}-${safeStorageFilename(body.filename)}`
  }
})
