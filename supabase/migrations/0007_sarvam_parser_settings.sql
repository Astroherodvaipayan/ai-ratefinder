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
