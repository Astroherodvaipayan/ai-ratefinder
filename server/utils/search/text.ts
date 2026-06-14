export function normalizeSearchText(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[×*]/g, ' x ')
    .replace(/\bfr\s*[-_/]?\s*ls\s*h\b/g, ' frlsh ')
    .replace(/\bfr\s*[-_/]?\s*ls\b/g, ' frls ')
    .replace(/\bsq\.?\s*mm\b/g, ' sqmm ')
    .replace(/\bmtrs?\.?\b/g, ' meter ')
    .replace(/\b(\d+(?:\.\d+)?)\s*m\b/g, '$1 meter')
    .replace(/\bmetres?\b/g, ' meter ')
    .replace(/\bmeters?\b/g, ' meter ')
    .replace(/\bnos?\.?\b/g, ' piece ')
    .replace(/\bpcs?\.?\b/g, ' piece ')
    .replace(/\bcopers?\b/g, ' copper ')
    .replace(/\bcoppers?\b/g, ' copper ')
    .replace(/\bbdls?\b/g, ' bundle ')
    .replace(/\bbundles?\b/g, ' bundle ')
    .replace(/\bcu\b/g, ' copper ')
    .replace(/\bal\b/g, ' aluminium ')
    .replace(/\bun\s*[-_/]?\s*arm(?:ou?red|ored|d)?\.?\b/g, ' unarmoured ')
    .replace(/\barm(?:ou?red|ored|d)?\.?\b/g, ' armoured ')
    .replace(/(\d+(?:\.\d+)?)\s*sqmm\s*x\s*(\d+)\s*(?:cores?|core|c)\b/g, '$1 sqmm $2 core')
    .replace(/(\d+)\s*(?:cores?|core|c)\b/g, '$1 core')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([0-9a-z])\s+x\s+([0-9])/g, '$1 $2')
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function compactText(value: string | null | undefined): string {
  return normalizeSearchText(value).replace(/[^a-z0-9.]+/g, '')
}

export function uniqueText(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const normalized = (value ?? '').replace(/\s+/g, ' ').trim()
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
  }
  return out
}

export function tokenize(value: string | null | undefined): string[] {
  const stop = new Set([
    'a', 'about', 'all', 'and', 'any', 'available', 'by', 'can', 'for', 'from',
    'give', 'how', 'in', 'is', 'list', 'of', 'please', 'price', 'prices', 'rate',
    'rates', 'show', 'the', 'to', 'what', 'with'
  ])
  return uniqueText(normalizeSearchText(value)
    .split(' ')
    .filter(token => token && !stop.has(token) && (token.length >= 2 || /^\d$/.test(token))))
}

export function parsePriceNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const cleaned = String(value)
    .replace(/[₹$€,\s]/g, '')
    .replace(/\b(?:rs|inr|mrp|rate|each|ea|pc|pcs|nos?|mtr|meter|kg|box|coil|roll|per)\b/gi, '')
    .replace(/[^\d.\-]/g, '')
  if (!cleaned) return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

export function normalizeUnit(value: string | null | undefined): string | null {
  const text = normalizeSearchText(value)
  if (!text) return null
  if (/\bcoil\b|\broll\b/.test(text)) return 'coil'
  if (/\b(?:meter|mtr|mtrs)\b/.test(text)) return 'meter'
  if (/\b(?:piece|pc|pcs|no|nos)\b/.test(text)) return 'piece'
  if (/\bkg\b|\bkilogram\b/.test(text)) return 'kg'
  if (/\bbox\b/.test(text)) return 'box'
  if (/\bpair\b/.test(text)) return 'pair'
  if (/\bset\b/.test(text)) return 'set'
  return text
}
