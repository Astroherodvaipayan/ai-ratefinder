create table if not exists user_settings (
  owner_id    uuid primary key references auth.users(id) on delete cascade,
  parser_mode text not null default 'auto',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  sarvam_language text not null default 'en-IN'
);

alter table user_settings
  add column if not exists parser_mode text not null default 'auto';

alter table user_settings
  add column if not exists created_at timestamptz not null default now();

alter table user_settings
  add column if not exists updated_at timestamptz not null default now();

alter table user_settings
  add column if not exists sarvam_language text not null default 'en-IN';

alter table user_settings
  drop constraint if exists user_settings_parser_mode_check;

alter table user_settings
  add constraint user_settings_parser_mode_check
  check (parser_mode in ('auto', 'internal', 'chandra', 'sarvam'));

alter table user_settings
  drop constraint if exists user_settings_sarvam_language_check;

alter table user_settings
  add constraint user_settings_sarvam_language_check
  check (sarvam_language in ('en-IN', 'hi-IN', 'bn-IN', 'gu-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'or-IN', 'pa-IN', 'ta-IN', 'te-IN', 'ur-IN', 'as-IN', 'bodo-IN', 'doi-IN', 'ks-IN', 'kok-IN', 'mai-IN', 'mni-IN', 'ne-IN', 'sa-IN', 'sat-IN', 'sd-IN'));

alter table user_settings enable row level security;

drop policy if exists "own rows" on user_settings;

create policy "own rows" on user_settings
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
