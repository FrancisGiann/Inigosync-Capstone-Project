-- Unattended attendance classification applies only to customer bookings.
-- A paid staff walk-in is automatically checked in at payment; other walk-in
-- states must not be reported or stored as unattended visits.
create or replace function internal.cancel_no_show_bookings()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);

  with changed as (
    update public.booking b
    set status = 'unattended',
        auto_cancelled_at = now()
    where b.no_show_policy_applies
      and b.status in ('pending', 'confirmed')
      and b.checked_in_at is null
      and b.time_date + make_interval(mins => coalesce((
        select r.grace_minutes
        from internal.booking_rule_for_date((b.time_date at time zone 'Asia/Manila')::date) r
      ), 30)) < now()
      and not exists (
        select 1
        from internal.paymongo_checkout_attempts a
        where ((a.booking_id = b.booking_id)
            or (a.balance_source = 'booking' and a.balance_id = b.booking_id))
          and a.status in ('creating', 'ready', 'review')
          and a.paymongo_payment_id is null
      )
    returning b.booking_id, b.customer_id, b.time_date, b.end_at
  )
  insert into public.audit_log(actor_role, action, entity_type, entity_id, details)
  select 'system', 'marked_unattended', 'booking', booking_id::text,
    jsonb_build_object('customer_id', customer_id, 'starts_at', time_date,
      'scheduled_end_at', end_at)
  from changed;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function internal.cancel_no_show_bookings() from public, anon, authenticated;
