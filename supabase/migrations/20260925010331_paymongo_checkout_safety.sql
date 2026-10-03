-- The online amount shown to staff must never come from client-supplied
-- booking.amount_total. Keep it aligned with the immutable server snapshot.
create or replace function public.prepare_paymongo_checkout(p_booking_id bigint, p_customer_id uuid)
returns table (attempt_id uuid, amount_minor bigint, total_minor bigint, payment_option text,
               booking_id bigint, courts text, time_date timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  b public.booking%rowtype;
  v_rate numeric;
  v_pct numeric;
  v_total numeric;
  v_charge numeric;
  v_attempt internal.paymongo_checkout_attempts%rowtype;
begin
  select * into b from public.booking where public.booking.booking_id = p_booking_id for update;
  if not found or b.customer_id <> p_customer_id then
    raise exception 'Booking not found' using errcode = 'P0002';
  end if;
  if b.status not in ('pending', 'confirmed') or b.checked_in_at is not null
     or b.payment_id is not null or b.amount_paid <> 0 or b.payment_option is null
     or b.payment_option not in ('full', 'downpayment') or b.time_date <= now() then
    raise exception 'This booking is not eligible for online payment' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_customer_id and p.status = 'active') then
    raise exception 'Active customer account required' using errcode = '42501';
  end if;
  select c.rate into v_rate from public.court c
    where lower(btrim(c.name)) = lower(btrim(b.courts)) and c.is_active and c.status = 'Available'
      and c.rate_unit = '/hr' limit 1;
  if v_rate is null or v_rate <= 0 then
    raise exception 'Online payment is unavailable until this court has an hourly rate' using errcode = '22023';
  end if;
  select s.downpayment_pct into v_pct from public.app_settings s where s.id = true;
  v_pct := coalesce(v_pct, 50);
  v_total := round(v_rate * coalesce(b.duration_minutes, 60)::numeric / 60, 2);
  v_charge := case when b.payment_option = 'full' then v_total else round(v_total * v_pct / 100, 2) end;
  if v_total <= 0 or v_charge <= 0 then
    raise exception 'Online payment amount must be greater than zero' using errcode = '22023';
  end if;

  select * into v_attempt from internal.paymongo_checkout_attempts a
    where a.booking_id = p_booking_id and a.status in ('creating', 'ready', 'review')
    order by a.created_at desc limit 1 for update;
  if not found then
    insert into internal.paymongo_checkout_attempts
      (booking_id, customer_id, amount_minor, total_minor, payment_option)
    values (b.booking_id, p_customer_id, round(v_charge * 100)::bigint,
            round(v_total * 100)::bigint, b.payment_option)
    returning * into v_attempt;
  end if;
  update public.booking set amount_total = v_attempt.total_minor / 100.0
    where public.booking.booking_id = b.booking_id;

  return query select v_attempt.id, v_attempt.amount_minor, v_attempt.total_minor,
    v_attempt.payment_option, b.booking_id, b.courts, b.time_date;
end;
$$;
revoke all on function public.prepare_paymongo_checkout(bigint, uuid) from public, anon, authenticated;
grant execute on function public.prepare_paymongo_checkout(bigint, uuid) to service_role;

create or replace function internal.guard_paymongo_booking_manual_collection()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.checked_in_at is distinct from old.checked_in_at
      or new.amount_paid > old.amount_paid
      or new.payment_id is distinct from old.payment_id)
     and exists (
       select 1 from internal.paymongo_checkout_attempts a
       where a.booking_id = old.booking_id and a.status in ('creating', 'ready', 'review')
     ) then
    raise exception 'An online checkout is still open. Verify or expire it before collecting payment.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_paymongo_booking_manual_collection() from public, anon, authenticated;
drop trigger if exists booking_guard_paymongo_collection on public.booking;
create trigger booking_guard_paymongo_collection before update on public.booking
for each row execute function internal.guard_paymongo_booking_manual_collection();

create or replace function public.record_paymongo_paid(
  p_event_id text, p_session_id text, p_payment_id text, p_amount_minor bigint
) returns text language plpgsql security definer set search_path = '' as $$
declare
  a internal.paymongo_checkout_attempts%rowtype;
  v_payment_id bigint;
begin
  select * into a from internal.paymongo_checkout_attempts
    where paymongo_session_id = p_session_id for update;
  if not found then raise exception 'Unknown PayMongo checkout session' using errcode = 'P0002'; end if;
  insert into internal.paymongo_webhook_events(event_id, event_type)
    values (p_event_id, 'checkout_session.payment.paid') on conflict do nothing;
  if not found then return 'duplicate'; end if;
  if a.status = 'paid' then return 'duplicate'; end if;
  if a.status not in ('ready', 'review') or p_amount_minor <> a.amount_minor
     or nullif(p_payment_id, '') is null then
    update internal.paymongo_checkout_attempts set status = 'review', updated_at = now() where id = a.id;
    return 'review';
  end if;
  if not exists (select 1 from public.booking b where b.booking_id = a.booking_id
                 and b.customer_id = a.customer_id and b.status in ('pending', 'confirmed')
                 and b.payment_id is null and b.amount_paid = 0 and b.checked_in_at is null) then
    update internal.paymongo_checkout_attempts set status = 'review', updated_at = now() where id = a.id;
    return 'review';
  end if;

  insert into public.payment(cost, paid, payment_method, down_full)
    values (a.total_minor / 100.0, a.amount_minor / 100.0, 'PayMongo', a.payment_option)
    returning payment_id into v_payment_id;
  update internal.paymongo_checkout_attempts set status = 'paid', paymongo_payment_id = p_payment_id,
    updated_at = now() where id = a.id;
  update public.booking set payment_id = v_payment_id, amount_total = a.total_minor / 100.0,
    amount_paid = a.amount_minor / 100.0, status = 'confirmed'
    where booking_id = a.booking_id;
  return 'paid';
end;
$$;
revoke all on function public.record_paymongo_paid(text, text, text, bigint) from public, anon, authenticated;
grant execute on function public.record_paymongo_paid(text, text, text, bigint) to service_role;

create or replace function internal.cancel_no_show_bookings()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  online_count integer;
  walkin_count integer;
begin
  update public.booking b
  set status = 'cancelled', auto_cancelled_at = now()
  where b.no_show_policy_applies
    and b.status in ('pending', 'confirmed')
    and b.checked_in_at is null
    and b.time_date + interval '30 minutes' < now()
    and not exists (
      select 1 from internal.paymongo_checkout_attempts a
      where a.booking_id = b.booking_id and a.status in ('creating', 'ready', 'review')
    );
  get diagnostics online_count = row_count;
  update public.walk_in_booking w
  set status = 'cancelled', auto_cancelled_at = now()
  where w.no_show_policy_applies
    and w.status in ('pending', 'confirmed')
    and w.checked_in_at is null
    and w.time_date + interval '30 minutes' < now();
  get diagnostics walkin_count = row_count;
  return online_count + walkin_count;
end;
$$;
revoke all on function internal.cancel_no_show_bookings() from public, anon, authenticated;
