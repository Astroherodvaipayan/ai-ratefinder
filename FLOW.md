# AI Ratefinder — Plan, Flow & Mockups

A construction/trading firm has stacks of vendor **price lists** (PDFs, scans,
Excel) and customer **BOQs / RFQs**. Today they hand-match each BOQ line to
the right vendor SKU and then build a quotation in Excel. We're automating
that loop.

> **One-line pitch**
> Upload price lists once. Drop a BOQ. Get a priced quotation in minutes — with
> a human in the loop only where the matcher isn't sure.

---

## 1. What we're building (in 6 bullets)

1. A **web app** where each task is a chat-style "thread".
2. **Datalab Chandra 2** reads every uploaded PDF / image and returns structured tables.
3. Rows from those tables build a **master product catalogue** — one product, many vendor prices.
4. When a **BOQ** is uploaded, each line is matched to a product with a **confidence score**.
5. The user **confirms or overrides** the matches; overrides train the matcher.
6. The app exports a **PDF / Excel quotation** with discount, GST and freight.

---

## 2. End-to-end flow

```
┌───────────────────────┐
│  User signs in        │
│  (email + password)   │
└──────────┬────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────┐
│  Home — pick a thread type                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │
│  │ Price list   │  │   BOQ run    │  │  Quotation   │            │
│  └──────────────┘  └──────────────┘  └──────────────┘            │
└────┬──────────────────────┬─────────────────────┬────────────────┘
     │ A                    │ B                   │ C
     ▼                      ▼                     ▼

A) PRICE-LIST INGEST                  B) BOQ RUN                          C) QUOTATION
─────────────────────                 ──────────                          ────────────
 1. Pick vendor                        1. Upload BOQ                       1. Pick a BOQ run
 2. Drop PDF/Excel                     2. Chandra OCR                      2. Pick vendor per line
 3. Chandra OCR                        3. Parse line items                 3. Set discount / GST / freight
 4. Parse table → rows                 4. Match each line:                 4. Preview
 5. Show editable table                    ≥0.85 → auto                    5. Export PDF / Excel
 6. Save to master DB                      0.6–0.85 → suggested
    + this vendor's prices                <0.6 → manual
                                       5. User confirms / overrides
                                       6. Overrides saved as aliases
                                          (feeds the matcher next time)
```

**The whole loop** — upload → OCR → parse → match → confirm → quote → export —
runs as a sequence of messages inside one chat thread, so the user can scroll
back and see what happened at every step.

---

## 3. Screen mockups

