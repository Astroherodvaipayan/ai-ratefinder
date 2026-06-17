<script setup lang="ts">
definePageMeta({ layout: 'default' })

interface Vendor {
  id: string
  owner_id: string
  name: string
  notes: string | null
  created_at: string
}

interface Doc {
  id: string
  filename: string
  status: string
  page_count: number | null
  item_count: number
  vendor: { id: string; name: string } | null
}

const { data: vendors, refresh: refreshVendors } = useFetch<Vendor[]>('/api/vendors', { default: () => [], lazy: true })
const { data: docs, refresh: refreshDocs } = useFetch<Doc[]>('/api/documents', { default: () => [], lazy: true })
const user = useSupabaseUser()

const name = ref('')
const deletingId = ref<string | null>(null)
const uploadOpen = ref(false)
const uploadVendorName = ref('')
const iconByVendor = ref<Record<string, string>>({})
const iconChoices = [
  'i-lucide-folder',
  'i-lucide-folder-kanban',
  'i-lucide-archive',
  'i-lucide-briefcase-business',
  'i-lucide-cable',
  'i-lucide-zap',
  'i-lucide-store',
  'i-lucide-building-2'
]

const folders = computed(() => {
  const known = vendors.value.map(vendor => ({
    id: vendor.id,
    owner_id: vendor.owner_id,
    name: vendor.name,
    notes: vendor.notes,
    docs: docs.value.filter(doc => doc.vendor?.id === vendor.id)
  }))
  const unassignedDocs = docs.value.filter(doc => !doc.vendor)
  return unassignedDocs.length
    ? [...known, { id: 'unassigned', name: 'Unassigned', notes: null, docs: unassignedDocs }]
    : known
})

function iconFor(vendorId: string) {
  return iconByVendor.value[vendorId] || 'i-lucide-folder'
}

function saveIcons() {
  if (!import.meta.client) return
  localStorage.setItem('ratefinder:vendor-icons', JSON.stringify(iconByVendor.value))
}

function setIcon(vendorId: string, icon: string) {
  iconByVendor.value = { ...iconByVendor.value, [vendorId]: icon }
  saveIcons()
}

function canDeleteVendor(folder: { id: string; owner_id?: string }) {
  return Boolean(folder.id !== 'unassigned' && folder.owner_id && user.value?.id === folder.owner_id)
}

async function add() {
  if (!name.value.trim()) return
  const created = await $fetch<Vendor>('/api/vendors', { method: 'POST', body: { name: name.value.trim() } })
  vendors.value = [
    created,
    ...vendors.value.filter(vendor => vendor.id !== created.id)
  ]
  name.value = ''
  void Promise.all([refreshVendors(), refreshDocs()])
}

async function deleteVendor(folder: { id: string; owner_id?: string; name: string; docs: Doc[] }) {
  if (!canDeleteVendor(folder) || deletingId.value) return

  const suffix = folder.docs.length
    ? ` ${folder.docs.length} document${folder.docs.length === 1 ? '' : 's'} will move to Unassigned.`
    : ''
  if (!confirm(`Delete "${folder.name}" folder?${suffix}`)) return

  deletingId.value = folder.id
  try {
    await $fetch(`/api/vendors/${folder.id}`, { method: 'DELETE' })
    vendors.value = vendors.value.filter(vendor => vendor.id !== folder.id)
    const { [folder.id]: _deleted, ...nextIcons } = iconByVendor.value
    iconByVendor.value = nextIcons
    saveIcons()
    await Promise.all([refreshVendors(), refreshDocs()])
  } finally {
    deletingId.value = null
  }
}

function openVendorUpload(folder: { id: string; name: string }) {
  if (folder.id === 'unassigned') return
  uploadVendorName.value = folder.name
  uploadOpen.value = true
}

async function onDocumentsUploaded() {
  await Promise.all([refreshVendors(), refreshDocs()])
}

