-- Route actionable staff booking notifications to matching transaction rows,
-- and include shared announcements in both account feeds.
-- The target ID is an existing booking ID, so notifications and read records
-- keep their current keys and no persisted notification rows need conversion.
create or replace function internal.notification_feed(p_user_id uuid,p_role text)
returns table(key text,title text,body text,category text,created_at timestamptz,href text)
language sql stable security definer set search_path = '' as $$
  select 'announcement:'||a.id::text,a.title,a.body,'announcement',a.publish_at,
    '#notifications'::text
  from internal.app_announcements a
  join public.profiles creator on creator.id=a.created_by
  where a.publish_at<=now() and creator.role='admin'
    and ((p_role='staff' and a.audience in ('both','staff'))
      or (p_role='customer' and a.audience in ('both','customers')))
  union all
  select n.key,n.title,n.body,n.category,n.published_at,
    case
      when n.category='maintenance' then '#court-schedule'
      when n.category='ending_soon' and n.key like 'ending-soon:%:%'
        then '#transactions?view=transactions&search='||split_part(n.key,':',3)
      else n.href
    end
  from internal.account_notice_events n
  where p_role='staff' and n.audience='staff'
    and n.category in ('maintenance','ending_soon')
  union all
  select 'activity:'||e.id::text,'Booking unattended',
    e.customer_name||' · '||coalesce(e.details->>'sport','Booking'),
    'unattended',e.created_at,
    case when e.source in ('booking','walkin') and nullif(e.source_id,'') is not null
      then '#transactions?view=unattended&search='||e.source_id
      else '#transactions?view=unattended'
    end
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
