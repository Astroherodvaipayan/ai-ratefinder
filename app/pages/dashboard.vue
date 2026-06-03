<script setup lang="ts">
definePageMeta({ layout: 'default' })

interface MetricEntry {
  name: string
  count: number
  value: number
}

interface RecentQuotation {
  id: string
  title: string
  customer: string | null
  status: string
  updated_at: string
  grand_total: number
  item_count: number
}

interface SalesDashboard {
  totals: {
    potential: number
    draft: number
    sent: number
    archived: number
    quotation_count: number
    open_count: number
    sent_count: number
    archived_count: number
    average_potential: number
    line_count: number
  }
  status: MetricEntry[]
  top_customers: MetricEntry[]
  top_vendors: MetricEntry[]
  recent: RecentQuotation[]
}

const emptyDashboard = (): SalesDashboard => ({
  totals: {
    potential: 0,
    draft: 0,
    sent: 0,
    archived: 0,
    quotation_count: 0,
    open_count: 0,
    sent_count: 0,
    archived_count: 0,
    average_potential: 0,
    line_count: 0
  },
  status: [],
  top_customers: [],
  top_vendors: [],
  recent: []
})

const { data: dashboard, pending, refresh } = useFetch<SalesDashboard>('/api/dashboard/sales', {
  lazy: true,
  default: emptyDashboard
})

const totals = computed(() => dashboard.value.totals)
const maxStatusValue = computed(() => Math.max(...dashboard.value.status.map(item => item.value), 1))
const maxCustomerValue = computed(() => Math.max(...dashboard.value.top_customers.map(item => item.value), 1))
const maxVendorValue = computed(() => Math.max(...dashboard.value.top_vendors.map(item => item.value), 1))

const currency = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0
})

const shortCurrency = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  notation: 'compact',
  maximumFractionDigits: 1
})

const numberFormat = new Intl.NumberFormat('en-IN')
const dateFormat = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit'
})

const money = (value: number) => currency.format(value)
const shortMoney = (value: number) => shortCurrency.format(value)
const count = (value: number) => numberFormat.format(value)
const dateLabel = (value: string) => dateFormat.format(new Date(value))
const titleCase = (value: string) =>
  value.replace(/(^|\s|-)\S/g, match => match.toUpperCase())

const statusColor = (status: string) =>
  status === 'sent' ? 'success' : status === 'archived' ? 'neutral' : 'warning'

const refreshDashboard = () => refresh()

const barStyle = (value: number, max: number) => ({
  width: `${Math.max(4, Math.round((value / max) * 100))}%`
})
</script>

