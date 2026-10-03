-- Return every immutable payment acknowledgment attached to one of the
-- authenticated customer's own bookings. The older single-receipt RPC picks
-- only the latest payment, which hides the original deposit after balance
-- settlement.
create or replace function public.customer_get_booking_payment_acknowledgments(p_booking_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_customer uuid;
  r record;
  v_result jsonb;
begin
  if v_actor is null or not exists (
    select 1 from public.profiles p
    where p.id = v_actor and p.role = 'customer' and p.status = 'active'
  ) then
    raise exception 'Active customer access is required' using errcode = '42501';
  end if;

  if p_booking_id is null or p_booking_id <= 0 then
    raise exception 'Invalid booking reference' using errcode = '22023';
  end if;

  select b.customer_id into v_customer
  from public.booking b
  where b.booking_id = p_booking_id;
  if not found or v_customer is distinct from v_actor then
    raise exception 'Booking not found' using errcode = 'P0002';
  end if;

  for r in
    select distinct p.payment_id
    from public.booking b
    join public.payment p on p.payment_id in (b.payment_id, b.balance_payment_id)
    left join internal.payment_acknowledgments a on a.payment_id = p.payment_id
    where b.booking_id = p_booking_id and a.payment_id is null
  loop
    perform internal.persist_payment_acknowledgment(r.payment_id, 'booking', p_booking_id, null);
  end loop;

  select jsonb_build_object(
    'source', 'booking',
    'id', p_booking_id,
    'payment_history', coalesce(jsonb_agg(
      jsonb_build_object(
        'payment_id', p.payment_id,
        'created_at', p.created_at,
        'method', p.payment_method,
        'base_minor', p.base_minor,
        'fee_minor', p.fee_minor,
        'gross_minor', p.gross_minor,
        'net_minor', p.net_minor,
        'receipt_id', a.receipt_id,
        'receipt_number', a.receipt_number,
        'issued_at', a.issued_at,
        'acknowledgment', a.payload
      ) order by p.created_at, p.payment_id
    ), '[]'::jsonb)
  ) into v_result
  from public.booking b
  join public.payment p on p.payment_id in (b.payment_id, b.balance_payment_id)
  left join internal.payment_acknowledgments a on a.payment_id = p.payment_id
  where b.booking_id = p_booking_id;

  return coalesce(v_result, jsonb_build_object(
    'source', 'booking', 'id', p_booking_id, 'payment_history', '[]'::jsonb
  ));
end;
$$;

revoke all on function public.customer_get_booking_payment_acknowledgments(bigint) from public, anon, authenticated;
grant execute on function public.customer_get_booking_payment_acknowledgments(bigint) to authenticated;
