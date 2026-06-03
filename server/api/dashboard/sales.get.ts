import { computeTotals } from '../../utils/totals'

type QuotationRow = {
  id: string
  title: string
  customer: string | null
  status: string | null
  discount_pct: number | string | null
  gst_pct: number | string | null
  freight: number | string | null
  updated_at: string
}

type ItemRow = {
  quotation_id: string
  vendor: string | null
  qty: number | string | null
  unit_price: number | string | null
}

const num = (value: number | string | null | undefined) =>
  value === null || value === undefined ? 0 : Number(value)

const cleanLabel = (value: string | null | undefined, fallback: string) => {
  const trimmed = value?.trim()
  return trimmed || fallback
}

const compactStatus = (status: string | null | undefined) =>
  cleanLabel(status, 'draft').toLowerCase()

const round2 = (value: number) => Math.round(value * 100) / 100

function topEntries(map: Map<string, { count: number; value: number }>, limit = 5) {
  return [...map.entries()]
    .map(([name, entry]) => ({ name, count: entry.count, value: round2(entry.value) }))
    .sort((a, b) => b.value - a.value || b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit)
}

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const client = await userClient(event)

  const { data: quotations, error: quotationError } = await client
    .from('quotations')
    .select('id, title, customer, status, discount_pct, gst_pct, freight, updated_at')
    .order('updated_at', { ascending: false })

  if (quotationError) throw createError({ statusCode: 500, statusMessage: quotationError.message })

  const quoteRows = (quotations ?? []) as QuotationRow[]
  const ids = quoteRows.map(quote => quote.id)

  let itemRows: ItemRow[] = []
  if (ids.length) {
    const { data: items, error: itemError } = await client
      .from('quotation_items')
      .select('quotation_id, vendor, qty, unit_price')
      .in('quotation_id', ids)

    if (itemError) throw createError({ statusCode: 500, statusMessage: itemError.message })
    itemRows = (items ?? []) as ItemRow[]
  }

  const itemsByQuote = itemRows.reduce((map, item) => {
    const bucket = map.get(item.quotation_id) ?? []
    bucket.push(item)
    map.set(item.quotation_id, bucket)
    return map
  }, new Map<string, ItemRow[]>())

  const statusMap = new Map<string, { count: number; value: number }>()
  const customerMap = new Map<string, { count: number; value: number }>()
  const vendorMap = new Map<string, { count: number; value: number }>()

  let potential = 0
  let draft = 0
  let sent = 0
  let archived = 0
  let openCount = 0
  let sentCount = 0
  let archivedCount = 0
  let lineCount = 0

  const recent = quoteRows.map((quote) => {
    const quoteItems = itemsByQuote.get(quote.id) ?? []
    const totalLines = quoteItems.map(item => ({
      qty: num(item.qty),
      unit_price: num(item.unit_price)
    }))
    const totals = computeTotals(totalLines, {
      discount_pct: num(quote.discount_pct),
      gst_pct: num(quote.gst_pct),
      freight: num(quote.freight)
    })
    const status = compactStatus(quote.status)
    const grandTotal = totals.grand_total
    const isArchived = status === 'archived'

    lineCount += quoteItems.length

    const statusEntry = statusMap.get(status) ?? { count: 0, value: 0 }
    statusEntry.count += 1
    statusEntry.value += grandTotal
    statusMap.set(status, statusEntry)

    if (!isArchived) {
      potential += grandTotal
      openCount += 1

      const customer = cleanLabel(quote.customer, 'No customer')
      const customerEntry = customerMap.get(customer) ?? { count: 0, value: 0 }
      customerEntry.count += 1
      customerEntry.value += grandTotal
      customerMap.set(customer, customerEntry)

      for (const item of quoteItems) {
        const vendor = cleanLabel(item.vendor, 'No vendor')
        const vendorEntry = vendorMap.get(vendor) ?? { count: 0, value: 0 }
        vendorEntry.count += 1
        vendorEntry.value += num(item.qty) * num(item.unit_price)
        vendorMap.set(vendor, vendorEntry)
      }
    }

    if (status === 'sent') {
      sent += grandTotal
      sentCount += 1
    } else if (status === 'archived') {
      archived += grandTotal
      archivedCount += 1
    } else {
      draft += grandTotal
    }

    return {
      id: quote.id,
      title: quote.title,
      customer: quote.customer,
      status,
      updated_at: quote.updated_at,
      grand_total: grandTotal,
      item_count: quoteItems.length
    }
  })

  const status = [...statusMap.entries()]
    .map(([name, entry]) => ({
      name,
      count: entry.count,
      value: round2(entry.value)
    }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))

  return {
    totals: {
      potential: round2(potential),
      draft: round2(draft),
      sent: round2(sent),
      archived: round2(archived),
      quotation_count: quoteRows.length,
      open_count: openCount,
      sent_count: sentCount,
      archived_count: archivedCount,
      average_potential: openCount ? round2(potential / openCount) : 0,
      line_count: lineCount
    },
    status,
    top_customers: topEntries(customerMap),
    top_vendors: topEntries(vendorMap),
    recent: recent.slice(0, 8)
  }
})
