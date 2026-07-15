export async function downloadChatExport(chatId: string, fallbackTitle = 'chat') {
  const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/export`, {
    credentials: 'same-origin'
  })
  if (!response.ok) throw new Error('The chat export could not be created.')

  const blob = await response.blob()
  const disposition = response.headers.get('content-disposition') ?? ''
  const safeTitle = fallbackTitle
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60) || 'chat'
  const filename = disposition.match(/filename="([^"]+)"/)?.[1]
    ?? `ai-ratefinder-${safeTitle}-${new Date().toISOString().slice(0, 10)}.json`
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
