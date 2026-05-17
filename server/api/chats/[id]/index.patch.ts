import { z } from 'zod'

const Body = z.object({
  title: z.string().optional(),
  quotation_id: z.string().uuid().nullable().optional()
})

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const id = getRouterParam(event, 'id')!
  const body = Body.parse(await readBody(event))
  const client = await userClient(event)
  const { data, error } = await client
    .from('chats')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', id).select().single()
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return data
})
