# AI Ratefinder

Upload vendor price lists and BOQs → OCR with **Datalab Chandra 2** → smart SKU
matching → quotation export. Chat-style workflow UI built on Nuxt UI v3.

See [`PLAN.md`](./PLAN.md) for the full 35-day delivery plan.

## Stack

- Nuxt 4 + Nuxt UI v3 (chat-style shell)
- Supabase (Postgres + Auth + Storage)
- Datalab Chandra 2 for OCR
- Vercel for hosting
- Pure Postgres SKU matching (`tsvector` + `pg_trgm`) — no LLM dependency

## Local dev

```bash
cp .env.example .env       # fill DATALAB_API_KEY + Supabase keys
npm install
npm run dev
```

## Supabase setup

1. Create a project at supabase.com.
2. SQL editor → run `supabase/migrations/0001_init.sql`, then `0002_match_fn.sql`.
3. Storage → create a private bucket called `uploads`.
4. Authentication → Email provider → enable email + password.
5. Copy `Project URL`, `anon key`, `service_role key` into `.env`.

## Datalab Chandra 2

Get a key at https://www.datalab.to. The client lives in
`server/utils/chandra.ts` and uses `POST /api/v1/convert` + polling.

## Deploy to Vercel

```bash
npx vercel
```

Set the four env vars (`DATALAB_API_KEY`, `SUPABASE_URL`, `SUPABASE_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`) in the Vercel project settings.
