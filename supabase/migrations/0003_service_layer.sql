-- Mahnwerk 0003: service layer support (demo workspaces, invoice idempotency, step execution).
-- All functions run as the service role only (server routes). NOT applied automatically. Apply
-- after review, after 0002.

begin;

-- ---------------------------------------------------------------------------
-- Invoice creation idempotency: one invoice per (workspace, debtor, client nonce).
-- ---------------------------------------------------------------------------
alter table public.invoices add column if not exists request_key text;
create unique index if not exists invoices_request_key_unique on public.invoices (request_key) where request_key is not null;

-- ---------------------------------------------------------------------------
-- Step execution lease (double click on execute runs the outbound call once).
-- ---------------------------------------------------------------------------
alter table public.steps add column if not exists exec_token uuid;
alter table public.steps add column if not exists exec_started_at timestamptz;

-- At most one pending (proposed or approved) dunning step per case. fee_invoice has its own index (0002).
create unique index if not exists steps_one_pending_dunning_step_per_case
  on public.steps (case_id)
  where status in ('proposed', 'approved') and kind in ('reminder', 'mahnung1', 'mahnung2', 'handover');

-- ---------------------------------------------------------------------------
-- Demo workspace creation with caps, atomically.
-- ---------------------------------------------------------------------------
create or replace function public.mw_create_demo_workspace(
  p_owner uuid,
  p_name text,
  p_expires_at timestamptz,
  p_now timestamptz,
  p_user_cap integer,
  p_global_cap integer,
  p_creditor jsonb,
  p_debtors jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_ws uuid;
  v_user_live integer;
  v_global_live integer;
  v_d jsonb;
begin
  -- Serializes all demo workspace creations so the caps cannot be overrun by concurrent requests.
  perform pg_advisory_xact_lock(hashtext('mw_create_demo_workspace'));

  select count(*) into v_user_live from public.workspaces
   where owner_uid = p_owner and kind = 'demo' and expires_at > p_now;
  if v_user_live >= p_user_cap then
    return jsonb_build_object('ok', false, 'reason', 'user_cap');
  end if;

  select count(*) into v_global_live from public.workspaces
   where kind = 'demo' and expires_at > p_now;
  if v_global_live >= p_global_cap then
    return jsonb_build_object('ok', false, 'reason', 'global_cap');
  end if;

  insert into public.workspaces (owner_uid, kind, name, jurisdiction, clock_offset_days, expires_at)
  values (p_owner, 'demo', p_name, 'DE', 0, p_expires_at)
  returning id into v_ws;

  insert into public.creditors (workspace_id, name, address, kleinunternehmer, lang)
  values (v_ws, p_creditor->>'name', coalesce(p_creditor->'address', '{}'::jsonb),
          coalesce((p_creditor->>'kleinunternehmer')::boolean, false), coalesce(p_creditor->>'lang', 'de'));

  for v_d in select * from jsonb_array_elements(p_debtors) loop
    insert into public.debtors (workspace_id, name, email, type, lang)
    values (v_ws, v_d->>'name', v_d->>'email', v_d->>'type', coalesce(v_d->>'lang', 'de'));
  end loop;

  insert into public.audit_log (workspace_id, actor, actor_uid, action, details)
  values (v_ws, 'user', p_owner, 'workspace.created', jsonb_build_object('expires_at', p_expires_at));

  return jsonb_build_object('ok', true, 'workspace_id', v_ws);
end;
$$;

-- ---------------------------------------------------------------------------
-- Invoice finalization: create the dunning case (state open) plus audit, idempotently.
-- ---------------------------------------------------------------------------
create or replace function public.mw_finalize_invoice(
  p_invoice_id uuid,
  p_paypal_invoice_id text,
  p_actor_uid uuid,
  p_virtual_date date,
  p_details jsonb
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_ws uuid;
  v_case uuid;
begin
  update public.invoices
     set paypal_invoice_id = p_paypal_invoice_id
   where id = p_invoice_id
     and (paypal_invoice_id is null or paypal_invoice_id = p_paypal_invoice_id)
  returning workspace_id into v_ws;
  if not found then
    raise exception 'invoice % missing or linked to another PayPal invoice', p_invoice_id;
  end if;

  insert into public.dunning_cases (workspace_id, invoice_id, state)
  values (v_ws, p_invoice_id, 'open')
  on conflict (invoice_id) do nothing
  returning id into v_case;

  if v_case is null then
    -- Already finalized by an earlier call: no second audit row.
    select id into v_case from public.dunning_cases where invoice_id = p_invoice_id;
    return v_case;
  end if;

  insert into public.audit_log (workspace_id, case_id, invoice_id, actor, actor_uid, action, to_state, virtual_date, details)
  values (v_ws, v_case, p_invoice_id, 'user', p_actor_uid, 'invoice.sent', 'open', p_virtual_date, coalesce(p_details, '{}'::jsonb));

  return v_case;
end;
$$;

-- ---------------------------------------------------------------------------
-- Step approval or rejection with audit, atomically.
-- Returns 'ok', 'already' (target status already set), 'invalid:<status>' or 'not_found'.
-- ---------------------------------------------------------------------------
create or replace function public.mw_decide_step(
  p_step_id uuid,
  p_decision text,
  p_actor_uid uuid,
  p_virtual_date date,
  p_note text
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_step public.steps%rowtype;
  v_target text;
begin
  if p_decision not in ('approve', 'reject') then
    raise exception 'unknown decision %', p_decision;
  end if;
  v_target := case when p_decision = 'approve' then 'approved' else 'rejected' end;

  select * into v_step from public.steps where id = p_step_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_step.status = v_target then
    return 'already';
  end if;
  if p_decision = 'approve' and v_step.status <> 'proposed' then
    return 'invalid:' || v_step.status;
  end if;
  if p_decision = 'reject' and (v_step.status not in ('proposed', 'approved') or v_step.exec_token is not null) then
    return 'invalid:' || v_step.status;
  end if;

  if p_decision = 'approve' then
    update public.steps set status = 'approved', approved_by = p_actor_uid, approved_at = now() where id = p_step_id;
  else
    update public.steps
       set status = 'rejected',
           validation = coalesce(validation, '{}'::jsonb)
             || jsonb_build_object('rejected_by', p_actor_uid, 'rejected_virtual_date', p_virtual_date, 'rejected_note', p_note)
     where id = p_step_id;
  end if;

  insert into public.audit_log (workspace_id, case_id, actor, actor_uid, action, virtual_date, details)
  values (v_step.workspace_id, v_step.case_id, 'user', p_actor_uid,
          case when p_decision = 'approve' then 'step.approved' else 'step.rejected' end,
          p_virtual_date, jsonb_build_object('step_id', p_step_id, 'kind', v_step.kind, 'note', p_note));
  return 'ok';
end;
$$;

-- ---------------------------------------------------------------------------
-- Step completion: optional case transition (via mw_transition_case) + step sent + audit, atomically.
-- Returns 'ok', 'conflict' (case changed, nothing written) or 'lost_claim'.
-- ---------------------------------------------------------------------------
create or replace function public.mw_complete_step(
  p_step_id uuid,
  p_exec_token uuid,
  p_sent_via text,
  p_draft jsonb,
  p_actor_uid uuid,
  p_virtual_date date,
  p_expected_version integer,
  p_from_state text,
  p_to_state text,
  p_prev_state text,
  p_paused_reason text,
  p_actor text,
  p_action text,
  p_transition_details jsonb,
  p_details jsonb
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_step public.steps%rowtype;
begin
  select * into v_step from public.steps where id = p_step_id for update;
  if not found or v_step.status <> 'approved' or v_step.exec_token is distinct from p_exec_token then
    return 'lost_claim';
  end if;
  if v_step.approved_by is null or v_step.approved_at is null then
    raise exception 'step % has no recorded approval', p_step_id;
  end if;

  if p_to_state is not null then
    if not public.mw_transition_case(v_step.case_id, p_expected_version, p_from_state, p_to_state, p_prev_state,
                                     p_paused_reason, p_actor, p_action, p_virtual_date, p_transition_details) then
      return 'conflict';
    end if;
  end if;

  update public.steps
     set status = 'sent', sent_via = p_sent_via, sent_at = now(), draft = coalesce(p_draft, draft),
         exec_token = null, exec_started_at = null
   where id = p_step_id;

  insert into public.audit_log (workspace_id, case_id, actor, actor_uid, action, virtual_date, details)
  values (v_step.workspace_id, v_step.case_id, 'user', p_actor_uid, 'step.sent', p_virtual_date,
          coalesce(p_details, '{}'::jsonb) || jsonb_build_object('step_id', p_step_id, 'kind', v_step.kind, 'sent_via', p_sent_via));
  return 'ok';
end;
$$;

-- ---------------------------------------------------------------------------
-- PayPal reminder quota: atomic increment while below the cap (sandbox: 2 per day per API caller).
-- ---------------------------------------------------------------------------
create or replace function public.mw_consume_reminder_quota(p_merchant text, p_day date, p_max integer)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_max integer := least(greatest(p_max, 0), 2);
  v_used integer;
begin
  if v_max = 0 then
    return false;
  end if;
  insert into public.api_quota (merchant_id, day, reminders_used)
  values (p_merchant, p_day, 1)
  on conflict (merchant_id, day) do update
     set reminders_used = public.api_quota.reminders_used + 1
   where public.api_quota.reminders_used < v_max
  returning reminders_used into v_used;
  return v_used is not null;
end;
$$;

revoke all on function public.mw_create_demo_workspace(uuid, text, timestamptz, timestamptz, integer, integer, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.mw_finalize_invoice(uuid, text, uuid, date, jsonb) from public, anon, authenticated;
revoke all on function public.mw_decide_step(uuid, text, uuid, date, text) from public, anon, authenticated;
revoke all on function public.mw_complete_step(uuid, uuid, text, jsonb, uuid, date, integer, text, text, text, text, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.mw_consume_reminder_quota(text, date, integer) from public, anon, authenticated;
grant execute on function public.mw_create_demo_workspace(uuid, text, timestamptz, timestamptz, integer, integer, jsonb, jsonb) to service_role;
grant execute on function public.mw_finalize_invoice(uuid, text, uuid, date, jsonb) to service_role;
grant execute on function public.mw_decide_step(uuid, text, uuid, date, text) to service_role;
grant execute on function public.mw_complete_step(uuid, uuid, text, jsonb, uuid, date, integer, text, text, text, text, text, text, jsonb, jsonb) to service_role;
grant execute on function public.mw_consume_reminder_quota(text, date, integer) to service_role;

commit;
