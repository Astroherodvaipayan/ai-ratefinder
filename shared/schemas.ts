import { z } from 'zod'

export const PriceRow = z.object({
  raw_name: z.string().min(1),
  sku: z.string().nullable(),
  unit: z.string().nullable(),
  price: z.number().nullable(),
  moq: z.string().nullable(),
  currency: z.string().default('INR'),
  source_page: z.number().int().nullable().optional()
})
export type PriceRow = z.infer<typeof PriceRow>

export const ChatItem = z.object({
  doc_item_id: z.string().uuid(),
  product_name: z.string(),
  sku: z.string().nullable(),
  unit: z.string().nullable(),
  price: z.number().nullable(),
  moq: z.string().nullable(),
  vendor: z.string(),
  source_page: z.number().int().nullable(),
  confidence: z.number().min(0).max(1)
})
export type ChatItem = z.infer<typeof ChatItem>
