-- Staff history is written by database triggers from real row changes, with
-- the authenticated actor taken from the JWT rather than browser payloads.
revoke insert on public.audit_log from authenticated;
drop policy if exists audit_log_staff_insert on public.audit_log;
drop policy if exists "audit_log_staff_insert" on public.audit_log;

create or replace function internal.guard_staff_payment_fields()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=(select auth.uid());
begin
  if v_actor is not null and exists(select 1 from public.profiles p where p.id=v_actor
    and p.role in ('staff','admin') and p.status='active')
    and coalesce(current_setting('inigosync.staff_payment_rpc',true),'')<>'on'
    and (new.amount_paid is distinct from old.amount_paid or new.payment_id is distinct from old.payment_id
      or new.balance_payment_id is distinct from old.balance_payment_id
      or new.balance_payment_method is distinct from old.balance_payment_method
      or new.balance_paid_at is distinct from old.balance_paid_at
      or new.checked_in_at is distinct from old.checked_in_at) then
    raise exception 'Use the verified check-in action to record payments and attendance' using errcode='42501';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_staff_payment_fields() from public,anon,authenticated;
create trigger booking_guard_staff_payment_fields before update on public.booking
  for each row execute function internal.guard_staff_payment_fields();
create trigger walkin_guard_staff_payment_fields before update on public.walk_in_booking
  for each row execute function internal.guard_staff_payment_fields();

create or replace function internal.audit_staff_reservation_action()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=(select auth.uid()); v_role text; v_action text; v_id text; v_info jsonb;
begin
  select p.role into v_role from public.profiles p where p.id=v_actor and p.role in ('staff','admin') and p.status='active';
  if v_role is null then return new; end if;
  if tg_table_name='booking' then v_id:=new.booking_id::text;
  else v_id:=new.walkin_id::text; end if;
  v_info:=jsonb_build_object('court',new.courts,'unit',new.court_unit,'starts_at',new.time_date,
    'total',new.amount_total,'paid',new.amount_paid);
  if tg_op='INSERT' then
    v_action:=case when tg_table_name='walk_in_booking' then 'recorded_walk_in' else 'recorded_booking' end;
  elsif new.checked_in_at is distinct from old.checked_in_at and new.checked_in_at is not null then
    v_action:='checked_in';
    v_info:=v_info||jsonb_build_object('cash_collected',greatest(0,new.amount_paid-old.amount_paid));
  elsif new.status is distinct from old.status then
    v_action:='booking_status_changed';
    v_info:=v_info||jsonb_build_object('from',old.status,'to',new.status);
  elsif new.amount_paid is distinct from old.amount_paid then
    v_action:='collected_payment';
    v_info:=v_info||jsonb_build_object('amount',new.amount_paid-old.amount_paid,
      'method',new.balance_payment_method);
  else return new;
  end if;
  insert into public.audit_log(actor_id,actor_role,action,entity_type,entity_id,details)
    values(v_actor,v_role,v_action,case when tg_table_name='booking' then 'booking' else 'walkin' end,v_id,v_info);
  return new;
end;
$$;
revoke all on function internal.audit_staff_reservation_action() from public,anon,authenticated;
create trigger booking_audit_staff_action after insert or update on public.booking
  for each row execute function internal.audit_staff_reservation_action();
create trigger walkin_audit_staff_action after insert or update on public.walk_in_booking
  for each row execute function internal.audit_staff_reservation_action();

-- Staff walk-ins are collected at the desk. Never classify an unconfirmed
-- provider payment as paid by inserting a row with an online label.
create or replace function internal.guard_new_walkin_payment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_rate_unit text;
begin
  v_rate_unit:=internal.authoritative_reservation_rate_unit(new.court_listing_id,new.court_unit_inventory_id);
  if v_rate_unit='/set' and (new.rate_quantity not between 1 and 100
      or new.end_at is distinct from new.time_date+make_interval(mins=>new.rate_quantity*60)) then
    raise exception 'Each set must reserve exactly 60 minutes on one lane' using errcode='22023';
  end if;
  if (select auth.uid()) is not null and exists(select 1 from public.profiles p
    where p.id=(select auth.uid()) and p.role in ('staff','admin') and p.status='active') then
    if new.payment_method is distinct from 'Cash' or not exists(select 1 from public.app_settings s where s.id=true and s.cash_enabled) then
      raise exception 'Only enabled cash payment can be recorded for a new walk-in' using errcode='42501';
    end if;
    if new.amount_total is null or new.amount_total<=0 then
      raise exception 'A priced court is required for a walk-in' using errcode='22023';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_new_walkin_payment() from public,anon,authenticated;
create trigger zzzz_walkin_guard_new_payment before insert on public.walk_in_booking
  for each row execute function internal.guard_new_walkin_payment();

create or replace function internal.guard_booking_set_duration()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if internal.authoritative_reservation_rate_unit(new.court_listing_id,new.court_unit_inventory_id)='/set'
    and (new.rate_quantity not between 1 and 100
      or new.end_at is distinct from new.time_date+make_interval(mins=>new.rate_quantity*60)) then
    raise exception 'Each set must reserve exactly 60 minutes on one lane' using errcode='22023';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_booking_set_duration() from public,anon,authenticated;
create trigger zzy_booking_guard_set_duration before insert on public.booking
  for each row execute function internal.guard_booking_set_duration();
