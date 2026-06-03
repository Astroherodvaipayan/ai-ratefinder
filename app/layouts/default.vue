<script setup lang="ts">
const user = useSupabaseUser()
const route = useRoute()

interface Chat { id: string; title: string; updated_at: string; message_count?: number }
const { data: chats, refresh: fetchChats } = await useFetch<Chat[]>('/api/chats', {
  default: () => [],
  immediate: Boolean(user.value),
  watch: false
})
const collapsed = ref(false)
const pinnedIds = ref<string[]>([])
const sortedChats = computed(() => {
  const pinned = new Set(pinnedIds.value)
  return [...chats.value].sort((a, b) => {
    const pinDelta = Number(pinned.has(b.id)) - Number(pinned.has(a.id))
    if (pinDelta) return pinDelta
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  })
})

async function refreshChats() {
  if (!user.value) {
    chats.value = []
    return
  }
  await fetchChats()
}

watch(user, async (value) => {
  if (value) await refreshChats()
  else chats.value = []
})

async function newChat() {
  if (!user.value) {
    await navigateTo('/login')
    return
  }

  const currentId = route.params.id as string | undefined
  if (currentId && route.path.startsWith('/chats/')) {
    const msgs = await $fetch<unknown[]>(`/api/chats/${currentId}/messages`).catch(() => [])
    if (!msgs.length) return
  }

  await refreshChats()
  const existingEmpty = chats.value.find(c => (c.message_count ?? 0) === 0)
  if (existingEmpty) {
    if (route.params.id !== existingEmpty.id) {
      await navigateTo(`/chats/${existingEmpty.id}`)
    }
    return
  }

  const c = await $fetch<Chat>('/api/chats', { method: 'POST', body: {} })
  await refreshChats()
  if (route.params.id !== c.id) {
    await navigateTo(`/chats/${c.id}`)
  }
}

async function signOut() {
  const supabase = useSupabaseClient()
  await supabase.auth.signOut()
  await navigateTo('/login')
}

function persistSidebar() {
  if (!import.meta.client) return
  localStorage.setItem('ratefinder:sidebar-collapsed', collapsed.value ? '1' : '0')
}

function persistPins() {
  if (!import.meta.client) return
  localStorage.setItem('ratefinder:pinned-chats', JSON.stringify(pinnedIds.value))
}

function toggleSidebar() {
  collapsed.value = !collapsed.value
  persistSidebar()
}

function isPinned(id: string) {
  return pinnedIds.value.includes(id)
}

function togglePin(chat: Chat) {
  pinnedIds.value = isPinned(chat.id)
    ? pinnedIds.value.filter(id => id !== chat.id)
    : [chat.id, ...pinnedIds.value]
  persistPins()
}

async function deleteChat(chat: Chat) {
  if (!confirm(`Delete "${chat.title}"?`)) return
  const deleteUrl = `/api/chats/${chat.id}` as string
  await $fetch(deleteUrl, { method: 'DELETE' })
  pinnedIds.value = pinnedIds.value.filter(id => id !== chat.id)
  persistPins()
  await refreshChats()
  if (route.params.id === chat.id) await navigateTo('/chats')
}

onMounted(() => {
  collapsed.value = localStorage.getItem('ratefinder:sidebar-collapsed') === '1'
  try {
    const saved = JSON.parse(localStorage.getItem('ratefinder:pinned-chats') || '[]')
    if (Array.isArray(saved)) pinnedIds.value = saved.filter(id => typeof id === 'string')
  } catch {
    pinnedIds.value = []
  }
})

const navItems = [
  { to: '/chats', label: 'Chat', icon: 'i-lucide-message-square' },
  { to: '/library', label: 'Library', icon: 'i-lucide-library' },
  { to: '/quotations', label: 'Quotations', icon: 'i-lucide-file-text' },
  { to: '/vendors', label: 'Vendors', icon: 'i-lucide-store' },
  { to: '/admin', label: 'Admin', icon: 'i-lucide-sliders-horizontal' }
]
</script>

