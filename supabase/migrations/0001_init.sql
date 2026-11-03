-- Mahnwerk initial schema.
-- Money is always integer cents (bigint). Dates without time are "date" (calendar days).
-- RLS is enabled on every table. Browser clients (anon key, anonymous auth users) can READ rows of
-- the workspace they own plus the read-only golden workspace. All money-relevant writes (invoices,
-- ledger, cases, steps, events, audit, AI runs, quota) go through server routes that use the
-- service role, which bypasses RLS. Users may only create their own demo workspace and edit their
-- own creditor and debtor master data.

begin;

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Workspaces
-- ---------------------------------------------------------------------------
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  -- Deleting an (anonymous) auth user removes its workspaces; audit rows survive (no FK there).
  owner_uid uuid references auth.users (id) on delete cascade,
  kind text not null default 'demo' check (kind in ('demo', 'real', 'golden')),
  name text not null default 'Workspace',
  jurisdiction text not null default 'DE',
  clock_offset_days integer not null default 0 check (clock_offset_days >= 0),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  -- The golden workspace has no owner; every other workspace has one.
  constraint workspaces_owner_required check ((kind = 'golden') = (owner_uid is null))
);
create index workspaces_owner_idx on public.workspaces (owner_uid);
-- At most one golden workspace.
create unique index workspaces_single_golden on public.workspaces ((kind)) where kind = 'golden';

-- ---------------------------------------------------------------------------
-- Master data
-- ---------------------------------------------------------------------------
create table public.creditors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null,
  address jsonb not null default '{}'::jsonb,
  kleinunternehmer boolean not null default false,
  lang text not null default 'de' check (lang in ('de', 'en')),
  created_at timestamptz not null default now()
);
create index creditors_ws_idx on public.creditors (workspace_id);

create table public.debtors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null,
  email text,
  type text not null check (type in ('consumer', 'business')),
  lang text not null default 'de' check (lang in ('de', 'en')),
  created_at timestamptz not null default now()
);
create index debtors_ws_idx on public.debtors (workspace_id);

-- ---------------------------------------------------------------------------
-- Rules configuration (global, read-only for clients)
-- ---------------------------------------------------------------------------
create table public.rule_sets (
  id uuid primary key default gen_random_uuid(),
  jurisdiction text not null,
  valid_from date not null,
  params jsonb not null,
  created_at timestamptz not null default now(),
  unique (jurisdiction, valid_from)
);

create table public.base_rates (
  jurisdiction text not null,
  valid_from date not null,
  rate_bp integer not null,
  source text,
  primary key (jurisdiction, valid_from)
);

-- ---------------------------------------------------------------------------
-- Invoices and ledger
-- ---------------------------------------------------------------------------
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  creditor_id uuid references public.creditors (id) on delete restrict,
  debtor_id uuid not null references public.debtors (id) on delete restrict,
  paypal_invoice_id text unique,
  number text,
  currency text not null default 'EUR' check (currency = 'EUR'),
  issue_date date not null,
  due_date date not null,
  fixed_calendar_due boolean not null default false,
  default_warning_printed boolean not null default false,
  received_on date,
  principal_cents bigint not null check (principal_cents > 0),
  -- Last values seen from a GET on PayPal (never from webhook payloads).
  paypal_status text,
  paypal_paid_cents bigint check (paypal_paid_cents >= 0),
  paypal_refunded_cents bigint check (paypal_refunded_cents >= 0),
  paypal_due_cents bigint check (paypal_due_cents >= 0),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  check (due_date >= issue_date)
);
create index invoices_ws_idx on public.invoices (workspace_id);
create index invoices_number_idx on public.invoices (number);

create table public.ledger (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  kind text not null check (kind in ('payment', 'refund')),
  -- Always positive; kind decides the direction (same convention as lib/rules).
  amount_cents bigint not null check (amount_cents > 0),
  booked_on date not null,
  -- PayPal payment_id / refund_id / transaction id. Unique per invoice and kind: makes replay idempotent.
  paypal_ref text not null,
  source text not null default 'paypal' check (source in ('paypal', 'manual')),
  allocation jsonb,
  created_at timestamptz not null default now(),
  unique (invoice_id, kind, paypal_ref)
);
create index ledger_invoice_idx on public.ledger (invoice_id);
create index ledger_ref_idx on public.ledger (paypal_ref);

-- ---------------------------------------------------------------------------
-- Dunning cases and steps
-- ---------------------------------------------------------------------------
create table public.dunning_cases (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  invoice_id uuid not null unique references public.invoices (id) on delete cascade,
  state text not null default 'open' check (state in (
    'open', 'overdue', 'reminded', 'mahnung1', 'mahnung2', 'handover_ready',
    'paused_dispute', 'closed_paid', 'closed_refunded', 'closed_cancelled'
  )),
  -- Active state to return to after a dispute pause or a reopen after closed_paid.
  prev_state text check (prev_state in ('open', 'overdue', 'reminded', 'mahnung1', 'mahnung2', 'handover_ready')),
  paused_reason text,
  rule_set_id uuid references public.rule_sets (id),
  default_start date,
  next_step_kind text,
  next_step_due date,
  fee_invoice_paypal_id text,
  version integer not null default 0,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check ((state = 'paused_dispute') = (paused_reason is not null))
);
create index dunning_cases_ws_idx on public.dunning_cases (workspace_id);

