-- Deterministic rate-finding engine.
-- Upload-time extraction persists source-cited canonical table cells and price
-- records. Chat-time search reads these records only.

create extension if not exists "pg_trgm";
create extension if not exists "uuid-ossp";

create table if not exists doc_tables (
  id                  uuid primary key default uuid_generate_v4(),
  tenant_id           uuid not null references auth.users(id) on delete cascade,
  document_id         uuid not null references documents(id) on delete cascade,
  vendor_id           uuid references vendors(id) on delete set null,
  source_page         int,
  table_index         int not null default 0,
  table_title         text,
  section_breadcrumb  text[] not null default '{}',
  parser_name         text not null,
  parser_confidence   numeric(5, 4) not null default 0.75,
  ocr_confidence      numeric(5, 4),
  created_at          timestamptz not null default now()
);

create index if not exists doc_tables_tenant_idx on doc_tables(tenant_id);
create index if not exists doc_tables_document_idx on doc_tables(document_id);
create index if not exists doc_tables_vendor_idx on doc_tables(vendor_id);

create table if not exists doc_table_cells (
  id                  uuid primary key default uuid_generate_v4(),
  tenant_id           uuid not null references auth.users(id) on delete cascade,
  document_id         uuid not null references documents(id) on delete cascade,
  vendor_id           uuid references vendors(id) on delete set null,
  source_table_id     uuid not null references doc_tables(id) on delete cascade,
  source_page         int,
  source_row_index    int not null,
  source_col_index    int not null,
  source_rowspan      int not null default 1,
  source_colspan      int not null default 1,
  is_header           boolean not null default false,
  is_price            boolean not null default false,
  row_headers         text[] not null default '{}',
  column_headers      text[] not null default '{}',
  parent_headers      text[] not null default '{}',
  merged_headers      text[] not null default '{}',
  raw_cell_value      text,
  normalized_value    text,
  unit                text,
  currency            text,
  moq                 text,
  footnotes           text[] not null default '{}',
  nearby_notes        text[] not null default '{}',
  bbox                jsonb,
  parser_confidence   numeric(5, 4) not null default 0.75,
  ocr_confidence      numeric(5, 4),
  created_at          timestamptz not null default now(),
  unique (source_table_id, source_row_index, source_col_index)
);

create index if not exists doc_table_cells_tenant_idx on doc_table_cells(tenant_id);
create index if not exists doc_table_cells_document_idx on doc_table_cells(document_id);
create index if not exists doc_table_cells_table_idx on doc_table_cells(source_table_id);

