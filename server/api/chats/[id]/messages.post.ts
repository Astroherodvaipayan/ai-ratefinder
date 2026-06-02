/**
 * Post a user message into a chat.
 *
 *   - Persists the user message
 *   - Retrieves top-N candidate doc_items + surrounding markdown
 *   - Sends candidates + history to Gemini for a structured answer
 *   - Sanitizes cited items against retrieved rows and creates/updates the
 *     chat's draft proforma invoice
 *   - Persists the assistant message (text + cited items)
 *   - Returns the assistant message
 */
import { z } from 'zod'
import { answerFromCandidates, constrainChatAnswer, type ChatTurn } from '../../../utils/gemini'
import { addDocItemsToQuotation, ensureChatQuotation } from '../../../utils/quotations'
import { retrieveCandidates } from '../../../utils/retrieval'

const Body = z.object({
  content: z.string().min(1),
  document_id: z.string().uuid().nullish(),
  vendor_id: z.string().uuid().nullish()
})

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const chatId = getRouterParam(event, 'id')!
  const { content, document_id: documentId, vendor_id: vendorId } = Body.parse(await readBody(event))
  const client = await userClient(event)

  // Confirm chat exists for this user (RLS does the security; this gives a 404).
  const { data: chat } = await client
    .from('chats')
    .select('id, title, quotation_id')
    .eq('id', chatId)
    .single()
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

  const scope = await resolveScopeLabels(client, { documentId, vendorId })

  // Retrieve candidates and ask Gemini
  const candidates = await retrieveCandidates(client, content, 30, {
    documentId,
    vendorId,
    ownerId: user.id
  })
  const rawReply = await answerFromCandidates(content, candidates, history.slice(0, -1), scope)
  const reply = constrainChatAnswer(rawReply, candidates)

  let quotationId: string | null = chat.quotation_id ?? null
  if (reply.items.length) {
    quotationId = await ensureChatQuotation(client, user.id, chat as any, content)
    await addDocItemsToQuotation(
      client,
      quotationId,
      reply.items.map(item => item.doc_item_id)
    )
  }

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

  return { ...msg, quotation_id: quotationId }
})

async function resolveScopeLabels(
  client: Awaited<ReturnType<typeof userClient>>,
  scope: { documentId?: string | null; vendorId?: string | null }
) {
  const labels: { documentName?: string | null; vendorName?: string | null } = {}

  if (scope.documentId) {
    const { data } = await client
      .from('documents')
      .select('filename, vendor:vendor_id(name)')
      .eq('id', scope.documentId)
      .maybeSingle()
    labels.documentName = data?.filename ?? null
    labels.vendorName = (data as any)?.vendor?.name ?? labels.vendorName ?? null
  }

  if (scope.vendorId && !labels.vendorName) {
    const { data } = await client
      .from('vendors')
      .select('name')
      .eq('id', scope.vendorId)
      .maybeSingle()
    labels.vendorName = data?.name ?? null
  }

  return labels
}
