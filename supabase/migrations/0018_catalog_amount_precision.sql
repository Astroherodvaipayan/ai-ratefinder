-- Catalogue prices must remain lossless. numeric(14, 2) rounded legitimate
-- source rates such as 143.665 before a release could be activated.

begin;

alter table public.catalog_offers
  alter column amount type numeric using amount::numeric;

create or replace function public.activate_catalog_release(target_release_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.catalog_releases%rowtype;
  stored_offer_count bigint;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  select * into target
  from public.catalog_releases
  where id = target_release_id
    and status = 'staging'
  for update;

  if not found then
    raise exception 'release is not staging';
  end if;
  if target.reconstruction_failures <> 0 then
    raise exception 'release contains reconstruction failures';
  end if;
  if target.offers_quarantined <> 0 then
    raise exception 'release contains quarantined offers';
  end if;
  if target.offers_published <= 0 then
    raise exception 'release contains no published offers';
  end if;

  select count(*) into stored_offer_count
  from public.catalog_offers
  where release_id = target_release_id;

  if stored_offer_count <> target.offers_published then
    raise exception 'stored offer count % does not match release count %', stored_offer_count, target.offers_published;
  end if;
  if exists (
    select 1
    from public.catalog_offers
    where release_id = target_release_id
      and (
        status <> 'published'
        or currency <> 'INR'
        or cardinality(validation_errors) <> 0
      )
  ) then
    raise exception 'release contains non-publishable offer rows';
  end if;

  update public.catalog_releases
  set status = 'retired'
  where status = 'active';

  update public.catalog_releases
  set status = 'active', activated_at = now()
  where id = target_release_id;
end;
$$;

revoke all on function public.activate_catalog_release(uuid) from public;
grant execute on function public.activate_catalog_release(uuid) to service_role;

commit;

notify pgrst, 'reload schema';
