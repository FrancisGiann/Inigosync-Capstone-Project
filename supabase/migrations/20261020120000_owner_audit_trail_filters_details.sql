-- Keep the owner audit RPC scoped to the requested filters and return a
-- curated, readable detail object without exposing source JSON or payment IDs.
create or replace function public.owner_audit_trail(
  p_search text default '',
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_category text default 'all',
  p_actor_id uuid default null,
  p_actor_role text default 'all',
  p_offset integer default 0,
  p_limit integer default 25
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if (select auth.uid()) is null or not exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin' and p.status = 'active'
  ) then
    raise exception 'Active owner access is required' using errcode = '42501';
  end if;
  if length(coalesce(p_search, '')) > 120
     or p_offset is null or p_limit is null
     or p_offset < 0 or p_offset > 100000
     or p_limit < 1 or p_limit > 50
     or (p_from is not null and p_to is not null and p_to <= p_from)
     or coalesce(p_actor_role, 'all') not in ('all', 'admin', 'staff', 'customer', 'system') then
    raise exception 'Invalid audit trail request' using errcode = '22023';
  end if;

  with events as (
    select a.id as event_id, 'owner_activity'::text as source,
      a.created_at, a.title as action,
      coalesce(nullif(btrim(p.full_name), ''), 'Owner') as actor_name,
      'admin'::text as actor_role,
      a.title as summary, null::numeric as amount,
      jsonb_strip_nulls(jsonb_build_object('description', nullif(btrim(a.detail), ''))) as details
    from public.owner_activity a
    left join public.profiles p on p.id = a.owner_id

    union all

    select a.id, 'audit_log'::text, a.created_at, a.action,
      coalesce(nullif(btrim(p.full_name), ''), 'Deleted account'),
      coalesce(a.actor_role, p.role::text, 'system'),
      a.action,
      case when coalesce(a.details->>'amount', a.details->>'cash_collected', a.details->>'paymentAmount') ~ '^[0-9]+(\.[0-9]+)?$'
        then coalesce(a.details->>'amount', a.details->>'cash_collected', a.details->>'paymentAmount')::numeric end,
      jsonb_strip_nulls(jsonb_build_object(
        'customer', coalesce(nullif(btrim(a.details->>'customerName'), ''), nullif(btrim(a.details->>'customer_name'), ''),
          nullif(btrim(booking_customer.full_name), ''), nullif(btrim(walkin.customer_name), ''),
          nullif(btrim(walkin_order.guest_name), ''), nullif(btrim(order_customer.full_name), ''),
          nullif(btrim(order_reservation.customer_name), '')),
        'court', coalesce(a.details->>'court', a.details->>'courtName', a.details->>'court_name'),
        'unit', a.details->>'unit',
        'sport', a.details->>'sport',
        'starts_at', coalesce(a.details->>'starts_at', a.details->>'time_date'),
        'scheduled_end_at', coalesce(a.details->>'scheduled_end_at', a.details->>'ends_at', a.details->>'end_at'),
        'checked_in_at', a.details->>'checked_in_at',
        'checked_out_at', a.details->>'checked_out_at',
        'from', a.details->>'from',
        'to', a.details->>'to',
        'status', a.details->>'status',
        'method', coalesce(a.details->>'method', a.details->>'paymentMethod', a.details->>'payment_method'),
        'amount', coalesce(a.details->>'amount', a.details->>'cash_collected', a.details->>'paymentAmount'),
        'total', a.details->>'total',
        'paid', a.details->>'paid',
        'subtotal', coalesce(a.details->>'subtotal', case when a.details->>'subtotal_minor' ~ '^-?[0-9]+(\.[0-9]+)?$' then ((a.details->>'subtotal_minor')::numeric / 100)::text end),
        'base_amount', coalesce(a.details->>'base_amount', case when a.details->>'base_minor' ~ '^-?[0-9]+(\.[0-9]+)?$' then ((a.details->>'base_minor')::numeric / 100)::text end),
        'fee', coalesce(a.details->>'fee', case when a.details->>'fee_minor' ~ '^-?[0-9]+(\.[0-9]+)?$' then ((a.details->>'fee_minor')::numeric / 100)::text end),
        'gross_amount', coalesce(a.details->>'gross_amount', case when a.details->>'gross_minor' ~ '^-?[0-9]+(\.[0-9]+)?$' then ((a.details->>'gross_minor')::numeric / 100)::text end),
        'reservation_count', a.details->>'reservation_count',
        'guest', a.details->>'guest',
        'released_hold', a.details->>'released_hold'
      ))
    from public.audit_log a
    left join public.profiles p on p.id = a.actor_id
    left join public.booking b on a.entity_type = 'booking' and b.booking_id::text = a.entity_id
    left join public.profiles booking_customer on booking_customer.id = b.customer_id
    left join public.walk_in_booking walkin
      on a.entity_type in ('walkin', 'walk_in_booking') and walkin.walkin_id::text = a.entity_id
    left join internal.staff_walkin_orders walkin_order
      on a.entity_type = 'walkin_order' and walkin_order.id::text = a.entity_id
    left join public.profiles order_customer on order_customer.id = walkin_order.customer_id
    left join lateral (
      select max(nullif(btrim(reservation.customer_name), '')) as customer_name
      from public.walk_in_booking reservation
      where reservation.walkin_order_id = walkin_order.id
    ) order_reservation on true

    union all

    select e.id, 'customer_operational_events'::text, e.created_at, e.action,
      coalesce(nullif(btrim(e.actor_name), ''), nullif(btrim(e.customer_name), ''), 'Account'),
      coalesce(e.actor_role, p.role::text, 'customer'),
      case
        when e.action = 'sign_in' then 'App sign-in observed'
        when e.action = 'sign_out' then 'App sign-out observed'
        when e.action = 'payment_recorded' then 'Payment recorded'
        else e.action
      end,
      case when e.action = 'payment_recorded' and e.details->>'amount' ~ '^[0-9]+(\.[0-9]+)?$'
        then (e.details->>'amount')::numeric end,
      jsonb_strip_nulls(jsonb_build_object(
        'customer', coalesce(nullif(btrim(e.details->>'customerName'), ''), nullif(btrim(e.details->>'customer_name'), '')),
        'sport', e.details->>'sport',
        'court', coalesce(e.details->>'court', e.details->>'courtName', e.details->>'court_name'),
        'unit', e.details->>'unit',
        'starts_at', coalesce(e.details->>'starts_at', e.details->>'time_date'),
        'scheduled_end_at', coalesce(e.details->>'scheduled_end_at', e.details->>'ends_at', e.details->>'end_at'),
        'checked_in_at', e.details->>'checked_in_at',
        'checked_out_at', e.details->>'checked_out_at',
        'status', e.details->>'status',
        'method', e.details->>'method',
        'amount', e.details->>'amount',
        'total', e.details->>'total',
        'paid', e.details->>'paid',
        'subtotal', coalesce(e.details->>'subtotal', case when e.details->>'subtotal_minor' ~ '^-?[0-9]+(\.[0-9]+)?$' then ((e.details->>'subtotal_minor')::numeric / 100)::text end),
        'base_amount', coalesce(e.details->>'base_amount', case when e.details->>'base_minor' ~ '^-?[0-9]+(\.[0-9]+)?$' then ((e.details->>'base_minor')::numeric / 100)::text end),
        'fee', coalesce(e.details->>'fee', case when e.details->>'fee_minor' ~ '^-?[0-9]+(\.[0-9]+)?$' then ((e.details->>'fee_minor')::numeric / 100)::text end),
        'gross_amount', coalesce(e.details->>'gross_amount', case when e.details->>'gross_minor' ~ '^-?[0-9]+(\.[0-9]+)?$' then ((e.details->>'gross_minor')::numeric / 100)::text end),
        'observed', e.details->>'observed',
        'request', e.details->>'request'
      ))
    from internal.customer_operational_events e
    left join public.profiles p on p.id = coalesce(e.actor_id, e.customer_id)
    where not (
      e.action in ('booking_created', 'walkin_created', 'time_in', 'time_out', 'unattended')
      and exists (
        select 1 from public.audit_log a
        where a.entity_id = e.source_id
          and (a.entity_type = e.source or (e.source = 'walkin' and a.entity_type = 'walk_in_booking'))
          and a.created_at = e.created_at
          and ((e.action = 'booking_created' and a.action = 'recorded_booking')
            or (e.action = 'walkin_created' and a.action = 'recorded_walk_in')
            or (e.action = 'time_in' and a.action = 'checked_in')
            or (e.action = 'time_out' and a.action in ('booking_timed_out', 'walkin_timed_out'))
            or (e.action = 'unattended' and a.action = 'booking_status_changed'))
      )
    )
  ), filtered as (
    select e.* from events e
    where (p_from is null or e.created_at >= p_from)
      and (p_to is null or e.created_at < p_to)
      and (coalesce(p_actor_role, 'all') = 'all' or e.actor_role = p_actor_role)
      and (nullif(btrim(p_search), '') is null or
        pg_catalog.strpos(pg_catalog.lower(e.event_id::text), pg_catalog.lower(btrim(p_search))) > 0
        or pg_catalog.strpos(pg_catalog.lower(e.actor_name), pg_catalog.lower(btrim(p_search))) > 0)
  ), page as (
    select * from filtered order by created_at desc, event_id desc, source asc
    offset p_offset limit p_limit
  )
  select jsonb_build_object(
    'total_count', (select count(*) from filtered),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
      'event_id', page.event_id, 'created_at', page.created_at,
      'action', page.action,
      'actor_name', page.actor_name, 'actor_role', page.actor_role,
      'summary', page.summary, 'details', page.details, 'amount', page.amount
    ) order by page.created_at desc, page.event_id desc, page.source asc) from page), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.owner_audit_trail(text, timestamptz, timestamptz, text, uuid, text, integer, integer) from public, anon;
grant execute on function public.owner_audit_trail(text, timestamptz, timestamptz, text, uuid, text, integer, integer) to authenticated;
