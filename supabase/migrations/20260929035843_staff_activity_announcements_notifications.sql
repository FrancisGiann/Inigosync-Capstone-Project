-- Front desk activity and published notices. Operational events are written by
-- database triggers or authenticated RPCs, never by client table inserts.

-- Existing Data API policies use both role helpers. Re-evaluate the profile's
-- current status on every request so disabling staff revokes unexpired tokens.
-- TRUNCATE bypasses RLS. Neither browser role needs DDL-like table privileges.
revoke truncate,trigger,references on all tables in schema public from anon,authenticated;

create or replace function internal.is_staff_or_admin(uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles p where p.id=uid
    and p.role in ('staff','admin') and p.status='active');
$$;
revoke all on function internal.is_staff_or_admin(uuid) from public,anon;
grant execute on function internal.is_staff_or_admin(uuid) to authenticated;

create or replace function public.inigosync_is_staff_or_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles p where p.id=(select auth.uid())
    and p.role in ('staff','admin') and p.status='active');
$$;
revoke all on function public.inigosync_is_staff_or_admin() from public,anon;
grant execute on function public.inigosync_is_staff_or_admin() to authenticated;

create or replace function internal.is_active_owner(uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles p where p.id=uid and p.role='admin' and p.status='active');
$$;
revoke all on function internal.is_active_owner(uuid) from public,anon;
grant execute on function internal.is_active_owner(uuid) to authenticated;

create or replace function internal.is_active_customer(uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles p where p.id=uid and p.role='customer' and p.status='active');
$$;
revoke all on function internal.is_active_customer(uuid) from public,anon;
grant execute on function internal.is_active_customer(uuid) to authenticated;

-- Reservation writes now flow through atomic, server-authorized functions.
-- This closes the legacy direct cash walk-in and status/exit update paths.
revoke insert,update,delete on public.booking,public.walk_in_booking from anon,authenticated;
revoke insert,update,delete on public.payment,public.audit_log from anon,authenticated;
revoke insert,delete on public.profiles from anon,authenticated;

drop policy if exists booking_select on public.booking;
create policy booking_select on public.booking for select to authenticated
  using((customer_id=(select auth.uid()) and internal.is_active_customer((select auth.uid())))
    or internal.is_staff_or_admin((select auth.uid())));
drop policy if exists payment_select on public.payment;
create policy payment_select on public.payment for select to authenticated
  using(internal.is_staff_or_admin((select auth.uid()))
    or (internal.is_active_customer((select auth.uid())) and exists(
      select 1 from public.booking b where b.payment_id=payment.payment_id
        and b.customer_id=(select auth.uid()))));

drop policy if exists audit_log_staff_read on public.audit_log;
drop policy if exists audit_log_owner_read on public.audit_log;
create policy audit_log_owner_read on public.audit_log for select to authenticated
  using(internal.is_active_owner((select auth.uid())));

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using((id=(select auth.uid()) and status='active')
    or (role='customer' and internal.is_staff_or_admin((select auth.uid())))
    or internal.is_active_owner((select auth.uid())));

-- Staff may view customer profiles for account lookup, but may edit only their
-- own profile. The owner retains staff management. Self-service cannot reenable
-- a disabled account or spoof a different Auth email through profiles.
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using((id=(select auth.uid()) and status='active') or internal.is_active_owner((select auth.uid())))
  with check((id=(select auth.uid()) and status='active') or internal.is_active_owner((select auth.uid())));

create or replace function internal.guard_profile_status_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.id is distinct from old.id or new.created_at is distinct from old.created_at
      or new.email is distinct from old.email)
    and (select auth.role()) is distinct from 'service_role' then
    raise exception 'Account identity fields cannot be changed directly' using errcode='42501';
  end if;
  if new.position is distinct from old.position and (select auth.role()) is distinct from 'service_role'
    and not internal.is_active_owner((select auth.uid())) then
    raise exception 'Only an active owner can change staff position' using errcode='42501';
  end if;
  if new.status is distinct from old.status and (select auth.role()) is distinct from 'service_role'
    and not internal.is_active_owner((select auth.uid())) then
    raise exception 'Only an active owner can change account status' using errcode='42501';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_profile_status_change() from public,anon,authenticated;
drop trigger if exists profiles_guard_status_change on public.profiles;
create trigger profiles_guard_status_change before update on public.profiles
  for each row execute function internal.guard_profile_status_change();

create table if not exists internal.customer_operational_events (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.profiles(id) on delete set null,
  customer_name text not null default 'Guest',
  action text not null,
  source text not null,
  source_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint customer_operational_events_action_check check (action in
    ('sign_in','sign_out','booking_created','walkin_created','payment_recorded','time_in','time_out','unattended'))
);
create index if not exists customer_operational_events_recent_idx on internal.customer_operational_events(created_at desc,id desc);
create index if not exists customer_operational_events_customer_idx on internal.customer_operational_events(customer_id,created_at desc);
-- One gateway/cash payment can cover several walk-in reservation lines.
create unique index if not exists customer_operational_payment_once_idx
  on internal.customer_operational_events ((details->>'payment_id'))
  where action='payment_recorded' and details->>'payment_id' is not null;
revoke all on internal.customer_operational_events from public,anon,authenticated;

