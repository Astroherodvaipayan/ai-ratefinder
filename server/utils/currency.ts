export const PRODUCT_CURRENCY = 'INR'

export function productCurrency() {
  return PRODUCT_CURRENCY
}

export function rupeeDisplayText(value: unknown) {
  if (typeof value !== 'string') return value
  return value
    .replace(/[€$]/g, '₹')
    .replace(/\b(?:EUR|USD)\b/gi, 'INR')
}

export function rupeeDisplayStrings(values: unknown) {
  return Array.isArray(values) ? values.map(value => rupeeDisplayText(value)) : values
}
