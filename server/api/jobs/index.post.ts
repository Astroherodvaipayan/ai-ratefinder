/**
 * Create a new job (chat thread).
 * Body: { kind: 'ingest_price_list' | 'ingest_boq' | 'build_quotation', title?, vendor_id? }
 */
import { z } from 'zod'

const Body = z.object({
  kind:      z.enum(['ingest_price_list', 'ingest_boq', 'build_quotation']),
  title:     z.string().optional(),
  vendor_id: z.string().uuid().optional()
})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = Body.parse(await readBody(event))
  const client = await userClient(event)

  const title = body.title
    ?? (body.kind === 'ingest_price_list' ? 'New price list ingest'
      : body.kind === 'ingest_boq'        ? 'New BOQ run'
      :                                     'New quotation')

  const { data, error } = await client
    .from('jobs')
    .insert({
      owner_id:  user.id,
      kind:      body.kind,
      title,
      vendor_id: body.vendor_id ?? null
    })
    .select()
    .single()

  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return data
})