create table if not exists internal.customer_session_events (
  customer_id uuid not null references public.profiles(id) on delete cascade,
  session_id text not null,
  kind text not null check (kind in ('sign_in','sign_out')),
  event_id uuid not null unique references internal.customer_operational_events(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key(customer_id,session_id,kind)
);
revoke all on internal.customer_session_events from public,anon,authenticated;

create or replace function public.record_customer_session_event(p_kind text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); sid text := nullif(auth.jwt()->>'session_id',''); eid uuid;
begin
  if uid is null or sid is null or p_kind not in ('sign_in','sign_out') or not exists (
    select 1 from public.profiles p where p.id=uid and p.role='customer' and p.status='active'
  ) then raise exception 'Active customer session required' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(uid::text),pg_catalog.hashtext(sid||':'||p_kind));
  if exists (select 1 from internal.customer_session_events e where e.customer_id=uid and e.session_id=sid and e.kind=p_kind) then return true; end if;
  insert into internal.customer_operational_events(customer_id,customer_name,action,source,source_id,details)
  select uid,coalesce(nullif(btrim(p.full_name),''),p.email,'Customer'),p_kind,'customer_session',null,
    jsonb_build_object('observed',true)
  from public.profiles p where p.id=uid returning id into eid;
  insert into internal.customer_session_events(customer_id,session_id,kind,event_id)
  values(uid,sid,p_kind,eid) on conflict do nothing;
  return true;
end;
$$;
revoke all on function public.record_customer_session_event(text) from public,anon;
grant execute on function public.record_customer_session_event(text) to authenticated;

create or replace function internal.capture_customer_reservation_event()
returns trigger language plpgsql security definer set search_path = '' as $$
declare cid uuid; cname text; src text; rid text; order_id uuid; details_json jsonb; event_action text;
  v_payment_id bigint; v_paid numeric;
begin
  if tg_table_name='booking' then
    cid:=new.customer_id; src:='booking'; rid:=new.booking_id::text;
    select coalesce(nullif(btrim(p.full_name),''),p.email,'Customer') into cname from public.profiles p where p.id=cid;
  else
    cid:=new.customer_id; src:='walkin'; rid:=new.walkin_id::text;
    order_id:=new.walkin_order_id;
    cname:=coalesce(nullif(btrim(new.customer_name),''),'Guest');
  end if;
  details_json:=jsonb_build_object('sport',new.sports,'court',new.courts,'unit',new.court_unit,
    'starts_at',new.time_date,'ends_at',new.end_at,'status',new.status);
  if tg_op='INSERT' then
    event_action:=case when src='booking' then 'booking_created' else 'walkin_created' end;
    insert into internal.customer_operational_events(customer_id,customer_name,action,source,source_id,details)
      values(cid,coalesce(cname,'Customer'),event_action,src,rid,details_json);
    if coalesce(new.amount_paid,0)>0 and new.payment_id is not null then
      v_payment_id:=new.payment_id;
      select coalesce(p.base_minor/100.0,p.paid) into v_paid from public.payment p where p.payment_id=v_payment_id;
      insert into internal.customer_operational_events(customer_id,customer_name,action,source,source_id,details)
        values(cid,coalesce(cname,'Customer'),'payment_recorded',
          case when src='walkin' and order_id is not null then 'walkin_order' else src end,
          case when src='walkin' and order_id is not null then order_id::text else rid end,
          details_json||jsonb_build_object('amount',v_paid,'payment_id',v_payment_id))
        on conflict do nothing;
    end if;
  else
    if coalesce(new.amount_paid,0)>coalesce(old.amount_paid,0)
      and coalesce(new.balance_payment_id,new.payment_id) is not null then
      v_payment_id:=coalesce(new.balance_payment_id,new.payment_id);
      select coalesce(p.base_minor/100.0,p.paid) into v_paid from public.payment p where p.payment_id=v_payment_id;
      insert into internal.customer_operational_events(customer_id,customer_name,action,source,source_id,details)
        values(cid,coalesce(cname,'Customer'),'payment_recorded',
          case when src='walkin' and order_id is not null and new.balance_payment_id is null
            then 'walkin_order' else src end,
          case when src='walkin' and order_id is not null and new.balance_payment_id is null
            then order_id::text else rid end,
          details_json||jsonb_build_object('amount',v_paid,'payment_id',v_payment_id))
        on conflict do nothing;
    end if;
    if new.checked_in_at is distinct from old.checked_in_at and new.checked_in_at is not null then
      insert into internal.customer_operational_events(customer_id,customer_name,action,source,source_id,details)
        values(cid,coalesce(cname,'Customer'),'time_in',src,rid,details_json||jsonb_build_object('at',new.checked_in_at));
    end if;
    if new.checked_out_at is distinct from old.checked_out_at and new.checked_out_at is not null then
      insert into internal.customer_operational_events(customer_id,customer_name,action,source,source_id,details)
        values(cid,coalesce(cname,'Customer'),'time_out',src,rid,details_json||jsonb_build_object('at',new.checked_out_at));
    end if;
    if new.auto_cancelled_at is distinct from old.auto_cancelled_at and new.auto_cancelled_at is not null then
      insert into internal.customer_operational_events(customer_id,customer_name,action,source,source_id,details)
        values(cid,coalesce(cname,'Customer'),'unattended',src,rid,details_json);
    end if;
  end if;
  return new;
end;
$$;
revoke all on function internal.capture_customer_reservation_event() from public,anon,authenticated;
drop trigger if exists booking_customer_operational_event on public.booking;
create trigger booking_customer_operational_event after insert or update on public.booking
  for each row execute function internal.capture_customer_reservation_event();
