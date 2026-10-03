-- Freeze every field that contributes to physical occupancy while an online
-- session may still be payable.
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
    or new.court_unit is distinct from old.court_unit
    or new.time_date is distinct from old.time_date
    or new.end_at is distinct from old.end_at
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

-- PayMongo idempotency keys expire after 24 hours. After 23 hours, an
-- unattached create is ambiguous: keep the slot locked for staff review and
-- never let a retry silently make a second provider session.
create or replace function public.list_paymongo_checkouts_due_for_expiry()
returns table (attempt_id uuid, session_id text)
language plpgsql security definer set search_path = '' as $$
begin
  update internal.paymongo_checkout_attempts
  set status = 'review', updated_at = now()
  where status = 'creating' and paymongo_session_id is null
    and created_at <= now() - interval '23 hours';

  return query
    select a.id, a.paymongo_session_id
    from internal.paymongo_checkout_attempts a
    join public.booking b on b.booking_id = a.booking_id
    where a.status = 'ready' and a.paymongo_session_id is not null
      and b.time_date <= now()
    order by b.time_date asc
    limit 50;
end;
$$;
revoke all on function public.list_paymongo_checkouts_due_for_expiry() from public, anon, authenticated;
grant execute on function public.list_paymongo_checkouts_due_for_expiry() to service_role;

comment on function public.list_paymongo_checkouts_due_for_expiry() is
  'Expires due PayMongo sessions and moves 23-hour unattached creation attempts into fail-closed staff review.';
