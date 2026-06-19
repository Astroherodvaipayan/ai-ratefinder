import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  MAX_DOCUMENT_UPLOAD_BYTES,
  documentUploadSizeError
} from '~~/shared/documentUpload'
import { ensureUploadBucketLimit } from '../../utils/uploadBucket'
import { getBillingUsageSummary } from '../../utils/billing'
import { adminClient } from '../../utils/supabase'

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

  const usage = await getBillingUsageSummary(adminClient(), user.id)
  if (usage.requires_payment) {
    throw createError({
      statusCode: 402,
      statusMessage: 'API credit balance is exhausted. Add a payment reference to continue uploading.',
      data: { billing: usage }
    })
  }

  await ensureUploadBucketLimit()

  return {
    bucket: 'uploads',
    storage_path: `${user.id}/${randomUUID()}-${safeStorageFilename(body.filename)}`
  }
})
