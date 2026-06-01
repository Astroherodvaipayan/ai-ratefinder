<script setup lang="ts">
definePageMeta({ layout: 'default' })

// Land users in a usable place: either the most recent chat or a fresh one.
const chats = await $fetch<Array<{ id: string }>>('/api/chats')
if (chats.length) {
  await navigateTo(`/chats/${chats[0].id}`, { replace: true })
} else {
  const c = await $fetch<{ id: string }>('/api/chats', { method: 'POST', body: {} })
  await navigateTo(`/chats/${c.id}`, { replace: true })
}
</script>

<template><div /></template>
