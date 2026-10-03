-- Durable, server-priced PayMongo checkout attempts. The browser never sends
-- an amount or provider credential; Edge Functions are the only callers.
create schema if not exists internal;

create table internal.paymongo_checkout_attempts (
  id uuid primary key default gen_random_uuid(),
  booking_id bigint not null references public.booking(booking_id) on delete restrict,
  customer_id uuid not null references public.profiles(id) on delete restrict,
  amount_minor bigint not null check (amount_minor > 0),
  total_minor bigint not null check (total_minor >= amount_minor),
  currency text not null default 'PHP' check (currency = 'PHP'),
  payment_option text not null check (payment_option in ('full', 'downpayment')),
  status text not null default 'creating'
    check (status in ('creating', 'ready', 'paid', 'expired', 'review')),
  paymongo_session_id text unique,
  checkout_url text,
  paymongo_payment_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint paymongo_attempt_ready_fields check (
    status not in ('ready', 'paid') or (paymongo_session_id is not null and checkout_url is not null)
  )
);
create unique index paymongo_one_active_attempt_per_booking
  on internal.paymongo_checkout_attempts (booking_id)
  where status in ('creating', 'ready', 'review');
create index paymongo_attempt_customer_recent
  on internal.paymongo_checkout_attempts (customer_id, created_at desc);

create table internal.paymongo_webhook_events (
  event_id text primary key,
  event_type text not null,
  received_at timestamptz not null default now()
);

alter table internal.paymongo_checkout_attempts enable row level security;
alter table internal.paymongo_webhook_events enable row level security;
revoke all on internal.paymongo_checkout_attempts, internal.paymongo_webhook_events
  from public, anon, authenticated;
grant usage on schema internal to service_role;
grant select, insert, update on internal.paymongo_checkout_attempts to service_role;
grant select, insert on internal.paymongo_webhook_events to service_role;

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
     or b.payment_option not in ('full', 'downpayment')
     or b.time_date <= now() then
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

  return query select v_attempt.id, v_attempt.amount_minor, v_attempt.total_minor,
    v_attempt.payment_option, b.booking_id, b.courts, b.time_date;
end;
$$;
revoke all on function public.prepare_paymongo_checkout(bigint, uuid) from public, anon, authenticated;
grant execute on function public.prepare_paymongo_checkout(bigint, uuid) to service_role;

create or replace function public.attach_paymongo_checkout(
  p_attempt_id uuid, p_session_id text, p_checkout_url text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if p_session_id !~ '^cs_[A-Za-z0-9]+' or p_checkout_url !~ '^https://checkout\.paymongo\.com/' then
    raise exception 'Invalid PayMongo checkout response' using errcode = '22023';
  end if;
  update internal.paymongo_checkout_attempts
    set paymongo_session_id = p_session_id, checkout_url = p_checkout_url,
        status = 'ready', updated_at = now()
    where id = p_attempt_id and status = 'creating'
      and (paymongo_session_id is null or paymongo_session_id = p_session_id);
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;
revoke all on function public.attach_paymongo_checkout(uuid, text, text) from public, anon, authenticated;
grant execute on function public.attach_paymongo_checkout(uuid, text, text) to service_role;

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
                 and b.payment_id is null and b.amount_paid = 0) then
    update internal.paymongo_checkout_attempts set status = 'review', updated_at = now() where id = a.id;
    return 'review';
  end if;

  insert into public.payment(cost, paid, payment_method, down_full)
    values (a.total_minor / 100.0, a.amount_minor / 100.0, 'PayMongo', a.payment_option)
    returning payment_id into v_payment_id;
  update public.booking set payment_id = v_payment_id, amount_total = a.total_minor / 100.0,
    amount_paid = a.amount_minor / 100.0, status = 'confirmed'
    where booking_id = a.booking_id;
  update internal.paymongo_checkout_attempts set status = 'paid', paymongo_payment_id = p_payment_id,
    updated_at = now() where id = a.id;
  return 'paid';
end;
$$;
revoke all on function public.record_paymongo_paid(text, text, text, bigint) from public, anon, authenticated;
grant execute on function public.record_paymongo_paid(text, text, text, bigint) to service_role;

create or replace function public.get_paymongo_checkout_attempt(p_attempt_id uuid, p_customer_id uuid)
returns table (id uuid, status text, checkout_url text, amount_minor bigint, total_minor bigint,
              currency text, payment_option text)
language sql security definer set search_path = '' as $$
  select a.id, a.status, a.checkout_url, a.amount_minor, a.total_minor, a.currency, a.payment_option
  from internal.paymongo_checkout_attempts a
  where a.id = p_attempt_id and a.customer_id = p_customer_id
$$;
revoke all on function public.get_paymongo_checkout_attempt(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_paymongo_checkout_attempt(uuid, uuid) to service_role;
