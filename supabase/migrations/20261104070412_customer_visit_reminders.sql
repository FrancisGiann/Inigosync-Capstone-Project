-- Event-keyed state replaces the legacy one-row-per-booking 5-hour behavior.
-- Legacy rows are retained as history and are no longer rendered or claimed.
create table if not exists internal.customer_visit_reminders (
  visit_type text not null check (visit_type in ('booking','walkin')),
  visit_id bigint not null,
  event_type text not null check (event_type in ('starting_soon','ending_soon')),
  event_at timestamptz not null,
  customer_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(), email_sent_at timestamptz,
  email_claimed_at timestamptz, email_claim_token uuid, email_snapshot jsonb,
  email_attempts integer not null default 0 check(email_attempts>=0),
  primary key(visit_type,visit_id,event_type,event_at),
  check((email_claimed_at is null)=(email_claim_token is null)),
  check(event_type<>'starting_soon' or visit_type='booking')
);
create index if not exists customer_visit_reminders_customer_feed_idx
  on internal.customer_visit_reminders(customer_id,created_at desc);
create index if not exists customer_visit_reminders_pending_idx
  on internal.customer_visit_reminders(email_sent_at,email_claimed_at,created_at) where email_sent_at is null;
alter table internal.customer_visit_reminders enable row level security;
revoke all on internal.customer_visit_reminders from public,anon,authenticated;

-- Stop a still-deployed old worker from sending additional five-hour mail.
create or replace function public.claim_customer_booking_reminders()
returns table(booking_id bigint,customer_id uuid,email text,sport text,court text,
  starts_at timestamptz,amount_due numeric,claim_token uuid)
language plpgsql security definer set search_path = '' as $$
begin
  return;
end;
$$;
revoke all on function public.claim_customer_booking_reminders() from public,anon,authenticated;
grant execute on function public.claim_customer_booking_reminders() to service_role;

create or replace function public.claim_customer_visit_reminders()
returns table(visit_type text,visit_id bigint,event_type text,event_at timestamptz,claim_token uuid)
language plpgsql security definer set search_path = '' as $$
begin
  insert into internal.customer_visit_reminders(visit_type,visit_id,event_type,event_at,customer_id)
  select 'booking',b.booking_id,'starting_soon',b.time_date,b.customer_id from public.booking b
  join public.profiles p on p.id=b.customer_id and p.role='customer' and p.status='active'
  where b.status='confirmed' and b.checked_in_at is null and b.time_date>now()
    and b.time_date<=now()+interval '30 minutes' on conflict do nothing;
  insert into internal.customer_visit_reminders(visit_type,visit_id,event_type,event_at,customer_id)
  select 'booking',b.booking_id,'ending_soon',b.end_at,b.customer_id from public.booking b
  join public.profiles p on p.id=b.customer_id and p.role='customer' and p.status='active'
  where b.status='confirmed' and b.checked_in_at is not null and b.checked_out_at is null
    and b.end_at>now() and b.end_at<=now()+interval '10 minutes' on conflict do nothing;
  insert into internal.customer_visit_reminders(visit_type,visit_id,event_type,event_at,customer_id)
  select 'walkin',w.walkin_id,'ending_soon',w.end_at,coalesce(o.customer_id,w.customer_id)
  from public.walk_in_booking w left join internal.staff_walkin_orders o on o.id=w.walkin_order_id
  join public.profiles p on p.id=coalesce(o.customer_id,w.customer_id)
    and p.role='customer' and p.status='active'
  where w.status='confirmed' and w.checked_in_at is not null and w.checked_out_at is null
    and w.end_at>now() and w.end_at<=now()+interval '10 minutes' on conflict do nothing;

  return query
  with candidates as (
    select r.visit_type,r.visit_id,r.event_type,r.event_at from internal.customer_visit_reminders r
    join lateral (
      select b.customer_id,b.status,b.checked_in_at,b.checked_out_at,b.time_date as starts_at,b.end_at
      from public.booking b where r.visit_type='booking' and b.booking_id=r.visit_id
      union all
      select coalesce(o.customer_id,w.customer_id),w.status,w.checked_in_at,w.checked_out_at,w.time_date,w.end_at
      from public.walk_in_booking w left join internal.staff_walkin_orders o on o.id=w.walkin_order_id
      where r.visit_type='walkin' and w.walkin_id=r.visit_id
    ) v on v.customer_id=r.customer_id
    join public.profiles p on p.id=r.customer_id and p.role='customer' and p.status='active'
    where r.email_sent_at is null and (r.email_claimed_at is null or r.email_claimed_at<now()-interval '5 minutes')
      and nullif(btrim(p.email),'') is not null and v.status='confirmed'
      and ((r.event_type='starting_soon' and r.visit_type='booking' and v.checked_in_at is null
          and r.event_at=v.starts_at and v.starts_at>now() and v.starts_at<=now()+interval '30 minutes')
        or (r.event_type='ending_soon' and v.checked_in_at is not null and v.checked_out_at is null
          and r.event_at=v.end_at and v.end_at>now() and v.end_at<=now()+interval '10 minutes'))
    -- Keep the batch within the existing five-minute lease at sequential SMTP rates.
    order by r.created_at,r.visit_id limit 5 for update of r skip locked
  ), claimed as (
    update internal.customer_visit_reminders r set email_claimed_at=now(),
      email_claim_token=gen_random_uuid(),email_attempts=r.email_attempts+1
    from candidates c where (r.visit_type,r.visit_id,r.event_type,r.event_at)=
      (c.visit_type,c.visit_id,c.event_type,c.event_at)
    returning r.visit_type,r.visit_id,r.event_type,r.event_at,r.email_claim_token
  ) select * from claimed;