create table if not exists doc_price_items (
  id                         uuid primary key default uuid_generate_v4(),
  tenant_id                  uuid not null references auth.users(id) on delete cascade,
  document_id                uuid not null references documents(id) on delete cascade,
  vendor_id                  uuid references vendors(id) on delete set null,
  legacy_doc_item_id         uuid references doc_items(id) on delete set null,
  source_page                int,
  source_table_id            uuid references doc_tables(id) on delete set null,
  source_cell_id             uuid references doc_table_cells(id) on delete set null,
  source_row_index           int,
  source_col_index           int,
  section_breadcrumb         text[] not null default '{}',
  table_title                text,
  row_headers                text[] not null default '{}',
  column_headers             text[] not null default '{}',
  parent_headers             text[] not null default '{}',
  nearby_notes               text[] not null default '{}',
  raw_cell_value             text,
  normalized_price           numeric(14, 2) not null,
  currency                   text not null default 'INR',
  unit                       text,
  moq                        text,
  product_text               text,
  sku_text                   text,
  description_text           text,
  attributes_json            jsonb not null default '[]'::jsonb,
  searchable_text            text not null,
  normalized_search_text     text not null,
  source_confidence          numeric(5, 4) not null default 0.75,
  parser_name                text not null,
  source_uploaded_at         timestamptz,
  created_at                 timestamptz not null default now(),
  search_doc                 tsvector generated always as (
    setweight(to_tsvector('simple', coalesce(searchable_text, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(product_text, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(sku_text, '')), 'B')
  ) stored
);

create index if not exists doc_price_items_search_idx on doc_price_items using gin (search_doc);
create index if not exists doc_price_items_norm_trgm_idx on doc_price_items using gin (normalized_search_text gin_trgm_ops);
create index if not exists doc_price_items_attrs_idx on doc_price_items using gin (attributes_json jsonb_path_ops);
create index if not exists doc_price_items_tenant_idx on doc_price_items(tenant_id);
create index if not exists doc_price_items_vendor_idx on doc_price_items(vendor_id);
create index if not exists doc_price_items_document_idx on doc_price_items(document_id);
create index if not exists doc_price_items_page_idx on doc_price_items(source_page);
create index if not exists doc_price_items_unit_idx on doc_price_items(unit);
create index if not exists doc_price_items_price_idx on doc_price_items(normalized_price);
create index if not exists doc_price_items_legacy_idx on doc_price_items(legacy_doc_item_id);

create table if not exists search_aliases (
  id              uuid primary key default uuid_generate_v4(),
  tenant_id       uuid references auth.users(id) on delete cascade,
  vendor_id       uuid references vendors(id) on delete cascade,
  document_id     uuid references documents(id) on delete cascade,
  alias_text      text not null,
  canonical_text  text not null,
  scope           text not null check (scope in ('global', 'tenant', 'vendor', 'document')),
  confidence      numeric(5, 4) not null default 0.5,
  source          text not null check (source in ('seed', 'document_mined', 'llm_suggested', 'match_log')),
  evidence        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz
);

create unique index if not exists search_aliases_unique_idx
  on search_aliases(scope, coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(vendor_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(document_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(alias_text), lower(canonical_text));
create index if not exists search_aliases_lookup_idx on search_aliases(lower(alias_text), scope, confidence desc);

create table if not exists search_eval_cases (
  id                              uuid primary key default uuid_generate_v4(),
  tenant_id                       uuid not null references auth.users(id) on delete cascade,
  document_id                     uuid references documents(id) on delete cascade,
  query                           text not null,
  expected_doc_price_item_id      uuid references doc_price_items(id) on delete cascade,
  expected_price                  numeric(14, 2),
  expected_unit                   text,
  expected_confidence_min         numeric(5, 4) not null default 0.85,
  tags                            text[] not null default '{}',
  created_at                      timestamptz not null default now()
);

create index if not exists search_eval_cases_tenant_idx on search_eval_cases(tenant_id);
create index if not exists search_eval_cases_doc_idx on search_eval_cases(document_id);

create table if not exists search_match_logs (
  id                         uuid primary key default uuid_generate_v4(),
  tenant_id                  uuid not null references auth.users(id) on delete cascade,
  query                      text not null,
  normalized_query           text not null,
  doc_price_item_id          uuid references doc_price_items(id) on delete set null,
  legacy_doc_item_id         uuid references doc_items(id) on delete set null,
  confidence_score           numeric(5, 4) not null,
  confidence_label           text not null,
  matched_fields             jsonb not null default '[]'::jsonb,
  missing_fields             jsonb not null default '[]'::jsonb,
  conflicting_fields         jsonb not null default '[]'::jsonb,
  aliases_used               jsonb not null default '[]'::jsonb,
  needs_review               boolean not null default false,
  selected_for_quotation     boolean not null default false,
  created_at                 timestamptz not null default now()
);

create index if not exists search_match_logs_tenant_idx on search_match_logs(tenant_id, created_at desc);
create index if not exists search_match_logs_item_idx on search_match_logs(doc_price_item_id);

alter table quotation_items
  add column if not exists doc_price_item_id uuid references doc_price_items(id) on delete set null;

create index if not exists quotation_items_price_item_idx on quotation_items(doc_price_item_id);

alter table doc_tables        enable row level security;
alter table doc_table_cells   enable row level security;
alter table doc_price_items   enable row level security;
alter table search_aliases    enable row level security;
alter table search_eval_cases enable row level security;
alter table search_match_logs enable row level security;

create policy "own rows" on doc_tables for all
  using (tenant_id = auth.uid()) with check (tenant_id = auth.uid());
create policy "own rows" on doc_table_cells for all
  using (tenant_id = auth.uid()) with check (tenant_id = auth.uid());
create policy "own rows" on doc_price_items for all
  using (tenant_id = auth.uid()) with check (tenant_id = auth.uid());
create policy "own rows" on search_eval_cases for all
  using (tenant_id = auth.uid()) with check (tenant_id = auth.uid());
create policy "own rows" on search_match_logs for all
  using (tenant_id = auth.uid()) with check (tenant_id = auth.uid());

create policy "visible aliases" on search_aliases for select
  using (tenant_id is null or tenant_id = auth.uid());
create policy "own aliases" on search_aliases for insert
  with check (tenant_id = auth.uid() or (tenant_id is null and scope = 'global'));
create policy "update own aliases" on search_aliases for update
  using (tenant_id = auth.uid()) with check (tenant_id = auth.uid());
create policy "delete own aliases" on search_aliases for delete
  using (tenant_id = auth.uid());

insert into search_aliases (tenant_id, alias_text, canonical_text, scope, confidence, source, evidence)
values
  (null, 'sq mm', 'sqmm', 'global', 0.98, 'seed', '{"reason":"unit normalization"}'),
  (null, 'sq.mm', 'sqmm', 'global', 0.98, 'seed', '{"reason":"unit normalization"}'),
  (null, 'sqmm', 'sqmm', 'global', 0.98, 'seed', '{"reason":"unit normalization"}'),
  (null, 'mtr', 'meter', 'global', 0.95, 'seed', '{"reason":"unit normalization"}'),
  (null, 'mtrs', 'meter', 'global', 0.95, 'seed', '{"reason":"unit normalization"}'),
  (null, 'metre', 'meter', 'global', 0.95, 'seed', '{"reason":"unit normalization"}'),
  (null, 'nos', 'piece', 'global', 0.9, 'seed', '{"reason":"unit normalization"}'),
  (null, 'no', 'piece', 'global', 0.85, 'seed', '{"reason":"unit normalization"}'),
  (null, 'pc', 'piece', 'global', 0.9, 'seed', '{"reason":"unit normalization"}'),
  (null, 'pcs', 'piece', 'global', 0.9, 'seed', '{"reason":"unit normalization"}'),
  (null, 'rs', 'inr', 'global', 0.98, 'seed', '{"reason":"currency normalization"}'),
  (null, '₹', 'inr', 'global', 0.98, 'seed', '{"reason":"currency normalization"}')
on conflict do nothing;

create or replace function rf_search_price_items(
  q text,
  lim int default 25,
  tenant uuid default auth.uid(),
  filter_vendor uuid default null,
  filter_document uuid default null
) returns table (
  doc_price_item_id uuid,
  legacy_doc_item_id uuid,
  document_id uuid,
  vendor_id uuid,
  vendor text,
  filename text,
  source_uploaded_at timestamptz,
  source_page int,
  source_table_id uuid,
  source_row_index int,
  source_col_index int,
  section_breadcrumb text[],
  table_title text,
  row_headers text[],
  column_headers text[],
  parent_headers text[],
  nearby_notes text[],
  raw_cell_value text,
  normalized_price numeric,
  currency text,
  unit text,
  moq text,
  product_text text,
  sku_text text,
  description_text text,
  attributes_json jsonb,
  searchable_text text,
  normalized_search_text text,
  source_confidence numeric,
  parser_name text,
  rank_score real
) language sql stable as $$
  with query as (
    select
      websearch_to_tsquery('simple', coalesce(q, '')) as tsq,
      lower(regexp_replace(coalesce(q, ''), '[^a-zA-Z0-9.]+', ' ', 'g')) as nq
  )
  select
    dpi.id,
    dpi.legacy_doc_item_id,
    dpi.document_id,
    dpi.vendor_id,
    v.name,
    d.filename,
    d.created_at,
    dpi.source_page,
    dpi.source_table_id,
    dpi.source_row_index,
    dpi.source_col_index,
    dpi.section_breadcrumb,
    dpi.table_title,
    dpi.row_headers,
    dpi.column_headers,
    dpi.parent_headers,
    dpi.nearby_notes,
    dpi.raw_cell_value,
    dpi.normalized_price,
    dpi.currency,
    dpi.unit,
    dpi.moq,
    dpi.product_text,
    dpi.sku_text,
    dpi.description_text,
    dpi.attributes_json,
    dpi.searchable_text,
    dpi.normalized_search_text,
    dpi.source_confidence,
    dpi.parser_name,
    (
      ts_rank_cd(dpi.search_doc, query.tsq)
      + greatest(similarity(dpi.normalized_search_text, query.nq), similarity(coalesce(dpi.product_text, ''), query.nq))
    )::real as rank_score
  from doc_price_items dpi
  join documents d on d.id = dpi.document_id
  left join vendors v on v.id = dpi.vendor_id
  cross join query
  where dpi.tenant_id = tenant
    and (filter_vendor is null or dpi.vendor_id = filter_vendor)
    and (filter_document is null or dpi.document_id = filter_document)
    and (
      dpi.search_doc @@ query.tsq
      or dpi.normalized_search_text % query.nq
      or coalesce(dpi.product_text, '') % query.nq
      or coalesce(dpi.sku_text, '') % query.nq
    )
  order by rank_score desc, dpi.source_uploaded_at desc nulls last, dpi.created_at desc
  limit lim;
$$;
