<script setup lang="ts">
definePageMeta({ layout: 'default' })

interface SourceCell {
  id: string
  row_index: number
  col_index: number
  rowspan: number
  colspan: number
  is_header: boolean
  is_price: boolean
  is_match: boolean
  text: string
  row_headers: string[]
  column_headers: string[]
  parent_headers: string[]
  unit: string | null
  currency: string | null
  moq: string | null
  bbox: Record<string, unknown> | null
}
interface SourceEvidence {
  kind: 'canonical' | 'legacy'
  id: string
  legacy_doc_item_id: string | null
  document: {
    id: string
    filename: string
    mime: string | null
    vendor: string | null
  }
  file_url: string
  source_page: number | null
  table: {
    id: string | null
    title: string | null
    section_breadcrumb: string[]
    row_index: number | null
    col_index: number | null
  }
  match: {
    description: string | null
    sku: string | null
    row_headers: string[]
    column_headers: string[]
    parent_headers: string[]
    nearby_notes: string[]
    raw_cell_value: string | null
    price: number | null
    currency: string
    unit: string | null
    moq: string | null
  }
  cells: SourceCell[]
}

const route = useRoute()
const router = useRouter()
const id = computed(() => route.params.id as string)

const { data: source, pending, error } = useFetch<SourceEvidence>(() => `/api/sources/${id.value}`, {
  lazy: true,
  default: () => null as any
})

const isImageSource = computed(() => source.value?.document.mime?.startsWith('image/') ?? false)
const sourceScope = computed(() => [
  source.value?.document.vendor,
  source.value?.source_page ? `p.${source.value.source_page}` : null
].filter(Boolean).join(' · '))

const contextRows = computed(() => {
  const byRow = new Map<number, SourceCell[]>()
  for (const cell of source.value?.cells ?? []) {
    byRow.set(cell.row_index, [...(byRow.get(cell.row_index) ?? []), cell])
  }
  return [...byRow.entries()]
    .map(([index, cells]) => ({
      index,
      isMatch: source.value?.table.row_index === index || cells.some(cell => cell.is_match),
      cells: cells.sort((a, b) => a.col_index - b.col_index)
    }))
    .sort((a, b) => a.index - b.index)
})

const evidenceLabels = computed(() => {
  const match = source.value?.match
  if (!match) return []
  return [
    { label: 'Row', value: match.row_headers.join(' · ') },
    { label: 'Column', value: match.column_headers.join(' · ') },
    { label: 'Parent', value: match.parent_headers.join(' · ') },
    { label: 'SKU', value: match.sku },
    { label: 'Unit', value: match.unit },
    { label: 'MOQ', value: match.moq }
  ].filter(item => item.value)
})

function goBack() {
  router.back()
}

function formatMoney(n: number | null, currency = 'INR') {
  if (n === null) return '—'
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: currency || 'INR',
      maximumFractionDigits: 2
    }).format(n)
  } catch {
    return `${currency || 'INR'} ${new Intl.NumberFormat('en-IN', {
      maximumFractionDigits: 2
    }).format(n)}`
  }
}

