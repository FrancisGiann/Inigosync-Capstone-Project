-- Customer notifications are limited to published admin announcements,
-- maintenance notices relevant to an existing booking, and confirmed booking
-- reminders. Reminder email work is claimed and retried by a service-only RPC.

create table if not exists internal.customer_booking_reminders (
  booking_id bigint primary key references public.booking(booking_id) on delete cascade,
  customer_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  email_sent_at timestamptz,
  email_claimed_at timestamptz,
  email_claim_token uuid,
  email_snapshot jsonb,
  email_attempts integer not null default 0 check(email_attempts >= 0),
  constraint customer_booking_reminders_claim_pair check
    ((email_claimed_at is null) = (email_claim_token is null))
);
create index if not exists customer_booking_reminders_pending_idx
  on internal.customer_booking_reminders(email_sent_at, email_claimed_at, created_at)
  where email_sent_at is null;
alter table internal.customer_booking_reminders enable row level security;
revoke all on internal.customer_booking_reminders from public, anon, authenticated;

create table if not exists internal.customer_maintenance_notices (
  key text primary key check(length(key) between 1 and 128),
  customer_id uuid not null references public.profiles(id) on delete cascade,
  booking_id bigint not null references public.booking(booking_id) on delete cascade,
  title text not null,
  body text not null,
  published_at timestamptz not null default now(),
  href text not null default '#bookings'
);
create index if not exists customer_maintenance_notices_owner_idx
  on internal.customer_maintenance_notices(customer_id,published_at desc);
alter table internal.customer_maintenance_notices enable row level security;
revoke all on internal.customer_maintenance_notices from public,anon,authenticated;

-- Replace the old broad customer activity feed with the three supported
-- customer-facing notification classes. Operational activity remains private.
create or replace function internal.notification_feed(p_user_id uuid,p_role text)
returns table(key text,title text,body text,category text,created_at timestamptz,href text)
language sql stable security definer set search_path = '' as $$
  select 'announcement:'||a.id::text,a.title,a.body,'announcement',a.publish_at,
    '#notifications'::text
  from internal.app_announcements a
  join public.profiles creator on creator.id=a.created_by
  where a.publish_at<=now()
    and ((p_role='staff' and a.audience='staff' and creator.role='admin')
      or (p_role='customer' and a.audience in ('both','customers') and creator.role='admin'))
  union all
  select n.key,n.title,n.body,n.category,n.published_at,
    case when n.category='maintenance' then '#bookings'
      when n.category='arrival' then '#overview'
      else n.href end
  from internal.account_notice_events n
  where (p_role='staff' and n.category='maintenance' and n.audience='staff')
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

-- Publish a maintenance notification only to customers whose confirmed online
-- booking overlaps the maintained court unit. Global maintenance details stay
-- staff-only and no other customers can see the scoped notice.
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
  return total_count+inserted_count;
end;
$$;
revoke all on function internal.capture_due_account_notices() from public,anon,authenticated;

-- Create reminder rows and atomically claim unsent email work. The strict upper
-- bound is intentional: at exactly five hours remaining, a reminder is not
-- due. A late scheduler invocation is still accepted until the booking starts.
create or replace function public.claim_customer_booking_reminders()
returns table(booking_id bigint,customer_id uuid,email text,sport text,court text,
  starts_at timestamptz,amount_due numeric,claim_token uuid)
language plpgsql security definer set search_path = '' as $$
begin
  insert into internal.customer_booking_reminders(booking_id,customer_id)
  select b.booking_id,b.customer_id
  from public.booking b
  join public.profiles p on p.id=b.customer_id and p.role='customer' and p.status='active'
  where b.status='confirmed' and b.time_date>now()
    and b.time_date<now()+interval '5 hours'
  on conflict do nothing;

  return query
  with claimable as (
    select r.booking_id
    from internal.customer_booking_reminders r
    join public.booking b on b.booking_id=r.booking_id and b.customer_id=r.customer_id
    join public.profiles p on p.id=r.customer_id and p.role='customer' and p.status='active'
    where r.email_sent_at is null
      and (r.email_claimed_at is null or r.email_claimed_at<now()-interval '5 minutes')
      and b.status='confirmed' and b.time_date>now()
      and b.time_date<now()+interval '5 hours'
      and nullif(btrim(p.email),'') is not null
    order by b.time_date,r.booking_id
    limit 5
    for update of r skip locked
  ), claimed as (
    update internal.customer_booking_reminders r
    set email_claimed_at=now(),email_claim_token=gen_random_uuid(),email_attempts=r.email_attempts+1,
      email_snapshot=jsonb_build_object(
        'email',p.email,'sport',b.sports,'court',b.courts,'starts_at',b.time_date,
        'amount_due',greatest(coalesce(b.amount_total,0)-coalesce(b.amount_paid,0),0))
    from claimable c
    join public.booking b on b.booking_id=c.booking_id
    join public.profiles p on p.id=b.customer_id
    where r.booking_id=c.booking_id
    returning r.booking_id,r.customer_id,r.email_claim_token,r.email_snapshot
  )
  select b.booking_id,b.customer_id,c.email_snapshot->>'email',c.email_snapshot->>'sport',
    c.email_snapshot->>'court',(c.email_snapshot->>'starts_at')::timestamptz,
    (c.email_snapshot->>'amount_due')::numeric,c.email_claim_token
  from claimed c
  join public.booking b on b.booking_id=c.booking_id and b.customer_id=c.customer_id
  join public.profiles p on p.id=c.customer_id
  where b.status='confirmed' and b.time_date>now();
