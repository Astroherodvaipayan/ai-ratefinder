import type { SupabaseClient } from '@supabase/supabase-js'

type ChatRowWithCount = {
  id: string
  title: string
  quotation_id: string | null
  created_at: string
  updated_at: string
  chat_messages?: { count: number }[] | null
}

export function chatMessageCount(row: { chat_messages?: { count: number }[] | null }): number {
  const nested = row.chat_messages
  if (!nested?.length) return 0
  return nested[0]?.count ?? 0
}

export function chatRowWithoutCount<T extends ChatRowWithCount>(row: T) {
  const { chat_messages: _messages, ...chat } = row
  return chat
}

async function recentChatsWithCounts(client: SupabaseClient, limit: number) {
  const { data, error } = await client
    .from('chats')
    .select('id, title, quotation_id, created_at, updated_at, chat_messages(count)')
    .order('updated_at', { ascending: false })
    .limit(limit)

  if (error) throw error
  return data ?? []
}

/** Most recently updated chat with zero messages, if any. */
export async function findReusableEmptyChat(client: SupabaseClient) {
  const data = await recentChatsWithCounts(client, 30)

  const empty = data?.find(row => chatMessageCount(row) === 0)
  return empty ? chatRowWithoutCount(empty) : null
}

/** Resolve the chat users should land on after auth: reusable empty, recent, or new. */
export async function ensureLandingChat(client: SupabaseClient, ownerId: string) {
  const data = await recentChatsWithCounts(client, 30)
  const existing = data.find(row => chatMessageCount(row) === 0) ?? data[0]
  if (existing) return chatRowWithoutCount(existing)

  const { data: created, error } = await client.from('chats').insert({
    owner_id: ownerId,
    title: 'New chat',
    quotation_id: null
  }).select('id, title, quotation_id, created_at, updated_at').single()
  if (error) throw error
  return created
}
