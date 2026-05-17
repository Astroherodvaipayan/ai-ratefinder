<script setup lang="ts">
const user = useSupabaseUser()
const route = useRoute()

interface Chat { id: string; title: string; updated_at: string }
const { data: chats, refresh: refreshChats } = await useFetch<Chat[]>('/api/chats', {
  default: () => []
})

async function newChat() {
  const c = await $fetch<Chat>('/api/chats', { method: 'POST', body: {} })
  await refreshChats()
  await navigateTo(`/chats/${c.id}`)
}

async function signOut() {
  const supabase = useSupabaseClient()
  await supabase.auth.signOut()
  await navigateTo('/login')
}

const navItems = [
  { to: '/library',    label: 'Library',    icon: 'i-lucide-library' },
  { to: '/chats',      label: 'Chat',       icon: 'i-lucide-message-square' },
  { to: '/quotations', label: 'Quotations', icon: 'i-lucide-file-text' },
  { to: '/vendors',    label: 'Vendors',    icon: 'i-lucide-store' }
]
</script>

<template>
  <div class="grid h-full grid-cols-[260px_1fr]">
    <aside class="flex h-full flex-col border-r border-default bg-elevated">
      <div class="flex items-center justify-between gap-2 px-4 py-3">
        <NuxtLink to="/" class="text-sm font-semibold tracking-tight">
          AI Ratefinder
        </NuxtLink>
        <UButton icon="i-lucide-plus" size="xs" color="primary" variant="soft" @click="newChat">
          New chat
        </UButton>
      </div>

      <nav class="space-y-0.5 px-2 pb-3 text-sm">
        <NuxtLink
          v-for="n in navItems"
          :key="n.to"
          :to="n.to"
          class="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accented"
          :class="route.path.startsWith(n.to) ? 'bg-accented font-medium' : ''"
        >
          <UIcon :name="n.icon" />
          {{ n.label }}
        </NuxtLink>
      </nav>

      <div class="px-3 pt-1 text-xs uppercase tracking-wide text-muted">
        Recent chats
      </div>

      <div class="flex-1 overflow-y-auto px-2 py-2">
        <NuxtLink
          v-for="c in chats"
          :key="c.id"
          :to="`/chats/${c.id}`"
          class="block truncate rounded px-2 py-1.5 text-sm hover:bg-accented"
          :class="route.params.id === c.id ? 'bg-accented font-medium' : ''"
        >
          {{ c.title }}
        </NuxtLink>
        <div v-if="!chats.length" class="px-2 py-4 text-xs text-muted">
          No chats yet.
        </div>
      </div>

      <div class="border-t border-default px-3 py-2 text-xs text-muted">
        <div class="flex items-center justify-between">
          <span class="truncate">{{ user?.email }}</span>
          <UButton size="xs" variant="ghost" icon="i-lucide-log-out" @click="signOut" />
        </div>
      </div>
    </aside>

    <main class="flex h-full flex-col overflow-hidden">
      <slot />
    </main>
  </div>
</template>
