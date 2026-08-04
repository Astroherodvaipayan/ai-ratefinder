-- AI Ratefinder prices are sourced from Indian vendor price lists. Currency
-- symbols interpreted as EUR/USD by OCR are metadata errors, not conversions.

begin;

update catalog_offers set currency = 'INR' where currency is distinct from 'INR';
update doc_items set currency = 'INR' where currency is distinct from 'INR';
update doc_price_items set currency = 'INR' where currency is distinct from 'INR';
update doc_table_cells set currency = 'INR' where currency is not null and currency is distinct from 'INR';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'catalog_offers_currency_inr') then
    alter table catalog_offers add constraint catalog_offers_currency_inr check (currency = 'INR');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'doc_items_currency_inr') then
    alter table doc_items add constraint doc_items_currency_inr check (currency = 'INR');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'doc_price_items_currency_inr') then
    alter table doc_price_items add constraint doc_price_items_currency_inr check (currency = 'INR');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'doc_table_cells_currency_inr') then
    alter table doc_table_cells add constraint doc_table_cells_currency_inr check (currency is null or currency = 'INR');
  end if;
end;
$$;

commit;

notify pgrst, 'reload schema';
