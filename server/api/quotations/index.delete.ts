import { z } from 'zod'

const Body = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100)
})

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const body = Body.parse(await readBody(event))
  const client = await userClient(event)
  const ids = [...new Set(body.ids)]

  const { error } = await client
    .from('quotations')
    .delete()
    .in('id', ids)

  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return { ok: true, deleted_ids: ids }
})