drop trigger if exists walkin_customer_operational_event on public.walk_in_booking;
create trigger walkin_customer_operational_event after insert or update on public.walk_in_booking
  for each row execute function internal.capture_customer_reservation_event();

-- Preserve pre-migration reservations in the activity view. These rows describe
-- the state known at migration time; they do not invent intermediate payments.
insert into internal.customer_operational_events(customer_id,customer_name,action,source,source_id,details,created_at)
select b.customer_id,coalesce(nullif(btrim(p.full_name),''),p.email,'Customer'),ev.action,'booking',b.booking_id::text,
  jsonb_build_object('sport',b.sports,'court',b.courts,'unit',b.court_unit,'starts_at',b.time_date,
    'ends_at',b.end_at,'status',b.status,'amount_paid_at_migration',b.amount_paid,
    'historical_snapshot',true),ev.occurred_at
from public.booking b left join public.profiles p on p.id=b.customer_id
cross join lateral (values
  ('booking_created',b.created_at,true),
  ('time_in',b.checked_in_at,b.checked_in_at is not null),
  ('time_out',b.checked_out_at,b.checked_out_at is not null),
  ('unattended',b.auto_cancelled_at,b.auto_cancelled_at is not null)
) ev(action,occurred_at,include_row)
where ev.include_row and ev.occurred_at is not null and not exists (
  select 1 from internal.customer_operational_events existing
  where existing.source='booking' and existing.source_id=b.booking_id::text and existing.action=ev.action
);
insert into internal.customer_operational_events(customer_id,customer_name,action,source,source_id,details,created_at)
select w.customer_id,coalesce(nullif(btrim(w.customer_name),''),'Guest'),ev.action,'walkin',w.walkin_id::text,
  jsonb_build_object('sport',w.sports,'court',w.courts,'unit',w.court_unit,'starts_at',w.time_date,
    'ends_at',w.end_at,'status',w.status,'amount_paid_at_migration',w.amount_paid,
    'historical_snapshot',true),ev.occurred_at
from public.walk_in_booking w
cross join lateral (values
  ('walkin_created',w.created_at,true),
  ('time_in',w.checked_in_at,w.checked_in_at is not null),
  ('time_out',w.checked_out_at,w.checked_out_at is not null),
  ('unattended',w.auto_cancelled_at,w.auto_cancelled_at is not null)
) ev(action,occurred_at,include_row)
where ev.include_row and ev.occurred_at is not null and not exists (
  select 1 from internal.customer_operational_events existing
  where existing.source='walkin' and existing.source_id=w.walkin_id::text and existing.action=ev.action
);

-- Reconstruct payment activity only where the original payment row exists.
-- Its timestamp and identifier come from the ledger, never the booking date.
insert into internal.customer_operational_events(customer_id,customer_name,action,source,source_id,details,created_at)
select b.customer_id,coalesce(nullif(btrim(profile.full_name),''),profile.email,'Customer'),
  'payment_recorded','booking',b.booking_id::text,
  jsonb_build_object('payment_id',pay.payment_id,'amount',coalesce(pay.base_minor/100.0,pay.paid),
    'historical_backfill',true),pay.created_at
from public.booking b
left join public.profiles profile on profile.id=b.customer_id
cross join lateral (values (b.payment_id),(b.balance_payment_id)) linked(payment_id)
join public.payment pay on pay.payment_id=linked.payment_id
on conflict do nothing;
insert into internal.customer_operational_events(customer_id,customer_name,action,source,source_id,details,created_at)
select w.customer_id,coalesce(nullif(btrim(w.customer_name),''),'Guest'),
  'payment_recorded','walkin',w.walkin_id::text,
  jsonb_build_object('payment_id',pay.payment_id,'amount',coalesce(pay.base_minor/100.0,pay.paid),
    'historical_backfill',true),pay.created_at
from public.walk_in_booking w
cross join lateral (values (w.payment_id),(w.balance_payment_id)) linked(payment_id)
join public.payment pay on pay.payment_id=linked.payment_id
on conflict do nothing;

create or replace function public.staff_customer_activity(
  p_search text default '', p_from date default null, p_to date default null,
  p_sort text default 'newest', p_offset integer default 0, p_limit integer default 20
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if (select auth.uid()) is null or not exists (select 1 from public.profiles p where p.id=(select auth.uid())
      and p.role='staff' and p.status='active') then
    raise exception 'Active staff access is required' using errcode='42501'; end if;
  if p_offset<0 or p_limit not between 1 and 100 or length(coalesce(p_search,''))>120
    or p_sort not in ('newest','oldest','name_asc','name_desc') or (p_from is not null and p_to is not null and p_to<p_from) then
    raise exception 'Invalid customer activity request' using errcode='22023'; end if;
  with filtered as (
    select e.id,e.created_at,e.customer_name,e.action,e.source,e.source_id,
      case when e.action='sign_in' then e.details || jsonb_build_object('sign_out_observed',
        exists(select 1 from internal.customer_session_events login
          join internal.customer_session_events logout on logout.customer_id=login.customer_id
            and logout.session_id=login.session_id and logout.kind='sign_out'
          where login.event_id=e.id and login.kind='sign_in')) else e.details end as details
    from internal.customer_operational_events e
    where (p_from is null or (e.created_at at time zone 'Asia/Manila')::date>=p_from)
      and (p_to is null or (e.created_at at time zone 'Asia/Manila')::date<=p_to)
      and (nullif(btrim(p_search),'') is null or e.customer_name ilike '%'||btrim(p_search)||'%'
        or e.action ilike '%'||btrim(p_search)||'%' or e.source ilike '%'||btrim(p_search)||'%'
        or coalesce(e.source_id,'') ilike '%'||btrim(p_search)||'%')
  ), page as (
    select * from filtered order by
      case when p_sort='oldest' then created_at end asc,
      case when p_sort='name_asc' then lower(customer_name) end asc,
      case when p_sort='name_desc' then lower(customer_name) end desc,
      created_at desc,id desc offset p_offset limit p_limit
  )
  select jsonb_build_object('total_count',(select count(*) from filtered),
    'rows',coalesce((select jsonb_agg(to_jsonb(page)) from page),'[]'::jsonb)) into result;
  return result;
end;
$$;
revoke all on function public.staff_customer_activity(text,date,date,text,integer,integer) from public,anon;
grant execute on function public.staff_customer_activity(text,date,date,text,integer,integer) to authenticated;

create table if not exists internal.app_announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 120),
  body text not null check (length(btrim(body)) between 1 and 4000),
  audience text not null check (audience in ('staff','customers','both')),
  publish_at timestamptz not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists app_announcements_publish_idx on internal.app_announcements(publish_at desc);
