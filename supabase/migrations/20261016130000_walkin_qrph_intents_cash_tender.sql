-- QR Ph Payment Intent support and server-recorded walk-in cash tender/change.
alter table public.app_settings add column if not exists qrph_enabled boolean not null default false;
alter table public.payment add column if not exists cash_tendered_minor bigint;
alter table public.payment add column if not exists cash_change_minor bigint;
-- Production may already have this constraint from the original QRPH migration.
do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.payment'::regclass
      and conname = 'payment_cash_change_nonnegative'
  ) then
    alter table public.payment add constraint payment_cash_change_nonnegative check (
      (cash_tendered_minor is null and cash_change_minor is null) or
      (cash_tendered_minor is not null and cash_change_minor is not null and payment_method='Cash'
        and cash_tendered_minor>=base_minor and cash_change_minor=cash_tendered_minor-base_minor)
    );
  end if;
end;
$$;
alter table internal.paymongo_checkout_attempts add column if not exists qr_image_url text;
alter table internal.paymongo_checkout_attempts add column if not exists qr_test_url text;
alter table internal.paymongo_checkout_attempts drop constraint if exists paymongo_attempt_ready_fields;
alter table internal.paymongo_checkout_attempts add constraint paymongo_attempt_ready_fields check (
  status not in ('ready','paid') or (paymongo_session_id is not null and
    (checkout_url is not null or qr_image_url is not null))
);

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

create or replace function public.record_paymongo_qrph_paid(
  p_event_id text,p_intent_id text,p_payment_id text,p_amount_minor bigint,p_fee_minor bigint,p_net_minor bigint
) returns text language plpgsql security definer set search_path = '' as $$
declare v_result text;
begin
  if p_intent_id !~ '^pi_[A-Za-z0-9]+' then raise exception 'Invalid Payment Intent' using errcode='22023'; end if;
  if not exists(select 1 from internal.paymongo_checkout_attempts a
    where a.paymongo_session_id=p_intent_id and a.walkin_order_id is not null and a.qr_image_url is not null) then
    return 'ignored';
  end if;
  v_result:=public.record_paymongo_paid(p_event_id,p_intent_id,p_payment_id,p_amount_minor,p_fee_minor,p_net_minor);
  update internal.paymongo_webhook_events set event_type='payment.paid' where event_id=p_event_id;
  return v_result;
