-- Online staff walk-ins reserve physical resources while PayMongo is active,
-- but do not become public walk-in reservations until trusted settlement.
alter table internal.reservation_resource_slots
  add column walkin_order_id uuid references internal.staff_walkin_orders(id) on delete restrict;
alter table internal.reservation_resource_slots
  drop constraint reservation_resource_slots_one_source;
alter table internal.reservation_resource_slots
  add constraint reservation_resource_slots_one_source
  check (num_nonnulls(booking_id,walkin_id,maintenance_id,hold_item_id,walkin_order_id)=1);
create table internal.staff_walkin_order_reservations (
  id bigint generated always as identity primary key,
  order_id uuid not null references internal.staff_walkin_orders(id) on delete restrict,
  staff_id uuid not null references public.profiles(id) on delete restrict,
  customer_id uuid references public.profiles(id) on delete set null,
  sports text not null,
  courts text not null,
  time_date timestamptz not null,
  end_at timestamptz not null,
  duration_minutes integer not null check (duration_minutes > 0),
  court_unit text not null,
  court_listing_id uuid not null references public.court(id) on delete restrict,
  court_unit_inventory_id uuid not null references public.court_unit_inventory(id) on delete restrict,
  rate_quantity integer not null check (rate_quantity between 1 and 100),
  rate_unit_snapshot text not null check (rate_unit_snapshot in ('/hr','/set')),
  customer_name text,
  customer_mobile text,
  amount_total numeric not null check (amount_total > 0),
  created_at timestamptz not null default now(),
  check (end_at > time_date)
);
create index staff_walkin_order_reservations_order_idx
  on internal.staff_walkin_order_reservations(order_id,id);
alter table internal.staff_walkin_order_reservations enable row level security;
revoke all on internal.staff_walkin_order_reservations from public,anon,authenticated;
grant select,insert,update on internal.staff_walkin_order_reservations to service_role;
grant usage,select on sequence internal.staff_walkin_order_reservations_id_seq to service_role;

