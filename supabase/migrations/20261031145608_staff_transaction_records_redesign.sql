-- Show one staff time-in event per row, including visits still in progress.
-- The event UUID is the transaction ID, including zero-collection events.
-- Unattended visits have no staff transaction ID or payment receipt.
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

    union all

    select
      null::uuid as transaction_id,
      w.walkin_id as visit_id,
      coalesce(w.auto_cancelled_at, w.created_at) as created_at,
      w.time_date as visit_starts_at,
      w.checked_in_at,
      w.checked_out_at,
      'walkin'::text as source,
      coalesce(nullif(pg_catalog.btrim(profile.full_name), ''), nullif(pg_catalog.btrim(w.customer_name), ''), 'Guest') as customer_name,
      w.sports as visit_sport,
      w.courts as visit_court,
      w.court_unit as visit_unit,
      w.end_at as visit_ends_at,
      w.duration_minutes as visit_duration_minutes,
      case when w.amount_total > 0 and (w.rate_unit_snapshot is not null or w.payment_id is not null or w.amount_paid > 0)
        then round(w.amount_total * 100)::bigint end as booking_total_minor,
      null::numeric as amount_collected,
      false as fully_paid,
      null::bigint as payment_id
    from public.walk_in_booking w
    left join public.profiles profile on profile.id = w.customer_id
    where w.status = 'unattended' and w.checked_in_at is null
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
