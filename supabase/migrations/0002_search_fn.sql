-- Hybrid full-text + trigram retrieval over doc_items.
-- Used by /api/chat (RAG candidates) and /api/search (library search).

create or replace function rf_search_items(q text, lim int default 15)
returns table (
  doc_item_id   uuid,
  document_id   uuid,
  raw_name      text,
  sku           text,
  unit          text,
  price         numeric,
  moq           text,
  currency      text,
  source_page   int,
  filename      text,
  vendor        text,
  score         float
)
language sql stable as $$
  select
    i.id,
    i.document_id,
    i.raw_name,
    i.sku,
    i.unit,
    i.price,
    i.moq,
    i.currency,
    i.source_page,
    d.filename,
    coalesce(v.name, 'Unknown') as vendor,
    (0.6 * ts_rank_cd(i.search_doc, plainto_tsquery('simple', q))
     + 0.4 * similarity(i.raw_name, q)) as score
  from doc_items i
  join documents d on d.id = i.document_id
  left join vendors v on v.id = d.vendor_id
  where i.owner_id = auth.uid()
    and (
      i.search_doc @@ plainto_tsquery('simple', q)
      or similarity(i.raw_name, q) > 0.2
      or i.sku ilike '%' || q || '%'
    )
  order by score desc
  limit lim;
$$;
