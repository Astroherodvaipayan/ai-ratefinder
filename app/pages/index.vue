<script setup lang="ts">
definePageMeta({ layout: 'default' })

const router = useRouter()
async function newJob(kind: 'ingest_price_list' | 'ingest_boq' | 'build_quotation') {
  const job = await $fetch<{ id: string }>('/api/jobs', { method: 'POST', body: { kind } })
  router.push(`/jobs/${job.id}`)
}
</script>

<template>
  <div class="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-8 p-8 text-center">
    <div class="space-y-2">
      <h1 class="text-3xl font-semibold tracking-tight">AI Ratefinder</h1>
      <p class="text-muted">
        Upload vendor price lists and BOQs. We extract, match, and quote.
      </p>
    </div>

    <div class="grid w-full grid-cols-1 gap-3 sm:grid-cols-3">
      <UCard class="cursor-pointer hover:bg-accented" @click="newJob('ingest_price_list')">
        <UIcon name="i-lucide-upload" class="mb-2 text-2xl text-primary" />
        <div class="font-medium">Ingest price list</div>
        <div class="text-xs text-muted">PDF / image / Excel</div>
      </UCard>
      <UCard class="cursor-pointer hover:bg-accented" @click="newJob('ingest_boq')">
        <UIcon name="i-lucide-list-checks" class="mb-2 text-2xl text-primary" />
        <div class="font-medium">Process BOQ</div>
        <div class="text-xs text-muted">Match line items to SKUs</div>
      </UCard>
      <UCard class="cursor-pointer hover:bg-accented" @click="newJob('build_quotation')">
        <UIcon name="i-lucide-file-text" class="mb-2 text-2xl text-primary" />
        <div class="font-medium">Build quotation</div>
        <div class="text-xs text-muted">From a matched BOQ</div>
      </UCard>
    </div>
  </div>
</template>