function cellClasses(cell: SourceCell) {
  return [
    'border px-2.5 py-2 align-top text-xs leading-5 transition-colors',
    cell.is_match
      ? 'border-warning bg-warning/20 font-semibold text-highlighted ring-2 ring-inset ring-warning/50'
      : cell.is_header
        ? 'border-default bg-elevated font-medium text-toned'
        : cell.is_price
          ? 'border-default bg-primary/5 text-highlighted'
          : 'border-default bg-default text-toned'
  ]
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-default">
    <header class="flex items-center justify-between gap-3 border-b border-default px-4 py-3 sm:px-6">
      <div class="flex min-w-0 items-center gap-3">
        <UButton variant="ghost" color="neutral" size="sm" icon="i-lucide-arrow-left" aria-label="Back" @click="goBack" />
        <div class="min-w-0">
          <h1 class="truncate text-sm font-semibold">
            {{ source?.document.filename ?? 'Source evidence' }}
          </h1>
          <p class="truncate text-xs text-muted">
            {{ sourceScope || 'Loading source' }}
          </p>
        </div>
      </div>
      <div v-if="source" class="flex shrink-0 items-center gap-2">
        <UButton :to="`/library/${source.document.id}`" size="sm" variant="soft" color="neutral" icon="i-lucide-library">
          Library
        </UButton>
        <UButton :href="source.file_url" target="_blank" size="sm" variant="soft" icon="i-lucide-external-link">
          Open file
        </UButton>
      </div>
    </header>

    <div v-if="pending" class="grid flex-1 place-items-center text-sm text-muted">
      Loading source evidence...
    </div>

    <div v-else-if="error || !source" class="grid flex-1 place-items-center px-6 text-center">
      <div>
        <UIcon name="i-lucide-circle-alert" class="mx-auto mb-3 text-2xl text-error" />
        <p class="text-sm font-medium text-highlighted">Could not load source evidence.</p>
        <p class="mt-1 text-xs text-muted">{{ error?.statusMessage || error?.message || 'Source match not found.' }}</p>
      </div>
    </div>

    <main v-else class="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_420px]">
      <section class="flex min-h-[48vh] min-w-0 flex-col border-b border-default lg:min-h-0 lg:border-b-0 lg:border-r">
        <div class="flex items-center justify-between gap-3 border-b border-default px-4 py-2.5">
          <div class="min-w-0">
            <p class="truncate text-xs font-medium text-toned">Original document</p>
            <p class="truncate text-xs text-muted">
              {{ source.source_page ? `Page ${source.source_page}` : 'Page not captured' }}
            </p>
          </div>
          <UBadge v-if="source.source_page" color="primary" variant="soft" size="sm">
            p.{{ source.source_page }}
          </UBadge>
        </div>
        <div class="min-h-0 flex-1 bg-elevated">
          <img
            v-if="isImageSource"
            :src="source.file_url"
            :alt="source.document.filename"
            class="mx-auto h-full max-w-full object-contain"
          >
          <iframe
            v-else
            :src="source.file_url"
            class="h-full w-full border-0"
            title="Source document"
          />
        </div>
      </section>

      <aside class="min-h-0 overflow-y-auto bg-default">
        <section class="border-b border-default px-4 py-4">
          <p class="text-xs font-medium uppercase text-muted">Matched price</p>
          <div class="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span class="text-2xl font-semibold tabular-nums text-highlighted">
              {{ formatMoney(source.match.price, source.match.currency) }}
            </span>
            <span v-if="source.match.unit" class="text-xs text-muted">/ {{ source.match.unit }}</span>
          </div>
          <p class="mt-2 text-sm leading-5 text-toned">
            {{ source.match.description || source.match.row_headers.join(' · ') || 'Matched source row' }}
          </p>
        </section>

        <section v-if="evidenceLabels.length" class="border-b border-default px-4 py-4">
          <dl class="grid grid-cols-[76px_1fr] gap-y-2 text-xs">
            <template v-for="item in evidenceLabels" :key="item.label">
              <dt class="text-muted">{{ item.label }}</dt>
              <dd class="min-w-0 break-words text-toned">{{ item.value }}</dd>
            </template>
          </dl>
        </section>

        <section class="px-4 py-4">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <h2 class="truncate text-sm font-semibold">Extracted source row</h2>
              <p class="truncate text-xs text-muted">
                {{ source.table.title || source.document.filename }}
              </p>
            </div>
            <UBadge :color="source.kind === 'canonical' ? 'success' : 'neutral'" variant="soft" size="sm">
              {{ source.kind === 'canonical' ? 'Cell match' : 'Page match' }}
            </UBadge>
          </div>

          <div v-if="contextRows.length" class="mt-4 overflow-x-auto rounded-lg border border-default">
            <table class="w-full min-w-[520px] border-collapse text-left">
              <tbody>
                <tr
                  v-for="row in contextRows"
                  :key="row.index"
                  :class="row.isMatch ? 'bg-warning/5' : ''"
                >
                  <td class="w-12 border border-default bg-muted px-2 py-2 text-right text-[11px] text-muted">
                    {{ row.index + 1 }}
                  </td>
                  <td
                    v-for="cell in row.cells"
                    :key="cell.id"
                    :rowspan="cell.rowspan || 1"
                    :colspan="cell.colspan || 1"
                    :class="cellClasses(cell)"
                  >
                    {{ cell.text || '—' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div v-else class="mt-4 rounded-lg border border-default bg-muted/50 px-3 py-3 text-xs leading-5 text-muted">
            No table-cell coordinates were stored for this older source row. The original file is opened on the cited page.
          </div>

          <div v-if="source.match.nearby_notes.length" class="mt-4 border-t border-default pt-3">
            <p class="text-xs font-medium text-toned">Notes</p>
            <ul class="mt-2 space-y-1 text-xs text-muted">
              <li v-for="note in source.match.nearby_notes" :key="note">{{ note }}</li>
            </ul>
          </div>
        </section>
      </aside>
    </main>
  </div>
</template>
