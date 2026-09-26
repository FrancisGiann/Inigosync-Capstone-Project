-- Booking and payment records must originate from the payment settlement
-- functions. Staff keep read access and use the check-in RPC for cash.
revoke insert, delete on public.booking from anon, authenticated;
revoke insert, update, delete on public.payment from anon, authenticated;
revoke delete on public.walk_in_booking from anon, authenticated;

drop policy if exists booking_insert on public.booking;

create or replace function internal.guard_staff_payment_fields()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=(select auth.uid());
begin
  if v_actor is not null and exists(select 1 from public.profiles p where p.id=v_actor
    and p.role in ('staff','admin') and p.status='active')
    and coalesce(current_setting('inigosync.staff_payment_rpc',true),'')<>'on'
    and (new.amount_paid is distinct from old.amount_paid
      or new.amount_total is distinct from old.amount_total
      or new.payment_id is distinct from old.payment_id
      or new.balance_payment_id is distinct from old.balance_payment_id
      or new.balance_payment_method is distinct from old.balance_payment_method
      or new.balance_paid_at is distinct from old.balance_paid_at
      or new.checked_in_at is distinct from old.checked_in_at
      or new.court_listing_id is distinct from old.court_listing_id
      or new.court_unit_inventory_id is distinct from old.court_unit_inventory_id
      or new.time_date is distinct from old.time_date
      or new.end_at is distinct from old.end_at
      or new.rate_quantity is distinct from old.rate_quantity) then
    raise exception 'Use the verified check-in action to record payments and attendance' using errcode='42501';
  end if;
  return new;
end;
$$;

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
    if new.amount_total is null or new.amount_total<=0 or new.amount_paid is distinct from new.amount_total then
      raise exception 'A walk-in must record its full cash payment' using errcode='22023';
    end if;
  end if;
  return new;
end;
$$;
