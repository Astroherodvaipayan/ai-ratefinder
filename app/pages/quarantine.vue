<script setup lang="ts">
definePageMeta({ layout: 'default' })

type OfferStatus = 'published' | 'quarantined'

interface CountOption {
  value: string
  count: number
}

interface CatalogueRow {
  id: string
  document_id: string
  status: OfferStatus
  category: string
  canonical_name: string
  brand: string | null
  sku: string | null
  facets: Record<string, unknown>
  amount: number
  currency: string
  basis_quantity: number | null
  basis_unit: string | null
  package_type: string | null
  moq: string | null
  source_page: number | null
  source_table_index: number | null
  source_row_index: number
  source_col_index: number
  source_table_title: string | null
  source_row_label: string | null
  source_column_label: string | null
  raw_price_value: string
  source_excerpt: string
  validation_errors: string[]
  document: { filename: string } | null
  vendor: { name: string } | null
}

interface CatalogueResponse {
  status: OfferStatus
  release: {
    id: string
    compiler_version: string
    offers_published: number
    offers_quarantined: number
    activated_at: string | null
  }
  summary: {
    total_current: number
    filtered_total: number
    reason_counts: CountOption[]
    category_counts: CountOption[]
  }
  pagination: {
    page: number
    page_size: number
    page_count: number
  }
  rows: CatalogueRow[]
}

const route = useRoute()
const router = useRouter()
const status = ref<OfferStatus>(route.query.status === 'quarantined' ? 'quarantined' : 'published')
const search = ref('')
const reason = ref('')
const category = ref('')
const page = ref(1)
const data = ref<CatalogueResponse | null>(null)
const pending = ref(true)
const loadError = ref<string | null>(null)
const exporting = ref(false)
let filterTimer: ReturnType<typeof setTimeout> | null = null

const isPublished = computed(() => status.value === 'published')
const firstVisible = computed(() => {
  if (!data.value?.summary.filtered_total) return 0
  return (data.value.pagination.page - 1) * data.value.pagination.page_size + 1
})
const lastVisible = computed(() => {
  if (!data.value) return 0
  return Math.min(
    data.value.summary.filtered_total,
    data.value.pagination.page * data.value.pagination.page_size
  )
})

function humanize(value: string) {
  return value.replace(/^missing_required_facet:/, 'Missing ').replaceAll('_', ' ')
}

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2
  }).format(amount)
}

function basisLabel(row: CatalogueRow) {
  if (!row.basis_quantity || !row.basis_unit) return 'Basis unresolved'
  return `per ${row.basis_quantity} ${row.basis_unit}${row.basis_quantity === 1 ? '' : 's'}`
}

async function load() {
  pending.value = true
  loadError.value = null
  try {
    data.value = await $fetch<CatalogueResponse>('/api/catalog/quarantine', {
      query: {
        status: status.value,
        page: page.value,
        page_size: 50,
        search: search.value || undefined,
        reason: status.value === 'quarantined' ? reason.value || undefined : undefined,
        category: category.value || undefined
      }
    })
    page.value = data.value.pagination.page
  } catch (err: any) {
    loadError.value = err?.statusMessage || err?.message || 'Could not load catalogue offers.'
  } finally {
    pending.value = false
  }
}

function scheduleFilterLoad() {
  page.value = 1
  if (filterTimer) clearTimeout(filterTimer)
  filterTimer = setTimeout(load, 250)
}

function selectStatus(next: OfferStatus) {
  if (next === status.value) return
  status.value = next
  reason.value = ''
  category.value = ''
  page.value = 1
  void router.replace({ query: { ...route.query, status: next } })
}

function clearFilters() {
  search.value = ''
  reason.value = ''
  category.value = ''
}

async function exportCsv() {
  if (exporting.value) return
  exporting.value = true
  try {
    const params = new URLSearchParams({ export: 'csv', status: status.value })
    if (search.value) params.set('search', search.value)
    if (reason.value && status.value === 'quarantined') params.set('reason', reason.value)
    if (category.value) params.set('category', category.value)

    const response = await fetch(`/api/catalog/quarantine?${params}`, { credentials: 'same-origin' })
    if (!response.ok) throw new Error('The catalogue export could not be created.')
    const blob = await response.blob()
    const disposition = response.headers.get('content-disposition') ?? ''
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `${status.value}-catalogue.csv`
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  } catch (err: any) {
    loadError.value = err?.message || 'Could not export the catalogue list.'
  } finally {
    exporting.value = false
  }
}

watch([status, search, reason, category], scheduleFilterLoad)
watch(page, (next, previous) => {
  if (next !== previous) void load()
})

