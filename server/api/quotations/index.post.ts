import { z } from 'zod'

const Body = z.object({
  title:    z.string().optional(),
  customer: z.string().optional()
})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = Body.parse((await readBody(event).catch(() => ({}))) ?? {})
  const client = await userClient(event)
  const { data, error } = await client.from('quotations').insert({
    owner_id: user.id,
    title:    body.title ?? 'New quotation',
    customer: body.customer ?? null
  }).select().single()
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return data
})
