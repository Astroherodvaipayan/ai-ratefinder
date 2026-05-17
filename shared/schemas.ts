import { z } from 'zod'

export const PriceRow = z.object({
  raw_name: z.string().min(1),
  sku: z.string().nullable(),
  unit: z.string().nullable(),
  price: z.number().nullable(),
  currency: z.string().default('INR'),
  raw_row: z.record(z.string(), z.string()).optional()
})
export type PriceRow = z.infer<typeof PriceRow>

export const BoqLine = z.object({
  line_no: z.number().int().nullable(),
  description: z.string().min(1),
  qty: z.number().nullable(),
  unit: z.string().nullable(),
  remarks: z.string().nullable()
})
export type BoqLine = z.infer<typeof BoqLine>

export const MatchCandidate = z.object({
  product_id: z.string().uuid(),
  canonical_name: z.string(),
  score: z.number(),
  vendor_prices: z.array(z.object({
    vendor_id: z.string().uuid(),
    vendor_name: z.string(),
    price: z.number().nullable(),
    unit: z.string().nullable(),
    sku: z.string().nullable()
  })).optional()
})
export type MatchCandidate = z.infer<typeof MatchCandidate>
