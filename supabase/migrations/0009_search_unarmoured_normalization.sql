-- Normalize unarmored/unarmoured spelling variants before search scoring.

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
