type ExportChat = {
  id: string
  title: string
  quotation_id: string | null
  created_at: string
  updated_at: string
}

type ExportMessage = {
  id: string
  role: string
  content: string
  items: unknown
  created_at: string
}

function filenamePart(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60) || 'chat'
}

/** Download one chat owned by the signed-in user as portable JSON. */
export default defineEventHandler(async (event) => {
  await requireUser(event)
  const id = getRouterParam(event, 'id')!
  const client = await userClient(event)

  const { data: chat, error: chatError } = await client
    .from('chats')
    .select('id, title, quotation_id, created_at, updated_at')
    .eq('id', id)
    .single<ExportChat>()

  if (chatError || !chat) {
    throw createError({ statusCode: 404, statusMessage: 'Chat not found' })
  }

  const { data: messages, error: messagesError } = await client
    .from('chat_messages')
    .select('id, role, content, items, created_at')
    .eq('chat_id', id)
    .order('created_at', { ascending: true })
    .returns<ExportMessage[]>()

  if (messagesError) {
    throw createError({ statusCode: 500, statusMessage: messagesError.message })
  }

  const exportedAt = new Date().toISOString()
  const archive = {
    format: 'ai-ratefinder-chat-export',
    version: 1,
    exported_at: exportedAt,
    chat: {
      ...chat,
      messages: messages ?? []
    }
  }

  const date = exportedAt.slice(0, 10)
  const filename = `ai-ratefinder-${filenamePart(chat.title)}-${date}.json`
  setHeader(event, 'Content-Type', 'application/json; charset=utf-8')
  setHeader(event, 'Content-Disposition', `attachment; filename="${filename}"`)
  setHeader(event, 'Cache-Control', 'private, no-store')
  return JSON.stringify(archive, null, 2)
})
