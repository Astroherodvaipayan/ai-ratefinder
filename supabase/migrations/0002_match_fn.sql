-- Hybrid full-text + trigram matcher used by /api/match
create or replace function rf_match_products(q text, lim int default 10)
returns table (
  product_id     uuid,
  canonical_name text,
  unit           text,
  score          float
)
language sql stable as $$
  select
    p.id,
    p.canonical_name,
    p.unit,
    (0.5 * ts_rank_cd(p.search_doc, plainto_tsquery('simple', q))
     + 0.5 * similarity(p.canonical_name, q)) as score
  from products p
  where p.owner_id = auth.uid()
    and (
      p.search_doc @@ plainto_tsquery('simple', q)
      or similarity(p.canonical_name, q) > 0.2
      or exists (select 1 from unnest(p.aliases) a where similarity(a, q) > 0.3)
    )
  order by score desc
  limit lim;
$$;
