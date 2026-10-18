-- Extend the existing staff balance checkout attempt so it can use the same
-- durable QR Ph Payment Intent flow as walk-in orders.

create or replace function public.register_paymongo_qrph_intent(
  p_attempt_id uuid,p_request jsonb,p_intent_id text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if p_intent_id !~ '^pi_[A-Za-z0-9]+' or p_request->>'payment_method_allowed' is distinct from '["qrph"]'
     or (p_request->>'amount') !~ '^[1-9][0-9]*$'
     or coalesce(p_request->>'client_key','')='' or (p_request->>'qr_expiry_seconds') !~ '^[0-9]+$'
     or (p_request->>'qr_expiry_seconds')::integer not between 60 and 9000 then
    raise exception 'Invalid QR Ph intent request' using errcode='22023';
  end if;
  update internal.paymongo_checkout_attempts set paymongo_session_id=p_intent_id,
    checkout_request=p_request,pass_on_fees=false,updated_at=now()
    where id=p_attempt_id and status='creating'
      and (walkin_order_id is not null or balance_source is not null)
      and amount_minor=(p_request->>'amount')::bigint
      and (paymongo_session_id is null or paymongo_session_id=p_intent_id);
  get diagnostics v_count=row_count;
  return v_count=1;
end;
$$;
revoke all on function public.register_paymongo_qrph_intent(uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.register_paymongo_qrph_intent(uuid,jsonb,text) to service_role;

create or replace function public.attach_paymongo_qrph_intent(
  p_attempt_id uuid,p_intent_id text,p_qr_image_url text,p_qr_livemode boolean,
  p_qr_test_url text default null
) returns boolean language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if p_intent_id !~ '^pi_[A-Za-z0-9]+' or p_qr_livemode is null
     or p_qr_image_url !~ '^data:image/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$'
     or length(p_qr_image_url)>1500000
     or (p_qr_test_url is not null and (p_qr_livemode
       or p_qr_test_url !~ '^https://test\.paymongo\.com([/?#]|$)')) then
    raise exception 'Invalid PayMongo QR Ph response' using errcode='22023';
  end if;
  update internal.paymongo_checkout_attempts set paymongo_session_id=p_intent_id,
    qr_image_url=p_qr_image_url,qr_livemode=p_qr_livemode,qr_test_url=p_qr_test_url,
    checkout_url=null,status='ready',updated_at=now()
    where id=p_attempt_id and status in ('creating','ready')
      and (paymongo_session_id is null or paymongo_session_id=p_intent_id)
      and (walkin_order_id is not null or balance_source is not null);
  get diagnostics v_count=row_count;
  return v_count=1;
end;
$$;
revoke all on function public.attach_paymongo_qrph_intent(uuid,text,text,boolean,text) from public,anon,authenticated;
grant execute on function public.attach_paymongo_qrph_intent(uuid,text,text,boolean,text) to service_role;

create or replace function public.prepare_paymongo_balance_checkout(p_source text,p_id bigint,p_staff_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_total numeric; v_paid numeric; v_start timestamptz; v_end timestamptz;
  v_no_show boolean; v_grace integer; v_due bigint; v_attempt internal.paymongo_checkout_attempts%rowtype;
  v_order uuid; v_customer uuid;
begin
  if p_source not in ('booking','walkin') or p_id is null or p_id<=0 or not exists
    (select 1 from public.profiles p where p.id=p_staff_id and p.role in ('staff','admin') and p.status='active') then
    raise exception 'Active staff access is required' using errcode='42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
  if p_source='booking' then
    select b.amount_total,b.amount_paid,b.time_date,b.end_at,b.no_show_policy_applies,b.customer_id
      into v_total,v_paid,v_start,v_end,v_no_show,v_customer from public.booking b
      where b.booking_id=p_id and b.status='confirmed' and b.checked_in_at is null for update;
  else
    select w.amount_total,w.amount_paid,w.time_date,w.end_at,w.no_show_policy_applies,
      w.walkin_order_id,w.customer_id
      into v_total,v_paid,v_start,v_end,v_no_show,v_order,v_customer from public.walk_in_booking w
      where w.walkin_id=p_id and w.status in ('pending','confirmed') and w.checked_in_at is null for update;
    if v_order is not null and not exists(select 1 from internal.staff_walkin_orders o
      where o.id=v_order and o.status='paid') then
      raise exception 'Resolve the walk-in order payment before collecting its balance' using errcode='55000';
    end if;
  end if;
  if v_total is null or v_paid is null or v_paid>=v_total then
    raise exception 'No balance is due for this reservation' using errcode='22023';
  end if;
  select r.grace_minutes into v_grace
    from internal.booking_rule_for_date((v_start at time zone 'Asia/Manila')::date) r;
  if v_end<=now() or (coalesce(v_no_show,true)
    and now()>v_start+make_interval(mins=>coalesce(v_grace,30))) then
    raise exception 'The Time-In grace period has ended for this reservation' using errcode='55000';
  end if;
  v_due:=round((v_total-v_paid)*100)::bigint;
  select * into v_attempt from internal.paymongo_checkout_attempts a
    where a.balance_source=p_source and a.balance_id=p_id
      and a.status in ('creating','ready','review')
    order by a.created_at desc limit 1 for update;
  if found then
    return jsonb_build_object('attempt_id',v_attempt.id,'amount_minor',v_attempt.amount_minor,
      'status',v_attempt.status,'checkout_url',v_attempt.checkout_url,
      'paymongo_session_id',v_attempt.paymongo_session_id,'checkout_request',v_attempt.checkout_request,
      'qr_image_url',v_attempt.qr_image_url,'qr_livemode',v_attempt.qr_livemode,
      'qr_test_url',v_attempt.qr_test_url,'expires_at',v_attempt.created_at+interval '15 minutes');
  end if;
  insert into internal.paymongo_checkout_attempts(booking_id,customer_id,amount_minor,total_minor,
    payment_option,balance_source,balance_id,staff_id,pass_on_fees)
    values(null,v_customer,v_due,v_due,'full',p_source,p_id,p_staff_id,true) returning * into v_attempt;
  return jsonb_build_object('attempt_id',v_attempt.id,'amount_minor',v_due,'status',v_attempt.status,
    'expires_at',v_attempt.created_at+interval '15 minutes');
end;
$$;
revoke all on function public.prepare_paymongo_balance_checkout(text,bigint,uuid) from public,anon,authenticated;
grant execute on function public.prepare_paymongo_balance_checkout(text,bigint,uuid) to service_role;

create or replace function public.record_paymongo_qrph_paid(
  p_event_id text,p_intent_id text,p_payment_id text,p_amount_minor bigint,p_fee_minor bigint,p_net_minor bigint
) returns text language plpgsql security definer set search_path = '' as $$
declare v_result text;
begin
  if p_intent_id !~ '^pi_[A-Za-z0-9]+' then raise exception 'Invalid Payment Intent' using errcode='22023'; end if;
  if not exists(select 1 from internal.paymongo_checkout_attempts a
    where a.paymongo_session_id=p_intent_id and a.qr_image_url is not null
      and (a.walkin_order_id is not null or a.balance_source in ('booking','walkin'))) then
    return 'ignored';
  end if;
  v_result:=public.record_paymongo_paid(p_event_id,p_intent_id,p_payment_id,p_amount_minor,p_fee_minor,p_net_minor);
  update internal.paymongo_webhook_events set event_type='payment.paid' where event_id=p_event_id;
  return v_result;
end;
$$;
revoke all on function public.record_paymongo_qrph_paid(text,text,text,bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.record_paymongo_qrph_paid(text,text,text,bigint,bigint,bigint) to service_role;

-- A QR intent may be registered successfully while its image attachment or
-- Edge response is interrupted. Keep that balance attempt in the same expiry
-- reconciliation path as a walk-in QR so it cannot remain open indefinitely.
create or replace function public.list_paymongo_checkouts_due_for_expiry()
returns table(attempt_id uuid,session_id text,checkout_request jsonb,should_abandon boolean)
language plpgsql security definer set search_path = '' as $$
begin
  return query
    select a.id,a.paymongo_session_id,a.checkout_request,
      (a.paymongo_session_id is null and (a.checkout_request is null
        or a.created_at<=now()-interval '20 hours')) as should_abandon
    from internal.paymongo_checkout_attempts a
      left join public.booking b on b.booking_id=a.booking_id
      left join internal.checkout_intents i on i.id=a.intent_id
      left join internal.staff_walkin_orders o on o.id=a.walkin_order_id
    where a.paymongo_payment_id is null and (
      (a.status in ('creating','review') and a.paymongo_session_id is null
        and a.created_at<=now()-interval '15 minutes')
      or (a.status='creating' and a.paymongo_session_id is not null
        and a.checkout_request->>'payment_method_allowed'='["qrph"]'
        and (o.expires_at<=now() or (a.balance_id is not null and a.created_at<=now()-interval '15 minutes')))
      or (a.status in ('ready','review') and a.paymongo_session_id is not null
        and (b.time_date<=now() or i.expires_at<=now() or o.expires_at<=now()
          or (a.balance_id is not null and a.created_at<=now()-interval '15 minutes'))))
    order by a.created_at limit 50;
end;
$$;
revoke all on function public.list_paymongo_checkouts_due_for_expiry() from public,anon,authenticated;
grant execute on function public.list_paymongo_checkouts_due_for_expiry() to service_role;

create or replace function public.mark_paymongo_checkout_expired(p_attempt_id uuid,p_session_id text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_intent uuid; v_order uuid; v_count integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
  update internal.paymongo_checkout_attempts set status='expired',updated_at=now()
    where id=p_attempt_id and paymongo_session_id=p_session_id and paymongo_payment_id is null
      and (status in ('ready','review') or (status='creating' and checkout_request->>'payment_method_allowed'='["qrph"]'
        and (walkin_order_id is not null or balance_source in ('booking','walkin'))))
    returning intent_id,walkin_order_id into v_intent,v_order;
  get diagnostics v_count=row_count;
  if v_count=1 and v_intent is not null then
    update internal.checkout_intents set status='expired',updated_at=now() where id=v_intent;
    delete from internal.reservation_resource_slots where hold_item_id in
      (select x.id from internal.checkout_intent_items x where x.intent_id=v_intent);
  end if;
  if v_count=1 and v_order is not null then
    update internal.staff_walkin_orders set status='expired',updated_at=now()
      where id=v_order and status in ('awaiting_payment','review');
    update public.walk_in_booking set status='cancelled'
      where walkin_order_id=v_order and status='pending' and checked_in_at is null;
    insert into public.audit_log(actor_role,action,entity_type,entity_id,details)
      values('system','expired_walkin_checkout','walkin_order',v_order::text,
        jsonb_build_object('attempt_id',p_attempt_id,'released_hold',true));
  end if;
  return v_count=1;
end;
$$;
revoke all on function public.mark_paymongo_checkout_expired(uuid,text) from public,anon,authenticated;
grant execute on function public.mark_paymongo_checkout_expired(uuid,text) to service_role;
