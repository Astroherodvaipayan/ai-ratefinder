<script setup lang="ts">
const user = useSupabaseUser()
const route = useRoute()

interface Job { id: string; kind: string; status: string; title: string; created_at: string }
const { data: jobs, refresh } = await useFetch<Job[]>('/api/jobs', { default: () => [] })

const kindLabel = (k: string) => k.replace(/_/g, ' ')

async function newJob(kind: 'ingest_price_list' | 'ingest_boq' | 'build_quotation') {
  const job = await $fetch<Job>('/api/jobs', { method: 'POST', body: { kind } })
  await refresh()
  await navigateTo(`/jobs/${job.id}`)
}

async function signOut() {
  const supabase = useSupabaseClient()
  await supabase.auth.signOut()
  await navigateTo('/login')
}
</script>

<template>
  <div class="grid h-full grid-cols-[260px_1fr]">
    <aside class="flex h-full flex-col border-r border-default bg-elevated">
      <div class="flex items-center justify-between gap-2 px-4 py-3">
        <NuxtLink to="/" class="text-sm font-semibold tracking-tight">
          AI Ratefinder
        </NuxtLink>
        <UDropdownMenu :items="[
          [{ label: 'New price-list ingest', icon: 'i-lucide-upload', click: () => newJob('ingest_price_list') }],
          [{ label: 'New BOQ run',           icon: 'i-lucide-list-checks', click: () => newJob('ingest_boq') }],
          [{ label: 'New quotation',         icon: 'i-lucide-file-text',   click: () => newJob('build_quotation') }]
        ]">
          <UButton icon="i-lucide-plus" size="xs" color="primary" variant="soft" />
        </UDropdownMenu>
      </div>

      <nav class="space-y-1 px-2 pb-2 text-sm">
        <NuxtLink to="/master" class="block rounded px-2 py-1.5 hover:bg-accented" active-class="bg-accented font-medium">
          Master catalogue
        </NuxtLink>
        <NuxtLink to="/vendors" class="block rounded px-2 py-1.5 hover:bg-accented" active-class="bg-accented font-medium">
          Vendors
        </NuxtLink>
      </nav>

      <div class="px-3 pt-2 text-xs uppercase tracking-wide text-muted">
        Threads
      </div>

      <div class="flex-1 overflow-y-auto px-2 py-2">
        <NuxtLink
          v-for="j in jobs"
          :key="j.id"
          :to="`/jobs/${j.id}`"
          class="block truncate rounded px-2 py-1.5 text-sm hover:bg-accented"
          :class="route.params.id === j.id ? 'bg-accented font-medium' : ''"
        >
          <div class="truncate">{{ j.title }}</div>
          <div class="text-[10px] uppercase tracking-wide text-muted">
            {{ kindLabel(j.kind) }} · {{ j.status }}
          </div>
        </NuxtLink>
        <div v-if="!jobs.length" class="px-2 py-4 text-xs text-muted">
          No threads yet. Use + to start one.
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
