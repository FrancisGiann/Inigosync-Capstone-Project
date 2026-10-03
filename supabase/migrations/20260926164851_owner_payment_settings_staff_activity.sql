-- Owner payment controls and trustworthy staff activity reads.
alter table public.app_settings
  add column if not exists card_enabled boolean not null default true;

alter table public.app_settings
  drop constraint if exists app_settings_online_method_required;
alter table public.app_settings
  add constraint app_settings_online_method_required
  check (card_enabled or gcash_enabled);

alter table public.app_settings
  drop constraint if exists app_settings_deposit_required;
alter table public.app_settings
  add constraint app_settings_deposit_required
  check (downpayment_pct > 0 and downpayment_pct < 100);

drop policy if exists app_settings_admin_write on public.app_settings;
create policy app_settings_admin_write on public.app_settings
  for all to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin'
      and coalesce(p.status, 'active') <> 'disabled'
  ))
  with check (exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin'
      and coalesce(p.status, 'active') <> 'disabled'
  ));

create index if not exists audit_log_actor_recent_idx
  on public.audit_log (actor_id, created_at desc, id desc)
  where actor_id is not null;

create or replace function public.owner_staff_activity(
  p_staff_id uuid, p_search text default '', p_offset integer default 0,
  p_limit integer default 10
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if (select auth.uid()) is null or not exists (
    select 1 from public.profiles p where p.id = (select auth.uid())
      and p.role = 'admin' and coalesce(p.status, 'active') <> 'disabled'
  ) then
    raise exception 'Active owner access is required' using errcode = '42501';
  end if;
  if p_staff_id is null or p_offset < 0 or p_limit < 1 or p_limit > 50
     or length(coalesce(p_search, '')) > 120 then
    raise exception 'Invalid staff activity request' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_staff_id and p.role = 'staff') then
    raise exception 'Staff account not found' using errcode = 'P0002';
  end if;

  with filtered as (
    select a.id, a.created_at, a.action, a.entity_type, a.entity_id, a.details
    from public.audit_log a
    where a.actor_id = p_staff_id
      and (nullif(btrim(p_search), '') is null
        or a.action ilike '%' || btrim(p_search) || '%'
        or a.entity_type ilike '%' || btrim(p_search) || '%'
        or coalesce(a.entity_id, '') ilike '%' || btrim(p_search) || '%'
        or coalesce(a.details::text, '') ilike '%' || btrim(p_search) || '%')
  ), page as (
    select * from filtered order by created_at desc, id desc
    offset p_offset limit p_limit
  )
  select jsonb_build_object(
    'total_count', (select count(*) from filtered),
    'rows', coalesce((select jsonb_agg(to_jsonb(page) order by created_at desc, id desc) from page), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;
revoke all on function public.owner_staff_activity(uuid,text,integer,integer) from public,anon;
grant execute on function public.owner_staff_activity(uuid,text,integer,integer) to authenticated;
