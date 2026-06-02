-- Hybrid full-text + trigram retrieval over doc_items.
-- Used by /api/chat (RAG candidates) and /api/search (library search).

drop function if exists rf_search_items(text, int);

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
  source_uploaded_at timestamptz,
  score         float
)
language sql stable as $$
  with scored as (
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
      d.created_at as source_uploaded_at,
      coalesce(v.name, 'Unknown') as vendor,
      (
        0.50 * ts_rank_cd(i.search_doc, plainto_tsquery('simple', q))
        + 0.30 * greatest(similarity(i.raw_name, q), similarity(coalesce(i.sku, ''), q))
        + 0.20 * case when coalesce(i.sku, '') ilike '%' || q || '%' then 1 else 0 end
      ) as score
    from doc_items i
    join documents d on d.id = i.document_id
    left join vendors v on v.id = d.vendor_id
    where i.owner_id = auth.uid()
      and d.status = 'parsed'
      and i.price is not null
      and (
        i.search_doc @@ plainto_tsquery('simple', q)
        or similarity(i.raw_name, q) > 0.2
        or similarity(coalesce(i.sku, ''), q) > 0.2
        or coalesce(i.sku, '') ilike '%' || q || '%'
      )
  )
  select
    id,
    document_id,
    raw_name,
    sku,
    unit,
    price,
    moq,
    currency,
    source_page,
    filename,
    vendor,
    source_uploaded_at,
    score
  from scored
  order by
    case when lower(coalesce(sku, '')) = lower(q) then 1 else 0 end desc,
    score desc,
    source_uploaded_at desc
  limit lim;
$$;
