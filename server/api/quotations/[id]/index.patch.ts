import { z } from 'zod'

const Body = z.object({
  title:        z.string().optional(),
  customer:     z.string().nullable().optional(),
  status:       z.enum(['draft', 'sent', 'archived']).optional(),
  discount_pct: z.number().min(0).max(100).optional(),
  gst_pct:      z.number().min(0).max(100).optional(),
  freight:      z.number().min(0).optional(),
  notes:        z.string().nullable().optional()
})

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const id = getRouterParam(event, 'id')!
  const body = Body.parse(await readBody(event))
  const client = await userClient(event)
  const { data, error } = await client
    .from('quotations')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', id).select().single()
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return data
})
