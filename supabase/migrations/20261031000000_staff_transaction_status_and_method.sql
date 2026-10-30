-- Forward migration: include the current booking/visit outcome and the
-- persisted payments from unattended bookings even when no staff action
-- created an attribution event (for example, an online down-payment deposit).
-- Return payment records the signed-in staff member handled, plus persisted
-- payments on bookings now marked unattended. Non-unattended booking payments
-- still require payment-specific staff attribution. One payment (including a
-- separate balance payment) produces one row.
create or replace function public.staff_get_involved_transactions()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_payments jsonb;
  v_result jsonb;
  r record;
begin
  if v_actor is null or not exists (
    select 1 from public.profiles p
    where p.id = v_actor and p.role = 'staff' and p.status = 'active'
  ) then
    raise exception 'Active staff access is required' using errcode = '42501';
  end if;

  with payment_contexts as (
    select p.payment_id, p.created_at, p.payment_method, p.base_minor, p.gross_minor,
      case
        when b.status = 'unattended' then 'unattended'
        when b.status = 'cancelled' then 'cancelled'
        when b.status = 'completed' then 'completed'
        when b.checked_in_at is not null then 'attended'
        else 'booked'
      end::text as visit_status,
      jsonb_build_array(jsonb_build_object('starts_at', b.time_date, 'ends_at', b.end_at)) as visits,
      'booking'::text as source,
      coalesce(nullif(btrim(profile.full_name), ''), profile.email, 'Customer') as customer_name,
      b.sports, b.courts, b.court_unit as unit,
      'booking'::text as context_type, b.booking_id as context_id, null::uuid as order_id
    from public.booking b
    join public.payment p on p.payment_id in (b.payment_id, b.balance_payment_id)
    left join public.profiles profile on profile.id = b.customer_id

    union all

    select p.payment_id, p.created_at, p.payment_method, p.base_minor, p.gross_minor,
      case
        when w.status = 'unattended' then 'unattended'
        when w.status = 'cancelled' then 'cancelled'
        when w.status = 'completed' then 'completed'
        when w.checked_in_at is not null then 'attended'
        else 'booked'
      end::text as visit_status,
      jsonb_build_array(jsonb_build_object('starts_at', w.time_date, 'ends_at', w.end_at)) as visits,
      'walkin'::text as source,
      coalesce(nullif(btrim(profile.full_name), ''), nullif(btrim(w.customer_name), ''), 'Guest') as customer_name,
      w.sports, w.courts, w.court_unit as unit,
      'walkin'::text as context_type, w.walkin_id as context_id, null::uuid as order_id
    from public.walk_in_booking w
    join public.payment p on p.payment_id = w.balance_payment_id
      or (w.walkin_order_id is null and p.payment_id = w.payment_id)
    left join public.profiles profile on profile.id = w.customer_id

    union all

    select p.payment_id, p.created_at, p.payment_method, p.base_minor, p.gross_minor,
      (select case
        when count(*) = 0 then 'unknown'
        when bool_and(w.status = 'unattended') then 'unattended'
        when bool_or(w.status = 'unattended') then 'partially_unattended'
        when bool_and(w.status = 'cancelled') then 'cancelled'
        when bool_and(w.status = 'completed') then 'completed'
        when bool_and(w.checked_in_at is not null) then 'attended'
        when bool_or(w.checked_in_at is not null) then 'mixed'
        else 'booked'
      end::text from public.walk_in_booking w where w.walkin_order_id = o.id) as visit_status,
      (select coalesce(jsonb_agg(jsonb_build_object('starts_at', v.starts_at, 'ends_at', v.ends_at)
        order by v.starts_at, v.ends_at), '[]'::jsonb)
       from (
         select distinct w.time_date as starts_at, w.end_at as ends_at
         from public.walk_in_booking w where w.walkin_order_id = o.id
       ) v) as visits,
      'walkin'::text as source,
      coalesce(nullif(btrim(profile.full_name), ''), nullif(btrim(o.guest_name), ''), 'Guest') as customer_name,
      (select string_agg(distinct w.sports, ', ' order by w.sports)
       from public.walk_in_booking w where w.walkin_order_id = o.id) as sports,
      (select string_agg(distinct w.courts, ', ' order by w.courts)
       from public.walk_in_booking w where w.walkin_order_id = o.id) as courts,
      (select string_agg(distinct nullif(w.court_unit, ''), ', ' order by nullif(w.court_unit, ''))
       from public.walk_in_booking w where w.walkin_order_id = o.id and nullif(w.court_unit, '') is not null) as unit,
      'walkin_order'::text as context_type, null::bigint as context_id, o.id as order_id
    from internal.staff_walkin_orders o
    join public.payment p on p.payment_id = o.payment_id
    left join public.profiles profile on profile.id = o.customer_id
  ), attributed as (
    select distinct on (pc.payment_id)
      pc.payment_id, pc.created_at, pc.payment_method, pc.base_minor, pc.gross_minor,
      pc.visit_status, pc.visits, pc.source, pc.customer_name, pc.sports, pc.courts, pc.unit,
      pc.context_type, pc.context_id, pc.order_id
    from payment_contexts pc
    where
      (pc.context_type = 'walkin' and exists (
        select 1 from public.walk_in_booking w
        where w.walkin_id = pc.context_id and w.staff_id = v_actor
          and w.walkin_order_id is null and w.payment_id = pc.payment_id
      ))
      or (pc.context_type = 'walkin_order' and exists (
        select 1 from internal.staff_walkin_orders o
        where o.id = pc.order_id and o.staff_id = v_actor and o.payment_id = pc.payment_id
      ))
      or (pc.context_type in ('booking', 'walkin') and pc.visit_status = 'unattended')
      or exists (
        select 1 from public.audit_log a
        where a.actor_id = v_actor
          and a.action in (
            'timed_in', 'collected_online_balance', 'late_online_balance_review',
            'created_walkin_order', 'collected_online_walkin'
          )
          and a.details->>'payment_id' = pc.payment_id::text
          and (
            (pc.context_type in ('booking', 'walkin')
              and a.entity_type = pc.context_type
              and a.entity_id = pc.context_id::text)
            or (pc.context_type = 'walkin_order'
              and a.entity_type = 'walkin_order'
              and a.entity_id = pc.order_id::text)
          )
      )
    order by pc.payment_id, pc.created_at desc, pc.context_type
  )
  select coalesce(jsonb_agg(to_jsonb(attributed)), '[]'::jsonb)
  into v_payments
  from attributed;

  -- Recreate historical acknowledgments only after the payment passed the
  -- inclusion checks above: staff attribution, or a persisted payment on an
  -- unattended reservation. This keeps receipt recovery within visible rows.
  for r in
    select x.payment_id, x.context_type, x.context_id, x.order_id
    from jsonb_to_recordset(v_payments) as x(
      payment_id bigint, context_type text, context_id bigint, order_id uuid
    )
    left join internal.payment_acknowledgments ack on ack.payment_id = x.payment_id
    where ack.payment_id is null
  loop
    begin
      if r.context_type = 'walkin_order' then
        perform internal.persist_payment_acknowledgment(r.payment_id, 'walkin_order', null, r.order_id);
      else
        perform internal.persist_payment_acknowledgment(r.payment_id, r.context_type, r.context_id, null);
      end if;
    exception when others then
      -- Keep the transaction visible; the client disables View when the
      -- receipt could not be reconstructed from a complete saved record.
      null;
    end;
  end loop;

  select jsonb_build_object(
    'transactions', coalesce(jsonb_agg(jsonb_build_object(
      'payment_id', x.payment_id,
      'created_at', x.created_at,
      'method', x.payment_method,
      'base_minor', x.base_minor,
      'gross_minor', x.gross_minor,
      'source', x.source,
      'status', x.visit_status,
      'visits', x.visits,
      'customer_name', x.customer_name,
      'sports', x.sports,
      'courts', x.courts,
      'unit', x.unit,
      'acknowledgment', ack.payload
    ) order by x.created_at desc, x.payment_id desc), '[]'::jsonb)
  ) into v_result
  from jsonb_to_recordset(v_payments) as x(
    payment_id bigint, created_at timestamptz, payment_method text, base_minor bigint,
    gross_minor bigint, visit_status text, visits jsonb, source text, customer_name text, sports text, courts text, unit text
  )
  left join internal.payment_acknowledgments ack on ack.payment_id = x.payment_id;

  return coalesce(v_result, jsonb_build_object('transactions', '[]'::jsonb));
end;
$$;

revoke all on function public.staff_get_involved_transactions() from public, anon;
grant execute on function public.staff_get_involved_transactions() to authenticated;

