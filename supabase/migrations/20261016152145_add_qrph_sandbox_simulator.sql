-- Extend the already-deployed QR Ph checkout with PayMongo's test simulator URL.
alter table internal.paymongo_checkout_attempts add column if not exists qr_test_url text;

create or replace function public.attach_paymongo_qrph_intent(
  p_attempt_id uuid,p_intent_id text,p_qr_image_url text,p_qr_test_url text default null
) returns boolean language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if p_intent_id !~ '^pi_[A-Za-z0-9]+' or p_qr_image_url !~ '^data:image/[A-Za-z0-9.+-]+;base64,'
     or length(p_qr_image_url)>1500000 or (p_qr_test_url is not null and
       p_qr_test_url !~ '^https://test\.paymongo\.com([/?#]|$)') then
    raise exception 'Invalid PayMongo QR Ph response' using errcode='22023';
  end if;
  update internal.paymongo_checkout_attempts set paymongo_session_id=p_intent_id,
    qr_image_url=p_qr_image_url,qr_test_url=p_qr_test_url,checkout_url=null,status='ready',updated_at=now()
    where id=p_attempt_id and status in ('creating','ready')
      and (paymongo_session_id is null or paymongo_session_id=p_intent_id)
      and walkin_order_id is not null;
  get diagnostics v_count=row_count;
  return v_count=1;
end;
$$;
revoke all on function public.attach_paymongo_qrph_intent(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.attach_paymongo_qrph_intent(uuid,text,text,text) to service_role;

drop function if exists public.attach_paymongo_qrph_intent(uuid,text,text);

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
      'checkout_url',v_attempt.checkout_url,'qr_image_url',v_attempt.qr_image_url,'qr_test_url',v_attempt.qr_test_url,'paymongo_session_id',v_attempt.paymongo_session_id,'checkout_request',v_attempt.checkout_request,
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
