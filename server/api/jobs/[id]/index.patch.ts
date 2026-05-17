import { z } from 'zod'

const Body = z.object({
  title:     z.string().optional(),
  vendor_id: z.string().uuid().optional(),
  status:    z.enum(['pending','ocr','extracting','ready','failed']).optional()
})

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const id = getRouterParam(event, 'id')!
  const body = Body.parse(await readBody(event))
  const client = await userClient(event)
  const { data, error } = await client
    .from('jobs')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return data
})
