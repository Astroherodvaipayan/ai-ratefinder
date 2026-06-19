-- Production hardening for proforma invoices and quotation item auditability.

alter table quotations
  add column if not exists payment_terms text,
  add column if not exists delivery_terms text,
  add column if not exists validity text,
  add column if not exists revision_no int not null default 1,
  add column if not exists locked_at timestamptz;

create table if not exists quotation_item_audit_logs (
  id                 uuid primary key default uuid_generate_v4(),
  quotation_id       uuid not null references quotations(id) on delete cascade,
  quotation_item_id  uuid references quotation_items(id) on delete set null,
  actor_id           uuid references auth.users(id) on delete set null,
  action             text not null,
  review_confirmed   boolean not null default false,
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

create index if not exists quotation_item_audit_logs_quote_idx
  on quotation_item_audit_logs(quotation_id, created_at desc);
create index if not exists quotation_item_audit_logs_item_idx
  on quotation_item_audit_logs(quotation_item_id, created_at desc);

alter table quotation_item_audit_logs enable row level security;

create policy "via quotation" on quotation_item_audit_logs for all
  using (exists (
    select 1 from quotations q
    where q.id = quotation_id and q.owner_id = auth.uid()
  ))
  with check (exists (
    select 1 from quotations q
    where q.id = quotation_id and q.owner_id = auth.uid()
  ));