<template>
  <div
    class="grid h-full bg-default transition-[grid-template-columns] duration-200"
    :class="collapsed ? 'grid-cols-[64px_1fr]' : 'grid-cols-[260px_1fr]'"
  >
    <aside class="flex h-full min-w-0 flex-col border-r border-default bg-muted">
      <div class="flex items-center justify-between gap-2 px-3 py-3">
        <NuxtLink v-if="!collapsed" to="/chats" class="flex min-w-0 items-center gap-2 truncate text-sm font-semibold tracking-tight">
          <span class="grid size-8 shrink-0 place-items-center rounded-lg border border-default bg-default text-highlighted shadow-sm">
            <UIcon name="i-lucide-search-check" />
          </span>
          <span class="truncate">AI Ratefinder</span>
        </NuxtLink>
        <UButton
          :icon="collapsed ? 'i-lucide-panel-right-open' : 'i-lucide-panel-left-close'"
          size="sm"
          variant="ghost"
          class="shrink-0 rounded-lg"
          :aria-label="collapsed ? 'Expand sidebar' : 'Collapse sidebar'"
          @click="toggleSidebar"
        />
      </div>

      <div class="px-2 pb-3">
        <UButton
          icon="i-lucide-plus"
          size="sm"
          color="primary"
          variant="solid"
          block
          class="h-10 justify-center rounded-lg"
          :aria-label="collapsed ? 'New chat' : undefined"
          @click="newChat"
        >
          <span v-if="!collapsed">New chat</span>
        </UButton>
      </div>

      <nav class="space-y-0.5 px-2 pb-3 text-sm" aria-label="Primary">
        <NuxtLink
          v-for="n in navItems"
          :key="n.to"
          :to="n.to"
          class="flex h-10 items-center gap-2 rounded-lg px-2 text-muted transition hover:bg-accented hover:text-highlighted"
          :class="[
            route.path.startsWith(n.to) ? 'bg-default font-medium text-highlighted shadow-sm ring-1 ring-inset ring-default' : '',
            collapsed ? 'justify-center' : ''
          ]"
          :aria-label="collapsed ? n.label : undefined"
        >
          <UIcon :name="n.icon" class="shrink-0" />
          <span v-if="!collapsed" class="truncate">{{ n.label }}</span>
        </NuxtLink>
      </nav>

      <div v-if="!collapsed" class="px-3 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted">
        Chats
      </div>

      <div class="flex-1 overflow-y-auto px-2 py-2">
        <div
          v-for="c in sortedChats"
          :key="c.id"
          class="group flex min-h-9 items-center gap-1 rounded-lg transition hover:bg-accented"
          :class="route.params.id === c.id ? 'bg-accented font-medium ring-1 ring-inset ring-default/80' : ''"
        >
          <NuxtLink
            :to="`/chats/${c.id}`"
            class="min-w-0 flex-1 truncate px-2 py-2 text-sm"
            :aria-label="collapsed ? c.title : undefined"
          >
            <UIcon v-if="collapsed" :name="isPinned(c.id) ? 'i-lucide-pin' : 'i-lucide-message-square'" />
            <span v-else class="truncate">{{ c.title }}</span>
          </NuxtLink>
          <template v-if="!collapsed">
            <UButton
              size="xs"
              variant="ghost"
              class="rounded-md"
              :icon="isPinned(c.id) ? 'i-lucide-pin-off' : 'i-lucide-pin'"
              :aria-label="isPinned(c.id) ? 'Unpin chat' : 'Pin chat'"
              @click.prevent="togglePin(c)"
            />
            <UButton
              size="xs"
              variant="ghost"
              color="error"
              class="rounded-md"
              icon="i-lucide-trash-2"
              aria-label="Delete chat"
              @click.prevent="deleteChat(c)"
            />
          </template>
        </div>
        <div v-if="!chats.length && !collapsed" class="px-2 py-4 text-xs text-muted">
          No chats yet.
        </div>
      </div>

      <div class="border-t border-default/80 px-3 py-3 text-xs text-muted">
        <div class="flex items-center justify-between gap-2">
          <span v-if="!collapsed" class="truncate">{{ user?.email }}</span>
          <UButton
            size="xs"
            variant="ghost"
            icon="i-lucide-log-out"
            :aria-label="collapsed ? 'Sign out' : undefined"
            @click="signOut"
          />
        </div>
      </div>
    </aside>

    <main class="flex h-full min-w-0 flex-col overflow-hidden">
      <slot />
    </main>
  </div>
</template>
