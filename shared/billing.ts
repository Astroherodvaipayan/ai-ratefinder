export const API_COST_MONTHLY_BUDGET_INR = 1500
export const API_COST_MARKUP_RATE = 0.25
export const API_COST_DEFAULT_MODE = 'high_accuracy' as const

export const API_COST_RECONCILED_MONTH_TO_DATE = {
  mode: API_COST_DEFAULT_MODE,
  pages: 1100,
  requests: 162,
  baseCostInr: 538
} as const

export const API_COST_RATES = {
  fast_balanced: {
    label: 'Fast and Balanced Mode',
    pricePerThousandPages: 457.20,
    pricePerPage: 0.49
  },
  high_accuracy: {
    label: 'High Accuracy Mode',
    pricePerThousandPages: 489.09,
    pricePerPage: 0.48909
  }
} as const

export type ApiCostMode = keyof typeof API_COST_RATES

export function roundInr(value: number) {
  return Math.round(value * 100) / 100
}

export function apiCostForPages(pages: number, mode: ApiCostMode) {
  return roundInr(Math.max(0, pages) * API_COST_RATES[mode].pricePerPage)
}

export function markedUpApiCost(baseCostInr: number) {
  return roundInr(Math.max(0, baseCostInr) * (1 + API_COST_MARKUP_RATE))
}

export function markedUpApiPricePerPage(mode: ApiCostMode) {
  return roundInr(API_COST_RATES[mode].pricePerPage * (1 + API_COST_MARKUP_RATE))
}

export function markedUpApiPricePerThousandPages(mode: ApiCostMode) {
  return roundInr(API_COST_RATES[mode].pricePerThousandPages * (1 + API_COST_MARKUP_RATE))
}

export function currentBillingMonthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}
