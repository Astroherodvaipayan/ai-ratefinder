import { z } from 'zod'

const Body = z.object({ name: z.string().min(1), notes: z.string().optional() })

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = Body.parse(await readBody(event))
  const client = await userClient(event)
  const { data, error } = await client
    .from('vendors')
    .insert({ owner_id: user.id, name: body.name, notes: body.notes ?? null })
    .select()
    .single()
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return data
})
