-- AI Ratefinder — initial schema
-- Library + Chat + Quotation model.
-- Run via Supabase SQL editor or `supabase db push`.

create extension if not exists "pg_trgm";
create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- Vendors — used as tags on documents
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
-- Documents — every uploaded price doc
-- ---------------------------------------------------------------------------
create type doc_status as enum ('uploading', 'ocr', 'extracting', 'parsed', 'failed');

create table if not exists documents (
  id                  uuid primary key default uuid_generate_v4(),
  owner_id            uuid not null references auth.users(id) on delete cascade,
  vendor_id           uuid references vendors(id) on delete set null,
  filename            text not null,
  storage_path        text not null,
  mime                text,
  size                bigint,
  status              doc_status not null default 'uploading',
  chandra_request_id  text,
  parsed_markdown     text,
  page_count          int,
  error               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists documents_owner_created_idx on documents(owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Doc items — every priced row extracted from a document
-- ---------------------------------------------------------------------------
create table if not exists doc_items (
  id              uuid primary key default uuid_generate_v4(),
  owner_id        uuid not null references auth.users(id) on delete cascade,
  document_id     uuid not null references documents(id) on delete cascade,
  raw_name        text not null,
  sku             text,
  unit            text,
  price           numeric(14, 2),
  moq             text,
  currency        text not null default 'INR',
  source_page     int,
  raw_row         jsonb,
  created_at      timestamptz not null default now(),
  search_doc      tsvector generated always as (
    setweight(to_tsvector('simple', coalesce(raw_name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(sku, '')),      'B')
  ) stored
);

create index if not exists doc_items_doc_idx       on doc_items(document_id);
create index if not exists doc_items_owner_idx     on doc_items(owner_id);
create index if not exists doc_items_search_idx    on doc_items using gin (search_doc);
create index if not exists doc_items_name_trgm_idx on doc_items using gin (raw_name gin_trgm_ops);
create index if not exists doc_items_sku_idx       on doc_items(sku);

-- ---------------------------------------------------------------------------
-- Chats — Claude-style threads
-- ---------------------------------------------------------------------------
create table if not exists chats (
  id              uuid primary key default uuid_generate_v4(),
  owner_id        uuid not null references auth.users(id) on delete cascade,
  title           text not null default 'New chat',
  quotation_id    uuid,  -- optional draft quotation this chat is feeding
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists chats_owner_idx on chats(owner_id, updated_at desc);

create type message_role as enum ('user', 'assistant');

create table if not exists chat_messages (
  id          uuid primary key default uuid_generate_v4(),
  chat_id     uuid not null references chats(id) on delete cascade,
  role        message_role not null,
  content     text not null,
  items       jsonb,  -- assistant: array of cited price cards
  created_at  timestamptz not null default now()
);

create index if not exists chat_messages_chat_idx on chat_messages(chat_id, created_at);

-- ---------------------------------------------------------------------------
-- Quotations
-- ---------------------------------------------------------------------------
create type quotation_status as enum ('draft', 'sent', 'archived');

create table if not exists quotations (
  id            uuid primary key default uuid_generate_v4(),
  owner_id      uuid not null references auth.users(id) on delete cascade,
  title         text not null default 'New quotation',
  customer      text,
  status        quotation_status not null default 'draft',
  discount_pct  numeric(5, 2) not null default 0,
  gst_pct       numeric(5, 2) not null default 18,
  freight       numeric(14, 2) not null default 0,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists quotations_owner_idx on quotations(owner_id, updated_at desc);

alter table chats
  add constraint chats_quotation_fk
  foreign key (quotation_id) references quotations(id) on delete set null;

create table if not exists quotation_items (
  id                 uuid primary key default uuid_generate_v4(),
  quotation_id       uuid not null references quotations(id) on delete cascade,
  doc_item_id        uuid references doc_items(id) on delete set null,
  source_document_id uuid references documents(id) on delete set null,
  line_no            int not null default 0,
  description        text not null,
  sku                text,
  unit               text,
  vendor             text,
  qty                numeric(14, 3) not null default 1,
  unit_price         numeric(14, 2) not null default 0,
  source_page        int,
  created_at         timestamptz not null default now()
);

create index if not exists quotation_items_qid_idx on quotation_items(quotation_id, line_no);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table vendors        enable row level security;
alter table documents      enable row level security;
alter table doc_items      enable row level security;
alter table chats          enable row level security;
alter table chat_messages  enable row level security;
alter table quotations     enable row level security;
alter table quotation_items enable row level security;

create policy "own rows" on vendors    for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "own rows" on documents  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "own rows" on doc_items  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "own rows" on chats      for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "own rows" on quotations for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "via chat" on chat_messages for all
  using (exists (select 1 from chats c where c.id = chat_id and c.owner_id = auth.uid()))
  with check (exists (select 1 from chats c where c.id = chat_id and c.owner_id = auth.uid()));

create policy "via quotation" on quotation_items for all
  using (exists (select 1 from quotations q where q.id = quotation_id and q.owner_id = auth.uid()))
  with check (exists (select 1 from quotations q where q.id = quotation_id and q.owner_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- Storage bucket for uploads (run once, separately if your migration runner
-- doesn't execute it):
--   insert into storage.buckets (id, name, public) values ('uploads', 'uploads', false);
-- ---------------------------------------------------------------------------
