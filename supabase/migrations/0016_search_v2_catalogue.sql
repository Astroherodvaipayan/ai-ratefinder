-- Search V2: authoritative, source-backed catalogue offers.
--
-- This table is intentionally separate from doc_price_items. The legacy table
-- contains extraction candidates; catalog_offers contains only validated,
-- purchasable offers that Search V2 is allowed to return.

create extension if not exists "pg_trgm";
create extension if not exists "uuid-ossp";

create table if not exists catalog_releases (
  id                    uuid primary key default uuid_generate_v4(),
  compiler_version      text not null,
  status                text not null default 'staging'
                          check (status in ('staging', 'active', 'retired')),
  documents_count       int not null default 0,
  offers_published      int not null default 0,
  offers_quarantined    int not null default 0,
  reconstruction_failures int not null default 0,
  created_at            timestamptz not null default now(),
  activated_at          timestamptz
);

create unique index if not exists catalog_releases_one_active_idx
  on catalog_releases(status) where status = 'active';

create table if not exists catalog_offers (
  id                    uuid primary key default uuid_generate_v4(),
  release_id            uuid not null references catalog_releases(id) on delete cascade,
  owner_id              uuid not null references auth.users(id) on delete cascade,
  document_id           uuid not null references documents(id) on delete cascade,
  vendor_id             uuid references vendors(id) on delete set null,

  category              text not null,
  canonical_name        text not null,
  brand                 text,
  sku                   text,
  aliases               text[] not null default '{}',
  facets                jsonb not null default '{}'::jsonb,

  amount                numeric(14, 2) not null check (amount > 0),
  currency              text not null default 'INR',
  basis_quantity        numeric(14, 3),
  basis_unit            text,
  package_type          text,
  moq                   text,

  source_page           int,
  source_table_index    int,
  source_row_index      int not null,
  source_col_index      int not null,
  source_table_title    text,
  source_row_label      text,
  source_column_label   text,
  raw_price_value       text not null,
  source_excerpt        text not null,

  status                text not null default 'quarantined'
                          check (status in ('published', 'quarantined', 'superseded')),
  validation_errors     text[] not null default '{}',
  compiler_version      text not null,
  compiled_at           timestamptz not null default now(),

  normalized_name       text generated always as (
    lower(regexp_replace(canonical_name, '[^a-zA-Z0-9.]+', ' ', 'g'))
  ) stored,
  -- Maintained by a trigger below. Keeping this as an ordinary column avoids
  -- PostgreSQL's generated-column immutability restriction on array_to_string.
  search_doc             tsvector not null default ''::tsvector,

  unique (release_id, document_id, source_table_index, source_row_index, source_col_index, category, canonical_name)
);

create index if not exists catalog_offers_published_category_idx
  on catalog_offers(category, status) where status = 'published';
create index if not exists catalog_offers_document_idx on catalog_offers(document_id);
create index if not exists catalog_offers_release_idx on catalog_offers(release_id, status);
create index if not exists catalog_offers_vendor_idx on catalog_offers(vendor_id);
create index if not exists catalog_offers_facets_idx on catalog_offers using gin(facets jsonb_path_ops);
create index if not exists catalog_offers_search_idx on catalog_offers using gin(search_doc);
create index if not exists catalog_offers_name_trgm_idx on catalog_offers using gin(normalized_name gin_trgm_ops);

create or replace function catalog_offers_set_search_doc()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.search_doc :=
    setweight(to_tsvector('simple', coalesce(new.canonical_name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(new.sku, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(new.category, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(array_to_string(new.aliases, ' '), '')), 'B');
  return new;
end;
$$;

create trigger catalog_offers_search_doc_trigger
before insert or update of canonical_name, sku, category, aliases
on catalog_offers
for each row execute function catalog_offers_set_search_doc();

create table if not exists catalog_compile_runs (
  id                    uuid primary key default uuid_generate_v4(),
  owner_id              uuid not null references auth.users(id) on delete cascade,
  document_id           uuid not null references documents(id) on delete cascade,
  compiler_version      text not null,
  status                text not null check (status in ('running', 'completed', 'failed')),
  tables_seen           int not null default 0,
  offers_published      int not null default 0,
  offers_quarantined    int not null default 0,
  error                 text,
  started_at            timestamptz not null default now(),
  completed_at          timestamptz
);

create index if not exists catalog_compile_runs_document_idx
  on catalog_compile_runs(document_id, started_at desc);

alter table catalog_offers enable row level security;
alter table catalog_compile_runs enable row level security;
alter table catalog_releases enable row level security;

create policy "active catalog release readable" on catalog_releases
  for select to authenticated using (status = 'active');

create policy "catalog offers readable by authenticated" on catalog_offers
  for select to authenticated using (true);
create policy "catalog offers insert own" on catalog_offers
  for insert to authenticated with check (owner_id = auth.uid());
create policy "catalog offers update own" on catalog_offers
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "catalog offers delete own" on catalog_offers
  for delete to authenticated using (owner_id = auth.uid());

create policy "compile runs own rows" on catalog_compile_runs
  for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create or replace function activate_catalog_release(target_release_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;
  if not exists (
    select 1 from catalog_releases
    where id = target_release_id and status = 'staging' and reconstruction_failures = 0
  ) then
    raise exception 'release is not activatable';
  end if;

  update catalog_releases
  set status = 'retired'
  where status = 'active';

  update catalog_releases
  set status = 'active', activated_at = now()
  where id = target_release_id;
end;
$$;

revoke all on function activate_catalog_release(uuid) from public;
grant execute on function activate_catalog_release(uuid) to service_role;

notify pgrst, 'reload schema';
