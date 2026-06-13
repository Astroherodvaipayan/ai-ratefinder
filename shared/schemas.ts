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
  doc_item_id: z.string().uuid().nullable(),
  doc_price_item_id: z.string().uuid().nullable().optional(),
  product_name: z.string(),
  sku: z.string().nullable(),
  unit: z.string().nullable(),
  price: z.number().nullable(),
  moq: z.string().nullable(),
  currency: z.string().default('INR'),
  vendor: z.string(),
  source_document: z.string().optional(),
  source_page: z.number().int().nullable(),
  confidence: z.number().min(0).max(1),
  needs_review: z.boolean().optional(),
  matched_table: z.string().nullable().optional(),
  matched_row: z.string().nullable().optional(),
  matched_column: z.string().nullable().optional(),
  match_explanation: z.string().nullable().optional(),
  alternatives: z.array(z.object({
    doc_item_id: z.string().uuid().nullable(),
    doc_price_item_id: z.string().uuid().nullable().optional(),
    description: z.string(),
    sku: z.string().nullable(),
    unit: z.string().nullable(),
    price: z.number(),
    currency: z.string().default('INR'),
    vendor: z.string().nullable(),
    source_document: z.string(),
    source_page: z.number().int().nullable(),
    confidence: z.number().min(0).max(1),
    needs_review: z.boolean()
  })).optional()
})
export type ChatItem = z.infer<typeof ChatItem>
