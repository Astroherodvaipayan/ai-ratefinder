<script setup lang="ts">
import { hasAuthSession } from '~/composables/useAuthSession'

definePageMeta({ layout: 'default' })

interface Chat { id: string; message_count?: number }

const supabase = useSupabaseClient()
const requestFetch = useRequestFetch()

if (!await hasAuthSession(supabase)) {
  await navigateTo('/login', { replace: true })
} else {
  const chat = await requestFetch<Chat>('/api/chats/landing')
  await navigateTo(`/chats/${chat.id}`, { replace: true })
}
</script>

<template><div /></template>
