-- Let the authenticated staff Edge Function replay the exact provider request
-- already registered for a walk-in attempt. This prevents a retry from
-- changing GCash-only checkout into the generic online checkout.
create or replace function public.prepare_staff_walkin_checkout(p_order_id uuid,p_staff_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_order internal.staff_walkin_orders%rowtype; v_attempt internal.paymongo_checkout_attempts%rowtype;
begin
  if p_staff_id is null or not exists(select 1 from public.profiles p where p.id=p_staff_id
    and p.role in ('staff','admin') and p.status='active') then
    raise exception 'Active staff access is required' using errcode='42501';
  end if;
  select * into v_order from internal.staff_walkin_orders o where o.id=p_order_id for update;
  if not found or v_order.status not in ('awaiting_payment','review') then
    raise exception 'This walk-in order is not eligible for payment' using errcode='22023';
  end if;
  if v_order.expires_at<=now() then
    raise exception 'This walk-in checkout expired. Create a new walk-in order.' using errcode='55000';
  end if;
  select * into v_attempt from internal.paymongo_checkout_attempts a
    where a.walkin_order_id=p_order_id and a.status in ('creating','ready','review')
    order by a.created_at desc limit 1 for update;
  if found then
    return jsonb_build_object('order_id',p_order_id,'attempt_id',v_attempt.id,'status',v_attempt.status,
      'checkout_url',v_attempt.checkout_url,'checkout_request',v_attempt.checkout_request,
      'base_minor',v_attempt.amount_minor,'expires_at',v_order.expires_at);
  end if;
  if v_order.status<>'awaiting_payment' then
    raise exception 'This walk-in checkout expired. Create a new walk-in order.' using errcode='55000';
  end if;
  insert into internal.paymongo_checkout_attempts(booking_id,intent_id,customer_id,amount_minor,total_minor,
    payment_option,staff_id,walkin_order_id,pass_on_fees)
    values(null,null,v_order.customer_id,v_order.subtotal_minor,v_order.subtotal_minor,
      'full',p_staff_id,p_order_id,true) returning * into v_attempt;
  return jsonb_build_object('order_id',p_order_id,'attempt_id',v_attempt.id,'status',v_attempt.status,
    'base_minor',v_attempt.amount_minor,'expires_at',v_order.expires_at);
end;
$$;
revoke all on function public.prepare_staff_walkin_checkout(uuid,uuid) from public,anon,authenticated;
grant execute on function public.prepare_staff_walkin_checkout(uuid,uuid) to service_role;
