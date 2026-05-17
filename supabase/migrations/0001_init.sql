-- AI Ratefinder — initial schema
-- Run via the Supabase SQL editor or `supabase db push`.

create extension if not exists "pg_trgm";
create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- Vendors (price-list sources)
-- ---------------------------------------------------------------------------
create table if not exists vendors (
  id          uuid primary key default uuid_generate_v4(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  notes       text,
  created_at  timestamptz not null default now(),
  unique (owner_id, name)
);

-- ---------------------------------------------------------------------------
-- Jobs — each chat thread is a job
-- ---------------------------------------------------------------------------
create type job_kind   as enum ('ingest_price_list', 'ingest_boq', 'build_quotation');
create type job_status as enum ('pending', 'ocr', 'extracting', 'ready', 'failed');

create table if not exists jobs (
  id          uuid primary key default uuid_generate_v4(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  kind        job_kind not null,
  status      job_status not null default 'pending',
  title       text not null,
  vendor_id   uuid references vendors(id) on delete set null,
  source_path text,                              -- Supabase Storage path
  chandra_request_id text,
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists jobs_owner_created_idx on jobs(owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Job messages — the chat transcript
-- ---------------------------------------------------------------------------
create type message_role as enum ('user', 'assistant', 'tool');

create table if not exists job_messages (
  id          uuid primary key default uuid_generate_v4(),
  job_id      uuid not null references jobs(id) on delete cascade,
  role        message_role not null,
  content     text,
  data        jsonb,                             -- structured payloads (tables, suggestions)
  created_at  timestamptz not null default now()
);

create index if not exists job_messages_job_idx on job_messages(job_id, created_at);

-- ---------------------------------------------------------------------------
-- Master product catalogue
-- ---------------------------------------------------------------------------
create table if not exists products (
  id              uuid primary key default uuid_generate_v4(),
  owner_id        uuid not null references auth.users(id) on delete cascade,
  canonical_name  text not null,
  aliases         text[] not null default '{}',
  attributes      jsonb not null default '{}'::jsonb,
  unit            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  search_doc      tsvector generated always as (
    setweight(to_tsvector('simple', coalesce(canonical_name,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(array_to_string(aliases, ' '),'')), 'B')
  ) stored
);

create index if not exists products_search_idx on products using gin (search_doc);
create index if not exists products_name_trgm_idx on products using gin (canonical_name gin_trgm_ops);
create index if not exists products_owner_idx on products(owner_id);

-- ---------------------------------------------------------------------------
-- Price list rows (per vendor)
-- ---------------------------------------------------------------------------
create table if not exists price_list_items (
  id              uuid primary key default uuid_generate_v4(),
  owner_id        uuid not null references auth.users(id) on delete cascade,
  vendor_id       uuid not null references vendors(id) on delete cascade,
  product_id      uuid references products(id) on delete set null,
  source_job_id   uuid references jobs(id) on delete set null,
  raw_name        text not null,
  sku             text,
  unit            text,
  price           numeric(14, 2),
  currency        text not null default 'INR',
  effective_from  date not null default current_date,
  raw_row         jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists pli_vendor_idx        on price_list_items(vendor_id);
create index if not exists pli_product_idx       on price_list_items(product_id);
create index if not exists pli_name_trgm_idx     on price_list_items using gin (raw_name gin_trgm_ops);
create index if not exists pli_sku_idx           on price_list_items(sku);

-- ---------------------------------------------------------------------------
-- BOQ line items
-- ---------------------------------------------------------------------------
create table if not exists boq_items (
  id              uuid primary key default uuid_generate_v4(),
  owner_id        uuid not null references auth.users(id) on delete cascade,
  job_id          uuid not null references jobs(id) on delete cascade,
  line_no         int,
  description     text not null,
  qty             numeric(14, 3),
  unit            text,
  remarks         text,
  matched_product_id uuid references products(id) on delete set null,
  match_confidence numeric(4, 3),
  match_status    text default 'pending',        -- pending | auto | suggested | manual
  created_at      timestamptz not null default now()
);

create index if not exists boq_job_idx on boq_items(job_id);

-- ---------------------------------------------------------------------------
-- User corrections (drives the post-training loop)
-- ---------------------------------------------------------------------------
create table if not exists corrections (
  id            uuid primary key default uuid_generate_v4(),
  owner_id      uuid not null references auth.users(id) on delete cascade,
  boq_item_id   uuid references boq_items(id) on delete set null,
  raw_text      text not null,
  product_id    uuid not null references products(id) on delete cascade,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Quotations
-- ---------------------------------------------------------------------------
create table if not exists quotations (
  id            uuid primary key default uuid_generate_v4(),
  owner_id      uuid not null references auth.users(id) on delete cascade,
  job_id        uuid references jobs(id) on delete set null,
  title         text not null,
  customer      text,
  discount_pct  numeric(5, 2) not null default 0,
  gst_pct       numeric(5, 2) not null default 18,
  freight       numeric(14, 2) not null default 0,
  totals        jsonb,
  created_at    timestamptz not null default now()
);

create table if not exists quotation_items (
  id            uuid primary key default uuid_generate_v4(),
  quotation_id  uuid not null references quotations(id) on delete cascade,
  line_no       int not null,
  description   text not null,
  sku           text,
  unit          text,
  qty           numeric(14, 3) not null,
  unit_price    numeric(14, 2) not null,
  discount_pct  numeric(5, 2) not null default 0
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table vendors          enable row level security;
alter table jobs             enable row level security;
alter table job_messages     enable row level security;
alter table products         enable row level security;
alter table price_list_items enable row level security;
alter table boq_items        enable row level security;
alter table corrections      enable row level security;
alter table quotations       enable row level security;
alter table quotation_items  enable row level security;

create policy "own rows" on vendors          for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "own rows" on jobs             for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "own rows" on products         for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "own rows" on price_list_items for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "own rows" on boq_items        for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "own rows" on corrections      for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "own rows" on quotations       for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "via job" on job_messages for all
  using (exists (select 1 from jobs j where j.id = job_id and j.owner_id = auth.uid()))
  with check (exists (select 1 from jobs j where j.id = job_id and j.owner_id = auth.uid()));

create policy "via quotation" on quotation_items for all
  using (exists (select 1 from quotations q where q.id = quotation_id and q.owner_id = auth.uid()))
  with check (exists (select 1 from quotations q where q.id = quotation_id and q.owner_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- Storage bucket for uploads (run separately if migration runner skips it):
--   select storage.create_bucket('uploads', public := false);
-- ---------------------------------------------------------------------------