end;
$$;
revoke all on function public.record_paymongo_qrph_paid(text,text,text,bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.record_paymongo_qrph_paid(text,text,text,bigint,bigint,bigint) to service_role;
-- Core walk-in transaction validates tender against the server-priced total.
create or replace function public.staff_create_walkin_order(
  p_customer_id uuid,p_guest_name text,p_guest_mobile text,p_items jsonb,p_payment_method text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid:=(select auth.uid()); v_customer_name text; v_customer_mobile text;
  v_order_id uuid; v_status text; v_attempt_id uuid; v_payment_id bigint; v_receipt jsonb;
  v_item jsonb; v_prepared jsonb:='[]'::jsonb; v_item_result jsonb:='[]'::jsonb;
  v_listing public.court%rowtype; v_unit public.court_unit_inventory%rowtype;
  v_start timestamptz; v_end timestamptz; v_start_local timestamp; v_end_local timestamp;
  v_minutes integer; v_quantity integer; v_rate_unit text; v_price numeric; v_minor bigint;
  v_total_minor bigint:=0; v_walkin_id bigint; v_count integer:=0; v_rule record; v_tendered_minor bigint;
begin
  if v_actor is null or not exists(select 1 from public.profiles p where p.id=v_actor
    and p.role in ('staff','admin') and p.status='active') then
    raise exception 'Active staff access is required' using errcode='42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items)=0
     or octet_length(p_items::text)>1048576 or p_payment_method is null
     or p_payment_method not in ('cash','paymongo') then
    raise exception 'Choose at least one reservation and a valid payment method' using errcode='22023';
  end if;
  if p_payment_method='cash' and not exists(select 1 from public.app_settings s where s.id=true and s.cash_enabled) then
    raise exception 'Cash payment is disabled' using errcode='42501';
  end if;
  if p_payment_method='paymongo' and not exists(select 1 from public.app_settings s where s.id=true and (s.card_enabled or s.gcash_enabled or s.qrph_enabled)) then
    raise exception 'Online payment is unavailable' using errcode='22023';
  end if;
  if p_customer_id is not null then
    select p.full_name,p.contact_num into v_customer_name,v_customer_mobile
      from public.profiles p where p.id=p_customer_id and p.role='customer' and p.status='active';
    if not found then raise exception 'Select an active customer account' using errcode='22023'; end if;
  else
    v_customer_name:=nullif(btrim(p_guest_name),'');
    v_customer_mobile:=nullif(btrim(p_guest_mobile),'');
    if v_customer_name is null or length(v_customer_name)>160 then
      raise exception 'Enter the guest customer name' using errcode='22023';
    end if;
    if v_customer_mobile is not null and v_customer_mobile !~ '^(\+63|0)9[0-9]{9}$' then
      raise exception 'Enter a valid Philippine mobile number or leave it empty' using errcode='22023';
    end if;
  end if;

  -- Price and validate the complete order before inserting any reservation.
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_count:=v_count+1;
    select * into v_listing from public.court c where c.id=(v_item->>'listing_id')::uuid
      and c.is_active and c.status='Available';
    select * into v_unit from public.court_unit_inventory u where u.id=(v_item->>'unit_id')::uuid
      and u.court_id=v_listing.id and u.is_active and u.inventory_verified
      and u.availability_status='available';
    if v_listing.id is null or v_unit.id is null then
      raise exception 'A selected sport, court, or unit is unavailable' using errcode='22023';
    end if;
    v_start:=(v_item->>'starts_at')::timestamptz;
    v_end:=(v_item->>'ends_at')::timestamptz;
    v_start_local:=v_start at time zone 'Asia/Manila';
    v_end_local:=v_end at time zone 'Asia/Manila';
    v_quantity:=coalesce(nullif(v_item->>'rate_quantity','')::integer,1);
    if v_start is null or v_end is null
      or v_start_local::time<date_trunc('hour',now() at time zone 'Asia/Manila')::time
      or v_start_local::date<>(now() at time zone 'Asia/Manila')::date
      or v_end_local::date<>v_start_local::date
      or v_start_local::time<>date_trunc('hour',v_start_local)::time
      or v_end_local::time<>date_trunc('hour',v_end_local)::time
      or v_end<=v_start or v_end>v_start+interval '12 hours' or v_quantity not between 1 and 100 then
      raise exception 'Walk-in reservations must use current or future whole-hour slots today' using errcode='22023';
    end if;
    select * into v_rule from internal.booking_rule_for_date(v_start_local::date);
    if not found then
      if v_start_local::time<time '08:00' or v_end_local::time>time '20:00' then
        raise exception 'The selected time is outside business hours' using errcode='22023';
      end if;
    elsif v_rule.is_closed or v_start_local::time<v_rule.opens_at or v_end_local::time>v_rule.closes_at then
      raise exception 'The selected time is outside business hours' using errcode='22023';
    end if;
    if now()>v_start+make_interval(mins=>coalesce(v_rule.grace_minutes,30)) then
      raise exception 'Walk-in Time-In grace period has ended for this slot. Choose a later available time.'
        using errcode='55000';
    end if;
    v_minutes:=ceil(extract(epoch from (v_end-v_start))/60)::integer;
    if v_minutes%60<>0 then raise exception 'Walk-in times must use full-hour slots' using errcode='22023'; end if;
    v_rate_unit:=internal.authoritative_reservation_rate_unit(v_listing.id,v_unit.id);
    if v_rate_unit not in ('/hr','/set') then raise exception 'Court rate is unavailable' using errcode='22023'; end if;
    if v_rate_unit='/set' and (v_end<>v_start+make_interval(mins=>v_quantity*60) or v_minutes<>v_quantity*60) then
      raise exception 'Each set reserves exactly 60 minutes on one lane' using errcode='22023';
    end if;
    v_price:=internal.authoritative_reservation_amount(v_listing.id,v_unit.id,v_start,v_end,v_minutes,v_quantity);
    if v_price is null or v_price<=0 then raise exception 'Court rate is unavailable' using errcode='22023'; end if;
    v_minor:=round(v_price*100)::bigint;
    v_total_minor:=v_total_minor+v_minor;
    v_prepared:=v_prepared||jsonb_build_array(jsonb_build_object(
      'listing_id',v_listing.id,'unit_id',v_unit.id,'sport',(select s.name from public.sport s where s.id=v_listing.sport_id),
      'court',v_listing.name,'unit',v_unit.label,'starts_at',v_start,'ends_at',v_end,
      'minutes',v_minutes,'quantity',v_quantity,'rate_unit',v_rate_unit,'amount_minor',v_minor));
  end loop;

  if p_payment_method='cash' then
    begin v_tendered_minor:=nullif(p_items->0->>'cash_tendered_minor','')::bigint;
    exception when invalid_text_representation then raise exception 'Enter a valid cash amount' using errcode='22023'; end;
    if v_tendered_minor is null or v_tendered_minor<v_total_minor or exists(
      select 1 from jsonb_array_elements(p_items) i
      where nullif(i->>'cash_tendered_minor','')::bigint is distinct from v_tendered_minor) then
      raise exception 'Cash tendered must cover the server-priced order total' using errcode='22023';
    end if;
  end if;

  v_status:=case when p_payment_method='cash' then 'paid' else 'awaiting_payment' end;
  insert into internal.staff_walkin_orders(staff_id,customer_id,guest_name,guest_mobile,status,subtotal_minor,gross_minor)
    values(v_actor,p_customer_id,case when p_customer_id is null then v_customer_name end,
      case when p_customer_id is null then v_customer_mobile end,v_status,v_total_minor,
      case when p_payment_method='cash' then v_total_minor else null end)
    returning id into v_order_id;
  if p_payment_method='cash' then
    perform set_config('inigosync.staff_payment_rpc','on',true);
    insert into public.payment(cost,paid,payment_method,down_full,base_minor,fee_minor,gross_minor,net_minor,cash_tendered_minor,cash_change_minor)
      values(v_total_minor/100.0,v_total_minor/100.0,'Cash','full',v_total_minor,0,v_total_minor,v_total_minor,v_tendered_minor,v_tendered_minor-v_total_minor)
      returning payment_id into v_payment_id;
    update internal.staff_walkin_orders set payment_id=v_payment_id,updated_at=now() where id=v_order_id;
  else
    insert into internal.paymongo_checkout_attempts(booking_id,intent_id,customer_id,amount_minor,total_minor,
      payment_option,staff_id,walkin_order_id,pass_on_fees)
      values(null,null,p_customer_id,v_total_minor,v_total_minor,'full',v_actor,v_order_id,true)
      returning id into v_attempt_id;
  end if;

  perform set_config('inigosync.staff_walkin_rpc','on',true);
  for v_item in select value from jsonb_array_elements(v_prepared) loop
    insert into public.walk_in_booking(staff_id,customer_id,walkin_order_id,sports,courts,time_date,end_at,
      duration_minutes,court_unit,court_listing_id,court_unit_inventory_id,rate_quantity,rate_unit_snapshot,
      customer_name,customer_mobile,status,payment_method,payment_id,amount_total,amount_paid)
    values(v_actor,p_customer_id,v_order_id,v_item->>'sport',v_item->>'court',(v_item->>'starts_at')::timestamptz,
      (v_item->>'ends_at')::timestamptz,(v_item->>'minutes')::integer,v_item->>'unit',
      (v_item->>'listing_id')::uuid,(v_item->>'unit_id')::uuid,(v_item->>'quantity')::integer,v_item->>'rate_unit',
      v_customer_name,v_customer_mobile,
      case when p_payment_method='cash' then 'confirmed' else 'pending' end,
      case when p_payment_method='cash' then 'Cash' else null end,v_payment_id,
      (v_item->>'amount_minor')::bigint/100.0,
      case when p_payment_method='cash' then (v_item->>'amount_minor')::bigint/100.0 else 0 end)
    returning walkin_id into v_walkin_id;
    v_item_result:=v_item_result||jsonb_build_array(jsonb_build_object(
      'reservation_id',v_walkin_id,'sport',v_item->>'sport','court',v_item->>'court','unit',v_item->>'unit',
      'starts_at',v_item->>'starts_at','ends_at',v_item->>'ends_at','subtotal_minor',v_item->>'amount_minor'));
  end loop;
  if p_payment_method='cash' then
    v_receipt:=internal.persist_payment_acknowledgment(v_payment_id,'walkin_order',null,v_order_id);
    update internal.payment_acknowledgments set payload=payload||jsonb_build_object('cash_tendered_minor',v_tendered_minor,'cash_change_minor',v_tendered_minor-v_total_minor,'cash_tendered',v_tendered_minor/100.0,'cash_change',(v_tendered_minor-v_total_minor)/100.0) where payment_id=v_payment_id returning payload into v_receipt;
    update internal.staff_walkin_orders set receipt_id=(v_receipt->>'receipt_id')::uuid where id=v_order_id;
  end if;
  insert into public.audit_log(actor_id,actor_role,action,entity_type,entity_id,details)
    values(v_actor,'staff','created_walkin_order','walkin_order',v_order_id::text,
      jsonb_build_object('customer_id',p_customer_id,'guest',p_customer_id is null,'reservation_count',v_count,
        'payment_method',case when p_payment_method='cash' then 'Cash' else 'PayMongo' end,
        'subtotal_minor',v_total_minor,'payment_id',v_payment_id,'receipt_id',v_receipt->>'receipt_id'));
  return jsonb_build_object('order_id',v_order_id,'status',v_status,'attempt_id',v_attempt_id,
    'base_minor',v_total_minor,'fee_minor',case when p_payment_method='cash' then 0 else null end,
    'gross_minor',case when p_payment_method='cash' then v_total_minor else null end,
    'receipt_id',v_receipt->>'receipt_id','receipt',v_receipt,'items',v_item_result);
exception when exclusion_violation then
  raise exception 'One of the selected physical courts is already reserved at that time' using errcode='23P01';
end;
$$;

-- Preserve the protected quote/guest guard wrappers as the only callable paths.
revoke all on function public.staff_create_walkin_order(uuid,text,text,jsonb,text)
  from public,anon,authenticated,service_role;



create or replace function public.register_paymongo_qrph_intent(p_attempt_id uuid,p_request jsonb,p_intent_id text)
returns boolean language plpgsql security definer set search_path = '' as $$
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
    where id=p_attempt_id and status='creating' and walkin_order_id is not null
      and amount_minor=(p_request->>'amount')::bigint
      and (paymongo_session_id is null or paymongo_session_id=p_intent_id);
  get diagnostics v_count=row_count;
  return v_count=1;
end;
$$;
revoke all on function public.register_paymongo_qrph_intent(uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.register_paymongo_qrph_intent(uuid,jsonb,text) to service_role;

-- Expose only the QR payload to the trusted staff Edge Function for retries.
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



alter table public.app_settings drop constraint if exists app_settings_online_method_required;
alter table public.app_settings add constraint app_settings_online_method_required
  check (card_enabled or gcash_enabled or qrph_enabled);

-- QR Ph remains a valid owner-enabled online channel when Card and GCash are off.
create or replace function public.prepare_paid_checkout_cart(
  p_customer_id uuid,p_items jsonb,p_payment_option text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_intent uuid; v_item jsonb; v_court public.court%rowtype; v_unit public.court_unit_inventory%rowtype;
  v_start timestamptz; v_end timestamptz; v_start_local timestamp; v_end_local timestamp;
  v_minutes integer; v_qty integer; v_rate_unit text; v_total numeric; v_charge numeric;
  v_total_minor bigint:=0; v_charge_minor bigint:=0; v_pct numeric; v_item_id uuid;
  v_count integer:=0; v_resource_count integer; v_rule record;
begin
  if p_customer_id is null or not exists(select 1 from public.profiles p where p.id=p_customer_id
    and p.role='customer' and p.status='active') then
    raise exception 'Active customer account required' using errcode='42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
  if p_payment_option not in ('full','downpayment') or jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Choose reservations and a valid payment option' using errcode='22023';
  end if;
  if jsonb_array_length(p_items) not between 1 and 8 or octet_length(p_items::text)>1048576 then
    raise exception 'Choose one to eight reservations and a valid payment option' using errcode='22023';
  end if;
  select coalesce(s.downpayment_pct,50) into v_pct from public.app_settings s where s.id=true;
  v_pct:=coalesce(v_pct,50);
  if not exists(select 1 from public.app_settings s where s.id=true and (s.card_enabled or s.gcash_enabled or s.qrph_enabled)) then
    raise exception 'Online payment is unavailable' using errcode='22023';
  end if;
  insert into internal.checkout_intents(customer_id,payment_option,downpayment_pct,amount_minor,total_minor)
    values(p_customer_id,p_payment_option,v_pct,1,1) returning id into v_intent;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_count:=v_count+1;
    select * into v_court from public.court c where c.id=(v_item->>'listing_id')::uuid
      and c.is_active and c.status='Available';
    select * into v_unit from public.court_unit_inventory u where u.id=(v_item->>'unit_id')::uuid
      and u.court_id=v_court.id and u.is_active and u.inventory_verified and u.availability_status='available';
    if v_court.id is null or v_unit.id is null then raise exception 'Court or lane is unavailable' using errcode='22023'; end if;
    v_start:=(v_item->>'starts_at')::timestamptz;
    v_end:=(v_item->>'ends_at')::timestamptz;
    v_start_local:=v_start at time zone 'Asia/Manila';
    v_end_local:=v_end at time zone 'Asia/Manila';
    v_qty:=coalesce(nullif(v_item->>'rate_quantity','')::integer,1);
    if v_start is null or v_end is null or v_start<=now()+interval '2 minutes'
      or v_end<=v_start or v_end>v_start+interval '12 hours'
      or v_start_local::date<>v_end_local::date or v_qty not between 1 and 100 then
      raise exception 'Choose a valid future court time on one local date' using errcode='22023';
    end if;
    select * into v_rule from internal.booking_rule_for_date(v_start_local::date);
    if not found then
      if v_start_local::time<time '08:00' or v_end_local::time>time '20:00' then
        raise exception 'Choose a time between 8:00 AM and 8:00 PM' using errcode='22023';
      end if;
    elsif v_rule.is_closed or v_start_local::time<v_rule.opens_at or v_end_local::time>v_rule.closes_at then
      raise exception 'Choose a time within the current business hours' using errcode='22023';
    end if;
    v_minutes:=ceil(extract(epoch from(v_end-v_start))/60)::integer;
    v_rate_unit:=internal.authoritative_reservation_rate_unit(v_court.id,v_unit.id);
    if v_rate_unit not in ('/hr','/set') then raise exception 'Court rate is unavailable' using errcode='22023'; end if;
    if v_rate_unit='/set' and (v_end<>v_start+make_interval(mins=>v_qty*60) or v_minutes<>v_qty*60) then
      raise exception 'Each bowling set reserves exactly 60 minutes' using errcode='22023';
    end if;
    v_total:=internal.authoritative_reservation_amount(v_court.id,v_unit.id,v_start,v_end,v_minutes,v_qty);
    if v_total is null or v_total<=0 then raise exception 'Court rate is unavailable' using errcode='22023'; end if;
    v_charge:=case when p_payment_option='full' then v_total else round(v_total*v_pct/100,2) end;
    if v_charge<=0 then raise exception 'Payment amount is too small' using errcode='22023'; end if;
    insert into internal.checkout_intent_items(intent_id,listing_id,unit_id,sports,courts,court_unit,
      starts_at,ends_at,duration_minutes,rate_quantity,rate_unit,total_minor,charge_minor)
    values(v_intent,v_court.id,v_unit.id,(select s.name from public.sport s where s.id=v_court.sport_id),
      v_court.name,v_unit.label,v_start,v_end,v_minutes,v_qty,v_rate_unit,
      round(v_total*100)::bigint,round(v_charge*100)::bigint) returning id into v_item_id;
    insert into internal.reservation_resource_slots(hold_item_id,resource_id,during)
    select v_item_id,m.resource_id,tstzrange(v_start,v_end,'[)')
      from public.court_unit_resource_map m join public.physical_court_resource r on r.id=m.resource_id and r.is_active
      where m.court_unit_id=v_unit.id;
    get diagnostics v_resource_count=row_count;
    if v_resource_count=0 then raise exception 'Court or lane has no available physical connection' using errcode='22023'; end if;
    v_total_minor:=v_total_minor+round(v_total*100)::bigint;
    v_charge_minor:=v_charge_minor+round(v_charge*100)::bigint;
  end loop;
  update internal.checkout_intents set total_minor=v_total_minor,amount_minor=v_charge_minor where id=v_intent;
  insert into internal.paymongo_checkout_attempts(booking_id,intent_id,customer_id,amount_minor,total_minor,payment_option,pass_on_fees)
    values(null,v_intent,p_customer_id,v_charge_minor,v_total_minor,p_payment_option,true);
  return (select jsonb_build_object('attempt_id',a.id,'intent_id',v_intent,
    'amount_minor',a.amount_minor,'total_minor',a.total_minor,'item_count',v_count,'expires_at',i.expires_at)
    from internal.paymongo_checkout_attempts a join internal.checkout_intents i on i.id=a.intent_id where i.id=v_intent);
exception when exclusion_violation then
  raise exception 'This physical court is already reserved during the selected time' using errcode='23P01';
end;
$$;

-- This RPC is intentionally callable only through the trusted service Edge Function.
revoke all on function public.prepare_paid_checkout_cart(uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.prepare_paid_checkout_cart(uuid,jsonb,text) to service_role;



-- Reconcile QR Ph intents whose QR attach timed out before ready status.
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
        and a.checkout_request->>'payment_method_allowed'='["qrph"]' and o.expires_at<=now())
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
      and (status in ('ready','review') or (status='creating' and walkin_order_id is not null
        and checkout_request->>'payment_method_allowed'='["qrph"]'))
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

