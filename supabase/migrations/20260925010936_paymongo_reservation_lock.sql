-- While a provider session can still accept payment, the slot identity and
-- reservation lifecycle cannot be changed by staff or customers. Settlement
-- and confirmed expiry first transition the attempt state, then proceed.
create or replace function internal.guard_paymongo_booking_manual_collection()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from internal.paymongo_checkout_attempts a
    where a.booking_id = old.booking_id and a.status in ('creating', 'ready', 'review')
  ) and (
    new.checked_in_at is distinct from old.checked_in_at
    or new.amount_paid > old.amount_paid
    or new.payment_id is distinct from old.payment_id
    or new.status is distinct from old.status
    or new.customer_id is distinct from old.customer_id
    or new.courts is distinct from old.courts
    or new.time_date is distinct from old.time_date
    or new.duration_minutes is distinct from old.duration_minutes
    or new.payment_option is distinct from old.payment_option
  ) then
    raise exception 'An online checkout is still open. Verify or expire it before changing this reservation.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_paymongo_booking_manual_collection() from public, anon, authenticated;

drop trigger if exists booking_guard_paymongo_collection on public.booking;
create trigger booking_guard_paymongo_collection before update on public.booking
for each row execute function internal.guard_paymongo_booking_manual_collection();
