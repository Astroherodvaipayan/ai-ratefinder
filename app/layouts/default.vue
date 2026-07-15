<script setup lang="ts">
const user = useSupabaseUser()
const route = useRoute()

interface Chat { id: string; title: string; updated_at: string; message_count?: number }
const { data: chats, refresh: fetchChats } = useFetch<Chat[]>('/api/chats', {
  key: 'sidebar-chats',
  default: () => [],
  lazy: true,
  immediate: Boolean(user.value),
  watch: false
})
const collapsed = ref(false)
const pinnedIds = ref<string[]>([])
const exportingChatIds = ref<string[]>([])
const toast = useToast()
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

  if (route.path !== '/chats') await navigateTo('/chats')
}

async function signOut() {
  const supabase = useSupabaseClient()
  await supabase.auth.signOut()
  await navigateTo('/login')
}

async function exportChat(chat: Chat) {
  if (exportingChatIds.value.includes(chat.id)) return
  exportingChatIds.value = [...exportingChatIds.value, chat.id]

  try {
    await downloadChatExport(chat.id, chat.title)
    toast.add({
      title: 'Chat export ready',
      description: `“${chat.title}” downloaded.`,
      icon: 'i-lucide-circle-check'
    })
  } catch (err: any) {
    toast.add({
      title: 'Export failed',
      description: err?.message || 'Please try again.',
      color: 'error',
      icon: 'i-lucide-circle-alert'
    })
  } finally {
    exportingChatIds.value = exportingChatIds.value.filter(id => id !== chat.id)
  }
}

const profileMenuItems = computed(() => [
  [
    {
      label: user.value?.email || 'Signed in',
      icon: 'i-lucide-user',
      disabled: true
    }
  ],
  [
    {
      label: 'API Cost',
      icon: 'i-lucide-wallet-cards',
      active: route.path.startsWith('/api-cost'),
      onSelect: () => navigateTo('/api-cost')
    }
  ],
  [
    {
      label: 'Sign out',
      icon: 'i-lucide-log-out',
      color: 'error' as const,
      onSelect: signOut
    }
  ]
])

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

function chatMenuItems(chat: Chat) {
  const isExporting = exportingChatIds.value.includes(chat.id)
  return [
    [
      {
        label: isPinned(chat.id) ? 'Unpin chat' : 'Pin chat',
        icon: isPinned(chat.id) ? 'i-lucide-bookmark-x' : 'i-lucide-bookmark',
        onSelect: () => togglePin(chat)
      },
      {
        label: isExporting ? 'Exporting…' : 'Export chat',
        icon: isExporting ? 'i-lucide-loader-circle' : 'i-lucide-download',
        disabled: isExporting,
        onSelect: () => exportChat(chat)
      }
    ],
    [
      {
        label: 'Delete chat',
        icon: 'i-lucide-trash-2',
        color: 'error' as const,
        onSelect: () => deleteChat(chat)
      }
    ]
  ]
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
  { to: '/dashboard', label: 'Sales', icon: 'i-lucide-chart-column' },
  { to: '/library', label: 'Library', icon: 'i-lucide-library' },
  { to: '/quotations', label: 'Quotations', icon: 'i-lucide-file-text' },
  { to: '/vendors', label: 'Vendors', icon: 'i-lucide-store' }
]
</script>

<template>
  <div
    class="grid h-full bg-default transition-[grid-template-columns] duration-200"
    :class="collapsed ? 'grid-cols-[64px_1fr]' : 'grid-cols-[260px_1fr]'"
  >
    <aside class="flex h-full min-w-0 flex-col border-r border-default bg-muted">
      <div class="px-3 py-3">
        <div
          class="flex gap-2"
          :class="collapsed ? 'flex-col items-center' : 'items-center justify-between'"
        >
          <NuxtLink
            to="/chats"
            class="flex min-w-0 items-center gap-2 truncate text-sm font-semibold tracking-tight"
            :aria-label="collapsed ? 'AI Ratefinder home' : undefined"
          >
            <BrandLogo size="sm" />
            <span v-if="!collapsed" class="truncate">AI Ratefinder</span>
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
            class="flex min-w-0 flex-1 items-center gap-1.5 truncate px-2 py-2 text-sm"
            :aria-label="collapsed ? c.title : undefined"
          >
            <UIcon v-if="collapsed" :name="isPinned(c.id) ? 'i-lucide-bookmark' : 'i-lucide-message-square'" />
            <template v-else>
              <UIcon
                v-if="isPinned(c.id)"
                name="i-lucide-bookmark"
                class="shrink-0 text-[13px] text-muted"
              />
              <span class="truncate">{{ c.title }}</span>
            </template>
          </NuxtLink>
          <template v-if="!collapsed">
            <UDropdownMenu :items="chatMenuItems(c)">
              <UButton
                size="xs"
                variant="ghost"
                class="rounded-md opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                icon="i-lucide-ellipsis"
                :aria-label="`Chat actions for ${c.title}`"
                @click.prevent.stop
              />
            </UDropdownMenu>
          </template>
        </div>
        <div v-if="!chats.length && !collapsed" class="px-2 py-4 text-xs text-muted">
          No chats yet.
        </div>
      </div>

      <div class="border-t border-default/80 px-3 py-3 text-xs text-muted">
        <div
          class="flex items-center gap-2"
          :class="collapsed ? 'justify-center' : 'justify-between'"
        >
          <span v-if="!collapsed" class="min-w-0 truncate">{{ user?.email }}</span>
          <UDropdownMenu :items="profileMenuItems">
            <UButton
              size="xs"
              variant="ghost"
              icon="i-lucide-settings"
              class="shrink-0 rounded-md"
              :aria-label="collapsed ? 'Profile settings' : 'Open profile settings'"
            />
          </UDropdownMenu>
        </div>
      </div>
    </aside>

    <main class="flex h-full min-w-0 flex-col overflow-hidden">
      <slot />
    </main>
  </div>
</template>
