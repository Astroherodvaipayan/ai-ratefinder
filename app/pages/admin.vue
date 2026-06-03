<script setup lang="ts">
definePageMeta({ layout: 'default' })

type ParserMode = 'auto' | 'internal' | 'chandra' | 'sarvam'
type SarvamLanguage = 'en-IN' | 'hi-IN' | 'bn-IN' | 'gu-IN' | 'kn-IN' | 'ml-IN' | 'mr-IN' | 'or-IN' | 'pa-IN' | 'ta-IN' | 'te-IN' | 'ur-IN' | 'as-IN' | 'bodo-IN' | 'doi-IN' | 'ks-IN' | 'kok-IN' | 'mai-IN' | 'mni-IN' | 'ne-IN' | 'sa-IN' | 'sat-IN' | 'sd-IN'

interface EvalRow {
  raw_name: string
  sku: string | null
  unit: string | null
  price: number | null
  moq: string | null
  currency: string
  source_page?: number | null
}

interface EvalSide {
  ok: boolean
  parser: string
  supported?: boolean
  row_count: number
  duration_ms: number
  warnings: string[]
  error: string | null
  rows: EvalRow[]
}

interface EvalResult {
  filename: string
  internal: EvalSide
  chandra: EvalSide
  sarvam: EvalSide
  comparison: {
    shared_count: number
    internal_only_count: number
    chandra_only_count: number
    sarvam_only_count: number
  }
}

const modeOptions: Array<{ value: ParserMode; label: string; description: string; icon: string }> = [
  {
    value: 'auto',
    label: 'Auto',
    description: 'Try internal parser first, then fall back to Chandra if no rows are found.',
    icon: 'i-lucide-sparkles'
  },
  {
    value: 'internal',
    label: 'Internal only',
    description: 'Use deterministic local parsing for Excel, CSV, and text-based PDFs.',
    icon: 'i-lucide-cpu'
  },
  {
    value: 'chandra',
    label: 'Chandra only',
    description: 'Use the OCR and structured extraction pipeline for every upload.',
    icon: 'i-lucide-cloud'
  },
  {
    value: 'sarvam',
    label: 'Sarvam only',
    description: 'Use Sarvam Document Intelligence with HTML table output for every upload.',
    icon: 'i-lucide-table-2'
  }
]

const sarvamLanguageOptions: Array<{ value: SarvamLanguage; label: string }> = [
  { value: 'en-IN', label: 'English' },
  { value: 'hi-IN', label: 'Hindi' },
  { value: 'bn-IN', label: 'Bengali' },
  { value: 'gu-IN', label: 'Gujarati' },
  { value: 'kn-IN', label: 'Kannada' },
  { value: 'ml-IN', label: 'Malayalam' },
  { value: 'mr-IN', label: 'Marathi' },
  { value: 'or-IN', label: 'Odia' },
  { value: 'pa-IN', label: 'Punjabi' },
  { value: 'ta-IN', label: 'Tamil' },
  { value: 'te-IN', label: 'Telugu' },
  { value: 'ur-IN', label: 'Urdu' },
  { value: 'as-IN', label: 'Assamese' },
  { value: 'bodo-IN', label: 'Bodo' },
  { value: 'doi-IN', label: 'Dogri' },
  { value: 'ks-IN', label: 'Kashmiri' },
  { value: 'kok-IN', label: 'Konkani' },
  { value: 'mai-IN', label: 'Maithili' },
  { value: 'mni-IN', label: 'Manipuri' },
  { value: 'ne-IN', label: 'Nepali' },
  { value: 'sa-IN', label: 'Sanskrit' },
  { value: 'sat-IN', label: 'Santali' },
  { value: 'sd-IN', label: 'Sindhi' }
]

const { data: settings, refresh: refreshSettings } = useFetch<{ parser_mode: ParserMode; sarvam_language: SarvamLanguage }>('/api/admin/parser-settings', {
  lazy: true,
  default: () => ({ parser_mode: 'auto' as ParserMode, sarvam_language: 'en-IN' as SarvamLanguage })
})

const selectedMode = ref<ParserMode>(settings.value?.parser_mode ?? 'auto')
const selectedSarvamLanguage = ref<SarvamLanguage>(settings.value?.sarvam_language ?? 'en-IN')
const saving = ref(false)
const saveError = ref<string | null>(null)
const saveSuccess = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const evalResult = ref<EvalResult | null>(null)
const evalError = ref<string | null>(null)
const evaluating = ref(false)

const activeMode = computed(() => settings.value?.parser_mode ?? 'auto')
const activeSarvamLanguage = computed(() => settings.value?.sarvam_language ?? 'en-IN')
const modeChanged = computed(() =>
  selectedMode.value !== activeMode.value
  || selectedSarvamLanguage.value !== activeSarvamLanguage.value
)
const evalSides = computed(() => evalResult.value
  ? [
      { key: 'internal', title: 'Internal parser', icon: 'i-lucide-cpu', data: evalResult.value.internal },
      { key: 'chandra', title: 'Chandra OCR', icon: 'i-lucide-cloud', data: evalResult.value.chandra },
      { key: 'sarvam', title: 'Sarvam OCR', icon: 'i-lucide-table-2', data: evalResult.value.sarvam }
    ]
  : []
)

