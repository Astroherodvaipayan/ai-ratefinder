<script setup lang="ts">
import { hasAuthSession } from '~/composables/useAuthSession'

definePageMeta({ layout: 'default' })

interface Chat { id: string; message_count?: number }

const supabase = useSupabaseClient()
const requestFetch = useRequestFetch()

if (!await hasAuthSession(supabase)) {
  await navigateTo('/login', { replace: true })
} else {
  const chats = await requestFetch<Chat[]>('/api/chats')
  const empty = chats.find(c => (c.message_count ?? 0) === 0)

  if (empty) {
    await navigateTo(`/chats/${empty.id}`, { replace: true })
  } else if (chats[0]) {
    await navigateTo(`/chats/${chats[0].id}`, { replace: true })
  } else {
    const c = await requestFetch<{ id: string }>('/api/chats', { method: 'POST', body: {} })
    await navigateTo(`/chats/${c.id}`, { replace: true })
  }
}
</script>

<template><div /></template>
