<script setup lang="ts">
definePageMeta({ layout: 'default' })

const { data: vendors, refresh } = await useFetch<any[]>('/api/vendors', { default: () => [] })
const name = ref('')

async function add() {
  if (!name.value.trim()) return
  await $fetch('/api/vendors', { method: 'POST', body: { name: name.value.trim() } })
  name.value = ''
  await refresh()
}
</script>

<template>
  <div class="flex h-full flex-col">
    <header class="border-b border-default px-6 py-4">
      <h1 class="text-base font-semibold">Vendors</h1>
      <div class="mt-2 flex gap-2">
        <UInput v-model="name" placeholder="New vendor name" class="max-w-xs" />
        <UButton size="sm" @click="add">Add</UButton>
      </div>
    </header>
    <div class="flex-1 overflow-y-auto px-6 py-4">
      <UTable
        :rows="vendors"
        :columns="[
          { key: 'name',       label: 'Name' },
          { key: 'notes',      label: 'Notes' },
          { key: 'created_at', label: 'Created' }
        ]"
      />
    </div>
  </div>
</template>