-- Return only the authenticated staff member's active attempt reference to
-- the trusted Edge Function. Provider identifiers never go to the browser.
create or replace function public.get_staff_walkin_checkout_cancellation(
  p_order_id uuid,p_staff_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if p_staff_id is null or not exists(select 1 from public.profiles p where p.id=p_staff_id
    and p.role in ('staff','admin') and p.status='active') then
    raise exception 'Active staff access is required' using errcode='42501';
  end if;
  select jsonb_build_object('attempt_id',a.id,'status',a.status,'session_id',a.paymongo_session_id)
    into v_result
    from internal.staff_walkin_orders o
    join internal.paymongo_checkout_attempts a on a.walkin_order_id=o.id
    where o.id=p_order_id and o.staff_id=p_staff_id and a.pass_on_fees=true
      and (a.paymongo_session_id is null or left(a.paymongo_session_id,3)='cs_')
      and ((o.status in ('awaiting_payment','review') and a.status in ('creating','ready','review'))
        or (o.status='expired' and a.status='expired' and a.paymongo_session_id is not null))
    order by a.created_at desc limit 1;
  return v_result;
end;
$$;
revoke all on function public.get_staff_walkin_checkout_cancellation(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_staff_walkin_checkout_cancellation(uuid,uuid) to service_role;

-- Existing trusted staff creation keeps its API and pricing checks. This
-- trigger diverts only online order children into private staging and writes
-- their exclusion-backed hold in the same transaction.
create or replace function internal.stage_online_walkin_reservation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_order internal.staff_walkin_orders%rowtype; v_stage_id bigint; v_count integer;
begin
  if new.walkin_order_id is null then return new; end if;
  select * into v_order from internal.staff_walkin_orders o where o.id=new.walkin_order_id;
  if not found then raise exception 'Walk-in order does not exist' using errcode='23503'; end if;
  if v_order.status='paid' then return new; end if;
  if v_order.status not in ('awaiting_payment','review') then
    raise exception 'Walk-in order is not eligible for reservation rows' using errcode='55000';
  end if;
  if new.status<>'pending' or new.payment_id is not null or new.payment_method is not null then
    raise exception 'Unpaid online walk-in orders cannot create public reservations' using errcode='55000';
  end if;
  insert into internal.staff_walkin_order_reservations(order_id,staff_id,customer_id,sports,courts,
    time_date,end_at,duration_minutes,court_unit,court_listing_id,court_unit_inventory_id,
    rate_quantity,rate_unit_snapshot,customer_name,customer_mobile,amount_total)
  values(new.walkin_order_id,new.staff_id,new.customer_id,new.sports,new.courts,new.time_date,
    new.end_at,new.duration_minutes,new.court_unit,new.court_listing_id,new.court_unit_inventory_id,
    new.rate_quantity,new.rate_unit_snapshot,new.customer_name,new.customer_mobile,new.amount_total)
  returning id into v_stage_id;
  insert into internal.reservation_resource_slots(walkin_order_id,resource_id,during)
  select new.walkin_order_id,m.resource_id,tstzrange(new.time_date,new.end_at,'[)')
    from public.court_unit_resource_map m
    join public.physical_court_resource r on r.id=m.resource_id and r.is_active
    where m.court_unit_id=new.court_unit_inventory_id;
  get diagnostics v_count=row_count;
  if v_count=0 then raise exception 'This walk-in court has no configured physical resource' using errcode='23503'; end if;
  return null;
exception when exclusion_violation then
  raise exception 'One of the selected physical courts is already reserved at that time' using errcode='23P01';
end;
$$;
revoke all on function internal.stage_online_walkin_reservation() from public,anon,authenticated;
drop trigger if exists walkin_stage_online_order on public.walk_in_booking;
create trigger walkin_stage_online_order before insert on public.walk_in_booking
for each row execute function internal.stage_online_walkin_reservation();

-- Permit only the settlement trigger's trusted PayMongo insert when an order
-- has already transitioned to paid. Manual/cash guard behavior stays intact.
do $migration$
declare v_definition text; v_updated text; v_old text;
begin
  v_definition:=pg_catalog.pg_get_functiondef('internal.guard_new_walkin_payment()'::regprocedure);
  v_old:='elsif v_order_status=''paid'' and new.status=''confirmed'' and new.payment_method=''Cash''
        and new.payment_id is not null and new.amount_total>0
        and new.amount_paid=new.amount_total
        and exists(select 1 from public.app_settings s where s.id=true and s.cash_enabled) then';
  if position(v_old in v_definition)=0 then
    raise exception 'Walk-in payment guard changed; review trusted online settlement insert';
  end if;
  v_updated:=replace(v_definition,v_old,
    'elsif v_order_status=''paid'' and new.status=''confirmed''
        and new.payment_method in (''Cash'',''PayMongo'')
        and new.payment_id is not null and new.amount_total>0
        and new.amount_paid=new.amount_total
        and ((new.payment_method=''Cash'' and exists(select 1 from public.app_settings s where s.id=true and s.cash_enabled))
          or (new.payment_method=''PayMongo'' and coalesce(current_setting(''inigosync.staff_payment_rpc'',true),'''')=''on'')) then');
  execute v_updated;
end;
$migration$;

-- Cash extension requests carry the original end time selected by the staff
-- screen. Serialize before pricing and reject a queued duplicate after the
-- first transaction moves that end time.
drop function public.staff_collect_cash_for_booking_extension(text,bigint,integer,bigint);
drop function internal.apply_staff_booking_extension(text,bigint,integer,bigint,text,bigint);

create function internal.apply_staff_booking_extension(p_source text,p_id bigint,
  p_duration_minutes integer,p_amount_minor bigint,p_payment_method text,
  p_cash_tendered_minor bigint,p_expected_end_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r record; v_actor uuid:=(select auth.uid()); v_rule record; v_max_end timestamptz;
  v_amount numeric; v_base numeric; v_payment_id bigint; v_receipt jsonb; v_tender bigint; v_change bigint;
  v_role text; v_new_end timestamptz; v_locked_end timestamptz;
begin
  if v_actor is null or not exists(select 1 from public.profiles p where p.id=v_actor
    and p.role='staff' and p.status='active') then
    raise exception 'Active staff access is required' using errcode='42501';
  end if;
  if p_source not in ('booking','walkin') or p_id is null or p_id<=0
    or p_duration_minutes is null or p_duration_minutes<60 or p_duration_minutes%60<>0
    or p_payment_method not in ('Cash','PayMongo') or p_expected_end_at is null then
    raise exception 'Invalid booking extension' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
  if p_source='booking' then
    select b.end_at into v_locked_end from public.booking b where b.booking_id=p_id for update;
  else
    select w.end_at into v_locked_end from public.walk_in_booking w where w.walkin_id=p_id for update;
  end if;
  if v_locked_end is distinct from p_expected_end_at then
    raise exception 'Reservation changed. Refresh extension availability and try again.' using errcode='40001';
  end if;
  select * into r from internal.staff_extension_row(p_source,p_id);
  if not found or r.status<>'confirmed' or r.checked_in_at is null or r.checked_out_at is not null
    or r.ends_at is null or r.ends_at<=now() or r.unit_id is null or r.rate_unit<>'/hr'
    or internal.authoritative_reservation_rate_unit(r.listing_id,r.unit_id)<>'/hr'
    or extract(minute from r.ends_at)<>0 or extract(second from r.ends_at)<>0 then
    raise exception 'Only an ongoing hourly reservation can be extended' using errcode='55000';
  end if;
  if r.ends_at is distinct from p_expected_end_at then
    raise exception 'Reservation changed. Refresh extension availability and try again.' using errcode='40001';
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
  elsif p_cash_tendered_minor is not null then
    raise exception 'Invalid cash tender for PayMongo' using errcode='22023';
  end if;
  perform set_config('inigosync.staff_payment_rpc','on',true);
  perform set_config('inigosync.staff_extension_rpc','on',true);
  insert into public.payment(cost,paid,payment_method,down_full,base_minor,fee_minor,gross_minor,net_minor,
    cash_tendered_minor,cash_change_minor)
    values(v_amount,v_amount,p_payment_method,'full',p_amount_minor,0,p_amount_minor,p_amount_minor,
      case when p_payment_method='Cash' then v_tender end,case when p_payment_method='Cash' then v_change end)
    returning payment_id into v_payment_id;
  if p_source='booking' then
    update public.booking set end_at=v_new_end,amount_total=coalesce(amount_total,v_base)+v_amount,
      amount_paid=amount_paid+v_amount,balance_payment_id=v_payment_id,
      balance_payment_method=p_payment_method,balance_paid_at=now()
      where booking_id=p_id and end_at=p_expected_end_at;
  else
    update public.walk_in_booking set end_at=v_new_end,amount_total=coalesce(amount_total,v_base)+v_amount,
      amount_paid=amount_paid+v_amount,balance_payment_id=v_payment_id,
      balance_payment_method=p_payment_method,balance_paid_at=now()
      where walkin_id=p_id and end_at=p_expected_end_at;
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
      jsonb_build_object('payment_id',v_payment_id,'old_end_at',p_expected_end_at,'new_end_at',v_new_end,
        'extension_minutes',p_duration_minutes,'amount',v_amount,'payment_method',p_payment_method));
  return jsonb_build_object('ok',true,'payment_id',v_payment_id,'receipt',v_receipt,'new_end_at',v_new_end);
end;
$$;
revoke all on function internal.apply_staff_booking_extension(text,bigint,integer,bigint,text,bigint,timestamptz)
  from public,anon,authenticated,service_role;

create function public.staff_collect_cash_for_booking_extension(p_source text,p_id bigint,
  p_duration_minutes integer,p_cash_tendered_minor bigint,p_expected_end_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_options jsonb; v_item jsonb; v_amount bigint; v_selected_start timestamptz;
begin
  if p_expected_end_at is null then raise exception 'Refresh extension availability and try again' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
  v_options:=public.staff_booking_extension_options(p_source,p_id)->'options';
  select value into v_item from jsonb_array_elements(v_options)
    where (value->>'duration_minutes')::integer=p_duration_minutes;
  if v_item is null then raise exception 'The requested extension is unavailable' using errcode='23P01'; end if;
  v_amount:=(v_item->>'amount_minor')::bigint;
  v_selected_start:=(v_item->>'new_end_at')::timestamptz-make_interval(mins=>p_duration_minutes);
  if v_selected_start is distinct from p_expected_end_at then
    raise exception 'Reservation changed. Refresh extension availability and try again.' using errcode='40001';
  end if;
  return internal.apply_staff_booking_extension(p_source,p_id,p_duration_minutes,v_amount,'Cash',
    p_cash_tendered_minor,p_expected_end_at);
end;
$$;
revoke all on function public.staff_collect_cash_for_booking_extension(text,bigint,integer,bigint,timestamptz)
  from public,anon;
grant execute on function public.staff_collect_cash_for_booking_extension(text,bigint,integer,bigint,timestamptz)
  to authenticated;

-- Reuse an active provider attempt for the exact original end/extension range.
-- This makes timeout/retry paths recover the saved checkout instead of trying
-- to reserve the extension range a second time.
drop function public.prepare_staff_booking_extension_checkout(text,bigint,integer,uuid);
create function public.prepare_staff_booking_extension_checkout(p_source text,p_id bigint,
  p_duration_minutes integer,p_staff_id uuid,p_expected_end_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_options jsonb; v_item jsonb; r record; v_intent uuid; v_item_id uuid; v_attempt uuid; v_amount bigint;
  v_new_end timestamptz; v_minutes integer; v_resource_count integer; v_existing record;
  v_expires_at timestamptz;
begin
  if p_staff_id is null or not exists(select 1 from public.profiles p where p.id=p_staff_id
    and p.role='staff' and p.status='active') then
    raise exception 'Active staff access is required' using errcode='42501';
  end if;
  if p_source not in ('booking','walkin') or p_id is null or p_id<=0 or p_expected_end_at is null
    or p_duration_minutes is null or p_duration_minutes<60 or p_duration_minutes%60<>0 then
    raise exception 'Invalid booking extension' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
  if p_source='booking' then
    select b.end_at into v_new_end from public.booking b where b.booking_id=p_id for update;
  else
    select w.end_at into v_new_end from public.walk_in_booking w where w.walkin_id=p_id for update;
  end if;
  if v_new_end is distinct from p_expected_end_at then
    raise exception 'Reservation changed. Refresh extension availability and try again.' using errcode='40001';
  end if;
  select * into r from internal.staff_extension_row(p_source,p_id);
  if not found or r.status<>'confirmed' or r.checked_in_at is null or r.checked_out_at is not null
    or r.ends_at is null or r.ends_at<=now() or r.unit_id is null or r.rate_unit<>'/hr'
    or r.ends_at is distinct from p_expected_end_at then
    raise exception 'Only the current active hourly reservation can be extended' using errcode='55000';
  end if;
  v_new_end:=p_expected_end_at+make_interval(mins=>p_duration_minutes);

  select x.intent_id,a.id as attempt_id,a.status,a.checkout_url,a.checkout_request,a.amount_minor,i.expires_at
    into v_existing
    from internal.staff_booking_extension_checkouts x
    join internal.checkout_intents i on i.id=x.intent_id
    join internal.paymongo_checkout_attempts a on a.intent_id=x.intent_id
    where x.source=p_source and x.reservation_id=p_id and x.staff_id=p_staff_id
      and x.old_end_at=p_expected_end_at and x.new_end_at=v_new_end
      and x.status in ('creating','ready') and i.status in ('creating','ready')
      and a.status in ('creating','ready') and i.expires_at>now()
    order by x.created_at desc limit 1;
  if found then
    return jsonb_build_object('intent_id',v_existing.intent_id,'attempt_id',v_existing.attempt_id,
      'amount_minor',v_existing.amount_minor,'status',v_existing.status,'checkout_url',v_existing.checkout_url,
      'checkout_request',v_existing.checkout_request,'expires_at',v_existing.expires_at);
  end if;
  if exists(select 1 from internal.staff_booking_extension_checkouts x
      join internal.checkout_intent_items i on i.intent_id=x.intent_id
      join internal.paymongo_checkout_attempts a on a.intent_id=x.intent_id
      where x.source=p_source and x.reservation_id=p_id and x.old_end_at=p_expected_end_at
        and x.new_end_at=v_new_end and (x.status='review' or a.status='review')) then
    raise exception 'This extension needs staff reconciliation before retrying' using errcode='55000';
  end if;
  v_options:=public.staff_booking_extension_options(p_source,p_id,p_staff_id)->'options';
  select value into v_item from jsonb_array_elements(v_options)
    where (value->>'duration_minutes')::integer=p_duration_minutes;
  if v_item is null then raise exception 'The requested extension is unavailable' using errcode='23P01'; end if;
  if ((v_item->>'new_end_at')::timestamptz-make_interval(mins=>p_duration_minutes)) is distinct from p_expected_end_at then
    raise exception 'Reservation changed. Refresh extension availability and try again.' using errcode='40001';
  end if;
  select * into r from internal.staff_extension_row(p_source,p_id);
  v_amount:=(v_item->>'amount_minor')::bigint;
  v_new_end:=(v_item->>'new_end_at')::timestamptz;
  v_minutes:=p_duration_minutes;
  if r.ends_at<=now()+interval '1 second' then
    raise exception 'Online extension checkout must start before the current booking ends' using errcode='55000';
  end if;
  v_expires_at:=least(now()+interval '15 minutes',r.ends_at-interval '1 second');
  insert into internal.checkout_intents(customer_id,status,payment_option,downpayment_pct,amount_minor,total_minor,expires_at)
    values(coalesce(r.customer_id,p_staff_id),'creating','full',100,v_amount,v_amount,v_expires_at) returning id into v_intent;
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
    'status','creating','expires_at',v_expires_at);
end;
$$;
revoke all on function public.prepare_staff_booking_extension_checkout(text,bigint,integer,uuid,timestamptz)
  from public,anon,authenticated;
grant execute on function public.prepare_staff_booking_extension_checkout(text,bigint,integer,uuid,timestamptz)
  to service_role;

-- Concurrent idempotent retries can both return the same provider session.
-- Accept a repeated ready attachment only when both stored values match.
create or replace function public.mark_staff_booking_extension_ready(
  p_attempt_id uuid,p_session_id text,p_checkout_url text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare v_intent uuid; v_attempt_status text; v_extension_status text;
  v_saved_session text; v_saved_url text; v_ok boolean;
begin
  select a.intent_id,a.status,x.status,a.paymongo_session_id,a.checkout_url
    into v_intent,v_attempt_status,v_extension_status,v_saved_session,v_saved_url
    from internal.paymongo_checkout_attempts a
    join internal.staff_booking_extension_checkouts x on x.intent_id=a.intent_id
    where a.id=p_attempt_id for update of a,x;
  if v_intent is null then return false; end if;
  if v_attempt_status='ready' and v_extension_status='ready' then
    return coalesce(v_saved_session=p_session_id and v_saved_url=p_checkout_url,false);
  end if;
  if v_attempt_status<>'creating' or v_extension_status<>'creating' then return false; end if;
  v_ok:=public.attach_paymongo_checkout(p_attempt_id,p_session_id,p_checkout_url);
  if not v_ok then return false; end if;
  update internal.checkout_intents set status='ready',updated_at=now()
    where id=v_intent and status='creating';
  update internal.staff_booking_extension_checkouts set status='ready'
    where intent_id=v_intent and status='creating';
  return true;
end;
$$;
revoke all on function public.mark_staff_booking_extension_ready(uuid,text,text) from public,anon,authenticated;
grant execute on function public.mark_staff_booking_extension_ready(uuid,text,text) to service_role;

-- Keep stale static clients from bypassing the expected-end compare. These
-- old signatures fail closed with a refresh message during the RPC roll out.
create function public.staff_collect_cash_for_booking_extension(
  p_source text,p_id bigint,p_duration_minutes integer,p_cash_tendered_minor bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'Refresh extension availability before taking payment' using errcode='40001';
end;
$$;
revoke all on function public.staff_collect_cash_for_booking_extension(text,bigint,integer,bigint) from public,anon;
grant execute on function public.staff_collect_cash_for_booking_extension(text,bigint,integer,bigint) to authenticated;

create function public.prepare_staff_booking_extension_checkout(
  p_source text,p_id bigint,p_duration_minutes integer,p_staff_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'Refresh extension availability before starting checkout' using errcode='40001';
end;
$$;
revoke all on function public.prepare_staff_booking_extension_checkout(text,bigint,integer,uuid)
  from public,anon,authenticated;
grant execute on function public.prepare_staff_booking_extension_checkout(text,bigint,integer,uuid)
  to service_role;

-- The original insert guard routes service-role inserts through its cash-only
-- fallback. Add a narrowly scoped trusted-settlement branch for new PayMongo
-- rows; all other service-role inserts still fail closed.
do $migration$
declare v_definition text; v_updated text; v_anchor text;
begin
  v_definition:=pg_catalog.pg_get_functiondef('internal.guard_new_walkin_payment()'::regprocedure);
  v_anchor:='if v_actor is not null and exists(select 1 from public.profiles p where p.id=v_actor
    and p.role in (''staff'',''admin'') and p.status=''active'') then';
  if position(v_anchor in v_definition)=0 then
    raise exception 'Walk-in payment guard changed; review trusted service-role settlement';
  end if;
  v_updated:=replace(v_definition,v_anchor,
    'if (select auth.role())=''service_role'' and coalesce(current_setting(''inigosync.staff_payment_rpc'',true),'''')=''on'' then
    if new.walkin_order_id is null or new.status<>''confirmed'' or new.payment_method<>''PayMongo''
       or new.payment_id is null or new.amount_total is null or new.amount_total<=0
       or new.amount_paid is distinct from new.amount_total
       or not exists(select 1 from internal.staff_walkin_orders o where o.id=new.walkin_order_id
         and o.status=''paid'' and o.payment_id=new.payment_id) then
      raise exception ''Invalid PayMongo walk-in settlement insert'' using errcode=''42501'';
    end if;
  elsif v_actor is not null and exists(select 1 from public.profiles p where p.id=v_actor
    and p.role in (''staff'',''admin'') and p.status=''active'') then');
  if v_updated=v_definition then raise exception 'Could not extend trusted walk-in payment guard'; end if;
  execute v_updated;
end;
$migration$;

-- Expose only attempts belonging to the requesting active staff member to
-- cancellation handlers. The Edge Functions still verify terminal provider
-- status and mode before calling the guarded expiry RPC.
create or replace function public.get_staff_booking_extension_cancellation(
  p_attempt_id uuid,p_staff_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if p_staff_id is null or not exists(select 1 from public.profiles p where p.id=p_staff_id
    and p.role='staff' and p.status='active') then
    raise exception 'Active staff access is required' using errcode='42501';
  end if;
  select jsonb_build_object('attempt_id',a.id,'status',a.status,'session_id',a.paymongo_session_id)
    into v_result
    from internal.staff_booking_extension_checkouts x
    join internal.checkout_intents i on i.id=x.intent_id
    join internal.paymongo_checkout_attempts a on a.intent_id=x.intent_id
    where a.id=p_attempt_id and x.staff_id=p_staff_id
      and ((x.status in ('creating','ready','review')
          and a.status in ('creating','ready','review') and i.status in ('creating','ready','review')
          and (a.paymongo_session_id is null or left(a.paymongo_session_id,3)='cs_'))
        or (x.status in ('creating','ready','review','expired') and a.status='expired'
          and i.status='expired' and left(a.paymongo_session_id,3)='cs_'));
  return v_result;
end;
$$;
revoke all on function public.get_staff_booking_extension_cancellation(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_staff_booking_extension_cancellation(uuid,uuid) to service_role;

create or replace function public.get_staff_walkin_qr_cancellation(
  p_order_id uuid,p_staff_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if p_staff_id is null or not exists(select 1 from public.profiles p where p.id=p_staff_id
    and p.role in ('staff','admin') and p.status='active') then
    raise exception 'Active staff access is required' using errcode='42501';
  end if;
  select jsonb_build_object('attempt_id',a.id,'status',a.status,'intent_id',a.paymongo_session_id,
      'livemode',a.qr_livemode)
    into v_result
    from internal.staff_walkin_orders o
    join internal.paymongo_checkout_attempts a on a.walkin_order_id=o.id
    where o.id=p_order_id and o.staff_id=p_staff_id
      and a.checkout_request->>'payment_method_allowed'='["qrph"]'
      and a.pass_on_fees=false
      and ((o.status in ('awaiting_payment','review') and a.status in ('creating','ready','review')
          and (a.paymongo_session_id is null or left(a.paymongo_session_id,3)='pi_'))
        or (o.status='expired' and a.status='expired' and left(a.paymongo_session_id,3)='pi_'))
    order by a.created_at desc limit 1;
  return v_result;
end;
$$;
revoke all on function public.get_staff_walkin_qr_cancellation(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_staff_walkin_qr_cancellation(uuid,uuid) to service_role;

-- A verified provider mode may be saved before the QR image is attached.
alter table internal.paymongo_checkout_attempts
  drop constraint if exists paymongo_attempt_qr_livemode_image;
alter table internal.paymongo_checkout_attempts
  add constraint paymongo_attempt_qr_livemode_image check (
    qr_livemode is null or qr_image_url is not null or
    (pass_on_fees=false and left(paymongo_session_id,3)='pi_'
      and checkout_request->>'payment_method_allowed'='["qrph"]')
  );

-- Record the provider mode as soon as a direct QR PaymentIntent is saved,
-- before QR attachment, so retries can recognize an already-cancelled intent
-- without asking the provider again.
create or replace function public.register_staff_walkin_qr_intent(
  p_attempt_id uuid,p_request jsonb,p_intent_id text,p_livemode boolean
) returns boolean language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if p_intent_id !~ '^pi_[A-Za-z0-9]+' or p_livemode is null
     or p_request->>'payment_method_allowed' is distinct from '["qrph"]'
     or (p_request->>'amount') !~ '^[1-9][0-9]*$'
     or coalesce(p_request->>'client_key','')=''
     or (p_request->>'qr_expiry_seconds') !~ '^[0-9]+$'
     or (p_request->>'qr_expiry_seconds')::integer not between 60 and 9000 then
    raise exception 'Invalid QR Ph intent request' using errcode='22023';
  end if;
  update internal.paymongo_checkout_attempts set paymongo_session_id=p_intent_id,
    checkout_request=p_request,pass_on_fees=false,qr_livemode=p_livemode,updated_at=now()
    where id=p_attempt_id and status='creating' and walkin_order_id is not null
      and amount_minor=(p_request->>'amount')::bigint
      and (paymongo_session_id is null or paymongo_session_id=p_intent_id)
      and (qr_livemode is null or qr_livemode=p_livemode);
  get diagnostics v_count=row_count;
  return v_count=1;
end;
$$;
revoke all on function public.register_staff_walkin_qr_intent(uuid,jsonb,text,boolean) from public,anon,authenticated;
grant execute on function public.register_staff_walkin_qr_intent(uuid,jsonb,text,boolean) to service_role;

create or replace function public.mark_staff_walkin_qr_intent_expired(
  p_attempt_id uuid,p_intent_id text,p_livemode boolean
) returns boolean language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if p_livemode is null or p_intent_id !~ '^pi_[A-Za-z0-9]+' then
    raise exception 'Invalid QR Ph cancellation confirmation' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
  update internal.paymongo_checkout_attempts set qr_livemode=p_livemode,updated_at=now()
    where id=p_attempt_id and paymongo_session_id=p_intent_id and walkin_order_id is not null
      and pass_on_fees=false and checkout_request->>'payment_method_allowed'='["qrph"]'
      and paymongo_payment_id is null and status in ('creating','ready','review')
      and (qr_livemode is null or qr_livemode=p_livemode);
  get diagnostics v_count=row_count;
  if v_count<>1 then return false; end if;
  return public.mark_paymongo_checkout_expired(p_attempt_id,p_intent_id);
end;
$$;
revoke all on function public.mark_staff_walkin_qr_intent_expired(uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.mark_staff_walkin_qr_intent_expired(uuid,text,boolean) to service_role;

-- `record_paymongo_paid` marks the order paid only after validating the signed
-- event, provider amount, session and payment reference. Materialize all rows
-- in that same transaction so the slot hold transfers atomically to bookings.
create or replace function internal.materialize_settled_walkin_order()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if old.status is distinct from 'paid' and new.status='paid'
     and exists(select 1 from internal.staff_walkin_order_reservations s where s.order_id=new.id) then
    delete from internal.reservation_resource_slots where walkin_order_id=new.id;
    perform set_config('inigosync.staff_payment_rpc','on',true);
    perform set_config('inigosync.staff_walkin_rpc','on',true);
    for r in select * from internal.staff_walkin_order_reservations s
      where s.order_id=new.id order by s.time_date,s.id loop
      insert into public.walk_in_booking(staff_id,customer_id,walkin_order_id,sports,courts,time_date,end_at,
        duration_minutes,court_unit,court_listing_id,court_unit_inventory_id,rate_quantity,rate_unit_snapshot,
        customer_name,customer_mobile,status,payment_method,payment_id,amount_total,amount_paid)
      values(r.staff_id,r.customer_id,new.id,r.sports,r.courts,r.time_date,r.end_at,r.duration_minutes,
        r.court_unit,r.court_listing_id,r.court_unit_inventory_id,r.rate_quantity,r.rate_unit_snapshot,
        r.customer_name,r.customer_mobile,'confirmed','PayMongo',new.payment_id,r.amount_total,r.amount_total);
    end loop;
  elsif old.status is distinct from 'expired' and new.status='expired' then
    delete from internal.reservation_resource_slots where walkin_order_id=new.id;
  end if;
  return new;
end;
$$;
revoke all on function internal.materialize_settled_walkin_order() from public,anon,authenticated;
drop trigger if exists staff_walkin_order_settlement_materialize on internal.staff_walkin_orders;
create trigger staff_walkin_order_settlement_materialize after update of status
on internal.staff_walkin_orders for each row execute function internal.materialize_settled_walkin_order();

-- Settlement validates against the private staged rows instead of requiring
-- pending public walk-in rows to exist before payment.
do $migration$
declare v_definition text; v_updated text;
begin
  v_definition:=pg_catalog.pg_get_functiondef(
    'public.record_paymongo_paid(text,text,text,bigint,bigint,bigint)'::regprocedure);
  if position('sum(w.amount_total),0)*100)::bigint,count(*)' in v_definition)=0 then
    raise exception 'PayMongo settlement walk-in validation changed; review online walk-in staging';
  end if;
  v_updated:=replace(v_definition,
    'select round(coalesce(sum(w.amount_total),0)*100)::bigint,count(*)
      into v_order_total,v_reservation_count from public.walk_in_booking w
      where w.walkin_order_id=v_order.id and w.status=''pending'' and w.checked_in_at is null;',
    'select case when exists(select 1 from internal.staff_walkin_order_reservations s where s.order_id=v_order.id)
        then (select coalesce(sum(round(s.amount_total*100)::bigint),0) from internal.staff_walkin_order_reservations s where s.order_id=v_order.id)
        else (select round(coalesce(sum(w.amount_total),0)*100)::bigint from public.walk_in_booking w
          where w.walkin_order_id=v_order.id and w.status=''pending'' and w.checked_in_at is null) end,
      case when exists(select 1 from internal.staff_walkin_order_reservations s where s.order_id=v_order.id)
        then (select count(*) from internal.staff_walkin_order_reservations s where s.order_id=v_order.id)
        else (select count(*) from public.walk_in_booking w
          where w.walkin_order_id=v_order.id and w.status=''pending'' and w.checked_in_at is null) end
      into v_order_total,v_reservation_count;');
  if v_updated=v_definition then raise exception 'Could not patch PayMongo walk-in settlement validation'; end if;
  execute v_updated;
end;
$migration$;

-- Occupancy exposes staged walk-in orders as temporary checkout holds so all
-- availability clients continue to treat them as unavailable.
do $migration$
declare v_definition text; v_updated text;
begin
  v_definition:=pg_catalog.pg_get_functiondef('public.court_occupancy(timestamptz,timestamptz)'::regprocedure);
  v_updated:=replace(v_definition,
    'when rs.hold_item_id is not null then ''checkout_hold''',
    'when rs.hold_item_id is not null or rs.walkin_order_id is not null then ''checkout_hold''');
  v_updated:=replace(v_updated,
    'case when rs.hold_item_id is not null then ''pending''',
    'case when rs.hold_item_id is not null or rs.walkin_order_id is not null then ''pending''');
  if v_updated=v_definition or position('rs.walkin_order_id is not null' in v_updated)=0 then
    raise exception 'Court occupancy reader changed; review staged online walk-in visibility';
  end if;
  execute v_updated;
end;
$migration$;

-- Preserve staged holds when resource mappings are rebuilt by owner edits.
do $migration$
declare v_definition text; v_updated text; v_anchor text;
begin
  v_definition:=pg_catalog.pg_get_functiondef('internal.refresh_reservation_resource_slots()'::regprocedure);
  v_anchor:='  if exists(select 1 from internal.reservation_slots s where';
  if position(v_anchor in v_definition)=0 then
    raise exception 'Resource slot rebuild changed; review online walk-in holds';
  end if;
  v_updated:=replace(v_definition,v_anchor,
    '  delete from internal.reservation_resource_slots where walkin_order_id is not null;
  insert into internal.reservation_resource_slots(walkin_order_id,resource_id,during)
    select s.order_id,m.resource_id,tstzrange(s.time_date,s.end_at,''[)'')
      from internal.staff_walkin_order_reservations s
      join internal.staff_walkin_orders o on o.id=s.order_id and o.status in (''awaiting_payment'',''review'')
      join public.court_unit_resource_map m on m.court_unit_id=s.court_unit_inventory_id
      join public.physical_court_resource r on r.id=m.resource_id and r.is_active;
  if exists(select 1 from internal.staff_walkin_order_reservations s
      join internal.staff_walkin_orders o on o.id=s.order_id and o.status in (''awaiting_payment'',''review'')
      where not exists(select 1 from internal.reservation_resource_slots rs
        where rs.walkin_order_id=s.order_id and rs.during=tstzrange(s.time_date,s.end_at,''[)''))) then
    raise exception ''Every active online walk-in order needs a physical resource'' using errcode=''23503'';
  end if;
  if exists(select 1 from internal.reservation_slots s where');
  if v_updated=v_definition then raise exception 'Could not retain staged walk-in holds on mapping rebuild'; end if;
  execute v_updated;
end;
$migration$;