revoke all on internal.app_announcements from public,anon,authenticated;

create or replace function public.owner_publish_announcement(p_title text,p_body text,p_audience text,p_publish_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare aid uuid; scheduled timestamptz:=coalesce(p_publish_at,now());
begin
  if (select auth.uid()) is null or not exists (select 1 from public.profiles p where p.id=(select auth.uid())
      and p.role='admin' and p.status='active') then
    raise exception 'Active owner access is required' using errcode='42501'; end if;
  if p_audience not in ('staff','customers','both') or length(btrim(coalesce(p_title,''))) not between 1 and 120
      or length(btrim(coalesce(p_body,''))) not between 1 and 4000 or not isfinite(scheduled) then
    raise exception 'Invalid announcement' using errcode='22023'; end if;
  insert into internal.app_announcements(title,body,audience,publish_at,created_by)
    values(btrim(p_title),btrim(p_body),p_audience,scheduled,(select auth.uid())) returning id into aid;
  return jsonb_build_object('id',aid,'status',case when scheduled<=now() then 'published' else 'scheduled' end);
end;
$$;
revoke all on function public.owner_publish_announcement(text,text,text,timestamptz) from public,anon;
grant execute on function public.owner_publish_announcement(text,text,text,timestamptz) to authenticated;

create or replace function public.owner_list_announcements(p_offset integer default 0,p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if (select auth.uid()) is null or not exists (select 1 from public.profiles p where p.id=(select auth.uid())
      and p.role='admin' and p.status='active') then
    raise exception 'Active owner access is required' using errcode='42501'; end if;
  if p_offset<0 or p_limit not between 1 and 100 then raise exception 'Invalid page' using errcode='22023'; end if;
  with page as (select a.id,a.title,a.body,a.audience,a.publish_at,a.created_at,
    case when a.publish_at<=now() then 'published' else 'scheduled' end as status
    from internal.app_announcements a order by a.created_at desc,a.id desc offset p_offset limit p_limit)
  select jsonb_build_object('total_count',(select count(*) from internal.app_announcements),
    'rows',coalesce((select jsonb_agg(to_jsonb(page)) from page),'[]'::jsonb)) into result;
  return result;
end;
$$;
revoke all on function public.owner_list_announcements(integer,integer) from public,anon;
grant execute on function public.owner_list_announcements(integer,integer) to authenticated;

alter table public.court_unit_maintenance add column if not exists publish_at timestamptz not null default now();

create table if not exists internal.notification_reads (
  user_id uuid not null references public.profiles(id) on delete cascade,
  notification_key text not null,
  read_at timestamptz not null default now(),
  primary key(user_id,notification_key),
  constraint notification_reads_key_length check(length(notification_key) between 1 and 128)
);
revoke all on internal.notification_reads from public,anon,authenticated;

-- Capture scheduled alerts at publication time. A live reservation or
-- maintenance row may later change or disappear; its published notice must
-- remain searchable with the same account-specific read key.
create table if not exists internal.staff_notice_config (
  singleton boolean primary key default true check (singleton),
  baseline_at timestamptz not null default now()
);
insert into internal.staff_notice_config(singleton) values(true) on conflict do nothing;
revoke all on internal.staff_notice_config from public,anon,authenticated;

create table if not exists internal.account_notice_events (
  key text primary key check (length(key) between 1 and 128),
  title text not null,
  body text not null,
  category text not null,
  audience text not null check (audience in ('staff','customers','both')),
  published_at timestamptz not null default now(),
  href text not null
);
create index if not exists account_notice_events_published_idx
  on internal.account_notice_events(published_at desc);
revoke all on internal.account_notice_events from public,anon,authenticated;

create or replace function internal.capture_due_account_notices()
returns integer language plpgsql security definer set search_path = '' as $$
declare baseline timestamptz; inserted_count integer; total_count integer:=0;
begin
  select c.baseline_at into baseline from internal.staff_notice_config c where c.singleton=true;
  if baseline is null then raise exception 'Notice baseline is missing'; end if;
  insert into internal.account_notice_events(key,title,body,category,audience,published_at,href)
  select 'arrival:'||b.booking_id::text,
    case when coalesce(b.amount_paid,0)<coalesce(b.amount_total,0)
      then 'Arrival needing balance' else 'Scheduled arrival' end,
    coalesce(nullif(btrim(p.full_name),''),p.email,'Customer')||' · '||
      coalesce(b.sports,'Sport')||' · '||to_char(b.time_date at time zone 'Asia/Manila','Mon DD, YYYY HH12:MI AM'),
    'arrival','staff',now(),'#booking-overview'
  from public.booking b left join public.profiles p on p.id=b.customer_id
  where b.time_date>baseline and b.time_date>=now()-interval '1 hour'
    and b.time_date-interval '24 hours'<=now()
    and b.status in ('pending','confirmed') and b.checked_in_at is null
  on conflict(key) do nothing;
  get diagnostics inserted_count = row_count;
  total_count:=total_count+inserted_count;
  insert into internal.account_notice_events(key,title,body,category,audience,published_at,href)
  select 'maintenance:'||m.id::text,'Court maintenance',
    coalesce(nullif(m.note,''),'A court is scheduled for maintenance.')||' ('||c.name||' · '||u.label||')',
    'maintenance','both',now(),'#court-schedule'
  from public.court_unit_maintenance m
  join public.court_unit_inventory u on u.id=m.court_unit_id
  join public.court c on c.id=u.court_id
  where m.ends_at>baseline and m.ends_at>now() and m.publish_at<=now()
  on conflict(key) do nothing;
  get diagnostics inserted_count = row_count;
  return total_count+inserted_count;
end;
$$;
revoke all on function internal.capture_due_account_notices() from public,anon,authenticated;
select internal.capture_due_account_notices();
select cron.schedule('inigosync-publish-account-notices','* * * * *',
  'select internal.capture_due_account_notices()');

create or replace function internal.notification_feed(p_user_id uuid,p_role text)
returns table(key text,title text,body text,category text,created_at timestamptz,href text)
language sql stable security definer set search_path = '' as $$
  select 'announcement:'||a.id::text,a.title,a.body,'announcement',a.publish_at,
    case when p_role='staff' then '#notifications' else '#notifications' end
  from internal.app_announcements a
  where a.publish_at<=now() and (a.audience='both' or a.audience=case when p_role='staff' then 'staff' else 'customers' end)
  union all
  select n.key,n.title,n.body,n.category,n.published_at,n.href
  from internal.account_notice_events n
  where n.audience='both' or n.audience=case when p_role='staff' then 'staff' else 'customers' end
  union all
  select 'activity:'||e.id::text,
    case e.action when 'booking_created' then 'New booking' when 'walkin_created' then 'Walk-in created'
      when 'payment_recorded' then 'Payment recorded' when 'time_in' then 'Customer arrived'
      when 'time_out' then 'Customer exited' when 'unattended' then 'Booking unattended' else 'Customer activity' end,
    e.customer_name||' · '||coalesce(e.details->>'sport','Booking'),e.action,e.created_at,
    case when p_role='staff' then '#transactions' else '#bookings' end
  from internal.customer_operational_events e
  where e.action in ('booking_created','walkin_created','payment_recorded','time_in','time_out','unattended')
    and (p_role='staff' or e.customer_id=p_user_id)
  ;
$$;
revoke all on function internal.notification_feed(uuid,text) from public,anon,authenticated;

create or replace function internal.list_account_notifications(p_expected_role text,p_search text,p_offset integer,p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare uid uuid:=(select auth.uid()); result jsonb;
begin
  if uid is null or not exists(select 1 from public.profiles p where p.id=uid and p.role::text=p_expected_role
      and p.status='active') then
    raise exception 'Active account access is required' using errcode='42501'; end if;
  if p_offset<0 or p_limit not between 1 and 100 or length(coalesce(p_search,''))>120 then
    raise exception 'Invalid notification request' using errcode='22023'; end if;
  with filtered as (
    select f.key,f.title,f.body,f.category,f.created_at,f.href,r.read_at
    from internal.notification_feed(uid,p_expected_role) f
    left join internal.notification_reads r on r.user_id=uid and r.notification_key=f.key
    where nullif(btrim(p_search),'') is null or f.title ilike '%'||btrim(p_search)||'%'
      or f.body ilike '%'||btrim(p_search)||'%'
  ), page as (select * from filtered order by created_at desc,key desc offset p_offset limit p_limit)
  select jsonb_build_object('total_count',(select count(*) from filtered),
    'unread_count',(select count(*) from internal.notification_feed(uid,p_expected_role) all_notices
      left join internal.notification_reads all_reads on all_reads.user_id=uid
        and all_reads.notification_key=all_notices.key
      where all_reads.read_at is null),
    'rows',coalesce((select jsonb_agg(to_jsonb(page)) from page),'[]'::jsonb)) into result;
  return result;
end;
$$;
revoke all on function internal.list_account_notifications(text,text,integer,integer) from public,anon,authenticated;

create or replace function public.staff_list_notifications(p_search text default '',p_offset integer default 0,p_limit integer default 20)
returns jsonb language sql stable security definer set search_path = '' as $$
  select internal.list_account_notifications('staff',p_search,p_offset,p_limit);
$$;
revoke all on function public.staff_list_notifications(text,integer,integer) from public,anon;
grant execute on function public.staff_list_notifications(text,integer,integer) to authenticated;

create or replace function public.customer_list_notifications(p_search text default '',p_offset integer default 0,p_limit integer default 20)
returns jsonb language sql stable security definer set search_path = '' as $$
  select internal.list_account_notifications('customer',p_search,p_offset,p_limit);
$$;
revoke all on function public.customer_list_notifications(text,integer,integer) from public,anon;
grant execute on function public.customer_list_notifications(text,integer,integer) to authenticated;

create or replace function public.mark_notification_read(p_key text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare uid uuid:=(select auth.uid()); account_role text;
begin
  select p.role::text into account_role from public.profiles p where p.id=uid and p.role in ('staff','customer')
    and p.status='active';
  if account_role is null then raise exception 'Active account access is required' using errcode='42501'; end if;
  if length(coalesce(p_key,'')) not between 1 and 128 or not exists(
    select 1 from internal.notification_feed(uid,account_role) f where f.key=p_key) then
    raise exception 'Notification not found' using errcode='P0002'; end if;
  insert into internal.notification_reads(user_id,notification_key) values(uid,p_key)
    on conflict(user_id,notification_key) do nothing;
  return true;
end;
$$;
revoke all on function public.mark_notification_read(text) from public,anon;
grant execute on function public.mark_notification_read(text) to authenticated;

create or replace function public.staff_mark_all_notifications_read()
returns integer language plpgsql security definer set search_path = '' as $$
declare uid uuid:=(select auth.uid()); marked integer;
begin
  if uid is null or not exists(select 1 from public.profiles p where p.id=uid
      and p.role='staff' and p.status='active') then
    raise exception 'Active staff access is required' using errcode='42501'; end if;
  insert into internal.notification_reads(user_id,notification_key)
  select uid,f.key from internal.notification_feed(uid,'staff') f
  on conflict(user_id,notification_key) do nothing;
  get diagnostics marked = row_count;
  return marked;
end;
$$;
revoke all on function public.staff_mark_all_notifications_read() from public,anon;
grant execute on function public.staff_mark_all_notifications_read() to authenticated;

-- Include scheduled publication time in owner maintenance editor.
create or replace function public.admin_get_sport_editor(p_court_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
    if (select auth.uid()) is null or not exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin' and p.status='active') then raise exception 'Active owner access is required' using errcode='42501'; end if;
    if p_court_id is null then
        select jsonb_build_object('version',0,'listing',null,'units','[]'::jsonb,'resources',coalesce((
            select jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'sport_names',coalesce((select jsonb_agg(distinct s.name order by s.name)
              from public.court_unit_resource_map mm join public.court_unit_inventory uu on uu.id=mm.court_unit_id
              join public.court cc on cc.id=uu.court_id join public.sport s on s.id=cc.sport_id where mm.resource_id=r.id),'[]'::jsonb)) order by r.name)
              from public.physical_court_resource r where r.is_active),'[]'::jsonb),'cutoff',(select night_rate_starts_at from public.app_settings where id=true)) into result;
        return result;
    end if;
    select jsonb_build_object(
      'version',c.editor_version,
      'listing',jsonb_build_object('id',c.id,'sport_id',s.id,'slug',c.slug,'name',c.name,'description',c.description,'unit',c.unit,'image_url',c.image_url,'is_active',c.is_active,'display_order',c.display_order),
      'units',coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'label',u.label,'photo_url',u.photo_url,'rate_day',u.rate_day,'rate_night',u.rate_night,'rate_unit',u.rate_unit,
        'resource_ids',coalesce((select jsonb_agg(m.resource_id order by m.resource_id) from public.court_unit_resource_map m where m.court_unit_id=u.id),'[]'::jsonb),
        'maintenance',coalesce((select jsonb_agg(jsonb_build_object('id',mnt.id,'start_at',mnt.starts_at,'end_at',mnt.ends_at,'note',mnt.note,'publish_at',mnt.publish_at) order by mnt.starts_at) from public.court_unit_maintenance mnt where mnt.court_unit_id=u.id),'[]'::jsonb)) order by u.created_at,u.id)
        from public.court_unit_inventory u where u.court_id=c.id),'[]'::jsonb),
      'resources',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'sport_names',coalesce((select jsonb_agg(distinct ss.name order by ss.name)
        from public.court_unit_resource_map mm join public.court_unit_inventory uu on uu.id=mm.court_unit_id
        join public.court cc on cc.id=uu.court_id join public.sport ss on ss.id=cc.sport_id where mm.resource_id=r.id),'[]'::jsonb)) order by r.name)
        from public.physical_court_resource r where r.is_active),'[]'::jsonb),
      'cutoff',(select night_rate_starts_at from public.app_settings where id=true))
    into result from public.court c left join public.sport s on s.id=c.sport_id where c.id=p_court_id;
    if result is null then raise exception 'Sport listing not found' using errcode='P0002'; end if;
    return result;
