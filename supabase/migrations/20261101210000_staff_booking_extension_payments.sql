-- Staff booking extensions reserve the immediately following physical slot.
-- Online holds share the checkout item exclusion mechanism; the booking end
-- changes only in the cash RPC or the verified PayMongo settlement branch.
create table internal.staff_booking_extension_checkouts (
  intent_id uuid primary key references internal.checkout_intents(id) on delete restrict,
  source text not null check (source in ('booking','walkin')),
  reservation_id bigint not null,
  staff_id uuid not null references public.profiles(id) on delete restrict,
  old_end_at timestamptz not null,
  new_end_at timestamptz not null,
  amount_minor bigint not null check (amount_minor > 0),
  status text not null default 'creating' check (status in ('creating','ready','paid','expired','review')),
  payment_id bigint references public.payment(payment_id),
  created_at timestamptz not null default now(),
  check (new_end_at > old_end_at)
);
alter table internal.staff_booking_extension_checkouts enable row level security;
revoke all on internal.staff_booking_extension_checkouts from public,anon,authenticated;
grant usage on schema internal to service_role;
grant select,insert,update on internal.staff_booking_extension_checkouts to service_role;
alter table internal.checkout_intent_items add column extension_source text check (extension_source in ('booking','walkin'));
alter table internal.checkout_intent_items add column extension_reservation_id bigint;