end;
$$;
revoke all on function public.claim_customer_visit_reminders() from public,anon,authenticated;
grant execute on function public.claim_customer_visit_reminders() to service_role;

create or replace function public.refresh_customer_visit_reminder(p_visit_type text,p_visit_id bigint,
  p_event_type text,p_event_at timestamptz,p_claim_token uuid)
returns table(email text,sport text,court text,court_unit text,starts_at timestamptz,ends_at timestamptz,amount_due numeric)
language plpgsql security definer set search_path = '' as $$
begin
  return query
  with visit as (
    select b.customer_id,b.sports,b.courts,null::text as court_unit,b.time_date,b.end_at,
      greatest(coalesce(b.amount_total,0)-coalesce(b.amount_paid,0),0) due,b.status,b.checked_in_at,b.checked_out_at
    from public.booking b where p_visit_type='booking' and b.booking_id=p_visit_id
    union all
    select coalesce(o.customer_id,w.customer_id),w.sports,w.courts,w.court_unit,w.time_date,w.end_at,
      greatest(coalesce(w.amount_total,0)-coalesce(w.amount_paid,0),0),w.status,w.checked_in_at,w.checked_out_at
    from public.walk_in_booking w left join internal.staff_walkin_orders o on o.id=w.walkin_order_id
    where p_visit_type='walkin' and w.walkin_id=p_visit_id
  )
  update internal.customer_visit_reminders r set email_claimed_at=now(),email_snapshot=jsonb_build_object(
    'email',p.email,'sport',v.sports,'court',v.courts,'court_unit',v.court_unit,
    'starts_at',v.time_date,'ends_at',v.end_at,'amount_due',v.due)
  from visit v join public.profiles p on p.id=v.customer_id and p.role='customer' and p.status='active'
  where r.visit_type=p_visit_type and r.visit_id=p_visit_id and r.event_type=p_event_type
    and r.event_at=p_event_at and r.customer_id=v.customer_id
    and r.email_claim_token=p_claim_token and r.email_sent_at is null
    and nullif(btrim(p.email),'') is not null and v.status='confirmed'
    and ((p_event_type='starting_soon' and p_visit_type='booking' and v.checked_in_at is null
        and v.time_date=p_event_at and v.time_date>now() and v.time_date<=now()+interval '30 minutes')
      or (p_event_type='ending_soon' and v.checked_in_at is not null and v.checked_out_at is null
        and v.end_at=p_event_at and v.end_at>now() and v.end_at<=now()+interval '10 minutes'))
  returning r.email_snapshot->>'email',r.email_snapshot->>'sport',r.email_snapshot->>'court',
    r.email_snapshot->>'court_unit',(r.email_snapshot->>'starts_at')::timestamptz,
    (r.email_snapshot->>'ends_at')::timestamptz,(r.email_snapshot->>'amount_due')::numeric;