end;
$$;
revoke all on function public.admin_get_sport_editor(uuid) from public,anon;
grant execute on function public.admin_get_sport_editor(uuid) to authenticated;



-- Persist optional notice publication time with maintenance changes.
-- Let new units receive their own physical resource in the same atomic sport save.
create or replace function public.admin_save_sport(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cid uuid; sid uuid; unit_id uuid; resource_id uuid; expected integer; next_version integer; is_new_unit boolean;
 listing_name text; listing_slug text; listing_unit text; listing_active boolean; item jsonb; mitem jsonb;
 label_value text; next_order integer; submitted uuid[]:=array[]::uuid[]; result_units jsonb:='[]'::jsonb;
 v_publish_at timestamptz;
begin
    if (select auth.uid()) is null or not exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='admin' and p.status='active') then raise exception 'Active owner access is required' using errcode='42501'; end if;
    perform set_config('inigosync.admin_sport_save','on',true);
    if jsonb_typeof(p_payload)<>'object' or jsonb_typeof(p_payload->'units')<>'array' or jsonb_array_length(p_payload->'units') not between 1 and 50 then raise exception 'Sport details need between 1 and 50 units' using errcode='22023'; end if;
    cid:=nullif(p_payload->>'court_id','')::uuid; expected:=coalesce((p_payload->>'expected_version')::integer,0);
    listing_name:=nullif(btrim(p_payload->>'name'),'');
    listing_slug:=coalesce(nullif(regexp_replace(lower(btrim(coalesce(p_payload->>'slug',p_payload->>'name'))),'[^a-z0-9]+','-','g'),''),gen_random_uuid()::text);
    listing_unit:=p_payload->>'unit'; listing_active:=coalesce((p_payload->>'is_active')::boolean,true);
    if listing_name is null or listing_unit not in ('courts','lanes','tables') then raise exception 'Sport name or unit type is invalid' using errcode='22023'; end if;
    update internal.reservation_resource_config_lock set version=version+1 where id=true;
    if cid is null then
        if expected<>0 then raise exception 'New sports must use version 0' using errcode='40001'; end if;
        select coalesce(max(display_order),0)+1 into next_order from public.court;
        insert into public.sport(slug,name,display_order,is_active) values(listing_slug,listing_name,next_order,listing_active)
          returning id into sid;
        insert into public.court(sport_id,slug,name,quantity,unit,description,status,image_url,display_order,is_active,editor_version)
          values(sid,listing_slug,listing_name,jsonb_array_length(p_payload->'units'),listing_unit,nullif(btrim(p_payload->>'description'),''),'Available',nullif(btrim(p_payload->>'image_url'),''),next_order,listing_active,1)
          returning id,editor_version into cid,next_version;
    else
        select c.sport_id into sid from public.court c where c.id=cid and c.editor_version=expected for update;
        if not found then raise exception 'This sport changed in another session. Reload it and retry.' using errcode='40001'; end if;
        if not listing_active and (exists(select 1 from public.booking b where b.court_listing_id=cid and b.status in ('pending','confirmed') and b.end_at>now())
          or exists(select 1 from public.walk_in_booking w where w.court_listing_id=cid and w.status in ('pending','confirmed') and w.end_at>now())) then raise exception 'A sport with an active or upcoming reservation cannot be archived' using errcode='23503'; end if;
        update public.sport set slug=listing_slug,name=listing_name,is_active=listing_active where id=sid;
        update public.court set slug=listing_slug,name=listing_name,quantity=jsonb_array_length(p_payload->'units'),unit=listing_unit,
          description=nullif(btrim(p_payload->>'description'),''),image_url=nullif(btrim(p_payload->>'image_url'),''),is_active=listing_active,
          editor_version=editor_version+1 where id=cid returning editor_version into next_version;
    end if;
    for item in select value from jsonb_array_elements(p_payload->'units') loop
        unit_id:=nullif(item->>'id','')::uuid; is_new_unit:=unit_id is null; label_value:=nullif(btrim(item->>'label'),'');
        if label_value is null then raise exception 'Every unit needs a name' using errcode='22023'; end if;
        if unit_id is null then
            insert into public.court_unit_inventory(court_id,label,photo_url,rate_day,rate_night,rate_unit,is_active,inventory_verified)
              values(cid,label_value,nullif(btrim(item->>'photo_url'),''),nullif(item->>'rate_day','')::numeric,nullif(item->>'rate_night','')::numeric,coalesce(item->>'rate_unit','/hr'),listing_active,true) returning id into unit_id;
            insert into public.physical_court_resource(name) values(listing_name||' · '||label_value) returning id into resource_id;
            insert into public.court_unit_resource_map(court_unit_id,resource_id) values(unit_id,resource_id);
        else
            if not exists(select 1 from public.court_unit_inventory where id=unit_id and court_id=cid) then raise exception 'A unit does not belong to this sport' using errcode='22023'; end if;
            update public.court_unit_inventory set label=label_value,photo_url=nullif(btrim(item->>'photo_url'),''),rate_day=nullif(item->>'rate_day','')::numeric,
              rate_night=nullif(item->>'rate_night','')::numeric,rate_unit=coalesce(item->>'rate_unit','/hr'),inventory_verified=true where id=unit_id;
        end if;
        if unit_id=any(submitted) then raise exception 'Duplicate unit ID' using errcode='22023'; end if;
        submitted:=array_append(submitted,unit_id);
        if jsonb_typeof(item->'resource_ids') is distinct from 'array' then raise exception 'Physical court connections must be a list' using errcode='22023'; end if;
        if jsonb_array_length(item->'resource_ids')=0 and not is_new_unit then raise exception 'Every existing unit must remain connected to a physical court space' using errcode='22023'; end if;
        if jsonb_array_length(item->'resource_ids')>0 then
            -- Add first so refresh triggers never observe a disconnected unit.
            for resource_id in select value::uuid from jsonb_array_elements_text(item->'resource_ids') loop
                if not exists(select 1 from public.physical_court_resource where id=resource_id and is_active) then raise exception 'Unknown physical resource' using errcode='22023'; end if;
                insert into public.court_unit_resource_map(court_unit_id,resource_id) values(unit_id,resource_id) on conflict do nothing;
            end loop;
            delete from public.court_unit_resource_map existing where existing.court_unit_id=unit_id and not exists(
              select 1 from jsonb_array_elements_text(item->'resource_ids') wanted(value) where wanted.value::uuid=existing.resource_id);
        end if;
        delete from public.court_unit_maintenance where court_unit_id=unit_id and (item->'maintenance' is null or not exists(
          select 1 from jsonb_array_elements(item->'maintenance') mm where nullif(mm->>'id','')::uuid=court_unit_maintenance.id));
        for mitem in select value from jsonb_array_elements(coalesce(item->'maintenance','[]'::jsonb)) loop
            if nullif(mitem->>'start_at','') is null or nullif(mitem->>'end_at','') is null then raise exception 'Maintenance needs a start and end time' using errcode='22023'; end if;
            v_publish_at:=coalesce(nullif(mitem->>'publish_at','')::timestamptz,
              (select existing.publish_at from public.court_unit_maintenance existing
                where existing.id=nullif(mitem->>'id','')::uuid and existing.court_unit_id=unit_id),now());
            if v_publish_at >= (mitem->>'end_at')::timestamptz then
              raise exception 'Maintenance notice must publish before maintenance ends' using errcode='22023'; end if;
            if nullif(mitem->>'id','') is null then
                insert into public.court_unit_maintenance(court_unit_id,starts_at,ends_at,note,publish_at,created_by)
                  values(unit_id,(mitem->>'start_at')::timestamptz,(mitem->>'end_at')::timestamptz,nullif(btrim(mitem->>'note'),''),v_publish_at,(select auth.uid()));
            else
                update public.court_unit_maintenance set starts_at=(mitem->>'start_at')::timestamptz,ends_at=(mitem->>'end_at')::timestamptz,note=nullif(btrim(mitem->>'note'),''),publish_at=v_publish_at
                  where id=(mitem->>'id')::uuid and court_unit_id=unit_id;
                if not found then raise exception 'Maintenance period does not belong to this unit' using errcode='22023'; end if;
            end if;
        end loop;
        result_units:=result_units||jsonb_build_array(jsonb_build_object('id',unit_id,'label',label_value));
    end loop;
    for unit_id in select u.id from public.court_unit_inventory u where u.court_id=cid and not(u.id=any(submitted)) loop
        if exists(select 1 from public.booking b where b.court_listing_id=cid and (b.court_unit_inventory_id=unit_id or
          (b.court_unit_inventory_id is null and (nullif(btrim(b.court_unit),'') is null or lower(btrim(b.court_unit))=(select lower(btrim(label)) from public.court_unit_inventory where id=unit_id)))))
          or exists(select 1 from public.walk_in_booking w where w.court_listing_id=cid and (w.court_unit_inventory_id=unit_id or
          (w.court_unit_inventory_id is null and (nullif(btrim(w.court_unit),'') is null or lower(btrim(w.court_unit))=(select lower(btrim(label)) from public.court_unit_inventory where id=unit_id))))) then
            raise exception 'A unit referenced by booking history cannot be deleted' using errcode='23503';
        end if;
        delete from public.court_unit_inventory where id=unit_id;
    end loop;
    update public.court set quantity=cardinality(submitted) where id=cid;
    delete from public.physical_court_resource r where not exists(select 1 from public.court_unit_resource_map m where m.resource_id=r.id);
    perform internal.capture_due_account_notices();
    return jsonb_build_object('court_id',cid,'sport_id',sid,'version',next_version,'units',result_units);
