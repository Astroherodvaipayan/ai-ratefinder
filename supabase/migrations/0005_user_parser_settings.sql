create table if not exists user_settings (
  owner_id    uuid primary key references auth.users(id) on delete cascade,
  parser_mode text not null default 'auto',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint user_settings_parser_mode_check
    check (parser_mode in ('auto', 'internal', 'chandra'))
);

alter table user_settings enable row level security;

create policy "own rows" on user_settings
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
