-- A staff walk-in order is an arrival as soon as its full payment is
-- authoritative. Cash orders are already paid when their reservations are
-- inserted; PayMongo orders are marked paid immediately before their pending
-- reservations are confirmed by record_paymongo_paid().
create or replace function internal.auto_time_in_paid_staff_walkin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.walkin_order_id is not null
      and new.checked_in_at is null
      and new.status = 'confirmed'
      and (tg_op = 'INSERT' or old.status is distinct from 'confirmed')
      and new.amount_total is not null
      and new.amount_paid >= new.amount_total
      and new.payment_id is not null
      and new.payment_method in ('Cash', 'PayMongo')
      and exists (
        select 1 from internal.staff_walkin_orders o
        where o.id = new.walkin_order_id and o.status = 'paid'
      ) then
    new.checked_in_at := now();
  end if;
  return new;
end;
$$;

revoke all on function internal.auto_time_in_paid_staff_walkin() from public, anon, authenticated;
drop trigger if exists zzzzzz_walkin_auto_time_in_paid_order on public.walk_in_booking;
-- PostgreSQL runs same-kind triggers alphabetically. Keep this after
-- zz_walkin_authoritative_amount and the zzzz*/zzzzz* guards so it validates
-- the final server-priced row values.
create trigger zzzzzz_walkin_auto_time_in_paid_order
  before insert or update on public.walk_in_booking
  for each row execute function internal.auto_time_in_paid_staff_walkin();

create or replace function internal.audit_auto_time_in_paid_staff_walkin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff_id uuid;
  v_staff_role text;
begin
  if new.walkin_order_id is null or new.checked_in_at is null
      or (tg_op = 'UPDATE' and (old.checked_in_at is not null or old.status = 'confirmed'))
      or new.payment_id is null then
    return new;
  end if;

  select o.staff_id into v_staff_id
    from internal.staff_walkin_orders o
    where o.id = new.walkin_order_id and o.status = 'paid';
  if v_staff_id is null then return new; end if;

  select p.role into v_staff_role from public.profiles p where p.id = v_staff_id;
  insert into public.audit_log(actor_id, actor_role, action, entity_type, entity_id, details)
  values (
    v_staff_id,
    coalesce(v_staff_role, 'staff'),
    'timed_in',
    'walkin',
    new.walkin_id::text,
    jsonb_build_object(
      'payment_id', new.payment_id,
      'cash_collected', case when new.payment_method = 'Cash' then new.amount_total else 0 end,
      'checked_in_at', new.checked_in_at,
      'automatic_time_in', true,
      'scheduled_end_at', new.end_at
    )
  );
  return new;
end;
$$;

revoke all on function internal.audit_auto_time_in_paid_staff_walkin() from public, anon, authenticated;
drop trigger if exists zzzzzzzz_walkin_audit_auto_time_in_paid_order on public.walk_in_booking;
-- Keep the audit event after the existing walk-in audit triggers, so it is
-- the latest attributed event for this automatically checked-in visit.
create trigger zzzzzzzz_walkin_audit_auto_time_in_paid_order
  after insert or update on public.walk_in_booking
  for each row execute function internal.audit_auto_time_in_paid_staff_walkin();

-- Historical rows are backfilled only when an order, payment, receipt, and staff audit trail
-- establish the paid walk-in.


-- Paid walk-ins are time-ins, never unattended visits. Payment timestamps are the authoritative
-- check-in time. The original scheduled end is used only for already-finished slots.
update public.walk_in_booking w
set checked_in_at = p.created_at,
    checked_out_at = case when w.end_at <= now() then w.end_at else null end,
    status = case when w.end_at <= now() then 'completed' else 'confirmed' end
