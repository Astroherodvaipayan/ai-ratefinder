-- Backfill canonical deterministic price records from existing legacy doc_items.
-- This is intentionally generic: it preserves legacy_doc_item_id, source page,
-- vendor/document context, SKU, unit, price, and searchable text without adding
-- category-specific columns.

do $$
begin
  if to_regclass('public.doc_price_items') is null then
    raise exception 'doc_price_items does not exist. Run 0010_deterministic_rate_engine.sql before this backfill.';
  end if;

  if to_regclass('public.doc_items') is null then
    raise exception 'doc_items does not exist. Run the base schema migrations before this backfill.';
  end if;

  if to_regprocedure('public.rf_search_normalize(text)') is null then
    raise exception 'rf_search_normalize(text) does not exist. Run 0008_search_electrical_terms.sql before this backfill.';
  end if;
end $$;

delete from doc_price_items
where legacy_doc_item_id is not null;

insert into doc_price_items (
  tenant_id,
  document_id,
  vendor_id,
  legacy_doc_item_id,
  source_page,
  section_breadcrumb,
  table_title,
  row_headers,
  column_headers,
  parent_headers,
  nearby_notes,
  raw_cell_value,
  normalized_price,
  currency,
  unit,
  moq,
  product_text,
  sku_text,
  description_text,
  attributes_json,
  searchable_text,
  normalized_search_text,
  source_confidence,
  parser_name,
  source_uploaded_at
)
select
  i.owner_id,
  i.document_id,
  d.vendor_id,
  i.id,
  i.source_page,
  array_remove(array[v.name, d.filename]::text[], null),
  d.filename,
  array_remove(array[i.raw_name, i.sku]::text[], null),
  array_remove(array[i.unit]::text[], null),
  array_remove(array[v.name]::text[], null),
  '{}'::text[],
  i.price::text,
  i.price,
  coalesce(i.currency, 'INR'),
  i.unit,
  i.moq,
  i.raw_name,
  i.sku,
  i.raw_name,
  '[]'::jsonb,
  concat_ws(
    '. ',
    case when v.name is not null then 'Vendor: ' || v.name end,
    'Document: ' || d.filename,
    case when i.source_page is not null then 'Page: ' || i.source_page end,
    'Row: ' || i.raw_name,
    case when i.sku is not null then 'SKU: ' || i.sku end,
    case when i.unit is not null then 'Unit: ' || i.unit end,
    'Rate: ' || i.price || ' ' || coalesce(i.currency, 'INR')
  ),
  rf_search_normalize(concat_ws(' ', v.name, d.filename, i.raw_name, i.sku, i.unit, i.price)),
  0.72,
  'legacy-doc-items-sql-backfill',
  d.created_at
from doc_items i
join documents d on d.id = i.document_id
left join vendors v on v.id = d.vendor_id
where i.price is not null;

notify pgrst, 'reload schema';
