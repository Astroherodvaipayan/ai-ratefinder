<script setup lang="ts">
definePageMeta({ layout: 'default' })

const q = ref('')
const debounced = refDebounced(q, 250)
const { data, refresh } = await useFetch<{ hits: any[] }>(() =>
  debounced.value ? `/api/search?q=${encodeURIComponent(debounced.value)}` : `/api/search?q=`,
  { default: () => ({ hits: [] }) }
)

watch(debounced, () => refresh())
</script>

<template>
  <div class="flex h-full flex-col">
    <header class="border-b border-default px-6 py-4">
      <h1 class="text-base font-semibold">Master catalogue</h1>
      <UInput v-model="q" placeholder="Search products, SKUs, aliases…" class="mt-2 max-w-md" icon="i-lucide-search" />
    </header>
    <div class="flex-1 overflow-y-auto px-6 py-4">
      <UTable
        :rows="data.hits"
        :columns="[
          { key: 'canonical_name', label: 'Product' },
          { key: 'unit',           label: 'Unit' },
          { key: 'score',          label: 'Score' }
        ]"
      />
      <p v-if="!data.hits.length" class="mt-6 text-sm text-muted">
        {{ q ? 'No matches.' : 'Type to search.' }}
      </p>
    </div>
  </div>
</template>
