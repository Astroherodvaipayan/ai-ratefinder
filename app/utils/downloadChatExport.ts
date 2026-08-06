type ChatExportDownload = {
  filename: string
  chatCount: number | null
  messageCount: number | null
}

async function downloadExport(
  path: string,
  fallbackFilename: string,
  errorMessage: string
): Promise<ChatExportDownload> {
  const response = await fetch(path, {
    credentials: 'same-origin'
  })
  if (!response.ok) throw new Error(errorMessage)

  const blob = await response.blob()
  const disposition = response.headers.get('content-disposition') ?? ''
  const filename = disposition.match(/filename="([^"]+)"/)?.[1]
    ?? fallbackFilename
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)

  return {
    filename,
    chatCount: numericHeader(response, 'x-chat-count'),
    messageCount: numericHeader(response, 'x-message-count')
  }
}

export async function downloadChatExport(chatId: string, fallbackTitle = 'chat') {
  const safeTitle = fallbackTitle
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60) || 'chat'
  const date = new Date().toISOString().slice(0, 10)

  return await downloadExport(
    `/api/chats/${encodeURIComponent(chatId)}/export`,
    `ai-ratefinder-${safeTitle}-${date}.json`,
    'The chat export could not be created.'
  )
}

export async function downloadAllChatsExport() {
  const date = new Date().toISOString().slice(0, 10)
  return await downloadExport(
    '/api/chats/export',
    `ai-ratefinder-chats-${date}.json`,
    'The chat archive could not be created.'
  )
}

function numericHeader(response: Response, name: string) {
  const raw = response.headers.get(name)
  if (raw === null || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : null
}
