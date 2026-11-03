-- Removes demo workspaces a week after they expired (the app already refuses expired ones).
-- Child tables cascade. audit_log is append-only by design and has no foreign key, so its rows stay.
-- The golden workspace (kind = 'golden', no expiry) is never touched.

create or replace function public.mw_purge_expired_demos(p_grace interval default interval '7 days')
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_ids uuid[];
begin
  select coalesce(array_agg(id), '{}') into v_ids
  from public.workspaces
  where kind = 'demo' and expires_at is not null and expires_at < now() - p_grace;

  if coalesce(array_length(v_ids, 1), 0) = 0 then
    return 0;
  end if;

  delete from public.workspaces where id = any (v_ids);
  return array_length(v_ids, 1);
end;
$$;

revoke all on function public.mw_purge_expired_demos(interval) from public, anon, authenticated;

create extension if not exists pg_cron;

select cron.schedule('mw-purge-expired-demos', '17 3 * * *', $$select public.mw_purge_expired_demos()$$);
