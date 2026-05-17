/**
 * Gemini client — used for two jobs:
 *
 *   1. extractPriceRowsLLM(markdown):
 *      Reads Chandra's markdown for a document and returns clean PriceRow[]
 *      records. We use JSON-schema-constrained output so the response is
 *      always parseable; no regex, no string-mangling.
 *
 *   2. answerFromCandidates(question, candidates, history):
 *      The chat brain. Given the user's question, a short conversation
 *      history, and a set of candidate doc_items + surrounding markdown,
 *      it writes a conversational answer and emits cited price cards.
 *
 * Default model: gemini-2.5-flash (fast + cheap, 1M-token context).
 */

import { GoogleGenAI, Type } from '@google/genai'

let client: GoogleGenAI | null = null

function gemini(): GoogleGenAI {
  if (client) return client
  const apiKey = useRuntimeConfig().geminiApiKey
  if (!apiKey) {
    throw createError({ statusCode: 500, statusMessage: 'GEMINI_API_KEY is not configured' })
  }
  client = new GoogleGenAI({ apiKey })
  return client
}

// ---------------------------------------------------------------------------
// 1) Extract clean rows from Chandra markdown
// ---------------------------------------------------------------------------

export interface CleanedPriceRow {
  raw_name: string
  sku: string | null
  unit: string | null
  price: number | null
  moq: string | null
  currency: string
  source_page: number | null
}

const ROW_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    rows: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          raw_name:    { type: Type.STRING },
          sku:         { type: Type.STRING, nullable: true },
          unit:        { type: Type.STRING, nullable: true },
          price:       { type: Type.NUMBER, nullable: true },
          moq:         { type: Type.STRING, nullable: true },
          currency:    { type: Type.STRING },
          source_page: { type: Type.NUMBER, nullable: true }
        },
        required: ['raw_name', 'currency'],
        propertyOrdering: ['raw_name', 'sku', 'unit', 'price', 'moq', 'currency', 'source_page']
      }
    }
  },
  required: ['rows']
}

const EXTRACTION_SYSTEM = `
You are converting a vendor's price-list document into structured JSON rows.
You are given the document as Chandra-extracted markdown. Read every table
and every list, including footnotes that change units or prices.

Rules:
- One JSON row per distinct product / SKU.
- Carry units exactly as the doc states them (e.g. "per 90m coil", "pc",
  "kg", "m"). If a footer says "all prices in ₹/100m", reflect that in the
  unit.
- "moq" is the minimum order quantity — capture it as a short string
  (e.g. "1 coil", "50 pcs"). Leave null if not stated.
- Price must be a number in the document's currency. Default currency to
  "INR" if not specified.
- Do NOT invent products, SKUs, or prices. If a cell is blank, return null.
- Skip total / subtotal / heading rows.
- Preserve the page number if it can be inferred from the markdown.
`.trim()

export async function extractPriceRowsLLM(markdown: string): Promise<CleanedPriceRow[]> {
  if (!markdown.trim()) return []
  const res = await gemini().models.generateContent({
    model: 'gemini-2.5-flash',
    contents: markdown,
    config: {
      systemInstruction: EXTRACTION_SYSTEM,
      responseMimeType: 'application/json',
      responseSchema: ROW_SCHEMA,
      temperature: 0.1
    }
  })

  const text = res.text ?? '{}'
  try {
    const parsed = JSON.parse(text) as { rows?: CleanedPriceRow[] }
    return parsed.rows ?? []
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// 2) Answer a chat question from candidate doc_items
// ---------------------------------------------------------------------------

export interface CandidateRow {
  doc_item_id: string
  product_name: string
  sku: string | null
  unit: string | null
  price: number | null
  moq: string | null
  currency: string
  vendor: string
  source_document: string
  source_page: number | null
  context_md: string                  // ±10 lines of markdown around the row
}

export interface ChatTurn { role: 'user' | 'assistant'; content: string }

export interface ChatAnswer {
  answer_text: string
  items: Array<{
    doc_item_id: string
    product_name: string
    sku: string | null
    unit: string | null
    price: number | null
    moq: string | null
    vendor: string
    source_page: number | null
    confidence: number
  }>
}

const ANSWER_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    answer_text: { type: Type.STRING },
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          doc_item_id:  { type: Type.STRING },
          product_name: { type: Type.STRING },
          sku:          { type: Type.STRING, nullable: true },
          unit:         { type: Type.STRING, nullable: true },
          price:        { type: Type.NUMBER, nullable: true },
          moq:          { type: Type.STRING, nullable: true },
          vendor:       { type: Type.STRING },
          source_page:  { type: Type.NUMBER, nullable: true },
          confidence:   { type: Type.NUMBER }
        },
        required: ['doc_item_id', 'product_name', 'vendor', 'confidence']
      }
    }
  },
  required: ['answer_text', 'items']
}

const ANSWER_SYSTEM = `
You are AI Ratefinder. Answer the user's question using ONLY the candidate
rows supplied to you. Each candidate has a unique doc_item_id — every item
you emit must reference one of those exact ids. Do not invent prices,
vendors, MOQs or SKUs.

Style:
- Conversational, 1–3 short sentences in "answer_text".
- Compare vendors when more than one matches (e.g. "Havells is ₹130
  cheaper per coil than Polycab for the same 2.5 sq.mm grade.").
- If nothing matches confidently, say so honestly and emit items = [].
- Set confidence in [0, 1] reflecting how well the candidate matches the
  user's intent (gauge, brand, length, etc.).
`.trim()

export async function answerFromCandidates(
  question: string,
  candidates: CandidateRow[],
  history: ChatTurn[] = []
): Promise<ChatAnswer> {
  const candidatesBlock = candidates.map(c => ({
    doc_item_id: c.doc_item_id,
    product_name: c.product_name,
    sku: c.sku,
    unit: c.unit,
    price: c.price,
    moq: c.moq,
    currency: c.currency,
    vendor: c.vendor,
    source_document: c.source_document,
    source_page: c.source_page,
    surrounding_markdown: c.context_md
  }))

  const prompt = [
    history.length
      ? `Conversation so far:\n${history.map(h => `${h.role}: ${h.content}`).join('\n')}\n`
      : '',
    `User question:\n${question}\n`,
    `Candidate rows (the only sources you may cite):\n${JSON.stringify(candidatesBlock, null, 2)}`
  ].join('\n')

  const res = await gemini().models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: {
      systemInstruction: ANSWER_SYSTEM,
      responseMimeType: 'application/json',
      responseSchema: ANSWER_SCHEMA,
      temperature: 0.2
    }
  })

  const text = res.text ?? '{}'
  try {
    return JSON.parse(text) as ChatAnswer
  } catch {
    return { answer_text: 'Sorry, I could not parse a confident answer.', items: [] }
  }
}
