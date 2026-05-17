# AI Ratefinder — Plan, Flow & Mockups

> **One-line pitch**
> A private library of vendor price docs you can chat with. Ask "what's the
> price of Polycab 2.5mm wire?" and get the answer, the MOQ, and the source
> page — then drop items into a quotation and download it.

---

## 1. What we're building (in 5 bullets)

1. A **Library page** — drop PDFs, images and Excels of vendor price lists.
   Each one is OCR'd by **Datalab Chandra 2** the moment it's uploaded.
2. A **chat interface** (Claude-style) — ask plain-English questions; the
   server searches every parsed doc and answers with **structured price cards**
   (product, price, MOQ, unit, vendor, source doc + page).
3. Every card has an **"Add to quotation"** button.
4. The **Quotation builder** lets you set qty / discount / GST / freight and
   download the finished quote as **PDF or Excel**.
5. Everything is per-user and private (Supabase Auth + RLS).

No live ERP, no vendor APIs, no inventory — just docs in, prices out, quote
down.

---

## 2. End-to-end flow

```
                          ┌──────────────┐
                          │   Sign in    │
                          └──────┬───────┘
                                 │
                                 ▼
        ┌──────────────────────────────────────────────────┐
        │                  ┌──────────────┐                │
        │   sidebar ───▶   │   LIBRARY    │   home          │
        │                  └──────┬───────┘                │
        │                         │                        │
        │                drop PDFs│/ images / Excels       │
        │                         ▼                        │
        │           ┌──────────────────────────────┐       │
        │           │  Chandra 2 OCR  (background) │       │
        │           │  markdown → parsed rows      │       │
        │           │  rows → searchable index     │       │
        │           └──────────────────────────────┘       │
        │                                                  │
        │                  ┌──────────────┐                │
        │   sidebar ───▶   │     CHAT     │                │
        │                  └──────┬───────┘                │
        │                         │                        │
        │     user: "price of Polycab 2.5mm wire?"         │
        │                         │                        │
        │                         ▼                        │
        │           ┌──────────────────────────────┐       │
        │           │  search across doc_items     │       │
        │           │  (tsvector + pg_trgm)        │       │
        │           └──────────────┬───────────────┘       │
        │                          │                       │
        │                          ▼                       │
        │           ┌──────────────────────────────┐       │
        │           │  structured price card(s)    │       │
        │           │  [ + Add to quotation ]      │       │
        │           └──────────────┬───────────────┘       │
        │                          │                       │
        │                          ▼                       │
        │                  ┌──────────────┐                │
        │                  │  QUOTATION   │  view / edit   │
        │                  │   BUILDER    │  download      │
        │                  └──────────────┘                │
        └──────────────────────────────────────────────────┘
```

---

## 3. Screen mockups

