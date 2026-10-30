-- Staff notifications are limited to staff announcements, maintenance,
-- unattended bookings, and active reservations ending within ten minutes.
create or replace function internal.notification_feed(p_user_id uuid,p_role text)
returns table(key text,title text,body text,category text,created_at timestamptz,href text)
language sql stable security definer set search_path = '' as $$
  select 'announcement:'||a.id::text,a.title,a.body,'announcement',a.publish_at,
    '#notifications'::text
  from internal.app_announcements a
  join public.profiles creator on creator.id=a.created_by
  where a.publish_at<=now() and creator.role='admin'
    and ((p_role='staff' and a.audience='staff')
      or (p_role='customer' and a.audience in ('both','customers')))
  union all
  select n.key,n.title,n.body,n.category,n.published_at,
    case when n.category='maintenance' then '#court-schedule' else n.href end
  from internal.account_notice_events n
  where p_role='staff' and n.audience='staff'
    and n.category in ('maintenance','ending_soon')
  union all
  select 'activity:'||e.id::text,'Booking unattended',
    e.customer_name||' · '||coalesce(e.details->>'sport','Booking'),
    'unattended',e.created_at,'#booking-overview'::text
  from internal.customer_operational_events e
  where p_role='staff' and e.action='unattended'
  union all
  select n.key,n.title,n.body,'maintenance',n.published_at,n.href
  from internal.customer_maintenance_notices n
  join public.booking b on b.booking_id=n.booking_id and b.customer_id=n.customer_id
  where p_role='customer' and n.customer_id=p_user_id
    and b.status='confirmed' and b.time_date>now()
  union all
  select 'booking-reminder:'||r.booking_id::text,
    'Upcoming booking in less than 5 hours',
    coalesce(b.sports,'Sport')||' · '||coalesce(b.courts,'Court')||' · '||
      to_char(b.time_date at time zone 'Asia/Manila','Mon DD, YYYY HH12:MI AM')||
      case when coalesce(b.amount_total,0)>coalesce(b.amount_paid,0)
        then ' · Balance due at check-in: PHP '||to_char(
          greatest(coalesce(b.amount_total,0)-coalesce(b.amount_paid,0),0),'FM999,999,990.00')
        else '' end,
    'booking_reminder',r.created_at,'#bookings'::text
  from internal.customer_booking_reminders r
  join public.booking b on b.booking_id=r.booking_id and b.customer_id=r.customer_id
  where p_role='customer' and r.customer_id=p_user_id
    and b.status='confirmed' and b.time_date>now()
$$;
revoke all on function internal.notification_feed(uuid,text) from public,anon,authenticated;

-- Capture persistent staff alerts on the existing one-minute cron. Primary
-- key notification keys make retries idempotent and preserve per-user read state.
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
    'maintenance','staff',now(),'#court-schedule'
  from public.court_unit_maintenance m
  join public.court_unit_inventory u on u.id=m.court_unit_id
  join public.court c on c.id=u.court_id
  where m.ends_at>baseline and m.ends_at>now() and m.publish_at<=now()
  on conflict(key) do nothing;
  get diagnostics inserted_count = row_count;
  total_count:=total_count+inserted_count;

  insert into internal.customer_maintenance_notices(key,customer_id,booking_id,title,body,published_at,href)
  select 'booking-maintenance:'||m.id::text||':'||b.booking_id::text,
    b.customer_id,b.booking_id,
    'Maintenance affects your booking',
    coalesce(nullif(m.note,''),'Court maintenance is scheduled.')||' ('||c.name||' · '||u.label||') · '||
      coalesce(b.sports,'Sport')||' · '||to_char(b.time_date at time zone 'Asia/Manila','Mon DD, YYYY HH12:MI AM'),
    now(),'#bookings'
  from public.court_unit_maintenance m
  join public.court_unit_inventory u on u.id=m.court_unit_id
  join public.court c on c.id=u.court_id
  join public.booking b on b.court_unit_inventory_id=m.court_unit_id
  where m.ends_at>baseline and m.ends_at>now() and m.publish_at<=now()
    and b.status='confirmed' and b.time_date>now()
    and b.time_date<m.ends_at and b.end_at>m.starts_at
  on conflict(key) do nothing;
  get diagnostics inserted_count = row_count;
  total_count:=total_count+inserted_count;

  insert into internal.account_notice_events(key,title,body,category,audience,published_at,href)
  select 'ending-soon:booking:'||b.booking_id::text,'Booking ending soon',
    coalesce(nullif(btrim(p.full_name),''),p.email,'Customer')||' · '||
      coalesce(b.sports,'Sport')||' · '||coalesce(b.courts,'Court')||' · ends at '||
      to_char(b.end_at at time zone 'Asia/Manila','Mon DD, YYYY HH12:MI AM'),
    'ending_soon','staff',now(),'#booking-overview'
  from public.booking b left join public.profiles p on p.id=b.customer_id
  where b.status='confirmed' and b.checked_in_at is not null and b.checked_out_at is null
    and b.end_at>now() and b.end_at<=now()+interval '10 minutes'
  on conflict(key) do nothing;
  get diagnostics inserted_count = row_count;
  total_count:=total_count+inserted_count;

  insert into internal.account_notice_events(key,title,body,category,audience,published_at,href)
  select 'ending-soon:walkin:'||w.walkin_id::text,'Walk-in ending soon',
    coalesce(nullif(btrim(w.customer_name),''),'Guest')||' · '||
      coalesce(w.sports,'Sport')||' · '||coalesce(w.courts,'Court')||' · ends at '||
      to_char(w.end_at at time zone 'Asia/Manila','Mon DD, YYYY HH12:MI AM'),
    'ending_soon','staff',now(),'#booking-overview'
  from public.walk_in_booking w
  where w.status='confirmed' and w.checked_in_at is not null and w.checked_out_at is null
    and w.end_at>now() and w.end_at<=now()+interval '10 minutes'
  on conflict(key) do nothing;
  get diagnostics inserted_count = row_count;
  return total_count+inserted_count;
end;
$$;
revoke all on function internal.capture_due_account_notices() from public,anon,authenticated;