create or replace function internal.staff_extension_row(p_source text,p_id bigint)
returns table(starts_at timestamptz,ends_at timestamptz,checked_in_at timestamptz,
  checked_out_at timestamptz,status text,customer_id uuid,listing_id uuid,unit_id uuid,court_name text,
  unit_name text,rate_unit text,sports_name text,base_total numeric,base_paid numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_source='booking' then
    return query select b.time_date,b.end_at,b.checked_in_at,b.checked_out_at,b.status,b.customer_id,
      b.court_listing_id,b.court_unit_inventory_id,b.courts,b.court_unit,b.rate_unit_snapshot,
      b.sports,b.amount_total,b.amount_paid
      from public.booking b where b.booking_id=p_id;
  elsif p_source='walkin' then
    return query select w.time_date,w.end_at,w.checked_in_at,w.checked_out_at,w.status,w.customer_id,
      w.court_listing_id,w.court_unit_inventory_id,w.courts,w.court_unit,w.rate_unit_snapshot,
      w.sports,w.amount_total,w.amount_paid
      from public.walk_in_booking w where w.walkin_id=p_id;
  end if;
end;
$$;
revoke all on function internal.staff_extension_row(text,bigint) from public,anon,authenticated,service_role;

create or replace function public.staff_booking_extension_options(p_source text,p_id bigint,p_staff_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r record; v_actor uuid:=coalesce((select auth.uid()),p_staff_id); v_rule record; v_max_end timestamptz;
  v_minutes integer; v_max_minutes integer; v_amount numeric; v_base numeric; v_options jsonb:='[]'::jsonb; v_blocked boolean;
begin
  if v_actor is null or ((select auth.uid()) is null and (select auth.jwt()->>'role') is distinct from 'service_role')
    or not exists(select 1 from public.profiles p where p.id=v_actor
    and p.role='staff' and p.status='active') then
    raise exception 'Active staff access is required' using errcode='42501';
  end if;
  if p_source not in ('booking','walkin') or p_id is null or p_id<=0 then
    raise exception 'Invalid reservation' using errcode='22023';
  end if;
  select * into r from internal.staff_extension_row(p_source,p_id);
  if not found or r.status<>'confirmed' or r.checked_in_at is null or r.checked_out_at is not null
    or r.ends_at is null or r.ends_at<=now() or r.unit_id is null or r.rate_unit<>'/hr'
    or internal.authoritative_reservation_rate_unit(r.listing_id,r.unit_id)<>'/hr'
    or extract(minute from r.ends_at)<>0 or extract(second from r.ends_at)<>0 then
    return jsonb_build_object('options','[]'::jsonb);
  end if;
  select * into v_rule from internal.booking_rule_for_date((r.ends_at at time zone 'Asia/Manila')::date);
  if not found or v_rule.is_closed then return jsonb_build_object('options','[]'::jsonb); end if;
  v_max_end:=((r.ends_at at time zone 'Asia/Manila')::date+v_rule.closes_at) at time zone 'Asia/Manila';
  if v_rule.closes_at<=v_rule.opens_at then v_max_end:=v_max_end+interval '1 day'; end if;
  v_max_minutes:=greatest(0,floor(extract(epoch from (v_max_end-r.ends_at))/3600)::integer*60);
  v_base:=internal.authoritative_reservation_amount(r.listing_id,r.unit_id,r.starts_at,r.ends_at,
    extract(epoch from (r.ends_at-r.starts_at))::integer/60,1);
  if v_base is null or v_base<=0 then return jsonb_build_object('options','[]'::jsonb); end if;
  if v_max_minutes>=60 then
    for v_minutes in 60..v_max_minutes by 60 loop
      select exists(select 1 from internal.reservation_resource_slots s
        join public.court_unit_resource_map m on m.resource_id=s.resource_id
        where m.court_unit_id=r.unit_id and s.during && pg_catalog.tstzrange(r.ends_at,r.ends_at+make_interval(mins=>v_minutes),'[)')
          and not (p_source='booking' and s.booking_id=p_id)
          and not (p_source='walkin' and s.walkin_id=p_id)) into v_blocked;
      exit when v_blocked;
      v_amount:=internal.authoritative_reservation_amount(r.listing_id,r.unit_id,r.starts_at,
        r.ends_at+make_interval(mins=>v_minutes),extract(epoch from (r.ends_at-r.starts_at))/60+v_minutes,1)-v_base;
      if v_amount is null or v_amount<=0 then exit; end if;
      v_options:=v_options||jsonb_build_array(jsonb_build_object(
        'duration_minutes',v_minutes,'amount_minor',round(v_amount*100)::bigint,
        'new_end_at',r.ends_at+make_interval(mins=>v_minutes)));
    end loop;
  end if;
  return jsonb_build_object('options',v_options);
end;
$$;
revoke all on function public.staff_booking_extension_options(text,bigint,uuid) from public,anon;
grant execute on function public.staff_booking_extension_options(text,bigint,uuid) to authenticated,service_role;

create or replace function internal.apply_staff_booking_extension(p_source text,p_id bigint,
  p_duration_minutes integer,p_amount_minor bigint,p_payment_method text,p_cash_tendered_minor bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r record; v_actor uuid:=(select auth.uid()); v_rule record; v_max_end timestamptz;
  v_amount numeric; v_base numeric; v_payment_id bigint; v_receipt jsonb; v_tender bigint; v_change bigint;
  v_role text; v_new_end timestamptz;
begin
  if v_actor is null or not exists(select 1 from public.profiles p where p.id=v_actor
    and p.role='staff' and p.status='active') then
    raise exception 'Active staff access is required' using errcode='42501';
  end if;
  if p_source not in ('booking','walkin') or p_id is null or p_id<=0
    or p_duration_minutes is null or p_duration_minutes<60 or p_duration_minutes%60<>0
    or p_payment_method not in ('Cash','PayMongo') then
    raise exception 'Invalid booking extension' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
  select * into r from internal.staff_extension_row(p_source,p_id);
  if not found or r.status<>'confirmed' or r.checked_in_at is null or r.checked_out_at is not null
    or r.ends_at is null or r.ends_at<=now() or r.unit_id is null or r.rate_unit<>'/hr'
    or internal.authoritative_reservation_rate_unit(r.listing_id,r.unit_id)<>'/hr'
    or extract(minute from r.ends_at)<>0 or extract(second from r.ends_at)<>0 then
    raise exception 'Only an ongoing hourly reservation can be extended' using errcode='55000';
  end if;
  select * into v_rule from internal.booking_rule_for_date((r.ends_at at time zone 'Asia/Manila')::date);
  if not found or v_rule.is_closed then raise exception 'The venue is closed after this reservation' using errcode='22023'; end if;
  v_max_end:=((r.ends_at at time zone 'Asia/Manila')::date+v_rule.closes_at) at time zone 'Asia/Manila';
  if v_rule.closes_at<=v_rule.opens_at then v_max_end:=v_max_end+interval '1 day'; end if;
  v_new_end:=r.ends_at+make_interval(mins=>p_duration_minutes);
  if v_new_end>v_max_end then raise exception 'Extension exceeds operating hours' using errcode='22023'; end if;
  if exists(select 1 from internal.reservation_resource_slots s
    join public.court_unit_resource_map m on m.resource_id=s.resource_id
    where m.court_unit_id=r.unit_id and s.during && pg_catalog.tstzrange(r.ends_at,v_new_end,'[)')
      and not (p_source='booking' and s.booking_id=p_id)
      and not (p_source='walkin' and s.walkin_id=p_id)) then
    raise exception 'The next time is no longer available' using errcode='23P01';
  end if;
  v_base:=internal.authoritative_reservation_amount(r.listing_id,r.unit_id,r.starts_at,r.ends_at,
    extract(epoch from (r.ends_at-r.starts_at))::integer/60,1);
  v_amount:=internal.authoritative_reservation_amount(r.listing_id,r.unit_id,r.starts_at,v_new_end,
    extract(epoch from (v_new_end-r.starts_at))::integer/60,1)-v_base;
  if v_amount is null or round(v_amount*100)::bigint<>p_amount_minor then
    raise exception 'The extension price changed. Refresh availability and try again.' using errcode='40001';
  end if;
  if p_payment_method='Cash' then
    if not exists(select 1 from public.app_settings s where s.id=true and s.cash_enabled) then
      raise exception 'Cash collection is disabled' using errcode='42501';
    end if;
    v_tender:=p_cash_tendered_minor;
    if v_tender is null or v_tender<p_amount_minor then raise exception 'Cash received must cover the extension amount' using errcode='22023'; end if;
    v_change:=v_tender-p_amount_minor;
  else
    if p_cash_tendered_minor is not null then raise exception 'Invalid cash tender for PayMongo' using errcode='22023'; end if;
  end if;
  perform set_config('inigosync.staff_payment_rpc','on',true);
  insert into public.payment(cost,paid,payment_method,down_full,base_minor,fee_minor,gross_minor,net_minor,
    cash_tendered_minor,cash_change_minor)
    values(v_amount,v_amount,p_payment_method,'full',p_amount_minor,0,p_amount_minor,p_amount_minor,
      case when p_payment_method='Cash' then v_tender end,case when p_payment_method='Cash' then v_change end)
    returning payment_id into v_payment_id;
  if p_source='booking' then
    update public.booking set end_at=v_new_end,amount_total=coalesce(amount_total,v_base)+v_amount,
      amount_paid=amount_paid+v_amount,balance_payment_id=v_payment_id,
      balance_payment_method=p_payment_method,balance_paid_at=now()
      where booking_id=p_id and end_at=r.ends_at;
  else
    update public.walk_in_booking set end_at=v_new_end,amount_total=coalesce(amount_total,v_base)+v_amount,
      amount_paid=amount_paid+v_amount,balance_payment_id=v_payment_id,
      balance_payment_method=p_payment_method,balance_paid_at=now()
      where walkin_id=p_id and end_at=r.ends_at;
  end if;
  if not found then raise exception 'Reservation changed before the extension was saved' using errcode='40001'; end if;
  v_receipt:=internal.persist_payment_acknowledgment(v_payment_id,p_source,p_id,null);
  if p_payment_method='Cash' then
    update internal.payment_acknowledgments set payload=payload||jsonb_build_object(
      'cash_tendered_minor',v_tender,'cash_change_minor',v_change,
      'cash_tendered',v_tender/100.0,'cash_change',v_change/100.0)
      where payment_id=v_payment_id returning payload into v_receipt;
  end if;
  select p.role into v_role from public.profiles p where p.id=v_actor;
  insert into public.audit_log(actor_id,actor_role,action,entity_type,entity_id,details)
    values(v_actor,coalesce(v_role,'staff'),'booking_extended',p_source,p_id::text,
      jsonb_build_object('payment_id',v_payment_id,'old_end_at',r.ends_at,'new_end_at',v_new_end,
        'extension_minutes',p_duration_minutes,'amount',v_amount,'payment_method',p_payment_method));
  return jsonb_build_object('ok',true,'payment_id',v_payment_id,'receipt',v_receipt,'new_end_at',v_new_end);
end;
$$;
revoke all on function internal.apply_staff_booking_extension(text,bigint,integer,bigint,text,bigint) from public,anon,authenticated,service_role;

create or replace function internal.guard_open_booking_extension()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_source text; v_id bigint;
begin
  if coalesce(current_setting('inigosync.staff_extension_rpc',true),'')='on' then return new; end if;
  if new.end_at is not distinct from old.end_at and new.checked_out_at is not distinct from old.checked_out_at then return new; end if;
  v_source:=case when tg_table_name='booking' then 'booking' else 'walkin' end;
  v_id:=case when tg_table_name='booking' then new.booking_id else new.walkin_id end;
  if exists(select 1 from internal.staff_booking_extension_checkouts x
    join internal.paymongo_checkout_attempts a on a.intent_id=x.intent_id
    where x.source=v_source and x.reservation_id=v_id and x.status in ('creating','ready')
      and a.status in ('creating','ready','review')) then
    raise exception 'An online extension is open; finish or expire that checkout before changing this reservation' using errcode='55000';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_open_booking_extension() from public,anon,authenticated,service_role;
drop trigger if exists booking_guard_open_extension on public.booking;
create trigger booking_guard_open_extension before update on public.booking
  for each row execute function internal.guard_open_booking_extension();
drop trigger if exists walkin_guard_open_extension on public.walk_in_booking;
create trigger walkin_guard_open_extension before update on public.walk_in_booking
  for each row execute function internal.guard_open_booking_extension();

-- A provider-paid checkout that cannot be applied is terminal review work.
-- Release its physical hold regardless of which settlement validation failed,
-- including shared fee checks before the extension branch below.
create or replace function internal.release_reviewed_staff_extension_hold()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status='review' and new.paymongo_payment_id is not null and new.intent_id is not null
     and exists(select 1 from internal.staff_booking_extension_checkouts x where x.intent_id=new.intent_id) then
    update internal.staff_booking_extension_checkouts set status='review'
      where intent_id=new.intent_id and status<>'paid';
    delete from internal.reservation_resource_slots s where s.hold_item_id in
      (select i.id from internal.checkout_intent_items i where i.intent_id=new.intent_id);
  end if;
  return new;
end;
$$;
revoke all on function internal.release_reviewed_staff_extension_hold() from public,anon,authenticated,service_role;
drop trigger if exists paymongo_release_reviewed_staff_extension_hold on internal.paymongo_checkout_attempts;
create trigger paymongo_release_reviewed_staff_extension_hold after update of status,paymongo_payment_id
  on internal.paymongo_checkout_attempts for each row
  when (new.status='review' and new.paymongo_payment_id is not null)
  execute function internal.release_reviewed_staff_extension_hold();

create or replace function public.staff_collect_cash_for_booking_extension(p_source text,p_id bigint,
  p_duration_minutes integer,p_cash_tendered_minor bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_options jsonb; v_item jsonb; v_amount bigint;
begin
  v_options:=public.staff_booking_extension_options(p_source,p_id)->'options';
  select value into v_item from jsonb_array_elements(v_options) where (value->>'duration_minutes')::integer=p_duration_minutes;
  if v_item is null then raise exception 'The requested extension is unavailable' using errcode='23P01'; end if;
  v_amount:=(v_item->>'amount_minor')::bigint;
  return internal.apply_staff_booking_extension(p_source,p_id,p_duration_minutes,v_amount,'Cash',p_cash_tendered_minor);
end;
$$;
revoke all on function public.staff_collect_cash_for_booking_extension(text,bigint,integer,bigint) from public,anon;
grant execute on function public.staff_collect_cash_for_booking_extension(text,bigint,integer,bigint) to authenticated;

create or replace function public.prepare_staff_booking_extension_checkout(p_source text,p_id bigint,
  p_duration_minutes integer,p_staff_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_options jsonb; v_item jsonb; r record; v_intent uuid; v_item_id uuid; v_attempt uuid; v_amount bigint;
  v_new_end timestamptz; v_minutes integer; v_resource_count integer;
begin
  if p_staff_id is null or not exists(select 1 from public.profiles p where p.id=p_staff_id
    and p.role='staff' and p.status='active') then raise exception 'Active staff access is required' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
  v_options:=public.staff_booking_extension_options(p_source,p_id,p_staff_id)->'options';
  select value into v_item from jsonb_array_elements(v_options) where (value->>'duration_minutes')::integer=p_duration_minutes;
  if v_item is null then raise exception 'The requested extension is unavailable' using errcode='23P01'; end if;
  select * into r from internal.staff_extension_row(p_source,p_id);
  v_amount:=(v_item->>'amount_minor')::bigint;
  v_new_end:=(v_item->>'new_end_at')::timestamptz;
  v_minutes:=p_duration_minutes;
  if r.ends_at<=now()+interval '1 second' then
    raise exception 'Online extension checkout must start before the current booking ends' using errcode='55000';
  end if;
  insert into internal.checkout_intents(customer_id,status,payment_option,downpayment_pct,amount_minor,total_minor,expires_at)
    values(coalesce(r.customer_id,p_staff_id),'creating','full',100,v_amount,v_amount,
      least(now()+interval '15 minutes',r.ends_at-interval '1 second')) returning id into v_intent;
  insert into internal.checkout_intent_items(intent_id,listing_id,unit_id,sports,courts,court_unit,
    starts_at,ends_at,duration_minutes,rate_quantity,rate_unit,total_minor,charge_minor,extension_source,extension_reservation_id)
    values(v_intent,r.listing_id,r.unit_id,r.sports_name,r.court_name,r.unit_name,r.ends_at,v_new_end,
      v_minutes,1,'/hr',v_amount,v_amount,p_source,p_id) returning id into v_item_id;
  insert into internal.reservation_resource_slots(hold_item_id,resource_id,during)
    select v_item_id,m.resource_id,pg_catalog.tstzrange(r.ends_at,v_new_end,'[)')
    from public.court_unit_resource_map m join public.physical_court_resource pr
      on pr.id=m.resource_id and pr.is_active where m.court_unit_id=r.unit_id;
  get diagnostics v_resource_count=row_count;
  if v_resource_count=0 then raise exception 'Court unit has no active physical slot' using errcode='22023'; end if;
  insert into internal.staff_booking_extension_checkouts(intent_id,source,reservation_id,staff_id,
    old_end_at,new_end_at,amount_minor)
    values(v_intent,p_source,p_id,p_staff_id,r.ends_at,v_new_end,v_amount);
  insert into internal.paymongo_checkout_attempts(booking_id,intent_id,customer_id,amount_minor,total_minor,
    payment_option,pass_on_fees,staff_id)
    values(null,v_intent,coalesce(r.customer_id,p_staff_id),v_amount,v_amount,'full',true,p_staff_id)
    returning id into v_attempt;
  return jsonb_build_object('intent_id',v_intent,'attempt_id',v_attempt,'amount_minor',v_amount,
    'status','creating','expires_at',now()+interval '15 minutes');
end;
$$;

revoke all on function public.prepare_staff_booking_extension_checkout(text,bigint,integer,uuid) from public,anon,authenticated;
grant execute on function public.prepare_staff_booking_extension_checkout(text,bigint,integer,uuid) to service_role;

create or replace function public.mark_staff_booking_extension_ready(p_attempt_id uuid,p_session_id text,p_checkout_url text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_intent uuid; v_ok boolean;
begin
  select a.intent_id into v_intent from internal.paymongo_checkout_attempts a
    join internal.staff_booking_extension_checkouts x on x.intent_id=a.intent_id
    where a.id=p_attempt_id and x.status='creating' for update of a,x;
  if v_intent is null then return false; end if;
  v_ok:=public.attach_paymongo_checkout(p_attempt_id,p_session_id,p_checkout_url);
  if not v_ok then return false; end if;
  update internal.checkout_intents set status='ready',updated_at=now() where id=v_intent and status='creating';
  update internal.staff_booking_extension_checkouts set status='ready' where intent_id=v_intent and status='creating';
  return true;
end;
$$;
revoke all on function public.mark_staff_booking_extension_ready(uuid,text,text) from public,anon,authenticated;
grant execute on function public.mark_staff_booking_extension_ready(uuid,text,text) to service_role;

create or replace function public.staff_booking_extension_result(p_attempt_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=(select auth.uid()); v_result jsonb;
begin
  if v_actor is null or not exists(select 1 from public.profiles p where p.id=v_actor
    and p.role='staff' and p.status='active') then
    raise exception 'Active staff access is required' using errcode='42501';
  end if;
  select jsonb_build_object('status',a.status,'receipt',ack.payload,'source',x.source,
      'reservation_id',x.reservation_id,'new_end_at',x.new_end_at)
    into v_result
    from internal.paymongo_checkout_attempts a
    join internal.staff_booking_extension_checkouts x on x.intent_id=a.intent_id
    left join internal.payment_acknowledgments ack on ack.payment_id=x.payment_id
    where a.id=p_attempt_id and x.staff_id=v_actor;
  if v_result is null then raise exception 'Extension checkout not found' using errcode='P0002'; end if;
  return v_result;
end;
$$;
revoke all on function public.staff_booking_extension_result(uuid) from public,anon;
grant execute on function public.staff_booking_extension_result(uuid) to authenticated;

-- The existing settlement function remains the single signed-webhook entry
-- point. Insert the extension branch before ordinary cart intents are expanded.
do $migration$
declare v_definition text; v_updated text; v_marker text;
begin
  v_definition:=pg_catalog.pg_get_functiondef('public.record_paymongo_paid(text,text,text,bigint,bigint,bigint)'::regprocedure);
  -- Match the top-level cart branch only. The same IF text also occurs inside
  -- the fee-mismatch branch with deeper indentation.
  v_marker:=E'\n  if a.intent_id is not null then';
  if (length(v_definition)-length(replace(v_definition,v_marker,'')))/length(v_marker)<>1 then
    raise exception 'PayMongo settlement function changed; review booking extension integration';
  end if;
  v_updated:=replace(v_definition,v_marker,$branch$
  if a.intent_id is not null and exists(select 1 from internal.staff_booking_extension_checkouts x where x.intent_id=a.intent_id) then
    select * into v_intent from internal.checkout_intents where id=a.intent_id for update;
    select * into x from internal.checkout_intent_items where intent_id=a.intent_id limit 1 for update;
    if a.status not in ('ready','review') or v_intent.status not in ('ready','review')
       or x.id is null or x.charge_minor<>a.amount_minor then
      update internal.staff_booking_extension_checkouts set status='review' where intent_id=a.intent_id;
      update internal.checkout_intents set status='review',updated_at=now() where id=a.intent_id;
      update internal.paymongo_checkout_attempts set status='review',paymongo_payment_id=p_payment_id,
        fee_minor=p_fee_minor,gross_minor=p_amount_minor,net_minor=p_net_minor,updated_at=now() where id=a.id;
      return 'review';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
    if x.starts_at<=now() then
      update internal.staff_booking_extension_checkouts set status='review' where intent_id=a.intent_id;
      update internal.checkout_intents set status='review',updated_at=now() where id=a.intent_id;
      delete from internal.reservation_resource_slots where hold_item_id=x.id;
      update internal.paymongo_checkout_attempts set status='review',paymongo_payment_id=p_payment_id,
        fee_minor=p_fee_minor,gross_minor=p_amount_minor,net_minor=p_net_minor,updated_at=now() where id=a.id;
      insert into public.audit_log(actor_id,actor_role,action,entity_type,entity_id,details)
        select e.staff_id,coalesce(p.role,'staff'),'paid_extension_after_original_end','paymongo_checkout',a.id::text,
          jsonb_build_object('paymongo_payment_id',p_payment_id,'booking_source',e.source,
            'reservation_id',e.reservation_id,'original_end_at',e.old_end_at,
            'extension_end_at',e.new_end_at,'refund_review_required',true)
        from internal.staff_booking_extension_checkouts e
        left join public.profiles p on p.id=e.staff_id where e.intent_id=a.intent_id;
      return 'review';
    end if;
    if x.extension_source='booking' then
      select b.end_at into v_balance_end from public.booking b where b.booking_id=x.extension_reservation_id
        and b.status='confirmed' and b.checked_in_at is not null and b.checked_out_at is null for update;
    else
      select w.end_at into v_balance_end from public.walk_in_booking w where w.walkin_id=x.extension_reservation_id
        and w.status='confirmed' and w.checked_in_at is not null and w.checked_out_at is null for update;
    end if;
    if not exists(select 1 from internal.staff_booking_extension_checkouts e where e.intent_id=a.intent_id and e.status='ready')
       or v_balance_end is distinct from x.starts_at then
      update internal.staff_booking_extension_checkouts set status='review' where intent_id=a.intent_id;
      update internal.checkout_intents set status='review',updated_at=now() where id=a.intent_id;
      update internal.paymongo_checkout_attempts set status='review',paymongo_payment_id=p_payment_id,
        fee_minor=p_fee_minor,gross_minor=p_amount_minor,net_minor=p_net_minor,updated_at=now() where id=a.id;
      return 'review';
    end if;
    v_due:=a.amount_minor;
    perform set_config('inigosync.staff_payment_rpc','on',true);
    perform set_config('inigosync.staff_extension_rpc','on',true);
    insert into public.payment(cost,paid,payment_method,down_full,base_minor,fee_minor,gross_minor,net_minor)
      values(v_due/100.0,v_due/100.0,'PayMongo','full',v_due,p_fee_minor,p_amount_minor,p_net_minor)
      returning payment_id into v_payment_id;
    if x.extension_source='booking' then
      delete from internal.reservation_resource_slots where hold_item_id=x.id;
      update public.booking set end_at=x.ends_at,amount_total=coalesce(amount_total,
        internal.authoritative_reservation_amount(court_listing_id,court_unit_inventory_id,time_date,x.starts_at,
          extract(epoch from (x.starts_at-time_date))::integer/60,1))+v_due/100.0,
        amount_paid=amount_paid+v_due/100.0,balance_payment_id=v_payment_id,
        balance_payment_method='PayMongo',balance_paid_at=now()
        where booking_id=x.extension_reservation_id and end_at=x.starts_at;
      perform internal.persist_payment_acknowledgment(v_payment_id,'booking',x.extension_reservation_id,null);
    else
      delete from internal.reservation_resource_slots where hold_item_id=x.id;
      update public.walk_in_booking set end_at=x.ends_at,amount_total=coalesce(amount_total,
        internal.authoritative_reservation_amount(court_listing_id,court_unit_inventory_id,time_date,x.starts_at,
          extract(epoch from (x.starts_at-time_date))::integer/60,1))+v_due/100.0,
        amount_paid=amount_paid+v_due/100.0,balance_payment_id=v_payment_id,
        balance_payment_method='PayMongo',balance_paid_at=now()
        where walkin_id=x.extension_reservation_id and end_at=x.starts_at;
      perform internal.persist_payment_acknowledgment(v_payment_id,'walkin',x.extension_reservation_id,null);
    end if;
    update internal.staff_booking_extension_checkouts set status='paid',payment_id=v_payment_id where intent_id=a.intent_id;
    update internal.checkout_intents set status='paid',updated_at=now() where id=a.intent_id;
    update internal.paymongo_checkout_attempts set status='paid',paymongo_payment_id=p_payment_id,
      fee_minor=p_fee_minor,gross_minor=p_amount_minor,net_minor=p_net_minor,updated_at=now() where id=a.id;
    return 'paid';
  end if;
$branch$||v_marker);
  if v_updated=v_definition then raise exception 'Could not add booking extension settlement branch'; end if;
  execute v_updated;
end;
$migration$;
