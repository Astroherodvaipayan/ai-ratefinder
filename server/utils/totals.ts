export interface LineForTotals {
  qty: number | string
  unit_price: number | string
}

export interface QuotationTotals {
  subtotal: number
  discount: number
  taxable: number
  gst: number
  freight: number
  grand_total: number
}

const num = (v: number | string | null | undefined) =>
  v === null || v === undefined ? 0 : (typeof v === 'string' ? Number(v) : v)

export function computeTotals(
  items: LineForTotals[],
  opts: { discount_pct: number | string; gst_pct: number | string; freight: number | string }
): QuotationTotals {
  const subtotal = items.reduce((s, i) => s + num(i.qty) * num(i.unit_price), 0)
  const discount = subtotal * (num(opts.discount_pct) / 100)
  const taxable = subtotal - discount
  const gst = taxable * (num(opts.gst_pct) / 100)
  const freight = num(opts.freight)
  const grand_total = taxable + gst + freight
  return {
    subtotal: round2(subtotal),
    discount: round2(discount),
    taxable:  round2(taxable),
    gst:      round2(gst),
    freight:  round2(freight),
    grand_total: round2(grand_total)
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100

export const formatInr = (n: number) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 2
  }).format(n)
