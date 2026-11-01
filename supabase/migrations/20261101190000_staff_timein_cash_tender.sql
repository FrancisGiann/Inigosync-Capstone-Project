-- Record the POS cash amount entered during Time-In on both the payment and
-- its immutable acknowledgment. The prior two-argument path can still time
-- in a fully paid reservation, but cannot settle a balance without tender.
create or replace function internal.staff_collect_cash_and_check_in(
  p_source text,p_id bigint,p_cash_tendered_minor bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid:=(select auth.uid()); v_total numeric; v_paid numeric; v_due numeric;
  v_due_minor bigint; v_change_minor bigint;
  v_start timestamptz; v_end timestamptz; v_grace integer; v_no_show boolean;
  v_payment_id bigint; v_result jsonb; v_receipt jsonb; v_order uuid; v_role text;
begin
  if v_actor is null or not exists(select 1 from public.profiles p where p.id=v_actor
    and p.role in ('staff','admin') and p.status='active') then
    raise exception 'Active staff access is required' using errcode='42501';
  end if;
  if p_source not in ('booking','walkin') or p_source is null or p_id is null or p_id<=0 then
    raise exception 'Invalid reservation' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
  if p_source='booking' then
    select amount_total,amount_paid,time_date,end_at,no_show_policy_applies
      into v_total,v_paid,v_start,v_end,v_no_show from public.booking
      where booking_id=p_id and status='confirmed' and checked_in_at is null for update;
  else
    select w.amount_total,w.amount_paid,w.time_date,w.end_at,w.no_show_policy_applies,w.walkin_order_id
      into v_total,v_paid,v_start,v_end,v_no_show,v_order
      from public.walk_in_booking w where w.walkin_id=p_id and w.status in ('pending','confirmed')
        and w.checked_in_at is null for update;
    if v_order is not null and not exists(select 1 from internal.staff_walkin_orders o
      where o.id=v_order and o.status='paid') then
      raise exception 'Resolve the online walk-in checkout before Time-In' using errcode='55000';
    end if;
  end if;
  if v_start is not null then
    select r.grace_minutes into v_grace from internal.booking_rule_for_date((v_start at time zone 'Asia/Manila')::date) r;
    if v_end<=now() or (coalesce(v_no_show,true)
      and now()>v_start+make_interval(mins=>coalesce(v_grace,30))) then
      raise exception 'The Time-In grace period has ended for this reservation' using errcode='55000';
    end if;
  end if;
  if v_total is null or v_paid is null or v_paid<0 or v_paid>v_total then
    raise exception 'Reservation cannot be checked in' using errcode='22023';
  end if;
  v_due:=round(v_total-v_paid,2);
  v_due_minor:=round(v_due*100)::bigint;
  if v_due_minor>0 then
    if p_cash_tendered_minor is null or p_cash_tendered_minor<v_due_minor then
      raise exception 'Cash received must cover the current balance' using errcode='22023';
    end if;
    v_change_minor:=p_cash_tendered_minor-v_due_minor;
  elsif p_cash_tendered_minor is not null then
    raise exception 'No cash balance is due for this reservation' using errcode='22023';
  end if;
  perform set_config('inigosync.staff_payment_rpc','on',true);
  if v_due>0 then
    if not exists(select 1 from public.app_settings s where s.id=true and s.cash_enabled) then
      raise exception 'Cash collection is disabled' using errcode='42501';
    end if;
    if exists(select 1 from internal.paymongo_checkout_attempts a where
      ((a.balance_source=p_source and a.balance_id=p_id) or
       (p_source='walkin' and a.walkin_order_id=v_order))
      and a.status in ('creating','ready','review')) then
      raise exception 'Online checkout is still open for this payment' using errcode='55000';
    end if;
    insert into public.payment(cost,paid,payment_method,down_full,base_minor,fee_minor,gross_minor,net_minor,
      cash_tendered_minor,cash_change_minor)
      values(v_due,v_due,'Cash','full',v_due_minor,0,v_due_minor,v_due_minor,
        p_cash_tendered_minor,v_change_minor)
      returning payment_id into v_payment_id;
  end if;
  if p_source='booking' then
    update public.booking set checked_in_at=now(),amount_paid=amount_total,
      balance_payment_id=case when v_due>0 then v_payment_id else balance_payment_id end,
      balance_payment_method=case when v_due>0 then 'Cash' else balance_payment_method end,
      balance_paid_at=case when v_due>0 then now() else balance_paid_at end
      where booking_id=p_id;
  else
    update public.walk_in_booking set checked_in_at=now(),amount_paid=amount_total,status='confirmed',
      balance_payment_id=case when v_due>0 then v_payment_id else balance_payment_id end,
      balance_payment_method=case when v_due>0 then 'Cash' else balance_payment_method end,
      balance_paid_at=case when v_due>0 then now() else balance_paid_at end
      where walkin_id=p_id;
  end if;
  if v_payment_id is not null then
    v_receipt:=internal.persist_payment_acknowledgment(v_payment_id,p_source,p_id,null);
    update internal.payment_acknowledgments set payload=payload||jsonb_build_object(
      'cash_tendered_minor',p_cash_tendered_minor,'cash_change_minor',v_change_minor,
      'cash_tendered',p_cash_tendered_minor/100.0,'cash_change',v_change_minor/100.0)
      where payment_id=v_payment_id returning payload into v_receipt;
  end if;
  select p.role into v_role from public.profiles p where p.id=v_actor;
  insert into public.audit_log(actor_id,actor_role,action,entity_type,entity_id,details)
    values(v_actor,coalesce(v_role,'staff'),'timed_in',p_source,p_id::text,
      jsonb_build_object('payment_id',v_payment_id,'cash_collected',v_due,
        'cash_tendered_minor',p_cash_tendered_minor,'cash_change_minor',v_change_minor,
        'checked_in_at',now(),'receipt_id',v_receipt->>'receipt_id'));
  v_result:=jsonb_build_object('source',p_source,'id',p_id,'cash_collected',v_due,
    'cash_tendered_minor',p_cash_tendered_minor,'cash_change_minor',v_change_minor,
    'payment_id',v_payment_id,'receipt',v_receipt,'checked_in',true);
  return v_result;
end;
$$;
revoke all on function internal.staff_collect_cash_and_check_in(text,bigint,bigint)
  from public,anon,authenticated,service_role;

create or replace function public.staff_collect_cash_and_check_in(p_source text,p_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := (select auth.uid()); v_start timestamptz;
begin
  if v_actor is null or not exists (
    select 1 from public.profiles p where p.id=v_actor
      and p.role in ('staff','admin') and p.status='active'
  ) then
    raise exception 'Active staff access is required' using errcode='42501';
  end if;
  if p_source <> 'booking' or p_source is null then
    raise exception 'Walk-ins time in automatically when their slot starts'
      using errcode='55000';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
  select b.time_date into v_start from public.booking b
    where b.booking_id=p_id and b.status='confirmed'
      and b.checked_in_at is null for update;
  if v_start is not null and now()<v_start-interval '30 minutes' then
    raise exception 'Time-In opens 30 minutes before the scheduled start'
      using errcode='55000';
  end if;
  return internal.staff_collect_cash_and_check_in(p_source,p_id,null);
end;
$$;
revoke all on function public.staff_collect_cash_and_check_in(text,bigint)
  from public,anon;
grant execute on function public.staff_collect_cash_and_check_in(text,bigint)
  to authenticated;

create function public.staff_collect_cash_and_check_in(
  p_source text,p_id bigint,p_cash_tendered_minor bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := (select auth.uid()); v_start timestamptz;
begin
  if v_actor is null or not exists (
    select 1 from public.profiles p where p.id=v_actor
      and p.role in ('staff','admin') and p.status='active'
  ) then
    raise exception 'Active staff access is required' using errcode='42501';
  end if;
  if p_source <> 'booking' or p_source is null then
    raise exception 'Walk-ins time in automatically when their slot starts'
      using errcode='55000';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
  select b.time_date into v_start from public.booking b
    where b.booking_id=p_id and b.status='confirmed'
      and b.checked_in_at is null for update;
  if v_start is not null and now()<v_start-interval '30 minutes' then
    raise exception 'Time-In opens 30 minutes before the scheduled start'
      using errcode='55000';
  end if;
  return internal.staff_collect_cash_and_check_in(p_source,p_id,p_cash_tendered_minor);
end;
$$;
revoke all on function public.staff_collect_cash_and_check_in(text,bigint,bigint)
  from public,anon;
grant execute on function public.staff_collect_cash_and_check_in(text,bigint,bigint)
  to authenticated;
