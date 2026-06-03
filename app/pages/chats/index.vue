<script setup lang="ts">
import { hasAuthSession } from '~/composables/useAuthSession'

definePageMeta({ layout: 'default' })

interface Chat { id: string }
interface Doc {
  id: string; filename: string; status: string; created_at: string
  vendor: { id: string; name: string } | null
}

const user = useSupabaseUser()
const supabase = useSupabaseClient()
const { data: docs, refresh: refreshDocs } = useFetch<Doc[]>('/api/documents', {
  default: () => [],
  lazy: true,
  immediate: Boolean(user.value),
  watch: false
})

const input = ref('')
const sending = ref(false)
const error = ref<string | null>(null)
const composer = ref<HTMLTextAreaElement | null>(null)
const uploadOpen = ref(false)
const selectedVendorId = ref('')
const selectedDocumentId = ref('')
const draftMessage = ref('')

const vendors = computed(() => {
  const byId = new Map<string, { id: string; name: string }>()
  for (const doc of docs.value) {
    if (doc.vendor) byId.set(doc.vendor.id, doc.vendor)
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
})
const scopedDocs = computed(() =>
  docs.value
    .filter(doc => doc.status === 'parsed')
    .filter(doc => !selectedVendorId.value || doc.vendor?.id === selectedVendorId.value)
)
const selectedVendorLabel = computed(() =>
  vendors.value.find(vendor => vendor.id === selectedVendorId.value)?.name || 'All vendors'
)
const selectedDocumentLabel = computed(() =>
  docs.value.find(doc => doc.id === selectedDocumentId.value)?.filename || 'All documents'
)
const scopeMenuUi = {
  content: 'min-w-[var(--reka-dropdown-menu-trigger-width)] max-w-[min(520px,calc(100vw-32px))] rounded-2xl border border-default/80 bg-default p-1.5 shadow-lg ring-1 ring-default/50',
  viewport: 'max-h-80 overflow-y-auto',
  group: 'p-0.5',
  item: 'rounded-xl px-3 py-2.5 text-sm',
  itemLeadingIcon: 'text-toned',
  itemLabel: 'truncate'
}
const vendorMenuItems = computed(() => [[
  {
    label: 'All vendors',
    icon: 'i-lucide-layers',
    color: 'primary' as const,
    active: !selectedVendorId.value,
    onSelect: () => {
      selectedVendorId.value = ''
      selectedDocumentId.value = ''
    }
  },
  ...vendors.value.map(vendor => ({
    label: vendor.name,
    icon: 'i-lucide-store',
    color: 'primary' as const,
    active: selectedVendorId.value === vendor.id,
    onSelect: () => {
      selectedVendorId.value = vendor.id
    }
  }))
]])
const documentMenuItems = computed(() => [[
  {
    label: 'All documents',
    icon: 'i-lucide-files',
    color: 'primary' as const,
    active: !selectedDocumentId.value,
    onSelect: () => {
      selectedDocumentId.value = ''
    }
  },
  ...scopedDocs.value.map(doc => ({
    label: `${doc.vendor?.name ? `${doc.vendor.name} · ` : ''}${doc.filename}`,
    icon: 'i-lucide-file-text',
    color: 'primary' as const,
    active: selectedDocumentId.value === doc.id,
    onSelect: () => {
      selectedDocumentId.value = doc.id
    }
  }))
]])

watch(selectedVendorId, () => {
  if (selectedDocumentId.value && !scopedDocs.value.some(doc => doc.id === selectedDocumentId.value)) {
    selectedDocumentId.value = ''
  }
})

watch(user, async (value) => {
  if (value) await refreshDocs()
  else docs.value = []
})

async function send() {
  if (!user.value) {
    await navigateTo('/login')
    return
  }

  const content = input.value.trim()
  if (!content || sending.value) return

  sending.value = true
  error.value = null
  draftMessage.value = content
  input.value = ''

  try {
    const chat = await $fetch<Chat>('/api/chats', { method: 'POST', body: {} })
    await $fetch(`/api/chats/${chat.id}/messages`, {
      method: 'POST',
      body: {
        content,
        vendor_id: selectedVendorId.value || undefined,
        document_id: selectedDocumentId.value || undefined
      }
    })
    await refreshNuxtData('sidebar-chats')
    await navigateTo(`/chats/${chat.id}`, { replace: true })
  } catch (err: any) {
    input.value = draftMessage.value
    draftMessage.value = ''
    error.value = err?.statusMessage || err?.message || 'Failed to send'
  } finally {
    sending.value = false
  }
}

function onComposerKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
  event.preventDefault()
  send()
}

