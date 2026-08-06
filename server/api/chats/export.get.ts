type ExportChat = {
  id: string
  title: string
  quotation_id: string | null
  created_at: string
  updated_at: string
}

type ExportMessage = {
  id: string
  chat_id: string
  role: string
  content: string
  items: unknown
  created_at: string
}

async function fetchAllRows<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null, error: { message: string } | null }>
) {
  const pageSize = 1000
  const rows: T[] = []

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1)
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    const page = data ?? []
    rows.push(...page)
    if (page.length < pageSize) return rows
  }
}

/** Download every chat owned by the signed-in user as a portable JSON archive. */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const client = await userClient(event)

  const chats = await fetchAllRows<ExportChat>((from, to) => client
    .from('chats')
    .select('id, title, quotation_id, created_at, updated_at')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(from, to))

  const messages = await fetchAllRows<ExportMessage>((from, to) => client
    .from('chat_messages')
    .select('id, chat_id, role, content, items, created_at')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(from, to))

  const messagesByChat = new Map<string, Omit<ExportMessage, 'chat_id'>[]>()
  for (const message of messages) {
    const { chat_id: chatId, ...exportedMessage } = message
    const chatMessages = messagesByChat.get(chatId) ?? []
    chatMessages.push(exportedMessage)
    messagesByChat.set(chatId, chatMessages)
  }

  const exportedAt = new Date().toISOString()
  const archive = {
    format: 'ai-ratefinder-chat-export',
    version: 1,
    exported_at: exportedAt,
    account: user.email ?? user.id,
    chat_count: chats.length,
    message_count: messages.length,
    chats: chats.map(chat => ({
      ...chat,
      messages: messagesByChat.get(chat.id) ?? []
    }))
  }

  const date = exportedAt.slice(0, 10)
  setHeader(event, 'Content-Type', 'application/json; charset=utf-8')
  setHeader(event, 'Content-Disposition', `attachment; filename="ai-ratefinder-chats-${date}.json"`)
  setHeader(event, 'Cache-Control', 'private, no-store')
  setHeader(event, 'X-Chat-Count', String(chats.length))
  setHeader(event, 'X-Message-Count', String(messages.length))
  return JSON.stringify(archive, null, 2)
})
