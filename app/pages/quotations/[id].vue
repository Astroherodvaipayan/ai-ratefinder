<script setup lang="ts">
definePageMeta({ layout: 'default' })

const route = useRoute()
const id = computed(() => route.params.id as string)

interface Item {
  id: string; line_no: number
  description: string; sku: string | null; unit: string | null
  vendor: string | null; qty: number; unit_price: number
  source_page: number | null
}
interface Totals {
  subtotal: number; discount: number; taxable: number
  gst: number; freight: number; grand_total: number
}
interface Quotation {
  id: string; title: string; customer: string | null
  status: 'draft' | 'sent' | 'archived'
  discount_pct: number; gst_pct: number; freight: number
  notes: string | null
  payment_terms: string | null
  delivery_terms: string | null
  validity: string | null
  revision_no: number
  items: Item[]; totals: Totals
}

const { data: q, refresh } = useFetch<Quotation>(() => `/api/quotations/${id.value}`, {
  lazy: true,
  default: () => null as any
})

// Local debounced field updates
const titleField     = ref(q.value?.title ?? '')
const customerField  = ref(q.value?.customer ?? '')
const discountField  = ref(Number(q.value?.discount_pct ?? 0))
const gstField       = ref(Number(q.value?.gst_pct ?? 18))
const freightField   = ref(Number(q.value?.freight ?? 0))
const paymentTermsField = ref(q.value?.payment_terms ?? '')
const deliveryTermsField = ref(q.value?.delivery_terms ?? '')
const validityField = ref(q.value?.validity ?? '')
const revisionField = ref(Number(q.value?.revision_no ?? 1))
const notesField = ref(q.value?.notes ?? '')

watch(q, (next) => {
  if (!next) return
  titleField.value    = next.title
  customerField.value = next.customer ?? ''
  discountField.value = Number(next.discount_pct)
  gstField.value      = Number(next.gst_pct)
  freightField.value  = Number(next.freight)
  paymentTermsField.value = next.payment_terms ?? ''
  deliveryTermsField.value = next.delivery_terms ?? ''
  validityField.value = next.validity ?? ''
  revisionField.value = Number(next.revision_no ?? 1)
  notesField.value = next.notes ?? ''
}, { immediate: true })

let saveTimer: any
function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveQuotation, 400)
}
async function saveQuotation() {
  await $fetch(`/api/quotations/${id.value}`, {
    method: 'PATCH',
    body: {
      title: titleField.value,
      customer: customerField.value || null,
      discount_pct: Number(discountField.value),
      gst_pct: Number(gstField.value),
      freight: Number(freightField.value),
      payment_terms: paymentTermsField.value || null,
      delivery_terms: deliveryTermsField.value || null,
      validity: validityField.value || null,
      revision_no: Number(revisionField.value) || 1,
      notes: notesField.value || null
    }
  })
  await refresh()
}

async function patchItem(item: Item, patch: Partial<Item>) {
  await $fetch(`/api/quotations/${id.value}/items/${item.id}`, {
    method: 'PATCH',
    body: patch
  })
  await refresh()
}

async function removeItem(item: Item) {
  await $fetch(`/api/quotations/${id.value}/items/${item.id}`, { method: 'DELETE' })
  await refresh()
}

const router = useRouter()
async function destroy() {
  if (!confirm('Delete this quotation?')) return
  await $fetch(`/api/quotations/${id.value}`, { method: 'DELETE' })
  router.push('/quotations')
}

function exportUrl(format: 'pdf' | 'xlsx') {
  return `/api/quotations/${id.value}/export?format=${format}`
}

const formatInr = (n: number | null | undefined) =>
  n === null || n === undefined
    ? '—'
    : new Intl.NumberFormat('en-IN', {
        style: 'currency', currency: 'INR', maximumFractionDigits: 2
      }).format(Number(n))
</script>