async function onDocumentsUploaded() {
  await refreshDocs()
}

onMounted(async () => {
  if (!await hasAuthSession(supabase)) {
    await navigateTo('/login', { replace: true })
    return
  }
  await refreshDocs()
  composer.value?.focus()
})
</script>

<template>
  <div class="relative flex h-full min-h-0 flex-col bg-default">
    <div class="flex min-h-0 flex-1 items-center justify-center px-4 py-8 sm:px-6">
      <div class="w-full max-w-4xl">
        <div class="mb-8 text-center">
          <h1 class="text-xl font-semibold tracking-tight text-highlighted">What prices should we find?</h1>
          <p class="mt-2 text-sm text-muted">Ask for rates, compare vendors, or build a cited proforma.</p>
        </div>

        <div v-if="draftMessage" class="mb-5 flex justify-end">
          <div class="max-w-[82%] whitespace-pre-wrap rounded-[22px] bg-accented px-4 py-2.5 text-sm leading-6 text-highlighted ring-1 ring-inset ring-default sm:max-w-[70%]">
            {{ draftMessage }}
          </div>
        </div>
        <div v-if="sending" class="mb-5 flex items-center justify-center gap-2 text-sm text-muted">
          <UIcon name="i-lucide-loader-2" class="animate-spin" />
          Searching indexed price rows...
        </div>

        <form aria-label="Start a new chat" @submit.prevent="send">
          <p v-if="error" class="mb-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
            {{ error }}
          </p>

          <div class="rounded-[28px] border border-default bg-default p-2 shadow-md ring-1 ring-inset ring-default/60">
            <div class="flex flex-wrap items-center gap-2 px-1 pb-2 sm:px-2">
              <UButton
                type="button"
                size="sm"
                variant="soft"
                color="neutral"
                icon="i-lucide-upload"
                class="h-10 shrink-0 rounded-full px-3"
                aria-label="Upload documents"
                @click="uploadOpen = true"
              >
                <span class="hidden sm:inline">Upload</span>
              </UButton>

              <UDropdownMenu :items="vendorMenuItems" :ui="scopeMenuUi">
                <button
                  type="button"
                  class="flex h-10 min-w-0 flex-1 items-center justify-between gap-3 rounded-full border border-default bg-muted px-3 text-left text-xs transition hover:bg-accented focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlighted sm:min-w-44"
                  aria-label="Choose vendor scope"
                >
                  <span class="flex min-w-0 items-center gap-2">
                    <UIcon name="i-lucide-store" class="shrink-0 text-toned" />
                    <span class="truncate">{{ selectedVendorLabel }}</span>
                  </span>
                  <UIcon name="i-lucide-chevron-down" class="shrink-0 text-muted" />
                </button>
              </UDropdownMenu>

              <UDropdownMenu :items="documentMenuItems" :ui="scopeMenuUi">
                <button
                  type="button"
                  class="flex h-10 min-w-0 flex-[1.4] items-center justify-between gap-3 rounded-full border border-default bg-muted px-3 text-left text-xs transition hover:bg-accented focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlighted sm:min-w-56"
                  aria-label="Choose document scope"
                >
                  <span class="flex min-w-0 items-center gap-2">
                    <UIcon name="i-lucide-file-search" class="shrink-0 text-toned" />
                    <span class="truncate">{{ selectedDocumentLabel }}</span>
                  </span>
                  <UIcon name="i-lucide-chevron-down" class="shrink-0 text-muted" />
                </button>
              </UDropdownMenu>
            </div>

            <div class="flex items-end gap-2">
              <label for="new-chat-composer" class="sr-only">Ask about a product, price, MOQ, vendor, or quotation</label>
              <textarea
                id="new-chat-composer"
                ref="composer"
                v-model="input"
                rows="1"
                class="max-h-36 min-h-12 flex-1 resize-none bg-transparent px-3 py-3 text-sm leading-6 outline-none placeholder:text-muted"
                placeholder="Ask for rates, compare vendors, or build a proforma..."
                :disabled="sending"
                @keydown="onComposerKeydown"
              />
              <UButton
                type="submit"
                :loading="sending"
                :disabled="!input.trim()"
                icon="i-lucide-arrow-up"
                class="mb-1 rounded-full"
                aria-label="Send message"
              />
            </div>
          </div>
        </form>
      </div>
    </div>

    <LazyDocumentUploadModal v-model:open="uploadOpen" @uploaded="onDocumentsUploaded" />
  </div>
</template>
