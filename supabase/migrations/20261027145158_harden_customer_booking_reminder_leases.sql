-- Keep sequential SMTP delivery within the claim lease and renew ownership
-- atomically when each item is refreshed immediately before send.
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

-- Revalidate the current booking/email/balance and renew this claim under the
-- same token, so a later serial send cannot be reclaimed based on the batch's
-- original timestamp.
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

-- The endpoint URL is per-environment configuration in Vault; never hard-code
-- a project's ref in a portable migration. Skip missing or malformed config.
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
  from vault.decrypted_secrets v
  where v.name='customer_booking_reminder_cron_secret' limit 1;
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
