/**
 * Post a user message into a chat.
 *
 *   - Persists the user message
 *   - Retrieves top-N candidate doc_items + surrounding markdown
 *   - Sends candidates + history to Gemini for a structured answer
 *   - Persists the assistant message (text + cited items)
 *   - Returns the assistant message
 */
import { z } from 'zod'
import { answerFromCandidates, type ChatTurn } from '../../../utils/gemini'
import { retrieveCandidates } from '../../../utils/retrieval'

const Body = z.object({ content: z.string().min(1) })

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const chatId = getRouterParam(event, 'id')!
  const { content } = Body.parse(await readBody(event))
  const client = await userClient(event)

  // Confirm chat exists for this user (RLS does the security; this gives a 404).
  const { data: chat } = await client.from('chats').select('id, title').eq('id', chatId).single()
  if (!chat) throw createError({ statusCode: 404, statusMessage: 'Chat not found' })

  // Persist user message
  await client.from('chat_messages').insert({
    chat_id: chatId, role: 'user', content
  })

  // Load short history (last 8 turns) for Gemini context
  const { data: prior } = await client
    .from('chat_messages')
    .select('role, content')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: false })
    .limit(8)
  const history: ChatTurn[] = (prior ?? []).reverse() as ChatTurn[]

  // Retrieve candidates and ask Gemini
  const candidates = await retrieveCandidates(client, content, 15)
  const reply = await answerFromCandidates(content, candidates, history.slice(0, -1))

  // Persist assistant message
  const { data: msg, error } = await client.from('chat_messages').insert({
    chat_id: chatId,
    role: 'assistant',
    content: reply.answer_text,
    items: reply.items
  }).select().single()
  if (error) throw createError({ statusCode: 500, statusMessage: error.message })

  // First user message becomes the chat title
  if (chat.title === 'New chat') {
    await client.from('chats')
      .update({ title: content.slice(0, 60), updated_at: new Date().toISOString() })
      .eq('id', chatId)
  } else {
    await client.from('chats')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', chatId)
  }

  return msg
})
