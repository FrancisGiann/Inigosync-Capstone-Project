-- Unified, owner-only audit trail with server-derived account session events.
-- The Data API never returns source JSON or payment/contact identifiers.

alter table internal.customer_operational_events
  add column if not exists actor_id uuid references public.profiles(id) on delete set null,
  add column if not exists actor_role text,
  add column if not exists actor_name text;

update internal.customer_operational_events e
set actor_id = coalesce(e.actor_id, e.customer_id),
    actor_role = coalesce(e.actor_role, p.role::text, 'customer'),
    actor_name = coalesce(e.actor_name, nullif(btrim(e.customer_name), ''), 'Customer')
from public.profiles p
where p.id = e.customer_id
  and (e.actor_id is null or e.actor_role is null or e.actor_name is null);

create index if not exists customer_operational_actor_recent_idx
  on internal.customer_operational_events(actor_id, created_at desc, id desc)
  where actor_id is not null;

create table if not exists internal.account_session_events (
  actor_id uuid not null references public.profiles(id) on delete cascade,
  session_id text not null,
  kind text not null check (kind in ('sign_in', 'sign_out')),
  event_id uuid not null unique references internal.customer_operational_events(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (actor_id, session_id, kind)
);
revoke all on internal.account_session_events from public, anon, authenticated;

insert into internal.account_session_events(actor_id, session_id, kind, event_id, created_at)
select customer_id, session_id, kind, event_id, created_at
from internal.customer_session_events
on conflict do nothing;

create or replace function public.record_account_session_event(
  p_kind text,
  p_reason text default 'app_login'
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_session text := nullif(auth.jwt()->>'session_id', '');
  v_role text;
  v_name text;
  v_event uuid;
begin
  if v_actor is null or v_session is null
     or p_kind is null or p_kind not in ('sign_in', 'sign_out')
     or p_reason is null or p_reason not in ('app_login', 'app_logout', 'idle_timeout', 'session_replaced') then
    raise exception 'An active account session is required' using errcode = '42501';
  end if;

  select p.role::text, coalesce(nullif(btrim(p.full_name), ''), 'Account')
    into v_role, v_name
  from public.profiles p
  where p.id = v_actor
    and p.role in ('customer', 'staff', 'admin')
    and p.status = 'active';
  if v_role is null then
    raise exception 'An active account session is required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(v_actor::text),
    pg_catalog.hashtext(v_session || ':' || p_kind)
  );
  if exists (
    select 1 from internal.account_session_events e
    where e.actor_id = v_actor and e.session_id = v_session and e.kind = p_kind
  ) then
    return true;
  end if;

  insert into internal.customer_operational_events(
    customer_id, customer_name, actor_id, actor_role, actor_name,
    action, source, source_id, details
  ) values (
    case when v_role = 'customer' then v_actor else null end,
    v_name, v_actor, v_role, v_name,
    p_kind, 'account_session', null,
    jsonb_build_object('observed', true, 'request', p_reason)
  ) returning id into v_event;

  insert into internal.account_session_events(actor_id, session_id, kind, event_id)
  values (v_actor, v_session, p_kind, v_event)
  on conflict do nothing;
  return true;
end;
$$;
revoke all on function public.record_account_session_event(text, text) from public, anon;
grant execute on function public.record_account_session_event(text, text) to authenticated;

-- Preserve the existing customer RPC contract for already-open customer pages.
create or replace function public.record_customer_session_event(p_kind text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  return public.record_account_session_event(p_kind, case when p_kind = 'sign_in' then 'app_login' else 'app_logout' end);
end;
$$;
revoke all on function public.record_customer_session_event(text) from public, anon;
grant execute on function public.record_customer_session_event(text) to authenticated;

create or replace function public.owner_audit_trail(
  p_search text default '',
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_category text default 'all',
  p_actor_id uuid default null,
  p_actor_role text default 'all',
  p_offset integer default 0,
  p_limit integer default 25
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if (select auth.uid()) is null or not exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin' and p.status = 'active'
  ) then
    raise exception 'Active owner access is required' using errcode = '42501';
  end if;
  if length(coalesce(p_search, '')) > 120
     or p_offset is null or p_limit is null
     or p_offset < 0 or p_offset > 100000
     or p_limit < 1 or p_limit > 50
     or (p_from is not null and p_to is not null and p_to <= p_from)
     or coalesce(p_category, 'all') not in ('all', 'account', 'booking', 'payment', 'staff', 'owner')
     or coalesce(p_actor_role, 'all') not in ('all', 'admin', 'staff', 'customer', 'system') then
    raise exception 'Invalid audit trail request' using errcode = '22023';
  end if;

  with events as (
    select a.id as event_id, 'owner_activity'::text as source,
      a.created_at, a.title as action, 'owner'::text as category,
      a.owner_id as actor_id, coalesce(nullif(btrim(p.full_name), ''), 'Owner') as actor_name,
      'admin'::text as actor_role, a.target_section as target_type, a.target_id,
      left(coalesce(nullif(btrim(a.detail), ''), a.title), 500) as summary,
      null::numeric as amount
    from public.owner_activity a
    left join public.profiles p on p.id = a.owner_id

    union all

    select a.id, 'audit_log'::text, a.created_at, a.action,
      case when a.action ilike '%payment%' or a.action ilike 'collected%' then 'payment'
        when a.entity_type in ('booking', 'walkin', 'walk_in_booking') then 'booking'
        else 'staff' end,
      a.actor_id, coalesce(nullif(btrim(p.full_name), ''), 'Deleted account'),
      coalesce(a.actor_role, p.role::text, 'system'), a.entity_type, a.entity_id,
      left(concat_ws(' · ',
        nullif(coalesce(a.details->>'customerName', a.details->>'customer_name', a.details->>'customer'), ''),
        nullif(coalesce(a.details->>'courtName', a.details->>'court_name', a.details->>'court'), ''),
        nullif(a.details->>'unit', ''),
        case when nullif(a.details->>'from', '') is not null or nullif(a.details->>'to', '') is not null
          then concat_ws(' → ', nullif(a.details->>'from', ''), nullif(a.details->>'to', '')) end,
        nullif(coalesce(a.details->>'method', a.details->>'paymentMethod', a.details->>'payment_method'), '')
      ), 500),
      case when coalesce(a.details->>'amount', a.details->>'cash_collected', a.details->>'paymentAmount') ~ '^[0-9]+(\.[0-9]+)?$'
        then coalesce(a.details->>'amount', a.details->>'cash_collected', a.details->>'paymentAmount')::numeric end
    from public.audit_log a
    left join public.profiles p on p.id = a.actor_id

    union all

    select e.id, 'customer_operational_events'::text, e.created_at, e.action,
      case when e.action in ('sign_in', 'sign_out') then 'account'
        when e.action = 'payment_recorded' then 'payment'
        else 'booking' end,
      coalesce(e.actor_id, e.customer_id),
      coalesce(nullif(btrim(e.actor_name), ''), nullif(btrim(e.customer_name), ''), 'Account'),
      coalesce(e.actor_role, p.role::text, 'customer'), e.source, e.source_id,
      case
        when e.action = 'sign_in' then 'App sign-in observed'
        when e.action = 'sign_out' then 'App sign-out observed'
        when e.action = 'payment_recorded' then 'Payment recorded'
        else left(concat_ws(' · ',
          nullif(coalesce(e.details->>'sport', ''), ''),
          nullif(coalesce(e.details->>'court', ''), ''),
          nullif(coalesce(e.details->>'unit', ''), ''),
          nullif(coalesce(e.details->>'status', ''), '')
        ), 500)
      end,
      case when e.action = 'payment_recorded' and e.details->>'amount' ~ '^[0-9]+(\.[0-9]+)?$'
        then (e.details->>'amount')::numeric end
    from internal.customer_operational_events e
    left join public.profiles p on p.id = coalesce(e.actor_id, e.customer_id)
    where not (
      e.action in ('booking_created', 'walkin_created', 'time_in', 'time_out', 'unattended')
      and exists (
        select 1 from public.audit_log a
        where a.entity_id = e.source_id
          and (a.entity_type = e.source or (e.source = 'walkin' and a.entity_type = 'walk_in_booking'))
          and a.created_at = e.created_at
          and ((e.action = 'booking_created' and a.action = 'recorded_booking')
            or (e.action = 'walkin_created' and a.action = 'recorded_walk_in')
            or (e.action = 'time_in' and a.action = 'checked_in')
            or (e.action = 'time_out' and a.action in ('booking_timed_out', 'walkin_timed_out'))
            or (e.action = 'unattended' and a.action = 'booking_status_changed'))
      )
    )
  ), filtered as (
    select e.* from events e
    where (p_from is null or e.created_at >= p_from)
      and (p_to is null or e.created_at < p_to)
      and (coalesce(p_category, 'all') = 'all' or e.category = p_category)
      and (p_actor_id is null or e.actor_id = p_actor_id)
      and (coalesce(p_actor_role, 'all') = 'all' or e.actor_role = p_actor_role)
      and (nullif(btrim(p_search), '') is null or
        pg_catalog.strpos(pg_catalog.lower(concat_ws(' ', e.event_id::text, e.action, e.category, e.actor_name, e.actor_role, e.target_type, e.target_id, e.summary)), pg_catalog.lower(btrim(p_search))) > 0)
  ), page as (
    select * from filtered order by created_at desc, event_id desc, source asc
    offset p_offset limit p_limit
  ), actor_options as (
    select distinct e.actor_id, e.actor_name, e.actor_role
    from events e where e.actor_id is not null
  )
  select jsonb_build_object(
    'total_count', (select count(*) from filtered),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
      'event_id', page.event_id, 'source', page.source, 'created_at', page.created_at,
      'action', page.action, 'category', page.category, 'actor_id', page.actor_id,
      'actor_name', page.actor_name, 'actor_role', page.actor_role,
      'target_type', page.target_type, 'target_id', page.target_id,
      'summary', page.summary, 'amount', page.amount
    ) order by page.created_at desc, page.event_id desc, page.source asc) from page), '[]'::jsonb),
    'actors', coalesce((select jsonb_agg(jsonb_build_object(
      'id', actor_options.actor_id, 'name', actor_options.actor_name, 'role', actor_options.actor_role
    ) order by lower(actor_options.actor_name), actor_options.actor_id) from actor_options), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.owner_audit_trail(text, timestamptz, timestamptz, text, uuid, text, integer, integer) from public, anon;
grant execute on function public.owner_audit_trail(text, timestamptz, timestamptz, text, uuid, text, integer, integer) to authenticated;
