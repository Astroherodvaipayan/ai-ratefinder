# AI Ratefinder

A private library of vendor price docs you can chat with.

- Drop vendor PDFs / images / Excel files into the **Library**.
- Uploaded docs are parsed by the selected extraction mode: internal table
  parsing, **Datalab Chandra 2**, or **Sarvam Document Intelligence** with HTML
  table output. Extracted rows (product · SKU · unit · price · MOQ · currency ·
  source page) are indexed in Postgres.
- Open **Chat** and ask in plain English ("price of polycab 2.5mm wire?" or
  multiple SKUs at once). New Chat opens a blank composer immediately, like
  ChatGPT; the chat is created only when the first message is sent. Gemini
  answers from your library and emits cited price cards.
- Every priced chat answer automatically creates or updates that chat's draft
  **proforma invoice**. Review qty / discount / GST / freight, then download
  as **PDF or Excel**.

See [`PLAN.md`](./PLAN.md) for the 35-day delivery plan and
[`FLOW.md`](./FLOW.md) for the flow + mockups.

## Stack

- Nuxt 4 + Nuxt UI v3 (chat-style shell)
- Supabase Postgres + Auth + Storage (RLS on every table)
- Internal parser for Excel, CSV and text PDFs
- Datalab Chandra 2 OCR
- Sarvam Document Intelligence OCR (`outputFormat: "html"`)
- Google Gemini 2.5 Flash (extraction + RAG chat, JSON-schema constrained)
- `pdfmake` + `exceljs` for quotation export
- Vercel for hosting

## Local dev

```bash
cp .env.example .env       # fill the required keys for your setup
npm install
npm run dev
```

## Supabase setup

1. Create a project at supabase.com.
2. SQL editor → run every file in `supabase/migrations/` in numeric order.
3. Storage → create a private bucket called `uploads`.
4. Authentication → Email provider → enable email + password.
5. Copy `Project URL`, `anon key`, `service_role key` into `.env`.

## Keys

- **Datalab Chandra 2** — https://www.datalab.to → `DATALAB_API_KEY`
- **Google AI Studio (Gemini)** — https://aistudio.google.com → `GEMINI_API_KEY`
- **Sarvam Document Intelligence** — https://sarvam.ai → `SARVAM_API_KEY`

## Parser modes

Admins can choose the parser in **Admin → Parser mode**:

| Mode | Behavior |
| --- | --- |
| `auto` | Try the internal parser first, then fall back to Chandra when no usable rows are found. |
| `internal` | Use local parsing for Excel, CSV and text-based PDFs. |
| `chandra` | Use Datalab Chandra OCR/extraction for every upload. |
| `sarvam` | Use Sarvam Document Intelligence with `outputFormat: "html"` for every upload. |

Sarvam requires `SARVAM_API_KEY` and `supabase/migrations/0006_sarvam_parser_settings.sql`.
The Admin page also stores the Sarvam document language, defaulting to `en-IN`.

## Chat behavior

- `/chats` is always a fresh blank composer.
- Clicking **New chat** navigates immediately to `/chats`; it does not create
  or reuse an empty thread.
- The first submitted message creates the chat, persists the message, then
  opens the new thread.
- Sidebar and route data refresh in the background so navigation remains fast.

## Deploy to Vercel

```bash
npx vercel
```

Set the env vars (`DATALAB_API_KEY`, `GEMINI_API_KEY`, `SARVAM_API_KEY`,
`SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) in the project
settings. `SARVAM_API_KEY` is only required when the Sarvam parser mode is used.

## API surface

| Method | Path                                          | Purpose                                   |
| -----: | --------------------------------------------- | ----------------------------------------- |
|    GET | `/api/documents`                              | List docs in your library                 |
|   POST | `/api/documents`                              | Upload file → OCR → extract → index       |
|    GET | `/api/documents/:id`                          | Doc + extracted rows                      |
|    GET | `/api/documents/:id/file`                     | Signed URL to original                    |
| DELETE | `/api/documents/:id`                          | Remove doc + rows                         |
|    GET | `/api/chats`                                  | Recent chat threads                       |
|   POST | `/api/chats`                                  | New chat                                  |
|    GET | `/api/chats/:id/messages`                     | Full transcript                           |
|   POST | `/api/chats/:id/messages`                     | Ask Gemini, get answer + cited items + draft proforma |
|    GET | `/api/quotations`                             | Your quotations                           |
|   POST | `/api/quotations`                             | Create draft                              |
|    GET | `/api/quotations/:id`                         | Quotation + items + live totals           |
|  PATCH | `/api/quotations/:id`                         | Edit customer / discount / GST / freight  |
|   POST | `/api/quotations/:id/items`                   | Add line (from doc_item or freeform)      |
|  PATCH | `/api/quotations/:id/items/:itemId`           | Edit a line                               |
| DELETE | `/api/quotations/:id/items/:itemId`           | Remove a line                             |
|    GET | `/api/quotations/:id/export?format=pdf\|xlsx` | Download                                  |
|    GET | `/api/search?q=…`                             | Free-text search across all doc_items     |
|    GET | `/api/vendors`                                | List your vendors                         |
|   POST | `/api/vendors`                                | Create a vendor                           |
