-- Mahnwerk 0004: AI call quota. One lifetime counter per workspace and one counter per UTC day for
-- all workspaces together, consumed atomically by public.mw_ai_consume (service role only).
-- NOT applied automatically. Apply after review, after 0003.

begin;

create table if not exists public.ai_quota_workspace (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  used integer not null default 0 check (used >= 0)
);

create table if not exists public.ai_quota_day (
  day date primary key,
  used integer not null default 0 check (used >= 0)
);

-- Server only: no policies, so anon and authenticated roles see nothing.
alter table public.ai_quota_workspace enable row level security;
alter table public.ai_quota_day enable row level security;

-- Consumes one AI call when both counters are below their limits, otherwise consumes nothing.
-- Race-free: every caller locks the day row first, then the workspace row (one fixed lock order, so
-- no deadlock), and checks and increments while holding both locks.
-- Returns {"ok": true, "workspace_used": n, "global_used": n} or {"ok": false, "scope": "global"|"workspace"}.
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
begin
  insert into public.ai_quota_day (day, used) values (p_day, 0) on conflict (day) do nothing;
  insert into public.ai_quota_workspace (workspace_id, used) values (p_workspace, 0) on conflict (workspace_id) do nothing;

  select used into v_global from public.ai_quota_day where day = p_day for update;
  select used into v_ws from public.ai_quota_workspace where workspace_id = p_workspace for update;

  if v_global >= p_global_limit then
    return jsonb_build_object('ok', false, 'scope', 'global');
  end if;
  if v_ws >= p_workspace_limit then
    return jsonb_build_object('ok', false, 'scope', 'workspace');
  end if;

  update public.ai_quota_day set used = used + 1 where day = p_day;
  update public.ai_quota_workspace set used = used + 1 where workspace_id = p_workspace;
  return jsonb_build_object('ok', true, 'workspace_used', v_ws + 1, 'global_used', v_global + 1);
end;
$$;

revoke all on function public.mw_ai_consume(uuid, date, integer, integer) from public, anon, authenticated;
grant execute on function public.mw_ai_consume(uuid, date, integer, integer) to service_role;

commit;
