alter table public.booking add column if not exists balance_payment_id bigint references public.payment(payment_id);
alter table public.walk_in_booking add column if not exists balance_payment_id bigint references public.payment(payment_id);

create or replace function public.get_paymongo_checkout_attempt_detail(p_attempt_id uuid,p_customer_id uuid)
returns table(id uuid,status text,checkout_url text,amount_minor bigint,total_minor bigint,
  currency text,payment_option text,paymongo_session_id text,item_count bigint)
language sql security definer set search_path = '' as $$
  select a.id,a.status,a.checkout_url,a.amount_minor,a.total_minor,a.currency,a.payment_option,
    a.paymongo_session_id,case when a.intent_id is null then 1::bigint else
      (select count(*) from internal.checkout_intent_items x where x.intent_id=a.intent_id) end
  from internal.paymongo_checkout_attempts a where a.id=p_attempt_id and a.customer_id=p_customer_id
$$;
revoke all on function public.get_paymongo_checkout_attempt_detail(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_paymongo_checkout_attempt_detail(uuid,uuid) to service_role;

create or replace function public.attach_paymongo_checkout(p_attempt_id uuid,p_session_id text,p_checkout_url text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_intent uuid; v_count integer;
begin
  if p_session_id !~ '^cs_[A-Za-z0-9]+' or p_checkout_url !~ '^https://checkout\.paymongo\.com/' then
    raise exception 'Invalid PayMongo checkout response' using errcode='22023';
  end if;
  update internal.paymongo_checkout_attempts set paymongo_session_id=p_session_id,checkout_url=p_checkout_url,
    status='ready',updated_at=now() where id=p_attempt_id and status='creating'
    and (paymongo_session_id is null or paymongo_session_id=p_session_id) returning intent_id into v_intent;
  get diagnostics v_count=row_count;
  if v_count=1 and v_intent is not null then
    update internal.checkout_intents set status='ready',updated_at=now() where id=v_intent;
  end if;
  return v_count=1;
end;
$$;
revoke all on function public.attach_paymongo_checkout(uuid,text,text) from public,anon,authenticated;
grant execute on function public.attach_paymongo_checkout(uuid,text,text) to service_role;

create or replace function public.prepare_paymongo_balance_checkout(p_source text,p_id bigint,p_staff_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_total numeric; v_paid numeric; v_due bigint; v_attempt internal.paymongo_checkout_attempts%rowtype;
begin
  if p_source not in ('booking','walkin') or p_id is null or p_id<=0 or not exists
    (select 1 from public.profiles p where p.id=p_staff_id and p.role in ('staff','admin') and p.status='active') then
    raise exception 'Active staff access is required' using errcode='42501';
  end if;
  if p_source='booking' then
    select b.amount_total,b.amount_paid into v_total,v_paid from public.booking b
      where b.booking_id=p_id and b.status='confirmed' and b.checked_in_at is null for update;
  else
    select w.amount_total,w.amount_paid into v_total,v_paid from public.walk_in_booking w
      where w.walkin_id=p_id and w.status in ('pending','confirmed') and w.checked_in_at is null for update;
  end if;
  if v_total is null or v_paid is null or v_paid>=v_total then
    raise exception 'No balance is due for this reservation' using errcode='22023';
  end if;
  v_due:=round((v_total-v_paid)*100)::bigint;
  select * into v_attempt from internal.paymongo_checkout_attempts a
    where a.balance_source=p_source and a.balance_id=p_id and a.status in ('creating','ready','review')
    order by a.created_at desc limit 1 for update;
  if found then return jsonb_build_object('attempt_id',v_attempt.id,'amount_minor',v_attempt.amount_minor,
    'status',v_attempt.status,'checkout_url',v_attempt.checkout_url); end if;
  insert into internal.paymongo_checkout_attempts(booking_id,customer_id,amount_minor,total_minor,payment_option,
    balance_source,balance_id,staff_id)
    values(null,p_staff_id,v_due,v_due,'full',p_source,p_id,p_staff_id) returning * into v_attempt;
  return jsonb_build_object('attempt_id',v_attempt.id,'amount_minor',v_due,'status',v_attempt.status);
end;
$$;
revoke all on function public.prepare_paymongo_balance_checkout(text,bigint,uuid) from public,anon,authenticated;
grant execute on function public.prepare_paymongo_balance_checkout(text,bigint,uuid) to service_role;

create or replace function public.record_paymongo_paid(
  p_event_id text,p_session_id text,p_payment_id text,p_amount_minor bigint
) returns text language plpgsql security definer set search_path = '' as $$
declare a internal.paymongo_checkout_attempts%rowtype; x internal.checkout_intent_items%rowtype;
  v_intent internal.checkout_intents%rowtype; v_payment_id bigint; v_booking_id bigint; v_due bigint;
begin
  select * into a from internal.paymongo_checkout_attempts where paymongo_session_id=p_session_id for update;
  if not found then raise exception 'Unknown PayMongo checkout session' using errcode='P0002'; end if;
  insert into internal.paymongo_webhook_events(event_id,event_type)
    values(p_event_id,'checkout_session.payment.paid') on conflict do nothing;
  if not found then return 'duplicate'; end if;
  if a.status='paid' then return 'duplicate'; end if;
  if a.status not in ('ready','review') or p_amount_minor<>a.amount_minor or nullif(p_payment_id,'') is null then
    update internal.paymongo_checkout_attempts set status='review',updated_at=now() where id=a.id;
    if a.intent_id is not null then update internal.checkout_intents set status='review',updated_at=now() where id=a.intent_id; end if;
    return 'review';
  end if;

  if a.intent_id is not null then
    select * into v_intent from internal.checkout_intents where id=a.intent_id for update;
    if v_intent.status not in ('ready','review') or v_intent.customer_id<>a.customer_id
      or v_intent.amount_minor<>a.amount_minor then
      update internal.paymongo_checkout_attempts set status='review',updated_at=now() where id=a.id;
      return 'review';
    end if;
    begin
      -- The exclusion lock changes ownership inside this transaction. A
      -- concurrent reservation cannot enter the same physical slot.
      delete from internal.reservation_resource_slots where hold_item_id in
        (select id from internal.checkout_intent_items where intent_id=a.intent_id);
      for x in select * from internal.checkout_intent_items where intent_id=a.intent_id order by starts_at,id loop
        insert into public.payment(cost,paid,payment_method,down_full)
          values(x.total_minor/100.0,x.charge_minor/100.0,'PayMongo',a.payment_option)
          returning payment_id into v_payment_id;
        insert into public.booking(customer_id,sports,courts,time_date,payment_id,status,
          duration_minutes,end_at,court_unit,amount_total,amount_paid,payment_option,
          court_unit_inventory_id,court_listing_id,rate_quantity,rate_unit_snapshot)
          values(a.customer_id,x.sports,x.courts,x.starts_at,v_payment_id,'confirmed',
            x.duration_minutes,x.ends_at,x.court_unit,x.total_minor/100.0,x.charge_minor/100.0,
            a.payment_option,x.unit_id,x.listing_id,x.rate_quantity,x.rate_unit)
          returning booking_id into v_booking_id;
        -- Keep the checkout's agreed amount if an owner edited a rate while
        -- the customer was at PayMongo.
        update public.booking set amount_total=x.total_minor/100.0,amount_paid=x.charge_minor/100.0,
          rate_unit_snapshot=x.rate_unit where booking_id=v_booking_id;
        update internal.checkout_intent_items set booking_id=v_booking_id where id=x.id;
      end loop;
      update internal.checkout_intents set status='paid',updated_at=now() where id=a.intent_id;
      update internal.paymongo_checkout_attempts set status='paid',paymongo_payment_id=p_payment_id,
        updated_at=now() where id=a.id;
      return 'paid';
    exception when others then
      -- The provider took the money. Preserve evidence and the hold for a
      -- staff reconciliation; never silently expose the slot again.
      update internal.checkout_intents set status='review',updated_at=now() where id=a.intent_id;
      update internal.paymongo_checkout_attempts set status='review',updated_at=now() where id=a.id;
      return 'review';
    end;
  end if;

  if a.balance_id is not null then
    if a.balance_source='booking' then
      select round((b.amount_total-b.amount_paid)*100)::bigint into v_due from public.booking b
        where b.booking_id=a.balance_id and b.status='confirmed' and b.checked_in_at is null for update;
    else
      select round((w.amount_total-w.amount_paid)*100)::bigint into v_due from public.walk_in_booking w
        where w.walkin_id=a.balance_id and w.status in ('pending','confirmed') and w.checked_in_at is null for update;
    end if;
    if v_due is distinct from a.amount_minor then
      update internal.paymongo_checkout_attempts set status='review',updated_at=now() where id=a.id;
      return 'review';
    end if;
    insert into public.payment(cost,paid,payment_method,down_full)
      values(v_due/100.0,v_due/100.0,'PayMongo','full') returning payment_id into v_payment_id;
    update internal.paymongo_checkout_attempts set status='paid',paymongo_payment_id=p_payment_id,
      updated_at=now() where id=a.id;
    if a.balance_source='booking' then
      update public.booking set amount_paid=amount_total,balance_payment_id=v_payment_id,
        balance_payment_method='PayMongo',balance_paid_at=now() where booking_id=a.balance_id;
    else
      update public.walk_in_booking set amount_paid=amount_total,balance_payment_id=v_payment_id,
        balance_payment_method='PayMongo',balance_paid_at=now() where walkin_id=a.balance_id;
    end if;
    insert into public.audit_log(actor_id,actor_role,action,entity_type,entity_id,details)
      values(a.staff_id,'staff','collected_online_balance',a.balance_source,a.balance_id::text,
        jsonb_build_object('amount',v_due/100.0,'payment_id',v_payment_id,'paymongo_payment_id',p_payment_id));
    return 'paid';
  end if;

  -- Retain reconciliation support for a legacy pending booking whose
  -- PayMongo session was created before this rollout.
  if not exists(select 1 from public.booking b where b.booking_id=a.booking_id
    and b.customer_id=a.customer_id and b.status in ('pending','confirmed')
    and b.payment_id is null and b.amount_paid=0 and b.checked_in_at is null) then
    update internal.paymongo_checkout_attempts set status='review',updated_at=now() where id=a.id;
    return 'review';
  end if;
  insert into public.payment(cost,paid,payment_method,down_full)
    values(a.total_minor/100.0,a.amount_minor/100.0,'PayMongo',a.payment_option)
    returning payment_id into v_payment_id;
  update internal.paymongo_checkout_attempts set status='paid',paymongo_payment_id=p_payment_id,updated_at=now() where id=a.id;
  update public.booking set payment_id=v_payment_id,amount_total=a.total_minor/100.0,
    amount_paid=a.amount_minor/100.0,status='confirmed' where booking_id=a.booking_id;
  return 'paid';
end;
$$;
revoke all on function public.record_paymongo_paid(text,text,text,bigint) from public,anon,authenticated;
grant execute on function public.record_paymongo_paid(text,text,text,bigint) to service_role;

create or replace function public.list_paymongo_checkouts_due_for_expiry()
returns table(attempt_id uuid,session_id text)
language plpgsql security definer set search_path = '' as $$
begin
  update internal.paymongo_checkout_attempts a set status='review',updated_at=now()
    where a.status='creating' and a.paymongo_session_id is null and a.created_at<=now()-interval '23 hours';
  update internal.checkout_intents i set status='review',updated_at=now()
    from internal.paymongo_checkout_attempts a where a.intent_id=i.id and a.status='review' and i.status='creating';
  return query
    select a.id,a.paymongo_session_id from internal.paymongo_checkout_attempts a
      left join public.booking b on b.booking_id=a.booking_id
      left join internal.checkout_intents i on i.id=a.intent_id
    where a.status='ready' and a.paymongo_session_id is not null
      and (b.time_date<=now() or i.expires_at<=now()
        or (a.balance_id is not null and a.created_at<=now()-interval '15 minutes'))
    order by a.created_at limit 50;
end;
$$;
revoke all on function public.list_paymongo_checkouts_due_for_expiry() from public,anon,authenticated;
grant execute on function public.list_paymongo_checkouts_due_for_expiry() to service_role;

create or replace function public.mark_paymongo_checkout_expired(p_attempt_id uuid,p_session_id text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_intent uuid; v_count integer;
begin
  update internal.paymongo_checkout_attempts set status='expired',updated_at=now()
    where id=p_attempt_id and paymongo_session_id=p_session_id and status='ready'
    returning intent_id into v_intent;
  get diagnostics v_count=row_count;
  if v_count=1 and v_intent is not null then
    update internal.checkout_intents set status='expired',updated_at=now() where id=v_intent;
    delete from internal.reservation_resource_slots where hold_item_id in
      (select id from internal.checkout_intent_items where intent_id=v_intent);
  end if;
  return v_count=1;
end;
$$;
revoke all on function public.mark_paymongo_checkout_expired(uuid,text) from public,anon,authenticated;
grant execute on function public.mark_paymongo_checkout_expired(uuid,text) to service_role;

create or replace function public.staff_collect_cash_and_check_in(p_source text,p_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=(select auth.uid()); v_total numeric; v_paid numeric; v_due numeric;
  v_payment_id bigint; v_result jsonb;
begin
  if v_actor is null or not exists(select 1 from public.profiles p where p.id=v_actor
    and p.role in ('staff','admin') and p.status='active') then
    raise exception 'Active staff access is required' using errcode='42501';
  end if;
  if p_source not in ('booking','walkin') or p_id is null or p_id<=0 then
    raise exception 'Invalid reservation' using errcode='22023';
  end if;
  if p_source='booking' then
    select amount_total,amount_paid into v_total,v_paid from public.booking
      where booking_id=p_id and status='confirmed' and checked_in_at is null for update;
  else
    select amount_total,amount_paid into v_total,v_paid from public.walk_in_booking
      where walkin_id=p_id and status in ('pending','confirmed') and checked_in_at is null for update;
  end if;
  if v_total is null or v_paid is null or v_paid<0 or v_paid>v_total then
    raise exception 'Reservation cannot be checked in' using errcode='22023';
  end if;
  v_due:=round(v_total-v_paid,2);
  perform set_config('inigosync.staff_payment_rpc','on',true);
  if v_due>0 then
    if not exists(select 1 from public.app_settings s where s.id=true and s.cash_enabled) then
      raise exception 'Cash collection is disabled' using errcode='42501';
    end if;
    if exists(select 1 from internal.paymongo_checkout_attempts a where a.balance_source=p_source
      and a.balance_id=p_id and a.status in ('creating','ready','review')) then
      raise exception 'Online balance checkout is still open' using errcode='55000';
    end if;
    insert into public.payment(cost,paid,payment_method,down_full)
      values(v_due,v_due,'Cash','full') returning payment_id into v_payment_id;
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
  v_result:=jsonb_build_object('source',p_source,'id',p_id,'cash_collected',v_due,'checked_in',true);
  return v_result;
end;
$$;
revoke all on function public.staff_collect_cash_and_check_in(text,bigint) from public,anon;
grant execute on function public.staff_collect_cash_and_check_in(text,bigint) to authenticated;
