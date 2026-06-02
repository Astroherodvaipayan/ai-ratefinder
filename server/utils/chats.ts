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

/** Most recently updated chat with zero messages, if any. */
export async function findReusableEmptyChat(client: SupabaseClient) {
  const { data, error } = await client
    .from('chats')
    .select('id, title, quotation_id, created_at, updated_at, chat_messages(count)')
    .order('updated_at', { ascending: false })
    .limit(30)

  if (error) throw error

  const empty = data?.find(row => chatMessageCount(row) === 0)
  return empty ? chatRowWithoutCount(empty) : null
}