end;
$$;
revoke all on function public.claim_customer_booking_reminders() from public,anon,authenticated;
grant execute on function public.claim_customer_booking_reminders() to service_role;

-- Refresh delivery data as the last database operation before sending. This
-- prevents queued work from using a cancelled or rescheduled booking, and picks
-- up the customer's current Auth-synchronized profile email and current balance.
-- Refresh the lease as well as the message snapshot immediately before sending.
-- SMTP does not provide a provider idempotency key, so an accepted message
-- followed by a lost completion update can be delivered again on retry.
create or replace function public.refresh_customer_booking_reminder(p_booking_id bigint,p_claim_token uuid)
returns table(email text,sport text,court text,starts_at timestamptz,amount_due numeric)
language plpgsql security definer set search_path = '' as $$
begin
  return query
  update internal.customer_booking_reminders r
  set email_claimed_at=now(),email_snapshot=jsonb_build_object(
    'email',p.email,'sport',b.sports,'court',b.courts,'starts_at',b.time_date,
    'amount_due',greatest(coalesce(b.amount_total,0)-coalesce(b.amount_paid,0),0))
  from public.booking b
  join public.profiles p on p.id=b.customer_id and p.role='customer' and p.status='active'
  where r.booking_id=p_booking_id and r.email_claim_token=p_claim_token and r.email_sent_at is null
    and b.booking_id=r.booking_id and b.customer_id=r.customer_id
    and b.status='confirmed' and b.time_date>now()
    and b.time_date<now()+interval '5 hours'
    and nullif(btrim(p.email),'') is not null
  returning r.email_snapshot->>'email',r.email_snapshot->>'sport',r.email_snapshot->>'court',
    (r.email_snapshot->>'starts_at')::timestamptz,(r.email_snapshot->>'amount_due')::numeric;
end;
$$;
revoke all on function public.refresh_customer_booking_reminder(bigint,uuid) from public,anon,authenticated;
grant execute on function public.refresh_customer_booking_reminder(bigint,uuid) to service_role;

create or replace function public.complete_customer_booking_reminder(p_booking_id bigint,p_claim_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare affected integer;
begin
  update internal.customer_booking_reminders
  set email_sent_at=now(),email_claimed_at=null,email_claim_token=null
  where booking_id=p_booking_id and email_claim_token=p_claim_token and email_sent_at is null;
  get diagnostics affected = row_count;
  return affected=1;
end;
$$;
revoke all on function public.complete_customer_booking_reminder(bigint,uuid) from public,anon,authenticated;
grant execute on function public.complete_customer_booking_reminder(bigint,uuid) to service_role;

create or replace function public.release_customer_booking_reminder(p_booking_id bigint,p_claim_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare affected integer;
begin
  update internal.customer_booking_reminders
  set email_claimed_at=null,email_claim_token=null
  where booking_id=p_booking_id and email_claim_token=p_claim_token and email_sent_at is null;
  get diagnostics affected = row_count;
  return affected=1;
end;
$$;
revoke all on function public.release_customer_booking_reminder(bigint,uuid) from public,anon,authenticated;
grant execute on function public.release_customer_booking_reminder(bigint,uuid) to service_role;

select vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),
  'customer_booking_reminder_cron_secret','Customer booking reminder worker authentication')
where not exists(select 1 from vault.secrets where name='customer_booking_reminder_cron_secret');
-- The scheduled SQL invocation forwards this generated secret to the worker;
-- do not place it in a public client or write it to logs.
-- Set customer_booking_reminder_function_url in Vault per environment to the
-- HTTPS Edge Function URL before the scheduled worker is expected to run.
-- Configure CUSTOMER_BOOKING_SMTP_USERNAME and
-- CUSTOMER_BOOKING_SMTP_APP_PASSWORD as Edge Function secrets. From defaults
-- to the SMTP username; optional sender and dashboard overrides are
-- CUSTOMER_BOOKING_REMINDER_FROM_EMAIL and CUSTOMER_BOOKING_DASHBOARD_URL.

create or replace function public.verify_customer_booking_reminder_worker(p_token text)
returns boolean language sql security definer set search_path = '' as $$
  select p_token is not null and length(p_token)=64 and exists(
    select 1 from vault.decrypted_secrets v
    where v.name='customer_booking_reminder_cron_secret'
      and extensions.digest(v.decrypted_secret,'sha256')=extensions.digest(p_token,'sha256')
  )
$$;
revoke all on function public.verify_customer_booking_reminder_worker(text) from public,anon,authenticated;
grant execute on function public.verify_customer_booking_reminder_worker(text) to service_role;

create extension if not exists pg_net with schema extensions;
create or replace function internal.invoke_customer_booking_reminder_worker()
returns void language plpgsql security definer set search_path = '' as $$
declare
  worker_secret text;
  function_url text;
begin
  select v.decrypted_secret into function_url
  from vault.decrypted_secrets v
  where v.name='customer_booking_reminder_function_url' limit 1;
  select v.decrypted_secret into worker_secret
  from vault.decrypted_secrets v where v.name='customer_booking_reminder_cron_secret' limit 1;
  if worker_secret is null or function_url is null
    or function_url !~* '^https://[a-z0-9-]+\.supabase\.co/functions/v1/customer-booking-reminders$' then
    return;
  end if;
  perform net.http_post(
    url := function_url,
    headers := pg_catalog.jsonb_build_object(
      'Content-Type','application/json','x-customer-booking-reminder-secret',worker_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
end;
$$;
revoke all on function internal.invoke_customer_booking_reminder_worker() from public,anon,authenticated;
select cron.schedule('customer-booking-reminders','* * * * *',
  'select internal.invoke_customer_booking_reminder_worker()');