from internal.staff_walkin_orders o
join public.payment p on p.payment_id = o.payment_id
join internal.payment_acknowledgments ack on ack.payment_id = p.payment_id
where o.id = w.walkin_order_id
  and o.status = 'paid'
  and w.status in ('confirmed', 'unattended')
  and w.checked_in_at is null
  and w.checked_out_at is null
  and w.payment_id = o.payment_id
  and w.payment_method in ('Cash', 'PayMongo')
  and w.amount_total is not null and w.amount_total > 0
  and w.amount_paid >= w.amount_total
  and p.paid >= p.cost and p.paid > 0
  and exists (
    select 1 from public.audit_log a
    where a.entity_type = 'walkin' and a.entity_id = w.walkin_id::text
      and a.action = 'recorded_walk_in' and a.actor_id = o.staff_id
  )
  and (w.status = 'confirmed' or exists (
    select 1 from public.audit_log a
    where a.entity_type = 'walkin' and a.entity_id = w.walkin_id::text
      and a.action = 'marked_unattended' and a.actor_id is null
  ));

-- The automatic AFTER trigger audits conversions from unattended rows. Existing confirmed rows
-- are backfilled directly, so add the equivalent attributed event for those rows explicitly.
insert into public.audit_log(actor_id, actor_role, action, entity_type, entity_id, details)
select o.staff_id, coalesce(pf.role, 'staff'), 'timed_in', 'walkin', w.walkin_id::text,
  jsonb_build_object('payment_id', w.payment_id,
    'cash_collected', case when w.payment_method = 'Cash' then w.amount_total else 0 end,
    'checked_in_at', w.checked_in_at, 'automatic_time_in', true,
    'scheduled_end_at', w.end_at)
from public.walk_in_booking w
join internal.staff_walkin_orders o on o.id = w.walkin_order_id and o.status = 'paid'
join public.payment p on p.payment_id = o.payment_id
left join public.profiles pf on pf.id = o.staff_id
where w.checked_in_at = p.created_at
  and w.payment_id = o.payment_id
  and not exists (
    select 1 from public.audit_log a
    where a.entity_type = 'walkin' and a.entity_id = w.walkin_id::text
      and a.action = 'timed_in'
  );

-- Preserve the receipt RPC authorization contract. This version retains receipt context
-- but removes walk-in rows from the unattended union; booking no-shows remain visible.