function statusColor(side: EvalSide) {
  if (!side.ok) return 'error'
  if (side.row_count > 0) return 'success'
  return 'warning'
}

function statusText(side: EvalSide) {
  if (!side.ok) return 'Failed'
  if (side.row_count > 0) return 'Rows found'
  return 'No rows'
}

function formatPrice(row: EvalRow) {
  if (row.price === null) return '-'
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: row.currency || 'INR',
    maximumFractionDigits: 2
  }).format(row.price)
}

async function saveMode() {
  saveError.value = null
  saveSuccess.value = false
  saving.value = true
  try {
    await $fetch('/api/admin/parser-settings', {
      method: 'PUT',
      body: {
        parser_mode: selectedMode.value,
        sarvam_language: selectedSarvamLanguage.value
      }
    })
    await refreshSettings()
    saveSuccess.value = true
  } catch (err: any) {
    saveError.value = err?.statusMessage || err?.message || 'Could not save parser mode'
  } finally {
    saving.value = false
  }
}

async function runEval(file: File) {
  evalError.value = null
  evalResult.value = null
  evaluating.value = true
  try {
    const form = new FormData()
    form.append('file', file)
    evalResult.value = await $fetch<EvalResult>('/api/admin/parser-eval', {
      method: 'POST',
      body: form
    })
  } catch (err: any) {
    evalError.value = err?.statusMessage || err?.message || 'Parser eval failed'
  } finally {
    evaluating.value = false
  }
}

