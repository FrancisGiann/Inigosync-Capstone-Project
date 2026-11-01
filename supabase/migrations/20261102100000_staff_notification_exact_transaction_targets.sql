-- Resolve global ending-soon alerts to the requesting staff member's own
-- visible time-in transaction. Keep unattended alerts keyed by visit ID.
-- No notification or read-state records are rewritten by this function change.
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
        then coalesce((
          select '#transactions?view=transactions&transaction_id='||a.id::text
          from public.audit_log a
          left join public.booking b
            on a.entity_type='booking' and b.booking_id::text=a.entity_id
          left join public.walk_in_booking w
            on a.entity_type='walkin' and w.walkin_id::text=a.entity_id
          where a.actor_id=p_user_id
            and a.entity_type=split_part(n.key,':',2)
            and a.entity_type in ('booking','walkin')
            and a.entity_id=split_part(n.key,':',3)
            and (a.action='timed_in'
              or (a.action='collected_online_balance' and a.details->>'time_in_recorded'='true'))
            and ((a.entity_type='booking' and b.checked_in_at is not null)
              or (a.entity_type='walkin' and w.checked_in_at is not null))
          order by a.created_at desc,a.id desc
          limit 1
        ),'#transactions?view=transactions&no_transaction=1')
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
      then '#transactions?view=unattended&visit_id='||e.source_id
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