-- Show one staff time-in event per row, including visits still in progress.
-- The event UUID is the transaction ID, including zero-collection events.
-- Only customer bookings can be unattended; paid staff walk-ins time in automatically.
create or replace function public.staff_get_involved_transactions()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_result jsonb;
begin
  if v_actor is null or not exists (
    select 1 from public.profiles p
    where p.id = v_actor and p.role = 'staff' and p.status = 'active'
  ) then
    raise exception 'Active staff access is required' using errcode = '42501';
  end if;

  with staff_timeins as (
    select distinct on (a.entity_type, a.entity_id)
      a.id as transaction_id,
      case when a.entity_type = 'booking' then b.booking_id else w.walkin_id end as visit_id,
      a.created_at,
      case when a.entity_type = 'booking' then b.time_date else w.time_date end as visit_starts_at,
      case when a.entity_type = 'booking' then b.checked_in_at else w.checked_in_at end as checked_in_at,
      case when a.entity_type = 'booking' then b.checked_out_at else w.checked_out_at end as checked_out_at,
      a.entity_type as source,
      case when a.entity_type = 'booking'
        then coalesce(nullif(pg_catalog.btrim(profile.full_name), ''), profile.email, 'Customer')
        else coalesce(nullif(pg_catalog.btrim(profile.full_name), ''), nullif(pg_catalog.btrim(w.customer_name), ''), 'Guest')
      end as customer_name,
      case when a.entity_type = 'booking' then b.sports else w.sports end as visit_sport,
      case when a.entity_type = 'booking' then b.courts else w.courts end as visit_court,
      case when a.entity_type = 'booking' then b.court_unit else w.court_unit end as visit_unit,
      case when a.entity_type = 'booking' then b.end_at else w.end_at end as visit_ends_at,
      case when a.entity_type = 'booking' then b.duration_minutes else w.duration_minutes end as visit_duration_minutes,
      case when a.entity_type = 'booking'
        then case when b.amount_total > 0 and (b.rate_unit_snapshot is not null or b.payment_id is not null or b.amount_paid > 0)
          then round(b.amount_total * 100)::bigint end
        else case when w.amount_total > 0 and (w.rate_unit_snapshot is not null or w.payment_id is not null or w.amount_paid > 0)
          then round(w.amount_total * 100)::bigint end
      end as booking_total_minor,
      coalesce(nullif(a.details->>'cash_collected', '')::numeric,
        nullif(a.details->>'base_minor', '')::numeric / 100, 0) as amount_collected,
      coalesce(case when a.entity_type = 'booking'
        then b.amount_total > 0 and b.amount_paid >= b.amount_total
        else w.amount_total > 0 and w.amount_paid >= w.amount_total
      end, false) as fully_paid,
      nullif(a.details->>'payment_id', '')::bigint as payment_id
    from public.audit_log a
    left join public.booking b
      on a.entity_type = 'booking' and b.booking_id::text = a.entity_id
    left join public.walk_in_booking w
      on a.entity_type = 'walkin' and w.walkin_id::text = a.entity_id
    left join public.profiles profile
      on profile.id = case when a.entity_type = 'booking' then b.customer_id else w.customer_id end
    where a.actor_id = v_actor
      and a.entity_type in ('booking', 'walkin')
      and (
        a.action = 'timed_in'
        or (a.action = 'collected_online_balance' and a.details->>'time_in_recorded' = 'true')
      )
      and ((a.entity_type = 'booking' and b.checked_in_at is not null)
        or (a.entity_type = 'walkin' and w.checked_in_at is not null))
    order by a.entity_type, a.entity_id, a.created_at desc, a.id desc
  ), unattended_visits as (
    select
      null::uuid as transaction_id,
      b.booking_id as visit_id,
      coalesce(b.auto_cancelled_at, b.created_at) as created_at,
      b.time_date as visit_starts_at,
      b.checked_in_at,
      b.checked_out_at,
      'booking'::text as source,
      coalesce(nullif(pg_catalog.btrim(profile.full_name), ''), profile.email, 'Customer') as customer_name,
      b.sports as visit_sport,
      b.courts as visit_court,
      b.court_unit as visit_unit,
      b.end_at as visit_ends_at,
      b.duration_minutes as visit_duration_minutes,
      case when b.amount_total > 0 and (b.rate_unit_snapshot is not null or b.payment_id is not null or b.amount_paid > 0)
        then round(b.amount_total * 100)::bigint end as booking_total_minor,
      null::numeric as amount_collected,
      false as fully_paid,
      null::bigint as payment_id
    from public.booking b
    left join public.profiles profile on profile.id = b.customer_id
    where b.status = 'unattended' and b.checked_in_at is null

  ), visits as (
    select * from staff_timeins
    union all
    select * from unattended_visits
  )
  select jsonb_build_object(
    'schema_version', 'visit_transactions_v1',
    'transactions', coalesce(jsonb_agg(jsonb_build_object(
      'transaction_id', visits.transaction_id,
      'visit_id', visits.visit_id,
      'created_at', visits.created_at,
      'source', visits.source,
      'customer_name', visits.customer_name,
      'checked_in_at', visits.checked_in_at,
      'checked_out_at', visits.checked_out_at,
      'status', case when visits.transaction_id is null then 'unattended'
        when visits.checked_out_at is null then 'in_progress'
        else 'completed' end,
      'amount_minor', case when visits.amount_collected is null then null else round(visits.amount_collected * 100)::bigint end,
      'fully_paid', visits.fully_paid,
      'booking_total_minor', visits.booking_total_minor,
      'payment_id', visits.payment_id,
      'visits', jsonb_build_array(jsonb_build_object(
        'starts_at', visits.visit_starts_at,
        'ends_at', visits.visit_ends_at,
        'sport', visits.visit_sport,
        'court', visits.visit_court,
        'unit', visits.visit_unit,
        'duration_minutes', visits.visit_duration_minutes
      )),
      'acknowledgment', ack.payload
    ) order by visits.created_at desc nulls last, visits.visit_id desc), '[]'::jsonb)
  ) into v_result
  from visits
  left join internal.payment_acknowledgments ack on ack.payment_id = visits.payment_id;

  return coalesce(v_result, jsonb_build_object(
    'schema_version', 'visit_transactions_v1',
    'transactions', '[]'::jsonb
  ));
end;
$$;

revoke all on function public.staff_get_involved_transactions() from public, anon;
grant execute on function public.staff_get_involved_transactions() to authenticated;
