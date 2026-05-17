import ExcelJS from 'exceljs'
import { computeTotals } from './totals'

interface QuotationForXlsx {
  title: string
  customer: string | null
  discount_pct: number
  gst_pct: number
  freight: number
  items: Array<{
    line_no: number
    description: string
    sku: string | null
    unit: string | null
    vendor: string | null
    qty: number
    unit_price: number
  }>
}

export async function renderQuotationXlsx(q: QuotationForXlsx): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Quotation')

  ws.addRow(['Quotation:', q.title])
  if (q.customer) ws.addRow(['Customer:', q.customer])
  ws.addRow([])

  const header = ws.addRow(['#', 'Description', 'SKU', 'Unit', 'Vendor', 'Qty', 'Rate', 'Amount'])
  header.font = { bold: true }
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F4F5' } }

  ws.columns = [
    { width: 5 }, { width: 40 }, { width: 16 }, { width: 10 },
    { width: 16 }, { width: 10 }, { width: 14 }, { width: 14 }
  ]

  for (const i of q.items) {
    ws.addRow([
      i.line_no,
      i.description,
      i.sku ?? '',
      i.unit ?? '',
      i.vendor ?? '',
      Number(i.qty),
      Number(i.unit_price),
      Number(i.qty) * Number(i.unit_price)
    ])
  }

  const totals = computeTotals(q.items, q)
  ws.addRow([])
  ws.addRow(['', '', '', '', '', '', 'Subtotal',  totals.subtotal])
  ws.addRow(['', '', '', '', '', '', `Discount (${q.discount_pct}%)`, -totals.discount])
  ws.addRow(['', '', '', '', '', '', `GST (${q.gst_pct}%)`, totals.gst])
  ws.addRow(['', '', '', '', '', '', 'Freight',   totals.freight])
  const grand = ws.addRow(['', '', '', '', '', '', 'Grand total', totals.grand_total])
  grand.font = { bold: true }

  ws.getColumn(7).numFmt = '#,##0.00'
  ws.getColumn(8).numFmt = '"₹"#,##0.00'

  const buf = await wb.xlsx.writeBuffer()
  return Buffer.from(buf)
}