<template>
  <div v-if="q" class="flex h-full flex-col">
    <header class="flex items-center justify-between border-b border-default px-6 py-4">
      <div>
        <UInput
          v-model="titleField"
          size="lg" variant="ghost"
          class="font-semibold"
          @blur="scheduleSave"
        />
        <UBadge class="ml-1" variant="soft" :color="q.status === 'sent' ? 'success' : 'warning'">
          {{ q.status }}
        </UBadge>
      </div>
      <div class="flex items-center gap-2">
        <a
          :href="exportUrl('pdf')"
          download
          class="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accented px-2.5 text-sm font-medium text-highlighted transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlighted"
        >
          <UIcon name="i-lucide-download" />
          PDF
        </a>
        <a
          :href="exportUrl('xlsx')"
          download
          class="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accented px-2.5 text-sm font-medium text-highlighted transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlighted"
        >
          <UIcon name="i-lucide-table" />
          Excel
        </a>
        <UButton size="sm" color="error" variant="soft" icon="i-lucide-trash-2" @click="destroy" />
      </div>
    </header>

    <div class="flex-1 overflow-y-auto px-6 py-6">
      <div class="grid grid-cols-1 gap-4 md:grid-cols-4">
        <UFormField label="Customer" class="md:col-span-2">
          <UInput v-model="customerField" @blur="scheduleSave" />
        </UFormField>
        <UFormField label="Discount %">
          <UInput v-model.number="discountField" type="number" step="0.1" @blur="scheduleSave" />
        </UFormField>
        <UFormField label="GST %">
          <UInput v-model.number="gstField" type="number" step="0.1" @blur="scheduleSave" />
        </UFormField>
        <UFormField label="Freight ₹">
          <UInput v-model.number="freightField" type="number" step="1" @blur="scheduleSave" />
        </UFormField>
        <UFormField label="Revision">
          <UInput v-model.number="revisionField" type="number" min="1" step="1" @blur="scheduleSave" />
        </UFormField>
        <UFormField label="Validity">
          <UInput v-model="validityField" placeholder="e.g. 15 days" @blur="scheduleSave" />
        </UFormField>
        <UFormField label="Payment terms" class="md:col-span-2">
          <UInput v-model="paymentTermsField" placeholder="e.g. 50% advance, balance before dispatch" @blur="scheduleSave" />
        </UFormField>
        <UFormField label="Delivery terms" class="md:col-span-2">
          <UInput v-model="deliveryTermsField" placeholder="e.g. Ex-works, 2 weeks from PO" @blur="scheduleSave" />
        </UFormField>
        <UFormField label="Notes" class="md:col-span-2">
          <UTextarea v-model="notesField" :rows="2" @blur="scheduleSave" />
        </UFormField>
      </div>

      <div class="mt-6 rounded-lg border border-default">
        <table class="w-full text-sm">
          <thead class="border-b border-default text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th class="px-3 py-2 w-8">#</th>
              <th class="px-3 py-2">Description</th>
              <th class="px-3 py-2">SKU</th>
              <th class="px-3 py-2">Unit</th>
              <th class="px-3 py-2">Vendor</th>
              <th class="px-3 py-2 text-right w-20">Qty</th>
              <th class="px-3 py-2 text-right w-32">Rate</th>
              <th class="px-3 py-2 text-right w-32">Amount</th>
              <th class="px-3 py-2 w-8"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="i in q.items" :key="i.id" class="border-b border-default">
              <td class="px-3 py-2 text-muted">{{ i.line_no }}</td>
              <td class="px-3 py-2">
                <UInput
                  :model-value="i.description" size="xs" variant="ghost"
                  @change="(v) => patchItem(i, { description: String(v) })"
                />
              </td>
              <td class="px-3 py-2 text-muted">{{ i.sku }}</td>
              <td class="px-3 py-2 text-muted">{{ i.unit }}</td>
              <td class="px-3 py-2 text-muted">{{ i.vendor }}</td>
              <td class="px-3 py-2 text-right">
                <UInput
                  :model-value="i.qty" type="number" step="0.001" size="xs" variant="ghost"
                  class="text-right"
                  @change="(v) => patchItem(i, { qty: Number(v) })"
                />
              </td>
              <td class="px-3 py-2 text-right">
                <UInput
                  :model-value="i.unit_price" type="number" step="0.01" size="xs" variant="ghost"
                  class="text-right"
                  @change="(v) => patchItem(i, { unit_price: Number(v) })"
                />
              </td>
              <td class="px-3 py-2 text-right tabular-nums">
                {{ formatInr(Number(i.qty) * Number(i.unit_price)) }}
              </td>
              <td class="px-3 py-2">
                <UButton size="xs" color="error" variant="ghost" icon="i-lucide-x" @click="removeItem(i)" />
              </td>
            </tr>
            <tr v-if="!q.items.length">
              <td colspan="9" class="px-3 py-8 text-center text-sm text-muted">
                No lines yet. Add items from the Chat page.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="mt-6 flex justify-end">
        <div class="w-72 space-y-1 text-sm">
          <div class="flex justify-between"><span>Subtotal</span> <span>{{ formatInr(q.totals.subtotal) }}</span></div>
          <div class="flex justify-between text-muted"><span>Discount ({{ q.discount_pct }}%)</span> <span>-{{ formatInr(q.totals.discount) }}</span></div>
          <div class="flex justify-between text-muted"><span>GST ({{ q.gst_pct }}%)</span> <span>{{ formatInr(q.totals.gst) }}</span></div>
          <div class="flex justify-between text-muted"><span>Freight</span> <span>{{ formatInr(q.totals.freight) }}</span></div>
          <div class="mt-2 flex justify-between border-t border-default pt-2 text-base font-semibold">
            <span>Grand total</span> <span>{{ formatInr(q.totals.grand_total) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