The UI is the [`nuxt-ui-templates/chat`](https://github.com/nuxt-ui-templates/chat)
shell, re-skinned for this product. Three-pane layout: **sidebar / thread / inspector**.

### 3.1 Home

```
┌────────────────────────────┬──────────────────────────────────────────────────────────┐
│ AI Ratefinder         [ + ]│                                                          │
│ ───────────────────────────│                AI Ratefinder                             │
│  Master catalogue          │   Upload vendor price lists and BOQs.                    │
│  Vendors                   │   We extract, match, and quote.                          │
│                            │                                                          │
│  THREADS                   │   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐    │
│   No threads yet           │   │ ⬆  Ingest    │ │ ☑  Process   │ │ 📄 Build     │    │
│                            │   │   price list │ │     BOQ      │ │   quotation  │    │
│                            │   │ PDF / image  │ │ Match lines  │ │  Export PDF  │    │
│                            │   │   / Excel    │ │   to SKUs    │ │              │    │
│                            │   └──────────────┘ └──────────────┘ └──────────────┘    │
│                            │                                                          │
│ rohan@example.com  [⎋]     │                                                          │
└────────────────────────────┴──────────────────────────────────────────────────────────┘
```

### 3.2 Price-list ingest thread

After dropping a vendor PDF:

```
┌────────────────────────────┬──────────────────────────────────────────────────────────┐
│ AI Ratefinder         [ + ]│ Acme Hardware — March price list      status: ready      │
│ ───────────────────────────│ ──────────────────────────────────────────────────────── │
│  Master catalogue          │                                                          │
│  Vendors                   │                          ┌──────────────────────────────┐│
│                            │                          │ Uploaded acme_mar.pdf        ││
│  THREADS                   │                          │ (2.1 MB)                     ││
│  • Acme — March price list │                          └──────────────────────────────┘│
│  • Mahesh BOQ #214         │                                                          │
│                            │ ┌────────────────────────────────────────────────────┐   │
│                            │ │ Extracted 142 price rows from acme_mar.pdf.        │   │
│                            │ │                                                    │   │
│                            │ │ ┌────────────────────┬───────┬──────┬────────────┐ │   │
│                            │ │ │ Product            │ SKU   │ Unit │ Price (₹)  │ │   │
│                            │ │ ├────────────────────┼───────┼──────┼────────────┤ │   │
│                            │ │ │ 4" GI Elbow 90°    │ E-490 │ pc   │      72.00 │ │   │
│                            │ │ │ PVC Pipe SCH-40 1" │ P-101 │ m    │      48.50 │ │   │
│                            │ │ │ Teflon tape 12mm   │ T-12  │ roll │      18.00 │ │   │
│                            │ │ │ …                  │       │      │            │ │   │
│                            │ │ └────────────────────┴───────┴──────┴────────────┘ │   │
│                            │ │  [ Save to master ]   [ Re-extract ]   [ Discard ] │   │
│                            │ └────────────────────────────────────────────────────┘   │
│                            │                                                          │
│ rohan@example.com  [⎋]     │ [ ⬆ Upload another price list ]                          │
└────────────────────────────┴──────────────────────────────────────────────────────────┘
```

### 3.3 BOQ run thread (after matching)

```
┌────────────────────────────┬──────────────────────────────────────────────────────────┐
│ AI Ratefinder         [ + ]│ Mahesh Project — BOQ #214        [ Run SKU matcher ] ✓   │
│ ───────────────────────────│ ──────────────────────────────────────────────────────── │
│                            │                                                          │
│  THREADS                   │                          ┌──────────────────────────────┐│
│  • Acme — March price list │                          │ Uploaded mahesh_boq.pdf      ││
│  • Mahesh BOQ #214 ◀       │                          └──────────────────────────────┘│
│                            │                                                          │
│                            │ ┌────────────────────────────────────────────────────┐   │
│                            │ │ Found 38 BOQ line items.                           │   │
│                            │ └────────────────────────────────────────────────────┘   │
│                            │                                                          │
│                            │ ┌────────────────────────────────────────────────────┐   │
│                            │ │ Matched 38 lines against the master catalogue.     │   │
│                            │ │                                                    │   │
│                            │ │  ● 4" GI elbow 90 deg                  [ AUTO ]    │   │
│                            │ │    → 4" GI Elbow 90°       score 0.93              │   │
│                            │ │                                                    │   │
│                            │ │  ● 1 inch PVC pipe sch40                [ AUTO ]   │   │
│                            │ │    → PVC Pipe SCH-40 1"    score 0.88              │   │
│                            │ │                                                    │   │
│                            │ │  ● Teflon tape                    [ SUGGESTED ]    │   │
│                            │ │    → Teflon tape 12mm      score 0.71              │   │
│                            │ │    [ Confirm ]   [ Pick another ]                  │   │
│                            │ │                                                    │   │
│                            │ │  ● MS angle 50x50x6              [ MANUAL ]        │   │
│                            │ │    Top 3:                                          │   │
│                            │ │      • MS Angle 50x50x6mm        0.58              │   │
│                            │ │      • MS Angle 40x40x6mm        0.41              │   │
│                            │ │      • MS Angle 50x50x5mm        0.39              │   │
│                            │ │    [ Pick ]   [ Search… ]                          │   │
│                            │ └────────────────────────────────────────────────────┘   │
│                            │                                                          │
│ rohan@example.com  [⎋]     │ [ → Build quotation from this BOQ ]                      │
└────────────────────────────┴──────────────────────────────────────────────────────────┘
```

### 3.4 Quotation builder

```
┌────────────────────────────┬──────────────────────────────────────────────────────────┐
│ AI Ratefinder         [ + ]│ Quotation — Mahesh Project                               │
│ ───────────────────────────│ ──────────────────────────────────────────────────────── │
│                            │                                                          │
│  THREADS                   │  Customer: [ Mahesh Builders Pvt Ltd        ]            │
│  • Acme — March price list │  Discount %: [ 5.00 ]   GST %: [ 18.00 ]                 │
│  • Mahesh BOQ #214         │  Freight ₹:  [ 2,500.00 ]                                │
│  • Quotation — Mahesh ◀    │                                                          │
│                            │  ┌─────┬────────────────────┬─────┬──────┬──────────┐    │
│                            │  │ #   │ Description        │ Qty │ Unit │ Rate (₹) │    │
│                            │  ├─────┼────────────────────┼─────┼──────┼──────────┤    │
│                            │  │ 1   │ 4" GI Elbow 90°    │ 120 │ pc   │   72.00  │    │
│                            │  │     │   vendor: ▾ Acme   │     │      │          │    │
│                            │  │ 2   │ PVC Pipe SCH-40 1" │ 250 │ m    │   48.50  │    │
│                            │  │     │   vendor: ▾ Acme   │     │      │          │    │
│                            │  │ 3   │ Teflon tape 12mm   │  40 │ roll │   18.00  │    │
│                            │  │     │   vendor: ▾ Karan  │     │      │          │    │
│                            │  │ …   │                    │     │      │          │    │
│                            │  └─────┴────────────────────┴─────┴──────┴──────────┘    │
│                            │                                                          │
│                            │              Subtotal:    ₹   1,42,300.00                │
│                            │              Discount 5%: ₹      7,115.00                │
│                            │              GST 18%:     ₹     24,333.30                │
│                            │              Freight:     ₹      2,500.00                │
│                            │              ────────────────────────────                │
│                            │              GRAND TOTAL: ₹   1,62,018.30                │
│                            │                                                          │
│ rohan@example.com  [⎋]     │ [ Preview ]  [ Export PDF ]  [ Export Excel ]            │
└────────────────────────────┴──────────────────────────────────────────────────────────┘
```

### 3.5 Master catalogue (search)

```
┌────────────────────────────┬──────────────────────────────────────────────────────────┐
│ AI Ratefinder         [ + ]│ Master catalogue                                         │
│ ───────────────────────────│ ──────────────────────────────────────────────────────── │
│  Master catalogue ◀        │ 🔍 [ pvc pipe sch40                                ]     │
│  Vendors                   │                                                          │
│                            │ ┌────────────────────┬──────┬───────┐                    │
│                            │ │ Product            │ Unit │ Score │                    │
│                            │ ├────────────────────┼──────┼───────┤                    │
│                            │ │ PVC Pipe SCH-40 1" │  m   │ 0.91  │                    │
│                            │ │ PVC Pipe SCH-40 ¾" │  m   │ 0.88  │                    │
│                            │ │ PVC Pipe SCH-80 1" │  m   │ 0.62  │                    │
│                            │ └────────────────────┴──────┴───────┘                    │
│                            │                                                          │
│                            │ Click any row → see vendor prices side-by-side,          │
│                            │ edit canonical name + aliases.                           │
│ rohan@example.com  [⎋]     │                                                          │
└────────────────────────────┴──────────────────────────────────────────────────────────┘
```

---

## 4. How it works under the hood (one screen, no jargon)

```
                          ┌──────────────────────┐
                          │  Browser  (Nuxt UI)  │
                          └──────────┬───────────┘
                                     │ HTTPS
                                     ▼
                          ┌──────────────────────┐
                          │  Nuxt server routes  │   /api/jobs, /ingest,
                          │   on Vercel          │   /match, /search …
                          └──┬───────────────┬───┘
                             │               │
                  ┌──────────▼──┐         ┌──▼───────────────────┐
                  │  Supabase   │         │  Datalab Chandra 2   │
                  │  Postgres   │         │   /api/v1/convert    │
                  │  Auth       │         │   submit + poll      │
                  │  Storage    │         └──────────────────────┘
                  └─────────────┘
```

- **Browser**: Nuxt 4 + Nuxt UI v3. Same shell as the Nuxt chat template.
- **Server**: Nuxt API routes on Vercel — thin, just orchestration.
- **Supabase**: stores users, files (the uploaded PDFs), the master catalogue
  and all transcripts. RLS keeps each user's data private.
- **Chandra 2**: the only AI dependency. Returns a clean markdown table for
  almost any vendor PDF / image. The server parses that markdown directly.
- **No LLM**: SKU matching is `tsvector` full-text + `pg_trgm` trigram
  similarity in Postgres. Cheap, deterministic, good enough. (We can bolt on
  embeddings later if match quality is weak.)

---

## 5. 35-day timeline

| Week | Days  | Milestone                                  | Demo we can show                       |
| ---- | ----- | ------------------------------------------ | -------------------------------------- |
| 1    | 1–7   | App shell, auth, vendors, master DB view   | Sign in, create a vendor               |
| 2    | 5–14  | Chandra ingest + price-list parsing        | Drop a PDF → table appears in 30 s     |
| 2–3  | 10–18 | Master catalogue search, manual edits      | Cmd-K search across all SKUs           |
| 3    | 15–19 | BOQ ingest + line extraction               | Drop a BOQ → 38 lines extracted        |
| 4    | 20–28 | SKU matcher + confidence UI + overrides    | Auto / Suggested / Manual buckets work |
| 4–5  | 26–32 | Quotation builder + PDF / Excel export     | Click Export → branded PDF downloads   |
| 5    | 30–35 | Real-document testing, bug-fix, deploy     | Live URL, 10 sample docs pass          |
| 1–35 | ⨯     | Override-driven aliases (post-training)    | Same BOQ uploaded twice matches better |

---

## 6. What we're explicitly NOT doing (from your SOW)

ERP integration · Mobile app · Multi-user roles & approval workflows ·
Third-party software / vendor API integrations · Inventory or stock tracking ·
Advanced analytics dashboards · 100% automation guarantee (a human still
confirms before a quote leaves the building).

---

## 7. What I need from you to start the build

1. **Supabase project URL + service-role key** (or sign-up access so I can
   create one in your account).
2. **Datalab API key** (get one at https://www.datalab.to).
3. **2–3 sample vendor price lists** and **1 sample BOQ** (PDFs are fine).
   These become the test fixtures.
4. **Logo + brand colour** for the quotation header (or we ship with a
   neutral default).

That's it. With those four, I can have the price-list ingest flow working
end-to-end and demo it to you inside 48 hours.