<template>
  <div class="flex h-full flex-col bg-default">
    <header class="border-b border-default px-6 py-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 class="text-lg font-semibold tracking-tight">Sales Dashboard</h1>
          <p class="mt-1 text-sm text-muted">
            Total potential sales from active draft and sent quotations.
          </p>
        </div>
        <UButton
          icon="i-lucide-refresh-cw"
          size="sm"
          variant="outline"
          class="rounded-lg"
          :loading="pending"
          @click="refreshDashboard"
        >
          Refresh
        </UButton>
      </div>
    </header>

    <main class="flex-1 overflow-y-auto px-6 py-5">
      <section class="grid gap-3 md:grid-cols-2 xl:grid-cols-4" aria-label="Sales totals">
        <div class="rounded-lg border border-default bg-muted/35 p-4">
          <div class="flex items-center justify-between gap-3">
            <span class="text-xs font-medium uppercase text-muted">Potential sales</span>
            <UIcon name="i-lucide-indian-rupee" class="text-muted" />
          </div>
          <div class="mt-3 text-2xl font-semibold tabular-nums tracking-tight">
            {{ money(totals.potential) }}
          </div>
          <div class="mt-1 text-xs text-muted">
            {{ count(totals.open_count) }} active quotation{{ totals.open_count === 1 ? '' : 's' }}
          </div>
        </div>

        <div class="rounded-lg border border-default bg-muted/35 p-4">
          <div class="flex items-center justify-between gap-3">
            <span class="text-xs font-medium uppercase text-muted">Sent value</span>
            <UIcon name="i-lucide-send" class="text-muted" />
          </div>
          <div class="mt-3 text-2xl font-semibold tabular-nums tracking-tight">
            {{ money(totals.sent) }}
          </div>
          <div class="mt-1 text-xs text-muted">
            {{ count(totals.sent_count) }} sent quotation{{ totals.sent_count === 1 ? '' : 's' }}
          </div>
        </div>

        <div class="rounded-lg border border-default bg-muted/35 p-4">
          <div class="flex items-center justify-between gap-3">
            <span class="text-xs font-medium uppercase text-muted">Draft value</span>
            <UIcon name="i-lucide-file-pen-line" class="text-muted" />
          </div>
          <div class="mt-3 text-2xl font-semibold tabular-nums tracking-tight">
            {{ money(totals.draft) }}
          </div>
          <div class="mt-1 text-xs text-muted">
            Avg active quote {{ shortMoney(totals.average_potential) }}
          </div>
        </div>

        <div class="rounded-lg border border-default bg-muted/35 p-4">
          <div class="flex items-center justify-between gap-3">
            <span class="text-xs font-medium uppercase text-muted">Quoted lines</span>
            <UIcon name="i-lucide-list-checks" class="text-muted" />
          </div>
          <div class="mt-3 text-2xl font-semibold tabular-nums tracking-tight">
            {{ count(totals.line_count) }}
          </div>
          <div class="mt-1 text-xs text-muted">
            Across {{ count(totals.quotation_count) }} total quotation{{ totals.quotation_count === 1 ? '' : 's' }}
          </div>
        </div>
      </section>

      <section class="mt-5 grid gap-5 xl:grid-cols-[1.15fr_0.85fr]" aria-label="Sales analysis">
        <div class="space-y-5">
          <div class="rounded-lg border border-default bg-default">
            <div class="flex items-center justify-between border-b border-default px-4 py-3">
              <h2 class="text-sm font-semibold">Pipeline By Status</h2>
              <span class="text-xs text-muted">Archived tracked separately</span>
            </div>
            <div class="space-y-3 p-4">
              <div v-if="!dashboard.status.length" class="py-6 text-sm text-muted">
                No quotations yet.
              </div>
              <div v-for="item in dashboard.status" :key="item.name" class="space-y-1.5">
                <div class="flex items-center justify-between gap-3 text-sm">
                  <div class="flex min-w-0 items-center gap-2">
                    <UBadge :color="statusColor(item.name)" variant="soft" class="shrink-0">
                      {{ titleCase(item.name) }}
                    </UBadge>
                    <span class="truncate text-muted">
                      {{ count(item.count) }} quotation{{ item.count === 1 ? '' : 's' }}
                    </span>
                  </div>
                  <span class="shrink-0 font-medium tabular-nums">{{ money(item.value) }}</span>
                </div>
                <div class="h-2 overflow-hidden rounded-full bg-muted">
                  <div class="h-full rounded-full bg-primary" :style="barStyle(item.value, maxStatusValue)" />
                </div>
              </div>
            </div>
          </div>

          <div class="rounded-lg border border-default bg-default">
            <div class="flex items-center justify-between border-b border-default px-4 py-3">
              <h2 class="text-sm font-semibold">Recent Quotations</h2>
              <NuxtLink to="/quotations" class="text-sm font-medium text-primary hover:underline">
                View all
              </NuxtLink>
            </div>
            <div class="overflow-x-auto">
              <table class="min-w-full text-sm">
                <thead class="bg-muted/45 text-left text-xs uppercase text-muted">
                  <tr>
                    <th class="px-4 py-2 font-medium">Quotation</th>
                    <th class="px-4 py-2 font-medium">Customer</th>
                    <th class="px-4 py-2 font-medium">Status</th>
                    <th class="px-4 py-2 text-right font-medium">Value</th>
                    <th class="px-4 py-2 text-right font-medium">Lines</th>
                    <th class="px-4 py-2 text-right font-medium">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-if="!dashboard.recent.length">
                    <td colspan="6" class="px-4 py-8 text-center text-muted">No quotations yet.</td>
                  </tr>
                  <tr
                    v-for="quote in dashboard.recent"
                    :key="quote.id"
                    class="border-t border-default hover:bg-accented"
                  >
                    <td class="max-w-[220px] px-4 py-3">
                      <NuxtLink
                        :to="`/quotations/${quote.id}`"
                        class="font-medium text-highlighted hover:underline"
                      >
                        {{ quote.title }}
                      </NuxtLink>
                    </td>
                    <td class="max-w-[180px] truncate px-4 py-3 text-muted">
                      {{ quote.customer || 'No customer' }}
                    </td>
                    <td class="px-4 py-3">
                      <UBadge :color="statusColor(quote.status)" variant="soft">
                        {{ titleCase(quote.status) }}
                      </UBadge>
                    </td>
                    <td class="px-4 py-3 text-right font-medium tabular-nums">
                      {{ money(quote.grand_total) }}
                    </td>
                    <td class="px-4 py-3 text-right tabular-nums text-muted">
                      {{ count(quote.item_count) }}
                    </td>
                    <td class="px-4 py-3 text-right text-muted">
                      {{ dateLabel(quote.updated_at) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="space-y-5">
          <div class="rounded-lg border border-default bg-default">
            <div class="flex items-center justify-between border-b border-default px-4 py-3">
              <h2 class="text-sm font-semibold">Top Customers</h2>
              <UIcon name="i-lucide-users" class="text-muted" />
            </div>
            <div class="space-y-4 p-4">
              <div v-if="!dashboard.top_customers.length" class="py-6 text-sm text-muted">
                No active customer value yet.
              </div>
              <div v-for="customer in dashboard.top_customers" :key="customer.name" class="space-y-1.5">
                <div class="flex items-center justify-between gap-3 text-sm">
                  <span class="min-w-0 truncate font-medium">{{ customer.name }}</span>
                  <span class="shrink-0 tabular-nums text-muted">{{ shortMoney(customer.value) }}</span>
                </div>
                <div class="h-2 overflow-hidden rounded-full bg-muted">
                  <div class="h-full rounded-full bg-primary" :style="barStyle(customer.value, maxCustomerValue)" />
                </div>
                <div class="text-xs text-muted">
                  {{ count(customer.count) }} active quotation{{ customer.count === 1 ? '' : 's' }}
                </div>
              </div>
            </div>
          </div>

          <div class="rounded-lg border border-default bg-default">
            <div class="flex items-center justify-between border-b border-default px-4 py-3">
              <h2 class="text-sm font-semibold">Top Vendors</h2>
              <UIcon name="i-lucide-store" class="text-muted" />
            </div>
            <div class="space-y-4 p-4">
              <div v-if="!dashboard.top_vendors.length" class="py-6 text-sm text-muted">
                No active vendor value yet.
              </div>
              <div v-for="vendor in dashboard.top_vendors" :key="vendor.name" class="space-y-1.5">
                <div class="flex items-center justify-between gap-3 text-sm">
                  <span class="min-w-0 truncate font-medium">{{ vendor.name }}</span>
                  <span class="shrink-0 tabular-nums text-muted">{{ shortMoney(vendor.value) }}</span>
                </div>
                <div class="h-2 overflow-hidden rounded-full bg-muted">
                  <div class="h-full rounded-full bg-primary" :style="barStyle(vendor.value, maxVendorValue)" />
                </div>
                <div class="text-xs text-muted">
                  {{ count(vendor.count) }} quoted line{{ vendor.count === 1 ? '' : 's' }}
                </div>
              </div>
            </div>
          </div>

          <div class="rounded-lg border border-default bg-muted/35 p-4">
            <div class="flex items-center gap-2 text-sm font-semibold">
              <UIcon name="i-lucide-archive" class="text-muted" />
              Closed or archived value
            </div>
            <div class="mt-3 text-xl font-semibold tabular-nums">{{ money(totals.archived) }}</div>
            <p class="mt-1 text-xs text-muted">
              {{ count(totals.archived_count) }} archived quotation{{ totals.archived_count === 1 ? '' : 's' }} excluded from potential sales.
            </p>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>
