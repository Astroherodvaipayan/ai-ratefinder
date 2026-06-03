import { ensureLandingChat } from '../../utils/chats'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const client = await userClient(event)

  try {
    return await ensureLandingChat(client, user.id)
  } catch (error: any) {
    throw createError({ statusCode: 500, statusMessage: error?.message ?? 'Could not resolve chat' })
  }
})
