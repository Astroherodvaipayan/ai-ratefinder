-- Make uploaded price documents a shared catalogue for authenticated users.
-- Chats, quotations, parser settings, and match logs remain user-owned.

-- Vendors are catalogue metadata: readable by all, mutable only by creator.
drop policy if exists "own rows" on vendors;
drop policy if exists "vendors readable by authenticated" on vendors;
drop policy if exists "vendors insert own" on vendors;
drop policy if exists "vendors update own" on vendors;
drop policy if exists "vendors delete own" on vendors;
create policy "vendors readable by authenticated" on vendors
  for select to authenticated using (true);
create policy "vendors insert own" on vendors
  for insert to authenticated with check (owner_id = auth.uid());
create policy "vendors update own" on vendors
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "vendors delete own" on vendors
  for delete to authenticated using (owner_id = auth.uid());

-- Documents and extracted legacy rows are readable by all users.
-- Only the uploader can create/update/delete their own rows.
drop policy if exists "own rows" on documents;
drop policy if exists "documents readable by authenticated" on documents;
drop policy if exists "documents insert own" on documents;
drop policy if exists "documents update own" on documents;
drop policy if exists "documents delete own" on documents;
create policy "documents readable by authenticated" on documents
  for select to authenticated using (true);
create policy "documents insert own" on documents
  for insert to authenticated with check (owner_id = auth.uid());
create policy "documents update own" on documents
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "documents delete own" on documents
  for delete to authenticated using (owner_id = auth.uid());

drop policy if exists "own rows" on doc_items;
drop policy if exists "doc_items readable by authenticated" on doc_items;
drop policy if exists "doc_items insert own" on doc_items;
drop policy if exists "doc_items update own" on doc_items;
drop policy if exists "doc_items delete own" on doc_items;
create policy "doc_items readable by authenticated" on doc_items
  for select to authenticated using (true);
create policy "doc_items insert own" on doc_items
  for insert to authenticated with check (owner_id = auth.uid());
create policy "doc_items update own" on doc_items
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "doc_items delete own" on doc_items
  for delete to authenticated using (owner_id = auth.uid());

-- Canonical extraction records use tenant_id as the uploader/owner id.
-- They are globally readable for deterministic search, but only owner-writable.
drop policy if exists "own rows" on doc_tables;
drop policy if exists "doc_tables readable by authenticated" on doc_tables;
drop policy if exists "doc_tables insert own" on doc_tables;
drop policy if exists "doc_tables update own" on doc_tables;
drop policy if exists "doc_tables delete own" on doc_tables;
create policy "doc_tables readable by authenticated" on doc_tables
  for select to authenticated using (true);
create policy "doc_tables insert own" on doc_tables
  for insert to authenticated with check (tenant_id = auth.uid());
create policy "doc_tables update own" on doc_tables
  for update to authenticated using (tenant_id = auth.uid()) with check (tenant_id = auth.uid());
create policy "doc_tables delete own" on doc_tables
  for delete to authenticated using (tenant_id = auth.uid());

drop policy if exists "own rows" on doc_table_cells;
drop policy if exists "doc_table_cells readable by authenticated" on doc_table_cells;
drop policy if exists "doc_table_cells insert own" on doc_table_cells;
drop policy if exists "doc_table_cells update own" on doc_table_cells;
drop policy if exists "doc_table_cells delete own" on doc_table_cells;
create policy "doc_table_cells readable by authenticated" on doc_table_cells
  for select to authenticated using (true);
create policy "doc_table_cells insert own" on doc_table_cells
  for insert to authenticated with check (tenant_id = auth.uid());
create policy "doc_table_cells update own" on doc_table_cells
  for update to authenticated using (tenant_id = auth.uid()) with check (tenant_id = auth.uid());
create policy "doc_table_cells delete own" on doc_table_cells
  for delete to authenticated using (tenant_id = auth.uid());

drop policy if exists "own rows" on doc_price_items;
drop policy if exists "doc_price_items readable by authenticated" on doc_price_items;
drop policy if exists "doc_price_items insert own" on doc_price_items;
drop policy if exists "doc_price_items update own" on doc_price_items;
drop policy if exists "doc_price_items delete own" on doc_price_items;
create policy "doc_price_items readable by authenticated" on doc_price_items
  for select to authenticated using (true);
create policy "doc_price_items insert own" on doc_price_items
  for insert to authenticated with check (tenant_id = auth.uid());
create policy "doc_price_items update own" on doc_price_items
  for update to authenticated using (tenant_id = auth.uid()) with check (tenant_id = auth.uid());
create policy "doc_price_items delete own" on doc_price_items
  for delete to authenticated using (tenant_id = auth.uid());

-- Document-scoped aliases mined from shared documents may help all users.
drop policy if exists "visible aliases" on search_aliases;
create policy "visible aliases" on search_aliases for select
  using (tenant_id is null or tenant_id = auth.uid() or document_id is not null);

-- The file API signs URLs server-side, but direct storage reads should also
-- support authenticated shared catalogue access.
drop policy if exists "users can read own files" on storage.objects;
drop policy if exists "authenticated users can read uploaded files" on storage.objects;
create policy "authenticated users can read uploaded files"
on storage.objects for select
to authenticated
using (bucket_id = 'uploads');

-- Search all shared canonical price records. The tenant argument is kept for
-- API compatibility and match-log ownership, but no longer restricts recall.
create or replace function rf_search_price_items(
  q text,
  tenant uuid,
  filter_vendor uuid default null,
  filter_document uuid default null,
  lim int default 40
) returns table (
  id uuid,
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
  where (filter_vendor is null or dpi.vendor_id = filter_vendor)
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