end;
$$;
revoke all on function public.refresh_customer_visit_reminder(text,bigint,text,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.refresh_customer_visit_reminder(text,bigint,text,timestamptz,uuid) to service_role;

create or replace function public.complete_customer_visit_reminder(p_visit_type text,p_visit_id bigint,
  p_event_type text,p_event_at timestamptz,p_claim_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare affected integer;
begin
  update internal.customer_visit_reminders set email_sent_at=now(),email_claimed_at=null,email_claim_token=null
  where visit_type=p_visit_type and visit_id=p_visit_id and event_type=p_event_type
    and event_at=p_event_at and email_claim_token=p_claim_token and email_sent_at is null;
  get diagnostics affected = row_count; return affected=1;
end;
$$;
revoke all on function public.complete_customer_visit_reminder(text,bigint,text,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.complete_customer_visit_reminder(text,bigint,text,timestamptz,uuid) to service_role;

create or replace function public.release_customer_visit_reminder(p_visit_type text,p_visit_id bigint,
  p_event_type text,p_event_at timestamptz,p_claim_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare affected integer;
begin
  update internal.customer_visit_reminders set email_claimed_at=null,email_claim_token=null
  where visit_type=p_visit_type and visit_id=p_visit_id and event_type=p_event_type
    and event_at=p_event_at and email_claim_token=p_claim_token and email_sent_at is null;
  get diagnostics affected = row_count; return affected=1;
end;
$$;
revoke all on function public.release_customer_visit_reminder(text,bigint,text,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.release_customer_visit_reminder(text,bigint,text,timestamptz,uuid) to service_role;

-- Keep the current staff and announcement feed unchanged, replace only its
-- obsolete booking reminder projection, and add event-keyed customer reminders.
create or replace function internal.notification_feed(p_user_id uuid,p_role text)
returns table(key text,title text,body text,category text,created_at timestamptz,href text)
language sql stable security definer set search_path = '' as $$
  select 'announcement:'||a.id::text,a.title,a.body,'announcement',a.publish_at,'#notifications'::text
  from internal.app_announcements a join public.profiles creator on creator.id=a.created_by
  where a.publish_at<=now() and creator.role='admin'
    and ((p_role='staff' and a.audience in ('both','staff')) or (p_role='customer' and a.audience in ('both','customers')))
  union all
  select n.key,n.title,n.body,n.category,n.published_at,
    case when n.category='maintenance' then '#court-schedule'
      when n.category='ending_soon' and n.key like 'ending-soon:%:%' then coalesce((
        select '#transactions?view=transactions&transaction_id='||a.id::text
        from public.audit_log a
        left join public.booking b on a.entity_type='booking' and b.booking_id::text=a.entity_id
        left join public.walk_in_booking w on a.entity_type='walkin' and w.walkin_id::text=a.entity_id
        where a.actor_id=p_user_id and a.entity_type=split_part(n.key,':',2)
          and a.entity_type in ('booking','walkin') and a.entity_id=split_part(n.key,':',3)
          and (a.action='timed_in' or (a.action='collected_online_balance' and a.details->>'time_in_recorded'='true'))
          and ((a.entity_type='booking' and b.checked_in_at is not null)
            or (a.entity_type='walkin' and w.checked_in_at is not null))
        order by a.created_at desc,a.id desc limit 1
      ),'#transactions?view=transactions&no_transaction=1') else n.href end
  from internal.account_notice_events n
  where p_role='staff' and n.audience='staff' and n.category in ('maintenance','ending_soon')
  union all
  select 'activity:'||e.id::text,'Booking unattended',e.customer_name||' · '||coalesce(e.details->>'sport','Booking'),
    'unattended',e.created_at,case when e.source in ('booking','walkin') and nullif(e.source_id,'') is not null
      then '#transactions?view=unattended&visit_id='||e.source_id else '#transactions?view=unattended' end
  from internal.customer_operational_events e where p_role='staff' and e.action='unattended'
  union all
  select n.key,n.title,n.body,'maintenance',n.published_at,n.href
  from internal.customer_maintenance_notices n join public.booking b on b.booking_id=n.booking_id and b.customer_id=n.customer_id
  where p_role='customer' and n.customer_id=p_user_id and b.status='confirmed' and b.time_date>now()
  union all
  select 'visit-reminder:'||r.visit_type||':'||r.event_type||':'||r.visit_id||':'||
      to_char(r.event_at at time zone 'UTC','YYYYMMDDHH24MISS.US'),
    case r.event_type when 'starting_soon' then 'Your booking starts in about 30 minutes'
      else 'Your visit ends in about 10 minutes' end,
    coalesce(v.sports,'Sport')||' · '||coalesce(v.courts,'Court')||
      case when nullif(v.court_unit,'') is not null then ' · '||v.court_unit else '' end||' · '||
      to_char(v.time_date at time zone 'Asia/Manila','Mon DD, YYYY HH12:MI AM')||'–'||
      to_char(v.end_at at time zone 'Asia/Manila','HH12:MI AM')||
      case when r.event_type='starting_soon' and coalesce(v.amount_total,0)>coalesce(v.amount_paid,0)
        then ' · Balance due at check-in: PHP '||to_char(greatest(v.amount_total-v.amount_paid,0),'FM999,999,990.00') else '' end,
    case r.event_type when 'starting_soon' then 'booking_reminder' else 'visit_ending_reminder' end,
    r.created_at,'#bookings'::text
  from internal.customer_visit_reminders r
  join lateral (
    select b.customer_id,b.sports,b.courts,null::text court_unit,b.time_date,b.end_at,b.amount_total,b.amount_paid,
      b.status,b.checked_in_at,b.checked_out_at from public.booking b
    where r.visit_type='booking' and b.booking_id=r.visit_id
    union all
    select coalesce(o.customer_id,w.customer_id),w.sports,w.courts,w.court_unit,w.time_date,w.end_at,w.amount_total,w.amount_paid,
      w.status,w.checked_in_at,w.checked_out_at from public.walk_in_booking w
    left join internal.staff_walkin_orders o on o.id=w.walkin_order_id where r.visit_type='walkin' and w.walkin_id=r.visit_id
  ) v on v.customer_id=r.customer_id
  where p_role='customer' and r.customer_id=p_user_id and
    ((r.event_type='starting_soon' and v.status='confirmed' and v.checked_in_at is null
        and r.event_at=v.time_date and v.time_date>now() and v.time_date<=now()+interval '30 minutes') or
     (r.event_type='ending_soon' and v.status='confirmed' and v.checked_in_at is not null
       and v.checked_out_at is null and r.event_at=v.end_at
       and v.end_at>now() and v.end_at<=now()+interval '10 minutes'))
$$;
revoke all on function internal.notification_feed(uuid,text) from public,anon,authenticated;