onMounted(() => {
  try {
    const saved = JSON.parse(localStorage.getItem('ratefinder:vendor-icons') || '{}')
    if (saved && typeof saved === 'object') iconByVendor.value = saved
  } catch {
    iconByVendor.value = {}
  }
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-default">
    <header class="border-b border-default/80 px-6 py-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0">
          <h1 class="text-base font-semibold">Vendor folders</h1>
          <p class="text-xs text-muted">Each brand keeps its uploaded rate documents together.</p>
        </div>
        <form class="flex gap-2" @submit.prevent="add">
          <UInput v-model="name" placeholder="New vendor name" size="sm" class="w-56" />
          <UButton type="submit" size="sm" icon="i-lucide-folder-plus" class="rounded-lg">Add</UButton>
        </form>
      </div>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <section
          v-for="folder in folders"
          :key="folder.id"
          class="rounded-xl border border-default/80 bg-default p-4 shadow-sm transition hover:shadow-md"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="flex min-w-0 items-center gap-3">
              <div class="grid size-12 shrink-0 place-items-center rounded-xl border border-default bg-muted">
                <UIcon :name="iconFor(folder.id)" class="text-2xl text-toned" />
              </div>
              <div class="min-w-0">
                <h2 class="truncate text-sm font-semibold">{{ folder.name }}</h2>
                <p class="text-xs text-muted">
                  {{ folder.docs.length }} document{{ folder.docs.length === 1 ? '' : 's' }}
                </p>
              </div>
            </div>

            <div class="flex shrink-0 items-center gap-1">
              <UButton
                v-if="canDeleteVendor(folder)"
                size="xs"
                variant="soft"
                icon="i-lucide-upload"
                class="rounded-md"
                aria-label="Upload documents to vendor folder"
                @click="openVendorUpload(folder)"
              >
                Upload
              </UButton>
              <UDropdownMenu
                :items="[iconChoices.map(icon => ({
                  label: icon.replace('i-lucide-', '').replaceAll('-', ' '),
                  icon,
                  onSelect: () => setIcon(folder.id, icon)
                }))]"
              >
                <UButton size="xs" variant="ghost" icon="i-lucide-pencil" class="rounded-md" aria-label="Edit folder icon" />
              </UDropdownMenu>
              <UButton
                v-if="folder.id !== 'unassigned'"
                size="xs"
                variant="ghost"
                color="error"
                icon="i-lucide-trash-2"
                class="rounded-md"
                :loading="deletingId === folder.id"
                aria-label="Delete vendor folder"
                @click="deleteVendor(folder)"
              />
            </div>
          </div>

          <div class="mt-4 space-y-2">
            <NuxtLink
              v-for="doc in folder.docs"
              :key="doc.id"
              :to="`/library/${doc.id}`"
              class="flex items-center justify-between gap-3 rounded-lg border border-default bg-muted px-3 py-2 text-sm transition hover:bg-accented"
            >
              <span class="min-w-0 truncate">{{ doc.filename }}</span>
              <span class="shrink-0 text-xs text-muted">
                {{ doc.item_count }} rows
                <span v-if="doc.page_count"> · {{ doc.page_count }}p</span>
              </span>
            </NuxtLink>

            <div
              v-if="!folder.docs.length"
              class="rounded-lg border border-dashed border-default bg-muted px-3 py-6 text-center text-xs text-muted"
            >
              <p>Upload a rate list and this folder will fill automatically.</p>
              <UButton
                v-if="folder.id !== 'unassigned'"
                size="xs"
                variant="soft"
                icon="i-lucide-upload"
                class="mt-3 rounded-md"
                @click="openVendorUpload(folder)"
              >
                Upload documents
              </UButton>
            </div>
          </div>
        </section>
      </div>
    </div>

    <LazyDocumentUploadModal
      v-model:open="uploadOpen"
      :initial-vendor-name="uploadVendorName"
      lock-vendor
      @uploaded="onDocumentsUploaded"
    />
  </div>
</template>
