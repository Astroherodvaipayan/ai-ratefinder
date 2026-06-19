import type { SupabaseClient } from '@supabase/supabase-js'
import {
  API_COST_DEFAULT_MODE,
  API_COST_MONTHLY_BUDGET_INR,
  API_COST_RATES,
  API_COST_RECONCILED_MONTH_TO_DATE,
  apiCostForPages,
  currentBillingMonthStart,
  markedUpApiCost,
  markedUpApiPricePerPage,
  markedUpApiPricePerThousandPages,
  roundInr,
  type ApiCostMode
} from '~~/shared/billing'

export interface BillingUsageSummary {
  month_start: string
  budget_inr: number
  top_up_amount_inr: number
  top_up_total_inr: number
  credit_limit_inr: number
  total_spend_inr: number
  remaining_inr: number
  balance_inr: number
  total_pages: number
  total_requests: number
  is_over_budget: boolean
  requires_payment: boolean
  has_payment_ref: boolean
  payment_refs: Array<{
    id: string
    reference_no: string
    amount_inr: number
    created_at: string
  }>
  rates: Array<{
    mode: ApiCostMode
    label: string
    price_per_1000_pages: number
    price_per_page: number
    pages: number
    requests: number
    spend_inr: number
  }>
}

function billingMonthDate(monthStartIso: string) {
  return monthStartIso.slice(0, 10)
}

async function loadPaymentRefs(client: SupabaseClient, monthStartIso: string) {
  const { data, error } = await client
    .from('api_payment_refs')
    .select('id, reference_no, amount_inr, created_at')
    .eq('billing_month', billingMonthDate(monthStartIso))
    .order('created_at', { ascending: false })

  if (error) {
    if (/api_payment_refs|schema cache|Could not find the table/i.test(error.message ?? '')) return []
    throw error
  }

  return (data ?? []).map((row: any) => ({
    id: row.id as string,
    reference_no: row.reference_no as string,
    amount_inr: Number(row.amount_inr ?? 0),
    created_at: row.created_at as string
  }))
}

export async function getBillingUsageSummary(
  client: SupabaseClient,
  _ownerId: string,
  now = new Date()
): Promise<BillingUsageSummary> {
  const monthStart = currentBillingMonthStart(now)
  const initial = await client
    .from('documents')
    .select('id, status, page_count, created_at, chandra_request_id, api_cost_mode, api_cost_inr')
    .gte('created_at', monthStart)
  let data: any[] | null = initial.data as any[] | null
  let error = initial.error

  if (error && /api_cost_|schema cache|Could not find/i.test(error.message ?? '')) {
    const retry = await client
      .from('documents')
      .select('id, status, page_count, created_at, chandra_request_id')
      .gte('created_at', monthStart)
    data = retry.data as any[] | null
    error = retry.error
  }

  if (error) throw error

  const breakdown = {
    fast_balanced: { pages: 0, requests: 0, base_spend_inr: 0, spend_inr: 0 },
    high_accuracy: { pages: 0, requests: 0, base_spend_inr: 0, spend_inr: 0 }
  } satisfies Record<ApiCostMode, { pages: number; requests: number; base_spend_inr: number; spend_inr: number }>

  for (const doc of data ?? []) {
    const mode = API_COST_DEFAULT_MODE
    const pages = Math.max(0, Number(doc.page_count ?? 0))
    breakdown[mode].pages += pages
    breakdown[mode].requests += 1
    breakdown[mode].base_spend_inr += apiCostForPages(pages, mode)
  }

  const reconciled = API_COST_RECONCILED_MONTH_TO_DATE
  const reconciledMode = reconciled.mode
  const modeBreakdown = breakdown[reconciledMode]
  if (modeBreakdown.pages <= reconciled.pages) {
    modeBreakdown.pages = reconciled.pages
    modeBreakdown.requests = Math.max(modeBreakdown.requests, reconciled.requests)
    modeBreakdown.base_spend_inr = reconciled.baseCostInr
  } else {
    const extraPages = modeBreakdown.pages - reconciled.pages
    modeBreakdown.requests = Math.max(modeBreakdown.requests, reconciled.requests)
    modeBreakdown.base_spend_inr = reconciled.baseCostInr + apiCostForPages(extraPages, reconciledMode)
  }

  for (const mode of Object.keys(breakdown) as ApiCostMode[]) {
    breakdown[mode].base_spend_inr = roundInr(breakdown[mode].base_spend_inr)
    breakdown[mode].spend_inr = markedUpApiCost(breakdown[mode].base_spend_inr)
  }

  const totalSpend = roundInr(Object.values(breakdown).reduce((sum, item) => sum + item.spend_inr, 0))
  const paymentRefs = await loadPaymentRefs(client, monthStart)
  const topUpTotal = roundInr(paymentRefs.reduce((sum, ref) => sum + ref.amount_inr, 0))
  const creditLimit = roundInr(API_COST_MONTHLY_BUDGET_INR + topUpTotal)
  const balance = roundInr(creditLimit - totalSpend)
  const requiresPayment = balance <= 0

  return {
    month_start: monthStart,
    budget_inr: API_COST_MONTHLY_BUDGET_INR,
    top_up_amount_inr: API_COST_MONTHLY_BUDGET_INR,
    top_up_total_inr: topUpTotal,
    credit_limit_inr: creditLimit,
    total_spend_inr: totalSpend,
    remaining_inr: Math.max(0, balance),
    balance_inr: balance,
    total_pages: Object.values(breakdown).reduce((sum, item) => sum + item.pages, 0),
    total_requests: Object.values(breakdown).reduce((sum, item) => sum + item.requests, 0),
    is_over_budget: requiresPayment,
    requires_payment: requiresPayment,
    has_payment_ref: paymentRefs.length > 0,
    payment_refs: paymentRefs,
    rates: (Object.keys(API_COST_RATES) as ApiCostMode[]).map(mode => ({
      mode,
      label: API_COST_RATES[mode].label,
      price_per_1000_pages: markedUpApiPricePerThousandPages(mode),
      price_per_page: markedUpApiPricePerPage(mode),
      pages: breakdown[mode].pages,
      requests: breakdown[mode].requests,
      spend_inr: roundInr(breakdown[mode].spend_inr)
    }))
  }
}

export async function recordDocumentApiCost(params: {
  client: SupabaseClient
  documentId: string
  pageCount: number | null
  mode?: ApiCostMode
}) {
  const mode = params.mode ?? API_COST_DEFAULT_MODE
  const cost = markedUpApiCost(apiCostForPages(Number(params.pageCount ?? 0), mode))
  const { error } = await params.client
    .from('documents')
    .update({
      api_cost_mode: mode,
      api_cost_inr: cost,
      api_cost_recorded_at: new Date().toISOString()
    })
    .eq('id', params.documentId)

  if (error && !/schema cache|api_cost_|Could not find/i.test(error.message ?? '')) throw error
}