create table public.steps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  case_id uuid not null references public.dunning_cases (id) on delete cascade,
  kind text not null check (kind in ('reminder', 'mahnung1', 'mahnung2', 'handover', 'fee_invoice', 'close')),
  facts jsonb not null default '{}'::jsonb,
  draft jsonb,
  validation jsonb,
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'sent', 'rejected', 'failed')),
  approved_by uuid,
  approved_at timestamptz,
  sent_via text check (sent_via in ('paypal_remind', 'email', 'paypal_invoice', 'none')),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  -- Nothing may be sent without a recorded human approval.
  check (status not in ('approved', 'sent') or (approved_by is not null and approved_at is not null))
);
create index steps_case_idx on public.steps (case_id);
create index steps_ws_idx on public.steps (workspace_id);

-- ---------------------------------------------------------------------------
-- PayPal webhook events
-- ---------------------------------------------------------------------------
create table public.paypal_events (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,
  event_type text not null,
  resource_type text,
  resource_id text,
  workspace_id uuid references public.workspaces (id) on delete set null,
  verified boolean not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  attempts integer not null default 0,
  note text,
  error text
);
create index paypal_events_unprocessed_idx on public.paypal_events (received_at) where processed_at is null;

-- ---------------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------------
-- No foreign keys on purpose: deleting an expired demo workspace must not need to touch audit rows
-- (any cascade or set null would be an UPDATE/DELETE and is blocked by the trigger below).
create table public.audit_log (
  id bigint generated always as identity primary key,
  workspace_id uuid,
  case_id uuid,
  invoice_id uuid,
  actor text not null check (actor in ('user', 'system', 'ai', 'paypal')),
  actor_uid uuid,
  action text not null,
  from_state text,
  to_state text,
  real_ts timestamptz not null default now(),
  virtual_date date,
  details jsonb not null default '{}'::jsonb
);
create index audit_log_ws_idx on public.audit_log (workspace_id, real_ts);
create index audit_log_case_idx on public.audit_log (case_id, real_ts);

create or replace function public.mw_audit_log_block_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_log is append-only (% blocked)', tg_op using errcode = 'insufficient_privilege';
end;
$$;

create trigger audit_log_no_update
  before update or delete on public.audit_log
  for each row execute function public.mw_audit_log_block_mutation();
create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function public.mw_audit_log_block_mutation();

-- ---------------------------------------------------------------------------
-- AI runs and API quota
-- ---------------------------------------------------------------------------
create table public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  step_id uuid references public.steps (id) on delete set null,
  purpose text not null,
  model text not null,
  input_facts jsonb not null,
  raw_output jsonb,
  validation_passed boolean,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz not null default now()
);
create index ai_runs_ws_idx on public.ai_runs (workspace_id);

create table public.api_quota (
  merchant_id text not null,
  day date not null,
  -- PayPal sandbox: max 2 invoice reminders per day per API caller.
  reminders_used integer not null default 0 check (reminders_used between 0 and 2),
  primary key (merchant_id, day)
);

