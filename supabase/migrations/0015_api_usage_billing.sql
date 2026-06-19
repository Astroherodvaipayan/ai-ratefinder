-- API usage billing guardrails.

alter table documents
  add column if not exists api_cost_mode text not null default 'high_accuracy';

alter table documents
  alter column api_cost_mode set default 'high_accuracy';

alter table documents
  add column if not exists api_cost_inr numeric(14, 2);

alter table documents
  add column if not exists api_cost_recorded_at timestamptz;

alter table documents
  drop constraint if exists documents_api_cost_mode_check;

alter table documents
  add constraint documents_api_cost_mode_check
  check (api_cost_mode in ('fast_balanced', 'high_accuracy'));

create table if not exists api_payment_refs (
  id             uuid primary key default uuid_generate_v4(),
  owner_id       uuid not null references auth.users(id) on delete cascade,
  billing_month  date not null,
  reference_no   text not null,
  amount_inr     numeric(14, 2) not null default 1500,
  note           text,
  created_at     timestamptz not null default now(),
  unique (owner_id, billing_month, reference_no)
);

create index if not exists api_payment_refs_owner_month_idx
  on api_payment_refs(owner_id, billing_month desc);

alter table api_payment_refs enable row level security;

drop policy if exists "own rows" on api_payment_refs;

create policy "own rows" on api_payment_refs
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
