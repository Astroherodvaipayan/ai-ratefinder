import { z } from 'zod'

const Body = z.object({
  description: z.string().optional(),
  sku:         z.string().nullable().optional(),
  unit:        z.string().nullable().optional(),
  vendor:      z.string().nullable().optional(),
  qty:         z.number().min(0).optional(),
  unit_price:  z.number().min(0).optional()
})

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const itemId = getRouterParam(event, 'itemId')!
  const body = Body.parse(await readBody(event))
  const client = await userClient(event)
  const { data, error } = await client
    .from('quotation_items').update(body).eq('id', itemId).select().single()
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return data
})
