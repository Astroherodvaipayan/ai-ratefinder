-- Search V3: make every published catalogue SKU directly addressable.
-- Formatting is ignored so "BA-40630-C" and "BA40630C" resolve identically.

alter table catalog_offers
  add column if not exists normalized_sku text generated always as (
    lower(regexp_replace(coalesce(sku, ''), '[^a-zA-Z0-9]+', '', 'g'))
  ) stored;

create index if not exists catalog_offers_release_normalized_sku_idx
  on catalog_offers(release_id, normalized_sku)
  where status = 'published' and normalized_sku <> '';

create index if not exists catalog_offers_normalized_sku_prefix_idx
  on catalog_offers(normalized_sku text_pattern_ops)
  where status = 'published' and normalized_sku <> '';

notify pgrst, 'reload schema';
