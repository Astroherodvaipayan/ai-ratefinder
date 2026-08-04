-- Preserve exact catalogue rates in quotation lines and retain a direct link
-- to the verified source offer used to create each line.

begin;

alter table public.quotation_items
  alter column unit_price type numeric using unit_price::numeric,
  add column if not exists catalog_offer_id uuid references public.catalog_offers(id) on delete set null;

create index if not exists quotation_items_catalog_offer_idx
  on public.quotation_items(catalog_offer_id);

commit;

notify pgrst, 'reload schema';
