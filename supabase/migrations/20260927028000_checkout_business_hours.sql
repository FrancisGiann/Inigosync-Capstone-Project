create or replace function public.prepare_paid_checkout_cart(
  p_customer_id uuid,p_items jsonb,p_payment_option text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_intent uuid; v_item jsonb; v_court public.court%rowtype; v_unit public.court_unit_inventory%rowtype;
  v_start timestamptz; v_end timestamptz; v_minutes integer; v_qty integer; v_rate_unit text;
  v_total numeric; v_charge numeric; v_total_minor bigint:=0; v_charge_minor bigint:=0;
  v_pct numeric; v_item_id uuid; v_count integer:=0; v_resource_count integer;
begin
  if p_customer_id is null or not exists (select 1 from public.profiles p where p.id=p_customer_id and p.role='customer' and p.status='active') then
    raise exception 'Active customer account required' using errcode='42501';
  end if;
  if p_payment_option not in ('full','downpayment') or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) not between 1 and 8 then
    raise exception 'Choose one to eight reservations and a payment option' using errcode='22023';
  end if;
  select coalesce(s.downpayment_pct,50) into v_pct from public.app_settings s where s.id=true;
  v_pct:=coalesce(v_pct,50);
  if not exists (select 1 from public.app_settings s where s.id=true and (s.card_enabled or s.gcash_enabled)) then
    raise exception 'Online payment is unavailable' using errcode='22023';
  end if;
  insert into internal.checkout_intents(customer_id,payment_option,downpayment_pct,amount_minor,total_minor)
    values(p_customer_id,p_payment_option,v_pct,1,1) returning id into v_intent;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_count:=v_count+1;
    select * into v_court from public.court c
      where c.id=(v_item->>'listing_id')::uuid and c.is_active and c.status='Available';
    select * into v_unit from public.court_unit_inventory u
      where u.id=(v_item->>'unit_id')::uuid and u.court_id=v_court.id and u.is_active and u.inventory_verified;
    if v_court.id is null or v_unit.id is null then raise exception 'Court or lane is unavailable' using errcode='22023'; end if;
    v_start:=(v_item->>'starts_at')::timestamptz;
    v_end:=(v_item->>'ends_at')::timestamptz;
    v_qty:=coalesce((v_item->>'rate_quantity')::integer,1);
    if v_start is null or v_end is null or v_start<=now()+interval '2 minutes'
      or v_end<=v_start or v_end>v_start+interval '12 hours' or v_qty not between 1 and 100 then
      raise exception 'Choose a future court time' using errcode='22023';
    end if;
    if (v_start at time zone 'Asia/Manila')::date <> (v_end at time zone 'Asia/Manila')::date
      or (v_start at time zone 'Asia/Manila')::time < time '08:00'
      or (v_end at time zone 'Asia/Manila')::time > time '20:00' then
      raise exception 'Choose a time between 8:00 AM and 8:00 PM on one day' using errcode='22023';
    end if;
    v_minutes:=ceil(extract(epoch from (v_end-v_start))/60)::integer;
    v_rate_unit:=internal.authoritative_reservation_rate_unit(v_court.id,v_unit.id);
    if v_rate_unit not in ('/hr','/set') then raise exception 'Court rate is unavailable' using errcode='22023'; end if;
    if v_rate_unit='/set' and (v_end <> v_start+make_interval(mins=>v_qty*60) or v_minutes<>v_qty*60) then
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
    if v_resource_count=0 then raise exception 'Court or lane has no available connection' using errcode='22023'; end if;
    v_total_minor:=v_total_minor+round(v_total*100)::bigint;
    v_charge_minor:=v_charge_minor+round(v_charge*100)::bigint;
  end loop;
  update internal.checkout_intents set total_minor=v_total_minor,amount_minor=v_charge_minor where id=v_intent;
  insert into internal.paymongo_checkout_attempts(booking_id,intent_id,customer_id,amount_minor,total_minor,payment_option)
    values(null,v_intent,p_customer_id,v_charge_minor,v_total_minor,p_payment_option);
  return (select jsonb_build_object('attempt_id',a.id,'intent_id',v_intent,'amount_minor',a.amount_minor,
    'total_minor',a.total_minor,'item_count',v_count,'expires_at',i.expires_at)
    from internal.paymongo_checkout_attempts a join internal.checkout_intents i on i.id=a.intent_id where a.intent_id=v_intent);
exception when exclusion_violation then
  raise exception 'This physical court is already reserved during the selected time' using errcode='23P01';
end;
$$;
