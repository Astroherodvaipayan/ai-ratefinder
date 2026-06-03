-- Improve product search for OCR punctuation/spacing variants.
-- Examples: "co axial", "co-axial", and "coaxial" should all find the same row.

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
  with query_text as (
    select
      q as original,
      regexp_replace(lower(q), '[^a-z0-9]+', ' ', 'g') as words,
      regexp_replace(lower(q), '[^a-z0-9]+', '', 'g') as compact
  ),
  scored as (
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
        0.45 * ts_rank_cd(i.search_doc, plainto_tsquery('simple', query_text.original))
        + 0.25 * greatest(similarity(i.raw_name, query_text.original), similarity(coalesce(i.sku, ''), query_text.original))
        + 0.20 * case when coalesce(i.sku, '') ilike '%' || query_text.original || '%' then 1 else 0 end
        + 0.10 * case
          when query_text.compact <> ''
            and (
              regexp_replace(lower(i.raw_name), '[^a-z0-9]+', '', 'g') like '%' || query_text.compact || '%'
              or regexp_replace(lower(coalesce(i.sku, '')), '[^a-z0-9]+', '', 'g') like '%' || query_text.compact || '%'
            )
          then 1 else 0
        end
      ) as score
    from doc_items i
    join documents d on d.id = i.document_id
    left join vendors v on v.id = d.vendor_id
    cross join query_text
    where i.owner_id = auth.uid()
      and d.status = 'parsed'
      and i.price is not null
      and (
        i.search_doc @@ plainto_tsquery('simple', query_text.original)
        or similarity(i.raw_name, query_text.original) > 0.2
        or similarity(coalesce(i.sku, ''), query_text.original) > 0.2
        or coalesce(i.sku, '') ilike '%' || query_text.original || '%'
        or (
          query_text.compact <> ''
          and (
            regexp_replace(lower(i.raw_name), '[^a-z0-9]+', '', 'g') like '%' || query_text.compact || '%'
            or regexp_replace(lower(coalesce(i.sku, '')), '[^a-z0-9]+', '', 'g') like '%' || query_text.compact || '%'
          )
        )
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
