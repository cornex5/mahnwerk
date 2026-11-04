-- Mahnwerk 0006: hardening after the pre-submission audit.
-- NOT applied automatically. Apply after review, after 0005.
--  1. Close the client write policies (always false). No client code writes; all writes go through server routes with the
--     service role, which enforce the demo caps and the 48 h expiry that a direct insert would bypass.
--  2. ai_runs: only the workspace owner may read (the example workspace's copilot answers stay private).
--  3. Default rule: the 30-day period of BGB 286(3) ends with day 30, so default starts on day 31.
--  4. AI quota: the example workspace is shared by all visitors, so it gets a daily cap instead of the
--     lifetime cap of 40 calls (which the first judges would use up for everyone).

begin;

-- Closed with ALTER POLICY (always false) instead of DROP, so the change stays reversible in one statement.
alter policy workspaces_insert_own_demo on public.workspaces with check (false);
alter policy creditors_insert on public.creditors with check (false);
alter policy creditors_update on public.creditors using (false) with check (false);
alter policy debtors_insert on public.debtors with check (false);
alter policy debtors_update on public.debtors using (false) with check (false);

alter policy ai_runs_select on public.ai_runs to authenticated using (public.mw_is_workspace_owner(workspace_id));

update public.rule_sets
   set params = jsonb_set(params, '{thirtyDayRuleDays}', '31'::jsonb)
 where jurisdiction = 'DE' and valid_from = '2026-07-01';

create table if not exists public.ai_quota_golden_day (
  day date primary key,
  used integer not null default 0 check (used >= 0)
);
alter table public.ai_quota_golden_day enable row level security;

-- Same contract as in 0004. The golden workspace is checked against a daily cap of 150 calls
-- (reported as scope "workspace" when reached); other workspaces keep the lifetime limit.
-- Lock order stays fixed: day row, then the golden day row or the workspace row.
create or replace function public.mw_ai_consume(
  p_workspace uuid,
  p_day date,
  p_workspace_limit integer,
  p_global_limit integer
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_global integer;
  v_ws integer;
  v_kind text;
  v_golden_cap constant integer := 150;
begin
  select kind into v_kind from public.workspaces where id = p_workspace;

  insert into public.ai_quota_day (day, used) values (p_day, 0) on conflict (day) do nothing;
  select used into v_global from public.ai_quota_day where day = p_day for update;
  if v_global >= p_global_limit then
    return jsonb_build_object('ok', false, 'scope', 'global');
  end if;

  if v_kind = 'golden' then
    insert into public.ai_quota_golden_day (day, used) values (p_day, 0) on conflict (day) do nothing;
    select used into v_ws from public.ai_quota_golden_day where day = p_day for update;
    if v_ws >= v_golden_cap then
      return jsonb_build_object('ok', false, 'scope', 'workspace');
    end if;
    update public.ai_quota_golden_day set used = used + 1 where day = p_day;
  else
    insert into public.ai_quota_workspace (workspace_id, used) values (p_workspace, 0) on conflict (workspace_id) do nothing;
    select used into v_ws from public.ai_quota_workspace where workspace_id = p_workspace for update;
    if v_ws >= p_workspace_limit then
      return jsonb_build_object('ok', false, 'scope', 'workspace');
    end if;
    update public.ai_quota_workspace set used = used + 1 where workspace_id = p_workspace;
  end if;

  update public.ai_quota_day set used = used + 1 where day = p_day;
  return jsonb_build_object('ok', true, 'workspace_used', v_ws + 1, 'global_used', v_global + 1);
end;
$$;

revoke all on function public.mw_ai_consume(uuid, date, integer, integer) from public, anon, authenticated;
grant execute on function public.mw_ai_consume(uuid, date, integer, integer) to service_role;

commit;