Three primary screens — **Library**, **Chat**, **Quotation** — all wrapped in
the [Nuxt UI chat template](https://github.com/nuxt-ui-templates/chat) shell.

### 3.1 Library

```
┌────────────────────────────┬──────────────────────────────────────────────────────────┐
│ AI Ratefinder              │  Library                                  [ ⬆ Upload ]   │
│ ─────────────────────────  │  ──────────────────────────────────────────────────────  │
│  📚 Library  ◀             │                                                          │
│  💬 Chat                   │  🔍 [ search documents…                              ]   │
│  📄 Quotations             │                                                          │
│                            │  ┌─────────────────────────────────────────────────────┐ │
│  CONVERSATIONS             │  │ polycab_mar_2026.pdf                       parsed  │ │
│  • Wire pricing comparison │  │ Polycab · uploaded 14 May · 312 items · 8 pages    │ │
│  • Mahesh BOQ research     │  └─────────────────────────────────────────────────────┘ │
│                            │  ┌─────────────────────────────────────────────────────┐ │
│                            │  │ havells_pricelist.pdf                      parsed  │ │
│                            │  │ Havells · uploaded 12 May · 188 items · 6 pages    │ │
│                            │  └─────────────────────────────────────────────────────┘ │
│                            │  ┌─────────────────────────────────────────────────────┐ │
│                            │  │ acme_hardware.xlsx                         parsed  │ │
│                            │  │ Acme · uploaded 10 May · 412 items                 │ │
│                            │  └─────────────────────────────────────────────────────┘ │
│                            │  ┌─────────────────────────────────────────────────────┐ │
│                            │  │ kabel_scan.pdf                           parsing…  │ │
│                            │  │ Kabel · uploaded just now · OCR in progress (3/12) │ │
│                            │  └─────────────────────────────────────────────────────┘ │
│                            │                                                          │
│ rohan@example.com    [⎋]   │  Drag & drop more files anywhere on this page.           │
└────────────────────────────┴──────────────────────────────────────────────────────────┘
```

Click any document → side-drawer with the parsed table + the original
PDF/Excel preview side-by-side. Edit a row, retag the vendor, delete the doc.

### 3.2 Chat (the main interaction)

```
┌────────────────────────────┬──────────────────────────────────────────────────────────┐
│ AI Ratefinder              │  💬 Wire pricing comparison                              │
│ ─────────────────────────  │  ──────────────────────────────────────────────────────  │
│  📚 Library                │                                                          │
│  💬 Chat  ◀                │                                                          │
│  📄 Quotations             │                          ┌─────────────────────────────┐ │
│                            │                          │ what is the price of        │ │
│  CONVERSATIONS             │                          │ polycab 2.5mm wire?         │ │
│  • Wire pricing comparison │                          └─────────────────────────────┘ │
│  • Mahesh BOQ research     │                                                          │
│                            │  ┌────────────────────────────────────────────────────┐  │
│  + New chat                │  │ Found 2 matches across your library.               │  │
│                            │  │                                                    │  │
│                            │  │ ┌──────────────────────────────────────────────┐   │  │
│                            │  │ │ Polycab 2.5 sq.mm Flexible Cu Wire (Green)   │   │  │
│                            │  │ │ ──────────────────────────────────────────   │   │  │
│                            │  │ │   Price     ₹2,850 / coil                    │   │  │
│                            │  │ │   Unit      90 m coil                        │   │  │
│                            │  │ │   MOQ       1 coil                           │   │  │
│                            │  │ │   SKU       PLC-25-GR-90                     │   │  │
│                            │  │ │   Vendor    Polycab                          │   │  │
│                            │  │ │   Source    polycab_mar_2026.pdf · p.3       │   │  │
│                            │  │ │                                              │   │  │
│                            │  │ │   [ + Add to quotation ]   [ View source ]   │   │  │
│                            │  │ └──────────────────────────────────────────────┘   │  │
│                            │  │                                                    │  │
│                            │  │ ┌──────────────────────────────────────────────┐   │  │
│                            │  │ │ Polycab 2.5 sq.mm Cu Wire (Red)              │   │  │
│                            │  │ │   Price     ₹2,890 / coil                    │   │  │
│                            │  │ │   Unit      90 m coil       MOQ  1 coil      │   │  │
│                            │  │ │   Vendor    Polycab    polycab_mar_2026 p.3  │   │  │
│                            │  │ │   [ + Add to quotation ]   [ View source ]   │   │  │
│                            │  │ └──────────────────────────────────────────────┘   │  │
│                            │  └────────────────────────────────────────────────────┘  │
│                            │                                                          │
│                            │                          ┌─────────────────────────────┐ │
│                            │                          │ also havells 2.5mm?         │ │
│                            │                          └─────────────────────────────┘ │
│                            │  ┌────────────────────────────────────────────────────┐  │
│                            │  │ Havells 2.5 sq.mm FR Cu Wire                       │  │
│                            │  │   Price ₹2,720 / coil · MOQ 1 · havells p.2        │  │
│                            │  │   [ + Add to quotation ]   [ View source ]         │  │
│                            │  └────────────────────────────────────────────────────┘  │
│                            │                                                          │
│                            │  ┌────────────────────────────────────────────────────┐  │
│ rohan@example.com    [⎋]   │  │ Ask about products, prices, MOQs…           [ ↵ ]  │  │
│                            │  └────────────────────────────────────────────────────┘  │
└────────────────────────────┴──────────────────────────────────────────────────────────┘
```

**How a chat message becomes an answer**
1. The message text is the search query.
2. Server runs full-text (`tsvector`) + trigram (`pg_trgm`) over every parsed
   row (`doc_items.raw_name + sku + raw_row`), scoped to the signed-in user.
3. Top hits are rendered as price cards with vendor + source-page citations.
4. **"View source"** opens the original PDF zoomed to the right page.
5. **"+ Add to quotation"** drops the item into the current quotation draft.

(Future: a small LLM can read the top hits and write a conversational summary
like "Havells is cheaper by ₹130 for the same gauge." MVP ships without it.)

### 3.3 Quotation

```
┌────────────────────────────┬──────────────────────────────────────────────────────────┐
│ AI Ratefinder              │  📄 Quotation — Mahesh Project           draft           │
│ ─────────────────────────  │  ──────────────────────────────────────────────────────  │
│  📚 Library                │                                                          │
│  💬 Chat                   │  Customer: [ Mahesh Builders Pvt Ltd            ]        │
│  📄 Quotations  ◀          │  Title:    [ Electrical materials — site 2      ]        │
│                            │                                                          │
│  ┌────────────────────┐    │  Discount % [ 5.00 ]   GST % [ 18.00 ]                   │
│  │ + New quotation    │    │  Freight ₹  [ 2,500.00 ]                                 │
│  └────────────────────┘    │                                                          │
│                            │  ┌─────┬──────────────────────────┬─────┬──────┬───────┐ │
│  • Mahesh Project ◀ draft  │  │  #  │ Description              │ Qty │ Unit │ Rate  │ │
│  • Karan Tower    sent     │  ├─────┼──────────────────────────┼─────┼──────┼───────┤ │
│  • Site 3         draft    │  │  1  │ Polycab 2.5 sq.mm wire   │  12 │ coil │ 2,850 │ │
│                            │  │     │  source: polycab p.3     │     │      │       │ │
│                            │  │  2  │ Havells 2.5 sq.mm wire   │   4 │ coil │ 2,720 │ │
│                            │  │     │  source: havells p.2     │     │      │       │ │
│                            │  │  3  │ MCB 16A C-curve          │  20 │ pc   │   245 │ │
│                            │  │     │  source: acme.xlsx       │     │      │       │ │
│                            │  └─────┴──────────────────────────┴─────┴──────┴───────┘ │
│                            │                                                          │
│                            │           Subtotal:    ₹  49,980.00                      │
│                            │           Discount 5%: ₹   2,499.00                      │
│                            │           GST 18%:     ₹   8,546.58                      │
│                            │           Freight:     ₹   2,500.00                      │
│                            │           ──────────────────────────                     │
│                            │           GRAND TOTAL: ₹  58,527.58                      │
│                            │                                                          │
│ rohan@example.com    [⎋]   │  [ Preview ]   [ ⬇ Download PDF ]   [ ⬇ Download Excel ] │
└────────────────────────────┴──────────────────────────────────────────────────────────┘
```

---

## 4. What lives where

```
                          ┌──────────────────────┐
                          │  Browser  (Nuxt UI)  │
                          │  Library / Chat /    │
                          │  Quotation pages     │
                          └──────────┬───────────┘
                                     │ HTTPS
                                     ▼
                          ┌──────────────────────┐
                          │  Nuxt server (Vercel)│
                          │    /api/documents    │
                          │    /api/chat         │
                          │    /api/search       │
                          │    /api/quotations   │
                          └──┬───────────────┬───┘
                             │               │
                  ┌──────────▼──┐         ┌──▼───────────────────┐
                  │  Supabase   │         │  Datalab Chandra 2   │
                  │  Postgres   │         │   /api/v1/convert    │
                  │  Auth       │         │   submit + poll      │
                  │  Storage    │         └──────────────────────┘
                  └─────────────┘
```

**Data model (simpler than before)**

```
users  ──┐
         │
         ▼
documents (id, filename, storage_path, vendor, status,
           chandra_request_id, parsed_markdown, page_count, created_at)
   │
   ▼
doc_items (id, document_id, raw_name, sku, unit, price, moq,
           currency, source_page, raw_row JSON, search_doc tsvector)

chats (id, title, created_at)
   │
   ▼
chat_messages (id, chat_id, role, content, citations JSON)

quotations (id, title, customer, discount_pct, gst_pct, freight, totals)
   │
   ▼
quotation_items (id, quotation_id, doc_item_id?, description, sku, unit,
                 qty, unit_price, source_document_id, source_page)
```

The old `products` / `boq_items` / `corrections` tables go away. Everything
hangs off `documents` and `doc_items`. A "product" is just whatever rows the
search returns — no separate master catalogue to maintain.

---

## 5. 35-day timeline (re-cut for this design)

| Week | Days  | Milestone                                          | Demo                                            |
| ---- | ----- | -------------------------------------------------- | ----------------------------------------------- |
| 1    | 1–7   | App shell, auth, Library page, upload to storage   | Sign in, drop a PDF, see it listed              |
| 2    | 5–14  | Chandra 2 ingest + table parsing into `doc_items`  | Drop a price list → 300 rows indexed in 30 s    |
| 2    | 10–14 | Library detail drawer (parsed table + source view) | Click a doc, scroll the extracted rows          |
| 3    | 12–20 | Chat UI + search backend + price-card renderer     | Ask "polycab 2.5mm" → cards with vendor + page  |
| 3–4  | 18–24 | Quotation draft, add-from-chat, edit qty           | Click + on a card → appears in quotation        |
| 4    | 22–28 | Discount / GST / freight + live totals             | Numbers update as you type                      |
| 4–5  | 26–32 | PDF & Excel export (`pdfmake` + `exceljs`)         | Download a branded PDF                          |
| 5    | 30–35 | Real-doc testing, polish, deploy to Vercel         | Live URL, 10 real vendor docs pass              |
| 1–35 | ⨯     | Override-driven alias learning (sideline)          | Same odd phrasing matches better the 2nd time   |

---

## 6. Out of scope (from your SOW)

ERP integration · Mobile app · Multi-user roles / approvals · Vendor APIs ·
Inventory or stock tracking · Advanced analytics · 100% automation (a human
reviews the quotation before it goes out).

---

## 7. What I need to start

1. **Supabase project URL + service-role key** (or invite me to create one).
2. **Datalab API key** (https://www.datalab.to).
3. **2–3 sample vendor price docs** + **1 sample BOQ** as test fixtures.
4. **Logo + brand colour** for the PDF header (or default neutral).

With those four, I can have the Library + Chat working end-to-end inside
48 hours — drop a Polycab PDF, ask about wire prices, get cards back.
