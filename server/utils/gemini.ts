/**
 * Gemini client — chat answer layer only.
 *
 * Given the user's question, a short conversation history, and a set of
 * candidate doc_items + surrounding markdown, it writes a conversational
 * answer and emits cited price cards.
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
// Answer a chat question from candidate doc_items
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
  source_uploaded_at: string | null
  source_page: number | null
  context_md: string                  // ±10 lines of markdown around the row
  match_confidence?: number | null
  matched_table?: string | null
  matched_row?: string | null
  matched_column?: string | null
  match_explanation?: string | null
}

export interface ChatTurn { role: 'user' | 'assistant'; content: string }

export interface ChatScope {
  vendorName?: string | null
  documentName?: string | null
}

export interface ChatAnswer {
  answer_text: string
  items: Array<{
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
    confidence: number
    matched_table?: string | null
    matched_row?: string | null
    matched_column?: string | null
    match_explanation?: string | null
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
          currency:     { type: Type.STRING },
          vendor:       { type: Type.STRING },
          source_document: { type: Type.STRING },
          source_page:  { type: Type.NUMBER, nullable: true },
          confidence:   { type: Type.NUMBER },
          matched_table: { type: Type.STRING, nullable: true },
          matched_row: { type: Type.STRING, nullable: true },
          matched_column: { type: Type.STRING, nullable: true },
          match_explanation: { type: Type.STRING, nullable: true }
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
- If the user asks a broad/vague question and candidates span multiple plausible
  vendors or documents, ask which brand/document they want and emit items = [].
- If a vendor or document scope is provided, answer only within that scope.
- If candidates are size/length variants of the same requested product family,
  list the priced variants instead of saying the price is unavailable.
- Set confidence in [0, 1] reflecting how well the candidate matches the
  user's intent (gauge, brand, length, etc.).
- If the same product/SKU appears in multiple uploaded documents, prefer the
  newest source_uploaded_at unless the user explicitly asks for older rates.
- For electrical matrix-table matches, use matched_table, matched_row,
  matched_column, and match_explanation when supplied. These indicate that the
  user's shorthand was mapped to a table title + row + column, even if the
  full query text does not appear literally in the PDF.
`.trim()

export async function answerFromCandidates(
  question: string,
  candidates: CandidateRow[],
  history: ChatTurn[] = [],
  scope: ChatScope = {}
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
    source_uploaded_at: c.source_uploaded_at,
    source_page: c.source_page,
    match_confidence: c.match_confidence,
    matched_table: c.matched_table,
    matched_row: c.matched_row,
    matched_column: c.matched_column,
    match_explanation: c.match_explanation,
    surrounding_markdown: c.context_md
  }))

  const prompt = [
    history.length
      ? `Conversation so far:\n${history.map(h => `${h.role}: ${h.content}`).join('\n')}\n`
      : '',
    `User question:\n${question}\n`,
    scope.vendorName || scope.documentName
      ? `Active search scope:\n${JSON.stringify({
          vendor: scope.vendorName ?? null,
          document: scope.documentName ?? null
        }, null, 2)}\n`
      : '',
    `Candidate rows (the only sources you may cite):\n${JSON.stringify(candidatesBlock, null, 2)}`
  ].join('\n')

  let res: Awaited<ReturnType<ReturnType<typeof gemini>['models']['generateContent']>>
  try {
    res = await gemini().models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        systemInstruction: ANSWER_SYSTEM,
        responseMimeType: 'application/json',
        responseSchema: ANSWER_SCHEMA,
        temperature: 0.2
      }
    })
  } catch (err) {
    const fallbackReason = geminiFallbackReason(err)
    if (fallbackReason) {
      console.warn('Gemini unavailable; falling back to retrieved candidates.', {
        reason: fallbackReason.kind,
        candidateCount: candidates.length
      })
      return fallbackAnswerFromCandidates(candidates, fallbackReason.message)
    }
    throw err
  }

  const text = res.text ?? '{}'
  try {
    return JSON.parse(text) as ChatAnswer
  } catch {
    return { answer_text: 'Sorry, I could not parse a confident answer.', items: [] }
  }
}

function geminiFallbackReason(err: unknown): null | {
  kind: 'billing_or_quota' | 'rate_limit'
  message: string
} {
  const value = err as {
    status?: number | string
    statusCode?: number | string
    code?: number | string
    message?: string
  }
  const numericStatus = Number(value?.status ?? value?.statusCode ?? value?.code)

  const text = [
    value?.status,
    value?.statusCode,
    value?.code,
    value?.message
  ].filter(Boolean).join(' ')

  if (
    /\bprepay(?:ment)?\b|credits? (?:are )?depleted|billing|quota|resource[_ -]?exhausted/i
      .test(text)
  ) {
    return {
      kind: 'billing_or_quota',
      message: 'The AI summarizer is unavailable because the Gemini API quota or billing check failed'
    }
  }

  if (numericStatus === 429 || /\b429\b|rate limit|too many requests/i.test(text)) {
    return {
      kind: 'rate_limit',
      message: 'The AI summarizer is temporarily rate-limited'
    }
  }

  return null
}

function fallbackAnswerFromCandidates(candidates: CandidateRow[], reason: string): ChatAnswer {
  const priced = candidates
    .filter(candidate => candidate.price !== null)
    .slice(0, 8)

  if (!priced.length) {
    return {
      answer_text: `${reason}, and I could not find a priced match in the retrieved document rows.`,
      items: []
    }
  }

  return {
    answer_text: `${reason}, so I’m showing the top ${priced.length} retrieved priced match${priced.length === 1 ? '' : 'es'} directly.`,
    items: priced.map(candidate => ({
      doc_item_id: candidate.doc_item_id,
      product_name: candidate.product_name,
      sku: candidate.sku,
      unit: candidate.unit,
      price: candidate.price,
      moq: candidate.moq,
      currency: candidate.currency,
      vendor: candidate.vendor,
      source_document: candidate.source_document,
      source_page: candidate.source_page,
      confidence: candidate.match_confidence ?? 0.55,
      matched_table: candidate.matched_table ?? null,
      matched_row: candidate.matched_row ?? null,
      matched_column: candidate.matched_column ?? null,
      match_explanation: candidate.match_explanation ?? null
    }))
  }
}

export function constrainChatAnswer(answer: ChatAnswer, candidates: CandidateRow[]): ChatAnswer {
  const byId = new Map(candidates.map(c => [c.doc_item_id, c]))
  const seen = new Set<string>()

  const items = (answer.items ?? []).flatMap((item) => {
    const candidate = byId.get(item.doc_item_id)
    if (!candidate || candidate.price === null || seen.has(candidate.doc_item_id)) return []
    seen.add(candidate.doc_item_id)

    const confidence = Number(item.confidence)
    return [{
      doc_item_id: candidate.doc_item_id,
      product_name: candidate.product_name,
      sku: candidate.sku,
      unit: candidate.unit,
      price: candidate.price,
      moq: candidate.moq,
      currency: candidate.currency,
      vendor: candidate.vendor,
      source_document: candidate.source_document,
      source_page: candidate.source_page,
      confidence: Number.isFinite(confidence)
        ? Math.max(0, Math.min(1, Math.max(confidence, candidate.match_confidence ?? 0)))
        : candidate.match_confidence ?? 0.5,
      matched_table: candidate.matched_table ?? item.matched_table ?? null,
      matched_row: candidate.matched_row ?? item.matched_row ?? null,
      matched_column: candidate.matched_column ?? item.matched_column ?? null,
      match_explanation: candidate.match_explanation ?? item.match_explanation ?? null
    }]
  })

  if (!items.length) {
    return {
      answer_text: answer.answer_text || 'I could not find a confident priced match in your uploaded rate documents.',
      items
    }
  }

  const saysNoPrice = /\b(?:cannot|can't|could not|unable to|no|not available|unavailable)\b.{0,80}\bprice\b/i
    .test(answer.answer_text ?? '')

  return {
    answer_text: saysNoPrice
      ? `I found ${items.length} priced match${items.length === 1 ? '' : 'es'} in your uploaded rate documents.`
      : answer.answer_text || 'I found matching prices in your uploaded rate documents.',
    items
  }
}
