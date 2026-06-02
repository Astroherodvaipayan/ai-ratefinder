/** Returns a short-lived signed URL for the original uploaded file. */
import { adminClient } from '../../../utils/supabase'

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const id = getRouterParam(event, 'id')!
  const client = await userClient(event)

  const { data: doc, error } = await client
    .from('documents').select('storage_path, mime').eq('id', id).single()
  if (error || !doc) throw createError({ statusCode: 404, statusMessage: 'not found' })

  const { data, error: signErr } = await adminClient().storage
    .from('uploads').createSignedUrl(doc.storage_path, 300)
  if (signErr || !data) throw createError({ statusCode: 500, statusMessage: signErr?.message ?? 'sign failed' })

  return { url: data.signedUrl, mime: doc.mime }
})
