-- Balance attempts belong to the reservation's customer. The staff actor is
-- already recorded separately in staff_id. Guests keep a null customer_id.
-- Customer status/cancel is limited to customer-created checkouts. Linked
-- staff walk-ins and staff balance collection use their own staff endpoints.
create or replace function public.get_paymongo_checkout_attempt_detail(p_attempt_id uuid,p_customer_id uuid)
returns table(id uuid,status text,checkout_url text,amount_minor bigint,total_minor bigint,
  currency text,payment_option text,paymongo_session_id text,item_count bigint)
language sql security definer set search_path = '' as $$
  select a.id,a.status,a.checkout_url,a.amount_minor,a.total_minor,a.currency,a.payment_option,
    a.paymongo_session_id,case when a.intent_id is null then 1::bigint else
      (select count(*) from internal.checkout_intent_items x where x.intent_id=a.intent_id) end
  from internal.paymongo_checkout_attempts a
  where a.id=p_attempt_id and a.customer_id=p_customer_id and a.staff_id is null
    and a.walkin_order_id is null and a.balance_id is null
    and exists(select 1 from public.profiles p
      where p.id=p_customer_id and p.role='customer' and p.status='active')
$$;
revoke all on function public.get_paymongo_checkout_attempt_detail(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_paymongo_checkout_attempt_detail(uuid,uuid) to service_role;

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
      'status',v_attempt.status,'checkout_url',v_attempt.checkout_url);
  end if;
  insert into internal.paymongo_checkout_attempts(booking_id,customer_id,amount_minor,total_minor,
    payment_option,balance_source,balance_id,staff_id,pass_on_fees)
    values(null,v_customer,v_due,v_due,'full',p_source,p_id,p_staff_id,true) returning * into v_attempt;
  return jsonb_build_object('attempt_id',v_attempt.id,'amount_minor',v_due,'status',v_attempt.status);
end;
$$;
revoke all on function public.prepare_paymongo_balance_checkout(text,bigint,uuid) from public,anon,authenticated;
grant execute on function public.prepare_paymongo_balance_checkout(text,bigint,uuid) to service_role;

-- Preserve attribution for any balance attempts created before this fix.
update internal.paymongo_checkout_attempts a set customer_id=b.customer_id,updated_at=now()
  from public.booking b where a.balance_source='booking' and a.balance_id=b.booking_id
    and a.customer_id is distinct from b.customer_id;
update internal.paymongo_checkout_attempts a set customer_id=w.customer_id,updated_at=now()
  from public.walk_in_booking w where a.balance_source='walkin' and a.balance_id=w.walkin_id
    and a.customer_id is distinct from w.customer_id;
