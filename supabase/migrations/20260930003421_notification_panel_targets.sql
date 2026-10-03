-- Keep published notice destinations valid in each portal. The same
-- maintenance notice appears to staff and customers, but their panels differ.
create or replace function internal.notification_feed(p_user_id uuid,p_role text)
returns table(key text,title text,body text,category text,created_at timestamptz,href text)
language sql stable security definer set search_path = '' as $$
  select 'announcement:'||a.id::text,a.title,a.body,'announcement',a.publish_at,
    '#notifications'::text
  from internal.app_announcements a
  where a.publish_at<=now() and (a.audience='both' or a.audience=case when p_role='staff' then 'staff' else 'customers' end)
  union all
  select n.key,n.title,n.body,n.category,n.published_at,
    case when n.category='maintenance' then
      case when p_role='staff' then '#schedule' else '#overview' end
      when n.category='arrival' then '#overview'
      else n.href end
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
