# AI Ratefinder — Plan of Work

35-day delivery plan, derived from the scope of work, built on the
[`nuxt-ui-templates/chat`](https://github.com/nuxt-ui-templates/chat)
scaffold and the Datalab **Chandra 2** OCR API.

## Tech stack (locked)

| Layer | Choice | Reason |
| --- | --- | --- |
| Framework | Nuxt 4 + Nuxt UI v3 | Base of the chat template |
| Styling | Tailwind CSS v4 (bundled with Nuxt UI) | Already wired in template |
| Hosting | **Vercel** | User choice |
| Database | **Supabase Postgres** + `pg_trgm` + `tsvector` FTS | User choice; trigram fuzzy + full-text in one place |
| Auth | **Supabase Auth (email + password)** via `@nuxtjs/supabase` | Custom signup forms, Supabase backend |
| File storage | **Supabase Storage** | Same vendor as DB + Auth |
| AI SDK | Vercel AI SDK (`ai`) for streaming UI primitives only | We stream tool-call progress, not LLM tokens |
| OCR | Internal parser, **Datalab Chandra 2**, optional **Sarvam Document Intelligence** | Admin-selectable parser modes |
| LLM | **Google Gemini 2.5 Flash** (Pro for hard queries) via `@google/genai` | Used twice: (a) clean Chandra markdown into structured rows at ingest, (b) RAG answers in the chat with JSON-schema-constrained output and citation-by-doc_item_id |
| Excel parsing | `exceljs` | Price list + BOQ ingest |
| PDF/Excel export | `pdfmake` + `exceljs` | Quotation export |
| Fuzzy search | Postgres FTS (`tsvector`) + `pg_trgm` similarity + `fuse.js` for client-side re-rank | Smart search across SKUs |

## Datalab Chandra 2 — integration notes

The hosted API uses an `X-API-Key` header. The flow:

1. **Submit** — `POST https://www.datalab.to/api/v1/convert` (multipart) with
   `file`, `output_format=json|markdown`, `use_llm=true` for higher accuracy on
   tables, `force_ocr=true` for scanned PDFs. Returns
   `{ success, request_id, request_check_url }`.
2. **Poll** — `GET {request_check_url}` with the same header until
   `status === "complete"` (or `"failed"`). Response carries
   `markdown` / `json`, `pages`, `images`, `metadata`, `page_count`.
3. **Parse** — feed the markdown/JSON tables into the extractor pipeline.

We will wrap this in a server util `server/utils/chandra.ts` with
`submitChandra(file, opts)` and `pollChandra(requestCheckUrl, { timeoutMs })`,
plus a queue-friendly variant for long BOQs.

## Sarvam Document Intelligence — integration notes

Sarvam is available as an admin-selectable parser mode for OCR-heavy documents
where HTML table preservation is useful.

1. **Create job** — `client.documentIntelligence.createJob({
   language: "en-IN", outputFormat: "html" })`.
2. **Upload/start/poll** — upload the source PDF/image/ZIP, start the job and
   wait for `Completed` or `PartiallyCompleted`.
3. **Download ZIP** — Sarvam returns a ZIP containing HTML output and companion
   JSON. The server sanitizes the HTML, stores it as document output and parses
   HTML tables back into indexed `doc_items`.

Required env var: `SARVAM_API_KEY`.
Required DB migration: `supabase/migrations/0006_sarvam_parser_settings.sql`.

Supported language values are BCP-47 Indian language codes such as `en-IN`,
`hi-IN`, `ta-IN`, etc. The Admin page stores this per user as
`user_settings.sarvam_language`.

## UI adaptation of the chat template

The chat template gives us:

- streaming chat surface (left = history, centre = thread, right = inspector)
- markdown rendering with code highlighting
- file upload with drag-and-drop via NuxtHub Blob
- persistent history via Drizzle

We will keep the **same shell** and turn each chat into a *workflow thread*:

| Chat-template concept | Ratefinder usage |
| --- | --- |
| Conversation | A **job** (price-list ingest, BOQ run, quotation build) |
| User message | Upload + intent ("ingest this price list", "match this BOQ") |
| Assistant message | Streaming progress + extracted/matched table + actions |
| Tool call | OCR step, parse step, match step, export step |
| Inspector panel | Editable table for corrections, confidence badges, manual override |

The user therefore drives the whole product through a conversational
interface, while the heavy lifting (OCR, matching, quoting) runs as
streamed tool calls.

## Chat behavior standard

The Chat route should behave like ChatGPT:

- `/chats` opens a blank composer immediately.
- Clicking **New chat** navigates to `/chats` without creating or reusing an
  empty chat row.
- A new chat row is created only when the first message is submitted.
- Sidebar/list refreshes happen in the background and must not block route
  changes or button feedback.
- Page data fetches should be lazy/non-blocking unless the page cannot render
  a useful shell without the data.

## 35-day milestones

### Days 1–7 — Front-end shell
- [ ] Fork chat template into this repo, strip GitHub auth (optional re-enable).
- [ ] Rebrand: "AI Ratefinder", colours, logo.
- [ ] Sidebar: **Uploads**, **Price Lists**, **BOQs / RFQs**, **Quotations**, **Master DB**.
- [ ] Global search bar (cmd-k) wired to a `search()` API stub.
- [ ] Editable AG-Grid-style table component (`<RfTable>`) backed by Nuxt UI table + inline edit.
- [ ] Quotation preview route (`/quotations/[id]`) with print stylesheet.

### Days 5–14 — OCR & data extraction
- [ ] `server/utils/chandra.ts` (submit + poll + retry/backoff).
- [ ] `server/api/uploads.post.ts` — accept PDF/Image/Excel, branch by mime.
- [ ] Excel ingest with `exceljs` (sheet/range picker on first upload per vendor).
- [ ] LLM normaliser: feed Chandra markdown to Claude with a strict JSON schema
      (`{ product_name, sku, unit, price, currency, raw_row }`) — Vercel AI SDK
      `generateObject` with Zod schema.
- [ ] Vendor-template memory: store the chosen sheet/column mapping per vendor
      so repeated uploads skip the prompt (groundwork for §8 fine-tuning).
- [ ] `price_list_items` table; weekly overwrite via `effective_from` column.

### Days 10–18 — Master DB & search
- [ ] `products` master table with `canonical_name`, `aliases[]`, `attributes` JSON.
- [ ] SQLite FTS5 virtual table over name + aliases + SKU.
- [ ] `/api/search` — fuzzy (`bm25` + trigram fallback via `fuse.js` server side).
- [ ] Cross-vendor view: one product → many vendor SKUs/prices.
- [ ] Inline edit + alias add UI in the inspector panel.

### Days 15–19 — BOQ / RFQ processing
- [ ] BOQ upload → Chandra (`use_llm=true`, `output_format=json`).
- [ ] Line-item extractor: `{ description, qty, unit, remarks }` Zod schema.
- [ ] BOQ viewer with editable rows + "re-match" button per row.

### Days 20–28 — SKU matching engine
- [ ] Candidate generation: FTS5 top-50 by description.
- [ ] Re-rank: embeddings (Claude / OpenAI) cosine + attribute overlap +
      unit compatibility.
- [ ] Confidence buckets: ≥0.85 auto, 0.6–0.85 suggest, <0.6 manual.
- [ ] UI badges + one-click accept/override; override writes an alias → feeds
      the post-training loop.

### Days 26–32 — Quotation generation
- [ ] Quotation builder: pick vendor(s) per line, apply discount %, GST %, freight.
- [ ] Margin/total/grand-total live recompute.
- [ ] `pdfmake` template (header, party, line items, totals, T&C footer).
- [ ] Excel export via `exceljs` (same data, different renderer).

### Days 30–35 — Testing & deploy
- [ ] Seed real sample documents (≥10 price lists, ≥5 BOQs) into a fixture set.
- [ ] Playwright end-to-end: ingest → match → quote → export.
- [ ] Deploy to NuxtHub (Cloudflare) or Vercel; secrets via `.env`.
- [ ] Bug-fix buffer.

### Days 1–35 (sideline) — Post-training loop
- [ ] Log every manual override into `corrections` (input row, chosen SKU, vendor).
- [ ] Nightly job: promote frequent overrides → permanent aliases.
- [ ] Per-vendor template store (column maps, page-skip rules) — read at ingest.
- [ ] Export `corrections.jsonl` for offline Chandra fine-tuning when volume permits.

## Out of scope (mirrors SOW)
ERP integration, mobile app, advanced analytics, multi-user RBAC, third-party
integrations, real-time vendor APIs, inventory tracking, 100% automation.

## Repo layout (target)

```
ai-ratefinder/
  app/
    components/
      RfTable.vue          # editable table
      UploadDrop.vue
      QuotationPreview.vue
    pages/
      index.vue            # chat shell (workflow threads)
      uploads/index.vue
      master/index.vue
      boqs/[id].vue
      quotations/[id].vue
  server/
    api/
      uploads.post.ts
      search.get.ts
      match.post.ts
      quotations/[id].pdf.get.ts
    utils/
      chandra.ts           # Datalab client
      extract.ts           # LLM-normalised extraction
      matcher.ts           # FTS5 + re-rank
      excel.ts
  shared/
    schemas/               # Zod schemas (LineItem, PriceRow, ...)
  database/
    schema.ts              # Drizzle
    migrations/
```

## Environment variables

```
DATALAB_API_KEY=...                  # Chandra 2 hosted API
GEMINI_API_KEY=...                   # Google AI Studio (Gemini 2.5 Flash)
SARVAM_API_KEY=...                   # Sarvam Document Intelligence
SUPABASE_URL=...
SUPABASE_KEY=...                     # anon key (client)
SUPABASE_SERVICE_ROLE_KEY=...        # server-only, for admin tasks
```