onMounted(load)
onBeforeUnmount(() => {
  if (filterTimer) clearTimeout(filterTimer)
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-default">
    <header class="border-b border-default/80 px-4 py-4 sm:px-6">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <h1 class="text-base font-semibold">Catalogue review</h1>
            <UBadge v-if="data" :color="isPublished ? 'success' : 'warning'" variant="soft">
              {{ data.summary.total_current.toLocaleString('en-IN') }} {{ status }}
            </UBadge>
          </div>
          <p class="mt-1 max-w-3xl text-sm text-muted">
            <template v-if="isPublished">
              Source-backed offers currently available to search and use in quotations.
            </template>
            <template v-else>
              Candidates excluded from quotations until their source identity or price basis is unambiguous.
            </template>
          </p>
        </div>
        <UButton
          icon="i-lucide-download"
          variant="soft"
          class="min-h-11 rounded-lg"
          :loading="exporting"
          :disabled="pending || !data?.summary.filtered_total"
          @click="exportCsv"
        >
          Export {{ isPublished ? 'published' : 'quarantined' }} CSV
        </UButton>
      </div>

      <div class="mt-4 inline-flex max-w-full rounded-xl border border-default bg-muted p-1" role="tablist" aria-label="Catalogue publication status">
        <button
          type="button"
          role="tab"
          :aria-selected="isPublished"
          class="flex min-h-11 items-center gap-2 rounded-lg px-4 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          :class="isPublished ? 'bg-default text-highlighted shadow-sm' : 'text-muted hover:text-highlighted'"
          @click="selectStatus('published')"
        >
          <UIcon name="i-lucide-circle-check" aria-hidden="true" />
          Published
          <span class="tabular-nums">{{ data?.release.offers_published.toLocaleString('en-IN') ?? '—' }}</span>
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="!isPublished"
          class="flex min-h-11 items-center gap-2 rounded-lg px-4 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          :class="!isPublished ? 'bg-default text-highlighted shadow-sm' : 'text-muted hover:text-highlighted'"
          @click="selectStatus('quarantined')"
        >
          <UIcon name="i-lucide-shield-alert" aria-hidden="true" />
          Quarantined
          <span class="tabular-nums">{{ data?.release.offers_quarantined.toLocaleString('en-IN') ?? '—' }}</span>
        </button>
      </div>
    </header>

    <main class="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
      <div class="mx-auto max-w-[1600px] space-y-4">
        <section v-if="data" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Catalogue release summary">
          <div class="rounded-xl border border-success/40 bg-success/5 p-4 shadow-sm">
            <p class="text-xs font-medium uppercase tracking-wide text-muted">Published</p>
            <p class="mt-1 text-2xl font-semibold tabular-nums">{{ data.release.offers_published.toLocaleString('en-IN') }}</p>
            <p class="mt-1 text-xs text-muted">Available to search and quote</p>
          </div>
          <div class="rounded-xl border border-warning/40 bg-warning/5 p-4 shadow-sm">
            <p class="text-xs font-medium uppercase tracking-wide text-muted">Quarantined</p>
            <p class="mt-1 text-2xl font-semibold tabular-nums">{{ data.release.offers_quarantined.toLocaleString('en-IN') }}</p>
            <p class="mt-1 text-xs text-muted">Blocked from customer-facing results</p>
          </div>
          <div class="rounded-xl border border-default bg-default p-4 shadow-sm">
            <p class="text-xs font-medium uppercase tracking-wide text-muted">Matching filters</p>
            <p class="mt-1 text-2xl font-semibold tabular-nums">{{ data.summary.filtered_total.toLocaleString('en-IN') }}</p>
            <p class="mt-1 text-xs text-muted">Rows included in CSV export</p>
          </div>
          <div class="rounded-xl border border-default bg-default p-4 shadow-sm">
            <p class="text-xs font-medium uppercase tracking-wide text-muted">Active compiler</p>
            <p class="mt-2 font-mono text-sm font-semibold">{{ data.release.compiler_version }}</p>
            <p class="mt-1 truncate text-xs text-muted" :title="data.release.id">Release {{ data.release.id.slice(0, 8) }}</p>
          </div>
        </section>

        <section class="rounded-xl border border-default bg-default p-4 shadow-sm" aria-label="Catalogue filters">
          <div
            class="grid gap-3"
            :class="isPublished
              ? 'lg:grid-cols-[minmax(280px,1fr)_minmax(200px,0.55fr)_auto]'
              : 'lg:grid-cols-[minmax(240px,1fr)_minmax(220px,0.7fr)_minmax(180px,0.55fr)_auto]'"
          >
            <div>
              <label for="catalogue-search" class="mb-1.5 block text-xs font-medium text-toned">Search catalogue</label>
              <UInput
                id="catalogue-search"
                v-model="search"
                icon="i-lucide-search"
                size="lg"
                placeholder="Product, SKU, brand, source row or price…"
                class="w-full"
              />
            </div>
            <div v-if="!isPublished">
              <label for="catalogue-reason" class="mb-1.5 block text-xs font-medium text-toned">Quarantine reason</label>
              <select
                id="catalogue-reason"
                v-model="reason"
                class="min-h-11 w-full rounded-lg border border-default bg-default px-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <option value="">All reasons</option>
                <option v-for="option in data?.summary.reason_counts ?? []" :key="option.value" :value="option.value">
                  {{ humanize(option.value) }} ({{ option.count }})
                </option>
              </select>
            </div>
            <div>
              <label for="catalogue-category" class="mb-1.5 block text-xs font-medium text-toned">Category</label>
              <select
                id="catalogue-category"
                v-model="category"
                class="min-h-11 w-full rounded-lg border border-default bg-default px-3 text-sm capitalize focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <option value="">All categories</option>
                <option v-for="option in data?.summary.category_counts ?? []" :key="option.value" :value="option.value">
                  {{ humanize(option.value) }} ({{ option.count }})
                </option>
              </select>
            </div>
            <div class="flex items-end">
              <UButton
                variant="ghost"
                color="neutral"
                icon="i-lucide-rotate-ccw"
                class="min-h-11 w-full justify-center rounded-lg lg:w-auto"
                :disabled="!search && !reason && !category"
                @click="clearFilters"
              >
                Reset
              </UButton>
            </div>
          </div>
        </section>

        <div v-if="loadError" role="alert" class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-error bg-error/10 px-4 py-3 text-sm text-error">
          <span>{{ loadError }}</span>
          <UButton color="error" variant="soft" size="sm" icon="i-lucide-refresh-cw" @click="load">Retry</UButton>
        </div>

        <section class="overflow-hidden rounded-xl border border-default bg-default shadow-sm" :aria-label="`${status} catalogue offers`">
          <div class="flex flex-wrap items-center justify-between gap-2 border-b border-default px-4 py-3 text-sm">
            <p class="text-muted" aria-live="polite">
              <template v-if="pending">Loading {{ status }} catalogue offers…</template>
              <template v-else-if="data?.summary.filtered_total">
                Showing <span class="font-medium text-highlighted">{{ firstVisible }}–{{ lastVisible }}</span>
                of <span class="font-medium text-highlighted">{{ data.summary.filtered_total.toLocaleString('en-IN') }}</span>
              </template>
              <template v-else>No matching {{ status }} items</template>
            </p>
            <p class="text-xs text-muted">Expand any row to inspect its original source evidence.</p>
          </div>

          <div v-if="pending" class="space-y-3 p-4">
            <USkeleton v-for="n in 7" :key="n" class="h-20 w-full rounded-lg" />
          </div>

          <div v-else-if="data?.rows.length" class="divide-y divide-default">
            <details v-for="row in data.rows" :key="row.id" class="group open:bg-muted/30">
              <summary class="grid cursor-pointer list-none gap-3 px-4 py-4 transition hover:bg-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary lg:grid-cols-[minmax(260px,1.2fr)_minmax(210px,0.8fr)_minmax(130px,0.45fr)_minmax(250px,0.9fr)_24px] lg:items-center">
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <UBadge color="neutral" variant="soft" size="xs" class="capitalize">{{ humanize(row.category) }}</UBadge>
                    <span v-if="row.sku" class="font-mono text-xs text-muted">{{ row.sku }}</span>
                  </div>
                  <p class="mt-1.5 break-words text-sm font-semibold text-highlighted">{{ row.canonical_name }}</p>
                  <p class="mt-1 truncate text-xs text-muted" :title="row.document?.filename ?? 'Unknown document'">
                    {{ row.vendor?.name || row.brand || 'Unknown vendor' }} · {{ row.document?.filename || 'Unknown document' }}
                  </p>
                </div>

                <div class="min-w-0">
                  <p class="text-xs font-medium uppercase tracking-wide text-muted">{{ isPublished ? 'Publication status' : 'Why blocked' }}</p>
                  <div class="mt-1.5 flex flex-wrap gap-1.5">
                    <UBadge v-if="isPublished" color="success" variant="soft" size="xs" icon="i-lucide-circle-check">
                      Ready to quote
                    </UBadge>
                    <UBadge v-for="item in row.validation_errors" v-else :key="item" color="warning" variant="soft" size="xs">
                      {{ humanize(item) }}
                    </UBadge>
                  </div>
                  <p v-if="isPublished" class="mt-1 text-xs text-muted">Raw source amount reconstructed exactly</p>
                </div>

                <div>
                  <p class="text-xs font-medium uppercase tracking-wide text-muted">{{ isPublished ? 'Quoted price' : 'Detected price' }}</p>
                  <p class="mt-1 text-sm font-semibold tabular-nums">{{ formatCurrency(row.amount) }}</p>
                  <p class="text-xs" :class="row.basis_quantity && row.basis_unit ? 'text-muted' : 'font-medium text-warning'">
                    {{ basisLabel(row) }}
                  </p>
                </div>

                <div class="min-w-0">
                  <p class="text-xs font-medium uppercase tracking-wide text-muted">Source position</p>
                  <p class="mt-1 truncate text-sm" :title="row.source_row_label ?? ''">{{ row.source_row_label || 'No row identity' }}</p>
                  <p class="truncate text-xs text-muted" :title="row.source_column_label ?? ''">
                    Page {{ row.source_page ?? '—' }} · table {{ row.source_table_index ?? '—' }} · row {{ row.source_row_index }} · column {{ row.source_col_index }}
                  </p>
                </div>

                <UIcon name="i-lucide-chevron-down" class="hidden text-muted transition-transform duration-200 group-open:rotate-180 lg:block" aria-hidden="true" />
              </summary>

              <div class="grid gap-4 border-t border-default/70 bg-muted/40 px-4 py-4 lg:grid-cols-2">
                <div class="space-y-3">
                  <div>
                    <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">Source excerpt</h3>
                    <pre class="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-default bg-default p-3 font-mono text-xs leading-5">{{ row.source_excerpt }}</pre>
                  </div>
                  <UButton
                    :to="`/library/${row.document_id}`"
                    size="sm"
                    variant="soft"
                    color="neutral"
                    icon="i-lucide-file-search"
                    class="min-h-11 rounded-lg"
                  >
                    Open source document
                  </UButton>
                </div>

                <dl class="grid content-start gap-x-4 gap-y-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt class="text-xs text-muted">Raw price cell</dt>
                    <dd class="mt-0.5 font-mono font-medium">{{ row.raw_price_value }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs text-muted">Source column</dt>
                    <dd class="mt-0.5 break-words">{{ row.source_column_label || 'Not detected' }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs text-muted">Package / MOQ</dt>
                    <dd class="mt-0.5">{{ row.package_type || '—' }} / {{ row.moq || '—' }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs text-muted">Catalogue status</dt>
                    <dd class="mt-0.5 capitalize">{{ row.status }}</dd>
                  </div>
                  <div class="sm:col-span-2">
                    <dt class="text-xs text-muted">Record ID</dt>
                    <dd class="mt-0.5 break-all font-mono text-xs">{{ row.id }}</dd>
                  </div>
                  <div class="sm:col-span-2">
                    <dt class="text-xs text-muted">Detected facets</dt>
                    <dd class="mt-1 overflow-auto rounded-lg border border-default bg-default p-3 font-mono text-xs">{{ JSON.stringify(row.facets, null, 2) }}</dd>
                  </div>
                </dl>
              </div>
            </details>
          </div>

          <div v-else-if="!loadError" class="px-4 py-16 text-center">
            <UIcon name="i-lucide-search-x" class="text-3xl text-muted" />
            <h2 class="mt-3 text-sm font-semibold">No matching items</h2>
            <p class="mt-1 text-sm text-muted">Try a broader search or reset the filters.</p>
            <UButton v-if="search || reason || category" variant="soft" class="mt-4 min-h-11 rounded-lg" @click="clearFilters">Reset filters</UButton>
          </div>

          <nav v-if="data && data.pagination.page_count > 1" class="flex items-center justify-between gap-3 border-t border-default px-4 py-3" :aria-label="`${status} catalogue pages`">
            <UButton
              variant="soft"
              color="neutral"
              icon="i-lucide-arrow-left"
              class="min-h-11 rounded-lg"
              :disabled="page <= 1 || pending"
              @click="page--"
            >
              Previous
            </UButton>
            <span class="text-sm tabular-nums text-muted">Page {{ data.pagination.page }} of {{ data.pagination.page_count }}</span>
            <UButton
              variant="soft"
              color="neutral"
              trailing-icon="i-lucide-arrow-right"
              class="min-h-11 rounded-lg"
              :disabled="page >= data.pagination.page_count || pending"
              @click="page++"
            >
              Next
            </UButton>
          </nav>
        </section>
      </div>
    </main>
  </div>
</template>