end;
$$;
revoke all on function public.admin_save_sport(jsonb) from public,anon;
grant execute on function public.admin_save_sport(jsonb) to authenticated;



-- Shared availability also rejects disabled or inactive account tokens.
create or replace function public.court_occupancy(from_at timestamptz,to_at timestamptz)
returns table(source text,courts text,court_unit text,time_date timestamptz,end_at timestamptz,duration_minutes integer,status text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.status='active' and p.role in ('customer','staff','admin')) then raise exception 'Active account access is required' using errcode='42501'; end if;
  if from_at is null or to_at is null or not isfinite(from_at) or not isfinite(to_at)
    or to_at<=from_at or to_at-from_at>interval '31 days' then raise exception 'Availability range must be between 0 and 31 days' using errcode='22023'; end if;
  return query
  select distinct on(rs.resource_id,rs.booking_id,rs.walkin_id,rs.maintenance_id,rs.hold_item_id,c.id,u.id)
    case when rs.maintenance_id is not null then 'maintenance' when rs.hold_item_id is not null then 'checkout_hold'
      when rs.booking_id is not null then 'online' else 'walkin' end,
    c.name,u.label,lower(rs.during),upper(rs.during),
    greatest(1,ceil(extract(epoch from (upper(rs.during)-lower(rs.during)))/60)::integer),
    case when rs.hold_item_id is not null then 'pending' else coalesce(b.status,w.status,'maintenance') end
  from internal.reservation_resource_slots rs join public.court_unit_resource_map tm on tm.resource_id=rs.resource_id
    join public.court_unit_inventory u on u.id=tm.court_unit_id and u.is_active
    join public.court c on c.id=u.court_id and c.is_active
    left join public.booking b on b.booking_id=rs.booking_id
    left join public.walk_in_booking w on w.walkin_id=rs.walkin_id
  where rs.during && tstzrange(from_at,to_at,'[)')
  order by rs.resource_id,rs.booking_id,rs.walkin_id,rs.maintenance_id,rs.hold_item_id,c.id,u.id;
end;
$$;
revoke all on function public.court_occupancy(timestamptz,timestamptz) from public,anon;
grant execute on function public.court_occupancy(timestamptz,timestamptz) to authenticated;