function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) runEval(file)
  input.value = ''
}
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <header class="border-b border-default/80 px-6 py-5">
      <div class="mx-auto flex max-w-5xl flex-col gap-2">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 class="text-lg font-semibold tracking-tight">Admin</h1>
            <p class="text-sm text-muted">Switch extraction mode and compare parser quality on the same file.</p>
          </div>
          <UBadge color="primary" variant="soft" class="capitalize">
            Active: {{ activeMode }}
          </UBadge>
        </div>
      </div>
    </header>

    <main class="flex-1 overflow-y-auto px-6 py-6">
      <div class="mx-auto max-w-5xl space-y-6">
        <section class="rounded-xl border border-default bg-default p-5 shadow-sm">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 class="text-base font-semibold">Parser mode</h2>
              <p class="mt-1 max-w-2xl text-sm text-muted">
                This controls future Library uploads. The eval tool below runs each parser for comparison.
              </p>
            </div>
            <UButton
              :loading="saving"
              :disabled="!modeChanged"
              class="min-h-10 rounded-lg"
              @click="saveMode"
            >
              Save mode
            </UButton>
          </div>

          <div class="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <button
              v-for="option in modeOptions"
              :key="option.value"
              type="button"
              class="min-h-28 rounded-xl border p-4 text-left transition hover:bg-accented focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              :class="selectedMode === option.value ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-default bg-muted/40'"
              @click="selectedMode = option.value"
            >
              <span class="flex items-center gap-2 text-sm font-semibold">
                <UIcon :name="option.icon" class="text-toned" />
                {{ option.label }}
              </span>
              <span class="mt-2 block text-sm text-muted">{{ option.description }}</span>
            </button>
          </div>

          <div class="mt-4 max-w-sm">
            <label for="sarvam-language" class="mb-1 block text-sm font-medium">Sarvam document language</label>
            <select
              id="sarvam-language"
              v-model="selectedSarvamLanguage"
              class="min-h-10 w-full rounded-lg border border-default bg-default px-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <option
                v-for="option in sarvamLanguageOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }} · {{ option.value }}
              </option>
            </select>
          </div>

          <p v-if="saveError" class="mt-3 text-sm text-error">{{ saveError }}</p>
          <p v-else-if="saveSuccess" class="mt-3 text-sm text-success">Parser mode saved.</p>
        </section>

        <section class="rounded-xl border border-default bg-default p-5 shadow-sm">
          <div class="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 class="text-base font-semibold">Parser eval</h2>
              <p class="mt-1 max-w-2xl text-sm text-muted">
                Upload a test file to run internal parsing, Chandra extraction, and Sarvam extraction side by side. Results are not saved to your Library.
              </p>
            </div>
            <div>
              <input
                ref="fileInput"
                type="file"
                class="hidden"
                accept=".pdf,.csv,.xlsx,.png,.jpg,.jpeg,.webp"
                @change="onPick"
              >
              <UButton
                icon="i-lucide-flask-conical"
                :loading="evaluating"
                class="min-h-10 rounded-lg"
                @click="fileInput?.click()"
              >
                Run eval
              </UButton>
            </div>
          </div>

          <p v-if="evalError" class="mt-4 rounded-lg border border-error bg-error/10 px-3 py-2 text-sm text-error">
            {{ evalError }}
          </p>

          <div v-if="evaluating" class="mt-5 rounded-xl border border-dashed border-default bg-muted p-6">
            <div class="mb-2 flex items-center justify-between text-sm">
              <span class="font-medium">Running parsers</span>
              <span class="text-muted">OCR parsers may take a few minutes</span>
            </div>
            <UProgress animation="carousel" />
          </div>

          <div v-if="evalResult" class="mt-5 space-y-5">
            <div class="grid gap-3 md:grid-cols-3 xl:grid-cols-5">
              <div class="rounded-xl border border-default bg-muted p-4">
                <div class="text-xs font-medium uppercase tracking-wide text-muted">File</div>
                <div class="mt-1 truncate text-sm font-semibold">{{ evalResult.filename }}</div>
              </div>
              <div class="rounded-xl border border-default bg-muted p-4">
                <div class="text-xs font-medium uppercase tracking-wide text-muted">Shared</div>
                <div class="mt-1 text-2xl font-semibold tabular-nums">{{ evalResult.comparison.shared_count }}</div>
              </div>
              <div class="rounded-xl border border-default bg-muted p-4">
                <div class="text-xs font-medium uppercase tracking-wide text-muted">Internal only</div>
                <div class="mt-1 text-2xl font-semibold tabular-nums">{{ evalResult.comparison.internal_only_count }}</div>
              </div>
              <div class="rounded-xl border border-default bg-muted p-4">
                <div class="text-xs font-medium uppercase tracking-wide text-muted">Chandra only</div>
                <div class="mt-1 text-2xl font-semibold tabular-nums">{{ evalResult.comparison.chandra_only_count }}</div>
              </div>
              <div class="rounded-xl border border-default bg-muted p-4">
                <div class="text-xs font-medium uppercase tracking-wide text-muted">Sarvam only</div>
                <div class="mt-1 text-2xl font-semibold tabular-nums">{{ evalResult.comparison.sarvam_only_count }}</div>
              </div>
            </div>

            <div class="grid gap-4 2xl:grid-cols-3">
              <article
                v-for="side in evalSides"
                :key="side.key"
                class="overflow-hidden rounded-xl border border-default bg-default"
              >
                <div class="border-b border-default bg-muted px-4 py-3">
                  <div class="flex items-center justify-between gap-3">
                    <div class="flex items-center gap-2">
                      <UIcon :name="side.icon" class="text-toned" />
                      <div>
                        <h3 class="text-sm font-semibold">{{ side.title }}</h3>
                        <p class="text-xs text-muted">{{ side.data.parser }} · {{ side.data.duration_ms }}ms</p>
                      </div>
                    </div>
                    <UBadge :color="statusColor(side.data)" variant="soft">
                      {{ statusText(side.data) }}
                    </UBadge>
                  </div>
                  <div class="mt-3 text-2xl font-semibold tabular-nums">
                    {{ side.data.row_count }}
                    <span class="text-sm font-normal text-muted">rows</span>
                  </div>
                </div>

                <div v-if="side.data.error" class="border-b border-error bg-error/10 px-4 py-3 text-sm text-error">
                  {{ side.data.error }}
                </div>
                <div v-else-if="side.data.warnings.length" class="border-b border-warning bg-warning/10 px-4 py-3 text-sm text-warning">
                  {{ side.data.warnings.join(' ') }}
                </div>

                <div class="max-h-[460px] overflow-auto">
                  <table class="w-full min-w-[680px] text-left text-sm">
                    <thead class="sticky top-0 bg-default text-xs uppercase tracking-wide text-muted">
                      <tr class="border-b border-default">
                        <th class="px-4 py-2 font-medium">Product</th>
                        <th class="px-4 py-2 font-medium">SKU</th>
                        <th class="px-4 py-2 font-medium">Unit</th>
                        <th class="px-4 py-2 text-right font-medium">Price</th>
                        <th class="px-4 py-2 font-medium">Page</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr
                        v-for="(row, index) in side.data.rows"
                        :key="`${side.key}-${index}`"
                        class="border-b border-default/60"
                      >
                        <td class="max-w-72 px-4 py-2 align-top">{{ row.raw_name }}</td>
                        <td class="px-4 py-2 align-top text-muted">{{ row.sku || '-' }}</td>
                        <td class="px-4 py-2 align-top text-muted">{{ row.unit || '-' }}</td>
                        <td class="px-4 py-2 text-right align-top tabular-nums">{{ formatPrice(row) }}</td>
                        <td class="px-4 py-2 align-top text-muted">{{ row.source_page || '-' }}</td>
                      </tr>
                      <tr v-if="!side.data.rows.length">
                        <td colspan="5" class="px-4 py-8 text-center text-muted">
                          No sample rows to show.
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div v-if="side.data.row_count > side.data.rows.length" class="border-t border-default px-4 py-2 text-xs text-muted">
                  Showing first {{ side.data.rows.length }} rows.
                </div>
              </article>
            </div>
          </div>
        </section>
      </div>
    </main>
  </div>
</template>
