-- Staff notifications contain published admin announcements addressed to
-- staff and staff-only court maintenance notices. Customers never receive
-- maintenance notices, including notices captured by an earlier migration.
update internal.account_notice_events
set audience='staff'
where category='maintenance' and audience is distinct from 'staff';

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
  return total_count+inserted_count;
end;
$$;
revoke all on function internal.capture_due_account_notices() from public,anon,authenticated;

create or replace function internal.notification_feed(p_user_id uuid,p_role text)
returns table(key text,title text,body text,category text,created_at timestamptz,href text)
language sql stable security definer set search_path = '' as $$
  select 'announcement:'||a.id::text,a.title,a.body,'announcement',a.publish_at,
    '#notifications'::text
  from internal.app_announcements a
  join public.profiles creator on creator.id=a.created_by
  where a.publish_at<=now()
    and ((p_role='staff' and a.audience='staff' and creator.role='admin')
      or (p_role='customer' and a.audience in ('both','customers')))
  union all
  select n.key,n.title,n.body,n.category,n.published_at,
    case when n.category='maintenance' then '#court-schedule'
      when n.category='arrival' then '#overview'
      else n.href end
  from internal.account_notice_events n
  where (p_role='staff' and n.category='maintenance' and n.audience='staff')
    or (p_role='customer' and n.category<>'maintenance' and n.audience in ('both','customers'))
  union all
  select 'activity:'||e.id::text,
    case e.action when 'booking_created' then 'New booking' when 'walkin_created' then 'Walk-in created'
      when 'payment_recorded' then 'Payment recorded' when 'time_in' then 'Customer arrived'
      when 'time_out' then 'Customer exited' when 'unattended' then 'Booking unattended' else 'Customer activity' end,
    e.customer_name||' · '||coalesce(e.details->>'sport','Booking'),e.action,e.created_at,
    '#bookings'::text
  from internal.customer_operational_events e
  where p_role='customer'
    and e.action in ('booking_created','walkin_created','payment_recorded','time_in','time_out','unattended')
    and e.customer_id=p_user_id;
$$;
revoke all on function internal.notification_feed(uuid,text) from public,anon,authenticated;
