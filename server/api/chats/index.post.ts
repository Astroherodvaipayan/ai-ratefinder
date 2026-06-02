import { z } from 'zod'
import { findReusableEmptyChat } from '../../utils/chats'

const Body = z.object({
  title: z.string().optional(),
  quotation_id: z.string().uuid().optional()
})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = Body.parse((await readBody(event).catch(() => ({}))) ?? {})
  const client = await userClient(event)

  const wantsNew = body.title !== undefined || body.quotation_id !== undefined
  if (!wantsNew) {
    const existing = await findReusableEmptyChat(client)
    if (existing) return existing
  }

  const { data, error } = await client.from('chats').insert({
    owner_id: user.id,
    title: body.title ?? 'New chat',
    quotation_id: body.quotation_id ?? null
  }).select('id, title, quotation_id, created_at, updated_at').single()
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })
  return data
})
