-- Make product search tolerant of electrical shorthand and brand-scoped queries.
-- Examples:
--   6SqmmX2Core Cu Armoured Cable -> 6 sqmm 2 core copper armoured cable
--   4Sqmm FRLs Wire 200Mtr        -> 4 sqmm frls wire 200 mtr

create or replace function rf_search_normalize(value text)
returns text
language sql immutable as $$
  with normalized as (
    select lower(coalesce(value, '')) as v
  ),
  symbols as (
    select regexp_replace(v, '[×*]', ' x ', 'g') as v
    from normalized
  ),
  terms as (
    select
      regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  regexp_replace(v, '\mfr[[:space:]]*[-_/]?[[:space:]]*ls[[:space:]]*h\M', ' frlsh ', 'gi'),
                  '\mfr[[:space:]]*[-_/]?[[:space:]]*ls\M', ' frls ', 'gi'
                ),
                '\mcu\M', ' copper ', 'gi'
              ),
              '\mal\M', ' aluminium ', 'gi'
            ),
            '\mun[[:space:]]*[-_/]?[[:space:]]*arm(ou?red|ored|d)?[.]?\M', ' unarmoured ', 'gi'
          ),
          '\marm(ou?red|ored|d)?[.]?\M', ' armoured ', 'gi'
        ) as v
    from symbols
  ),
  dimensions as (
    select
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(v, '([0-9]+([.][0-9]+)?)[[:space:]]*sq[.]?[[:space:]]*mm[[:space:]]*x[[:space:]]*([0-9]+)[[:space:]]*(cores?|core|c)\M', '\1 sqmm \3 core', 'gi'),
            '([0-9]+([.][0-9]+)?)[[:space:]]*sq[.]?[[:space:]]*mm\M', '\1 sqmm', 'gi'
          ),
          '([0-9]+)[[:space:]]*(cores?|core|c)\M', '\1 core', 'gi'
        ),
        '([0-9]+([.][0-9]+)?)[[:space:]]*(mtrs?[.]?|metres?|meters?|mtr)\M', '\1 mtr', 'gi'
      ) as v
    from terms
  ),
  spaced as (
    select
      regexp_replace(
        regexp_replace(
          regexp_replace(v, '([[:alpha:]])([0-9])', '\1 \2', 'g'),
          '([0-9])([[:alpha:]])', '\1 \2', 'g'
        ),
        '([[:alnum:].])[[:space:]]*x[[:space:]]*([0-9])', '\1 \2', 'gi'
      ) as v
    from dimensions
  ),
  decimal_safe as (
    select regexp_replace(v, '([0-9])[.]([0-9])', '\1p\2', 'g') as v
    from spaced
  ),
  cleaned as (
    select regexp_replace(v, '[^a-z0-9]+', ' ', 'g') as v
    from decimal_safe
  )
  select btrim(regexp_replace(regexp_replace(v, '([0-9])p([0-9])', '\1.\2', 'g'), '[[:space:]]+', ' ', 'g'))
  from cleaned;
$$;

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
      rf_search_normalize(q) as words,
      regexp_replace(rf_search_normalize(q), '[^a-z0-9]+', '', 'g') as compact
  ),
  item_text as (
    select
      i.*,
      d.filename,
      d.created_at as source_uploaded_at,
      coalesce(v.name, 'Unknown') as vendor,
      rf_search_normalize(concat_ws(' ', i.raw_name, i.sku, i.unit, coalesce(v.name, ''), d.filename)) as words
    from doc_items i
    join documents d on d.id = i.document_id
    left join vendors v on v.id = d.vendor_id
    where i.owner_id = auth.uid()
      and d.status = 'parsed'
      and i.price is not null
  ),
  prepared_items as (
    select
      *,
      regexp_replace(words, '[^a-z0-9]+', '', 'g') as compact
    from item_text
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
      i.filename,
      i.source_uploaded_at,
      i.vendor,
      i.words as item_words,
      i.compact as item_compact,
      query_text.words as query_words,
      query_text.compact as query_compact,
      (
        0.30 * ts_rank_cd(to_tsvector('simple', i.words), plainto_tsquery('simple', query_text.words))
        + 0.25 * greatest(similarity(i.words, query_text.words), similarity(coalesce(i.sku, ''), query_text.original))
        + 0.20 * case
          when query_text.compact <> ''
            and (
              i.compact like '%' || query_text.compact || '%'
              or (
                length(i.compact) >= 6
                and query_text.compact like '%' || i.compact || '%'
              )
            )
          then 1 else 0
        end
        + 0.25 * (
          select coalesce(avg(case when token = any(regexp_split_to_array(i.words, '[[:space:]]+')) then 1.0 else 0.0 end), 0)
          from unnest(regexp_split_to_array(query_text.words, '[[:space:]]+')) as token
          where token <> ''
            and token not in (
              'about', 'all', 'any', 'available', 'cable', 'cables', 'document',
              'documents', 'find', 'for', 'from', 'give', 'price', 'prices',
              'rate', 'rates', 'show', 'the', 'this', 'with'
            )
        )
      ) as score
    from prepared_items i
    cross join query_text
    where query_text.words <> ''
      and (
        to_tsvector('simple', i.words) @@ plainto_tsquery('simple', query_text.words)
        or similarity(i.words, query_text.words) > 0.18
        or similarity(coalesce(i.sku, ''), query_text.original) > 0.2
        or coalesce(i.sku, '') ilike '%' || query_text.original || '%'
        or (
          query_text.compact <> ''
          and (
            i.compact like '%' || query_text.compact || '%'
            or (
              length(i.compact) >= 6
              and query_text.compact like '%' || i.compact || '%'
            )
          )
        )
        or (
          select coalesce(avg(case when token = any(regexp_split_to_array(i.words, '[[:space:]]+')) then 1.0 else 0.0 end), 0)
          from unnest(regexp_split_to_array(query_text.words, '[[:space:]]+')) as token
          where token <> ''
            and token not in (
              'about', 'all', 'any', 'available', 'cable', 'cables', 'document',
              'documents', 'find', 'for', 'from', 'give', 'price', 'prices',
              'rate', 'rates', 'show', 'the', 'this', 'with'
            )
        ) >= 0.60
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