-- ---------------------------------------------------------------------------
-- Case transition with audit, atomically (service role only)
-- ---------------------------------------------------------------------------
create or replace function public.mw_transition_case(
  p_case_id uuid,
  p_expected_version integer,
  p_from_state text,
  p_to_state text,
  p_prev_state text,
  p_paused_reason text,
  p_actor text,
  p_action text,
  p_virtual_date date,
  p_details jsonb
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_ws uuid;
  v_invoice uuid;
begin
  update public.dunning_cases
     set state = p_to_state,
         prev_state = p_prev_state,
         paused_reason = p_paused_reason,
         version = version + 1,
         updated_at = now()
   where id = p_case_id
     and version = p_expected_version
     and state = p_from_state
  returning workspace_id, invoice_id into v_ws, v_invoice;

  if not found then
    return false;
  end if;

  insert into public.audit_log (workspace_id, case_id, invoice_id, actor, action, from_state, to_state, virtual_date, details)
  values (v_ws, p_case_id, v_invoice, p_actor, p_action, p_from_state, p_to_state, p_virtual_date, coalesce(p_details, '{}'::jsonb));

  return true;
end;
$$;

revoke all on function public.mw_transition_case(uuid, integer, text, text, text, text, text, text, date, jsonb) from public, anon, authenticated;
grant execute on function public.mw_transition_case(uuid, integer, text, text, text, text, text, text, date, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- RLS helpers
-- ---------------------------------------------------------------------------
create or replace function public.mw_is_workspace_owner(p_ws uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspaces w
     where w.id = p_ws and w.owner_uid = (select auth.uid()) and w.kind <> 'golden'
  );
$$;

create or replace function public.mw_can_read_workspace(p_ws uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspaces w
     where w.id = p_ws and (w.kind = 'golden' or w.owner_uid = (select auth.uid()))
  );
$$;

revoke all on function public.mw_is_workspace_owner(uuid) from public;
revoke all on function public.mw_can_read_workspace(uuid) from public;
grant execute on function public.mw_is_workspace_owner(uuid) to anon, authenticated, service_role;
grant execute on function public.mw_can_read_workspace(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.workspaces enable row level security;
alter table public.creditors enable row level security;
alter table public.debtors enable row level security;
alter table public.rule_sets enable row level security;
alter table public.base_rates enable row level security;
alter table public.invoices enable row level security;
alter table public.ledger enable row level security;
alter table public.dunning_cases enable row level security;
alter table public.steps enable row level security;
alter table public.paypal_events enable row level security;
alter table public.audit_log enable row level security;
alter table public.ai_runs enable row level security;
alter table public.api_quota enable row level security;

-- workspaces: read own or golden; create only an own demo workspace.
create policy workspaces_select on public.workspaces
  for select to anon, authenticated
  using (kind = 'golden' or owner_uid = (select auth.uid()));
create policy workspaces_insert_own_demo on public.workspaces
  for insert to authenticated
  with check (owner_uid = (select auth.uid()) and kind = 'demo');

-- creditors and debtors: read own or golden; owner may write own (never golden).
create policy creditors_select on public.creditors
  for select to anon, authenticated using (public.mw_can_read_workspace(workspace_id));
create policy creditors_insert on public.creditors
  for insert to authenticated with check (public.mw_is_workspace_owner(workspace_id));
create policy creditors_update on public.creditors
  for update to authenticated
  using (public.mw_is_workspace_owner(workspace_id))
  with check (public.mw_is_workspace_owner(workspace_id));

create policy debtors_select on public.debtors
  for select to anon, authenticated using (public.mw_can_read_workspace(workspace_id));
create policy debtors_insert on public.debtors
  for insert to authenticated with check (public.mw_is_workspace_owner(workspace_id));
create policy debtors_update on public.debtors
  for update to authenticated
  using (public.mw_is_workspace_owner(workspace_id))
  with check (public.mw_is_workspace_owner(workspace_id));

-- Global config: readable by everyone, writable only by the service role.
create policy rule_sets_select on public.rule_sets for select to anon, authenticated using (true);
create policy base_rates_select on public.base_rates for select to anon, authenticated using (true);

-- Money and workflow tables: read-only for clients, scoped to own or golden workspace.
create policy invoices_select on public.invoices
  for select to anon, authenticated using (public.mw_can_read_workspace(workspace_id));
create policy ledger_select on public.ledger
  for select to anon, authenticated using (public.mw_can_read_workspace(workspace_id));
create policy dunning_cases_select on public.dunning_cases
  for select to anon, authenticated using (public.mw_can_read_workspace(workspace_id));
create policy steps_select on public.steps
  for select to anon, authenticated using (public.mw_can_read_workspace(workspace_id));
create policy audit_log_select on public.audit_log
  for select to anon, authenticated using (workspace_id is not null and public.mw_can_read_workspace(workspace_id));
create policy ai_runs_select on public.ai_runs
  for select to anon, authenticated using (public.mw_can_read_workspace(workspace_id));
-- Raw webhook payloads: only the owner of the linked workspace (never golden, never unlinked).
create policy paypal_events_select on public.paypal_events
  for select to authenticated using (workspace_id is not null and public.mw_is_workspace_owner(workspace_id));
-- api_quota: no client policies at all (service role only).

-- ---------------------------------------------------------------------------
-- Seed data
-- ---------------------------------------------------------------------------
-- Basiszinssatz per BGB 247, Deutsche Bundesbank. Must match lib/rules/de.ts (DE_BASE_RATES).
insert into public.base_rates (jurisdiction, valid_from, rate_bp, source)
values ('DE', '2026-07-01', 152, 'Deutsche Bundesbank, Basiszinssatz 1.52 percent from 2026-07-01');

-- Must match lib/rules/de.ts (DE_RULESET). A test checks this.
insert into public.rule_sets (jurisdiction, valid_from, params)
values ('DE', '2026-07-01', '{
  "marginBp": {"consumer": 500, "business": 900},
  "flatFeeCents": {"consumer": 0, "business": 4000},
  "dayCountBasis": 365,
  "thirtyDayRuleDays": 30,
  "waitingDays": {"reminder": 0, "mahnung1": 7, "mahnung2": 10, "handover": 14},
  "allocationOrder": ["fee", "interest", "principal"]
}'::jsonb);

commit;
