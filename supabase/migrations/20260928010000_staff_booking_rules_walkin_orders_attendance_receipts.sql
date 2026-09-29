-- Shared booking rules, staff walk-in orders, immutable payment acknowledgments,
-- and server-controlled attendance/payment records.

create table if not exists public.booking_rule_sets (
  effective_from date primary key,
  grace_minutes integer not null default 30 check (grace_minutes between 0 and 720),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.booking_rule_days (
  effective_from date not null references public.booking_rule_sets(effective_from) on delete cascade,
  weekday smallint not null check (weekday between 1 and 7),
  is_closed boolean not null default false,
  opens_at time,
  closes_at time,
  primary key (effective_from, weekday),
  check ((is_closed and opens_at is null and closes_at is null)
      or (not is_closed and opens_at is not null and closes_at > opens_at
        and extract(minute from opens_at)=0 and extract(second from opens_at)=0
        and extract(minute from closes_at)=0 and extract(second from closes_at)=0))
);

alter table public.booking_rule_sets enable row level security;
alter table public.booking_rule_days enable row level security;
revoke all on public.booking_rule_sets, public.booking_rule_days from public, anon, authenticated;

insert into public.booking_rule_sets(effective_from,grace_minutes)
values(date '1970-01-01',30) on conflict (effective_from) do nothing;
insert into public.booking_rule_days(effective_from,weekday,is_closed,opens_at,closes_at)
select date '1970-01-01',d,false,time '08:00',time '20:00'
from generate_series(1,7) d
on conflict (effective_from,weekday) do nothing;

create or replace function internal.booking_rule_for_date(p_date date)
returns table(opens_at time, closes_at time, is_closed boolean, grace_minutes integer)
language sql stable security definer set search_path = '' as $$
  select d.opens_at,d.closes_at,d.is_closed,s.grace_minutes
  from public.booking_rule_sets s
  join public.booking_rule_days d on d.effective_from=s.effective_from
  where s.effective_from=(select max(s2.effective_from) from public.booking_rule_sets s2
    where s2.effective_from<=p_date)
    and d.weekday=extract(isodow from p_date)::smallint
$$;
revoke all on function internal.booking_rule_for_date(date) from public,anon,authenticated;

create or replace function public.booking_rules_for_date(p_date date)
returns table(open_hour smallint,close_hour smallint,is_closed boolean,grace_minutes integer,timezone text)
language plpgsql stable security definer set search_path = '' as $$
declare r record; v_actor uuid:=(select auth.uid());
begin
  if v_actor is null or not exists(select 1 from public.profiles p where p.id=v_actor
    and p.role in ('customer','staff','admin') and p.status='active') then
    raise exception 'Active account access is required' using errcode='42501';
  end if;
  if p_date is null then raise exception 'A business date is required' using errcode='22023'; end if;
  select * into r from internal.booking_rule_for_date(p_date);
  if not found then
    return query select 8::smallint,20::smallint,false,30,'Asia/Manila'::text;
  else
    return query select extract(hour from r.opens_at)::smallint,
      extract(hour from r.closes_at)::smallint,r.is_closed,r.grace_minutes,'Asia/Manila'::text;
  end if;
end;
$$;
revoke all on function public.booking_rules_for_date(date) from public,anon;
grant execute on function public.booking_rules_for_date(date) to authenticated;

create or replace function public.owner_get_booking_rules()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor uuid:=(select auth.uid()); result jsonb;
begin
  if v_actor is null or not exists(select 1 from public.profiles p where p.id=v_actor
    and p.role='admin' and p.status='active') then
    raise exception 'Active owner access is required' using errcode='42501';
  end if;
  select jsonb_build_object('timezone','Asia/Manila','rules',coalesce(jsonb_agg(
    jsonb_build_object('effective_from',s.effective_from,'grace_minutes',s.grace_minutes,
      'weekly_hours',(select jsonb_agg(jsonb_build_object('weekday',d.weekday,
        'opens_at',case when d.is_closed then null else to_char(d.opens_at,'HH24:MI') end,
        'closes_at',case when d.is_closed then null else to_char(d.closes_at,'HH24:MI') end,
        'is_closed',d.is_closed) order by d.weekday)
        from public.booking_rule_days d where d.effective_from=s.effective_from))
    order by s.effective_from desc),'[]'::jsonb)) into result
  from public.booking_rule_sets s;
  return result;
end;
$$;
revoke all on function public.owner_get_booking_rules() from public,anon;
grant execute on function public.owner_get_booking_rules() to authenticated;

create or replace function public.owner_save_booking_rules(
  p_weekly_hours jsonb,p_grace_minutes integer,p_effective_from date
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid:=(select auth.uid()); v_until date; v_row jsonb; v_day integer;
  v_open time; v_close time; v_closed boolean; v_count integer:=0;
begin
  if v_actor is null or not exists(select 1 from public.profiles p where p.id=v_actor
    and p.role='admin' and p.status='active') then
    raise exception 'Active owner access is required' using errcode='42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
  if p_effective_from is null or p_effective_from < (now() at time zone 'Asia/Manila')::date
     or p_grace_minutes is null or p_grace_minutes not between 0 and 720
     or jsonb_typeof(p_weekly_hours) is distinct from 'array'
     or jsonb_array_length(p_weekly_hours)<>7 then
    raise exception 'Choose a future effective date, seven weekly days, and a grace period from 0 to 720 minutes' using errcode='22023';
  end if;

  select min(effective_from) into v_until from public.booking_rule_sets
    where effective_from>p_effective_from;
  for v_row in select value from jsonb_array_elements(p_weekly_hours) loop
    v_day:=nullif(v_row->>'weekday','')::integer;
    if v_day is null or v_day not between 1 and 7 or exists(
      select 1 from jsonb_array_elements(p_weekly_hours) j
      where j.value->>'weekday'=v_row->>'weekday' and j.value is distinct from v_row
    ) then
      raise exception 'Use each ISO weekday number from 1 to 7 exactly once' using errcode='22023';
    end if;
    v_closed:=coalesce((v_row->>'is_closed')::boolean,false);
    if v_closed then v_open:=null; v_close:=null;
    else
      v_open:=nullif(v_row->>'opens_at','')::time;
      v_close:=nullif(v_row->>'closes_at','')::time;
      if v_open is null or v_close is null or v_close<=v_open
        or extract(minute from v_open)<>0 or extract(second from v_open)<>0
        or extract(minute from v_close)<>0 or extract(second from v_close)<>0 then
        raise exception 'Open and close times must be whole-hour values with close after open' using errcode='22023';
      end if;
    end if;
    v_count:=v_count+1;
  end loop;
  if (select count(distinct nullif(value->>'weekday','')::integer)
      from jsonb_array_elements(p_weekly_hours))<>7 then
    raise exception 'Use each ISO weekday number from 1 to 7 exactly once' using errcode='22023';
  end if;

  -- A scheduled ruleset cannot strand an existing reservation or payment hold.
  if exists(
    select 1 from (
      select b.time_date starts_at,b.end_at ends_at from public.booking b
        where b.status in ('pending','confirmed') and b.end_at>now()
      union all
      select w.time_date,w.end_at from public.walk_in_booking w
        where w.status in ('pending','confirmed') and w.end_at>now()
      union all
      select x.starts_at,x.ends_at from internal.checkout_intent_items x
        join internal.checkout_intents i on i.id=x.intent_id
          and i.status in ('creating','ready','review') and i.expires_at>now()
        join internal.paymongo_checkout_attempts a on a.intent_id=i.id
          and a.status in ('creating','ready','review') and a.paymongo_payment_id is null
    ) r
    cross join lateral internal.booking_rule_for_date((r.starts_at at time zone 'Asia/Manila')::date) old_rule
    where (r.starts_at at time zone 'Asia/Manila')::date>=p_effective_from
      and (v_until is null or (r.starts_at at time zone 'Asia/Manila')::date<v_until)
      and exists(select 1 from jsonb_array_elements(p_weekly_hours) j
        where nullif(j.value->>'weekday','')::integer=extract(isodow from r.starts_at at time zone 'Asia/Manila')::integer
          and (coalesce((j.value->>'is_closed')::boolean,false)
            or (r.starts_at at time zone 'Asia/Manila')::time<nullif(j.value->>'opens_at','')::time
            or (r.ends_at at time zone 'Asia/Manila')::time>nullif(j.value->>'closes_at','')::time))
  ) then
    raise exception 'These hours conflict with an existing reservation or payment hold' using errcode='23P01';
  end if;

  insert into public.booking_rule_sets(effective_from,grace_minutes,created_by,updated_at)
    values(p_effective_from,p_grace_minutes,v_actor,now())
    on conflict(effective_from) do update set grace_minutes=excluded.grace_minutes,
      created_by=excluded.created_by,updated_at=now();
  delete from public.booking_rule_days where effective_from=p_effective_from;
  for v_row in select value from jsonb_array_elements(p_weekly_hours) loop
    v_day:=(v_row->>'weekday')::integer;
    v_closed:=coalesce((v_row->>'is_closed')::boolean,false);
    v_open:=case when v_closed then null else nullif(v_row->>'opens_at','')::time end;
    v_close:=case when v_closed then null else nullif(v_row->>'closes_at','')::time end;
    insert into public.booking_rule_days(effective_from,weekday,is_closed,opens_at,closes_at)
      values(p_effective_from,v_day,v_closed,v_open,v_close);
  end loop;
  return jsonb_build_object('saved',true,'effective_from',p_effective_from,
    'grace_minutes',p_grace_minutes,'timezone','Asia/Manila');
end;
$$;
revoke all on function public.owner_save_booking_rules(jsonb,integer,date) from public,anon;
grant execute on function public.owner_save_booking_rules(jsonb,integer,date) to authenticated;

-- Every new reservation uses the same owner-managed hours as the availability UI.
create or replace function internal.guard_reservation_business_hours()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_rule record; v_start_local timestamp; v_end_local timestamp;
begin
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
  if new.time_date is null or new.end_at is null or new.end_at<=new.time_date then
    raise exception 'Choose a valid reservation time' using errcode='22023';
  end if;
  v_start_local:=new.time_date at time zone 'Asia/Manila';
  v_end_local:=new.end_at at time zone 'Asia/Manila';
  if v_start_local::date<>v_end_local::date then
    raise exception 'A reservation must start and end on the same local date' using errcode='22023';
  end if;
  select * into v_rule from internal.booking_rule_for_date(v_start_local::date);
  if not found then
    if v_start_local::time<time '08:00' or v_end_local::time>time '20:00' then
      raise exception 'Choose a time within business hours' using errcode='22023';
    end if;
  elsif v_rule.is_closed or v_start_local::time<v_rule.opens_at or v_end_local::time>v_rule.closes_at then
    raise exception 'The selected time is outside business hours' using errcode='22023';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_reservation_business_hours() from public,anon,authenticated;
drop trigger if exists booking_rules_guard on public.booking;
create trigger booking_rules_guard before insert or update of time_date,end_at on public.booking
  for each row execute function internal.guard_reservation_business_hours();
drop trigger if exists walkin_rules_guard on public.walk_in_booking;
create trigger walkin_rules_guard before insert or update of time_date,end_at on public.walk_in_booking
  for each row execute function internal.guard_reservation_business_hours();

-- Optional customer linkage belongs to the order and every child reservation.
create table if not exists internal.staff_walkin_orders (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.profiles(id) on delete restrict,
  customer_id uuid references public.profiles(id) on delete set null,
  guest_name text,
  guest_mobile text,
  status text not null check (status in ('awaiting_payment','paid','expired','review')),
  subtotal_minor bigint not null check (subtotal_minor>0),
  fee_minor bigint not null default 0 check (fee_minor>=0),
  gross_minor bigint check (gross_minor is null or gross_minor>=subtotal_minor),
  payment_id bigint references public.payment(payment_id) on delete restrict,
  receipt_id uuid,
  expires_at timestamptz not null default (now()+interval '15 minutes'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((customer_id is not null and guest_name is null)
      or (customer_id is null and nullif(btrim(guest_name),'') is not null))
);
alter table internal.staff_walkin_orders enable row level security;
revoke all on internal.staff_walkin_orders from public,anon,authenticated;
grant select,insert,update on internal.staff_walkin_orders to service_role;

alter table public.walk_in_booking add column if not exists customer_id uuid references public.profiles(id) on delete set null;
alter table public.walk_in_booking add column if not exists walkin_order_id uuid references internal.staff_walkin_orders(id) on delete restrict;
alter table public.walk_in_booking add column if not exists checked_out_at timestamptz;
create index if not exists walkin_customer_recent_idx on public.walk_in_booking(customer_id,time_date desc,walkin_id desc)
  where customer_id is not null;
create index if not exists walkin_order_idx on public.walk_in_booking(walkin_order_id,walkin_id)
  where walkin_order_id is not null;

alter table public.walk_in_booking drop constraint if exists walk_in_booking_status_check;
alter table public.walk_in_booking add constraint walk_in_booking_status_check
  check (status in ('pending','confirmed','cancelled','completed','unattended'));

alter table public.payment add column if not exists base_minor bigint not null default 0;
alter table public.payment add column if not exists fee_minor bigint not null default 0;
alter table public.payment add column if not exists gross_minor bigint not null default 0;
alter table public.payment add column if not exists net_minor bigint not null default 0;
alter table public.profiles add column if not exists phone_verified boolean not null default false;
alter table public.profiles add column if not exists contact_num_validated boolean not null default false;
alter table public.profiles add column if not exists contact_num_validated_at timestamptz;
update public.profiles set phone_verified=false where phone_verified is distinct from false;
comment on column public.profiles.contact_num_validated is
  'True when Abstract Phone Intelligence accepted the current number as a valid Philippine mobile; this does not prove ownership. Existing values default false because historical client-written flags are not trusted.';
comment on column public.profiles.contact_num_validated_at is
  'Time the current contact number passed format, country, and mobile-line validation; null for historical records without a known validation time.';
comment on column public.profiles.phone_verified is
  'Legacy Supabase SMS ownership flag. New Abstract API checks do not establish phone ownership and never set this flag true.';
update public.payment set base_minor=round(paid*100)::bigint,
  gross_minor=round(paid*100)::bigint,net_minor=round(paid*100)::bigint where base_minor=0 and paid>0;
alter table public.payment drop constraint if exists payment_minor_amounts_nonnegative;
alter table public.payment add constraint payment_minor_amounts_nonnegative
  check (base_minor>=0 and fee_minor>=0 and gross_minor>=base_minor and net_minor>=0);

alter table internal.paymongo_checkout_attempts alter column customer_id drop not null;
alter table internal.paymongo_checkout_attempts add column if not exists walkin_order_id uuid
  references internal.staff_walkin_orders(id) on delete restrict;
alter table internal.paymongo_checkout_attempts add column if not exists pass_on_fees boolean not null default false;
alter table internal.paymongo_checkout_attempts add column if not exists fee_minor bigint not null default 0;
alter table internal.paymongo_checkout_attempts add column if not exists gross_minor bigint;
alter table internal.paymongo_checkout_attempts add column if not exists net_minor bigint;
alter table internal.paymongo_checkout_attempts add column if not exists checkout_request jsonb;
alter table internal.paymongo_checkout_attempts alter column pass_on_fees set default true;
alter table internal.paymongo_checkout_attempts drop constraint if exists paymongo_attempt_one_target;
alter table internal.paymongo_checkout_attempts add constraint paymongo_attempt_one_target
  check (num_nonnulls(booking_id,intent_id,balance_id,walkin_order_id)=1);
alter table internal.paymongo_checkout_attempts drop constraint if exists paymongo_attempt_balance_fields;
alter table internal.paymongo_checkout_attempts add constraint paymongo_attempt_balance_fields check (
  (balance_id is null and balance_source is null and
    ((walkin_order_id is null and staff_id is null) or (walkin_order_id is not null and staff_id is not null)))
  or (balance_id is not null and balance_source is not null and staff_id is not null and walkin_order_id is null)
);
create unique index if not exists paymongo_one_active_walkin_attempt
  on internal.paymongo_checkout_attempts(walkin_order_id)
  where walkin_order_id is not null and status in ('creating','ready','review');

create sequence if not exists internal.payment_acknowledgment_number_seq;
create table if not exists internal.payment_acknowledgments (
  payment_id bigint primary key references public.payment(payment_id) on delete restrict,
  receipt_id uuid not null unique default gen_random_uuid(),
  receipt_number text not null unique,
  order_id uuid references internal.staff_walkin_orders(id) on delete restrict,
  issued_at timestamptz not null default now(),
  payload jsonb not null
);
alter table internal.payment_acknowledgments enable row level security;
revoke all on internal.payment_acknowledgments from public,anon,authenticated;
grant select,insert on internal.payment_acknowledgments to service_role;
alter table internal.staff_walkin_orders add constraint staff_walkin_orders_receipt_id_fkey
  foreign key(receipt_id) references internal.payment_acknowledgments(receipt_id) on delete set null;

create or replace function internal.persist_payment_acknowledgment(
  p_payment_id bigint,p_source text,p_reservation_id bigint default null,p_order_id uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_existing jsonb; v_receipt_id uuid:=gen_random_uuid(); v_receipt_number text;
  v_issued_at timestamptz:=now(); v_name text; v_mobile text; v_customer_id uuid;
  v_items jsonb; v_payment public.payment%rowtype; v_payload jsonb;
  v_court_subtotal_minor bigint; v_paid_to_date_minor bigint; v_remaining_minor bigint;
begin
  select a.payload into v_existing from internal.payment_acknowledgments a where a.payment_id=p_payment_id;
  if v_existing is not null then return v_existing; end if;
  select * into v_payment from public.payment p where p.payment_id=p_payment_id;
  if not found then raise exception 'Payment record not found' using errcode='P0002'; end if;

  if p_source='booking' then
    select b.customer_id,p.full_name,p.contact_num,
      round(coalesce(b.amount_total,0)*100)::bigint,
      jsonb_build_array(jsonb_build_object('reservation_id',b.booking_id,'sport',b.sports,
        'court',b.courts,'unit',b.court_unit,'starts_at',b.time_date,'ends_at',b.end_at,
        'subtotal_minor',round(coalesce(b.amount_total,0)*100)::bigint,
        'subtotal',round(coalesce(b.amount_total,0)::numeric,2)))
      into v_customer_id,v_name,v_mobile,v_court_subtotal_minor,v_items
    from public.booking b left join public.profiles p on p.id=b.customer_id
    where b.booking_id=p_reservation_id;
    select coalesce(sum(pay.base_minor),0)::bigint into v_paid_to_date_minor
      from public.booking b join public.payment pay on pay.payment_id in (b.payment_id,b.balance_payment_id)
      where b.booking_id=p_reservation_id and pay.created_at<=v_payment.created_at;
  elsif p_source='walkin' then
    select w.customer_id,coalesce(p.full_name,w.customer_name),coalesce(p.contact_num,w.customer_mobile),
      round(coalesce(w.amount_total,0)*100)::bigint,
      jsonb_build_array(jsonb_build_object('reservation_id',w.walkin_id,'sport',w.sports,
        'court',w.courts,'unit',w.court_unit,'starts_at',w.time_date,'ends_at',w.end_at,
        'subtotal_minor',round(coalesce(w.amount_total,0)*100)::bigint,
        'subtotal',round(coalesce(w.amount_total,0)::numeric,2)))
      into v_customer_id,v_name,v_mobile,v_court_subtotal_minor,v_items
    from public.walk_in_booking w left join public.profiles p on p.id=w.customer_id
    where w.walkin_id=p_reservation_id;
    select coalesce(sum(pay.base_minor),0)::bigint into v_paid_to_date_minor
      from public.walk_in_booking w join public.payment pay
        on pay.payment_id in (w.payment_id,w.balance_payment_id)
      where w.walkin_id=p_reservation_id and pay.created_at<=v_payment.created_at;
  elsif p_source='walkin_order' then
    select o.customer_id,coalesce(p.full_name,o.guest_name),coalesce(p.contact_num,o.guest_mobile),
      (select round(coalesce(sum(w2.amount_total),0)*100)::bigint
        from public.walk_in_booking w2 where w2.walkin_order_id=o.id),
      (select jsonb_agg(jsonb_build_object('reservation_id',w.walkin_id,'sport',w.sports,
        'court',w.courts,'unit',w.court_unit,'starts_at',w.time_date,'ends_at',w.end_at,
        'subtotal_minor',round(coalesce(w.amount_total,0)*100)::bigint,
        'subtotal',round(coalesce(w.amount_total,0)::numeric,2))
        order by w.time_date,w.walkin_id) from public.walk_in_booking w where w.walkin_order_id=o.id)
      into v_customer_id,v_name,v_mobile,v_court_subtotal_minor,v_items
    from internal.staff_walkin_orders o left join public.profiles p on p.id=o.customer_id
    where o.id=p_order_id;
    select coalesce(sum(q.base_minor),0)::bigint into v_paid_to_date_minor from (
      select distinct pay.payment_id,pay.base_minor from internal.staff_walkin_orders o
      left join public.walk_in_booking w on w.walkin_order_id=o.id
      join public.payment pay on pay.payment_id=o.payment_id or pay.payment_id=w.balance_payment_id
      where o.id=p_order_id and pay.created_at<=v_payment.created_at
    ) q;
  else
    raise exception 'Invalid receipt source' using errcode='22023';
  end if;
  if v_items is null or v_items='[]'::jsonb then
    raise exception 'Reservation receipt details not found' using errcode='P0002';
  end if;
  v_remaining_minor:=greatest(0,coalesce(v_court_subtotal_minor,0)-coalesce(v_paid_to_date_minor,0));

  v_receipt_number:='PA-'||to_char(v_issued_at at time zone 'Asia/Manila','YYYYMMDD')||'-'||
    lpad(nextval('internal.payment_acknowledgment_number_seq')::text,7,'0');
  v_payload:=jsonb_build_object(
    'receipt_id',v_receipt_id,'receipt_number',v_receipt_number,'issued_at',v_issued_at,
    'customer_name',coalesce(nullif(btrim(v_name),''),'Guest'),'mobile',nullif(btrim(v_mobile),''),
    'items',v_items,'court_subtotal_minor',coalesce(v_court_subtotal_minor,0),
    'court_subtotal',coalesce(v_court_subtotal_minor,0)/100.0,
    'subtotal_minor',v_payment.base_minor,'amount_paid_minor',v_payment.base_minor,
    'paid_minor',v_payment.base_minor,
    'payment_base_minor',v_payment.base_minor,'amount_paid',v_payment.base_minor/100.0,
    'remaining_balance_minor',v_remaining_minor,'remaining_minor',v_remaining_minor,
    'remaining_balance',v_remaining_minor/100.0,
    'fee_minor',v_payment.fee_minor,
    'gross_minor',v_payment.gross_minor,'subtotal',v_payment.base_minor/100.0,
    'fee',v_payment.fee_minor/100.0,'total',v_payment.gross_minor/100.0,
    'payment_method',v_payment.payment_method,'payment_status','paid',
    'disclaimer','Payment acknowledgment and entry pass — not a BIR invoice or official receipt.');
  insert into internal.payment_acknowledgments(payment_id,receipt_id,receipt_number,order_id,issued_at,payload)
    values(p_payment_id,v_receipt_id,v_receipt_number,p_order_id,v_issued_at,v_payload)
    on conflict(payment_id) do nothing;
  select a.payload into v_existing from internal.payment_acknowledgments a where a.payment_id=p_payment_id;
  if p_order_id is not null then
    update internal.staff_walkin_orders o set receipt_id=(v_existing->>'receipt_id')::uuid
      where o.id=p_order_id and o.receipt_id is null;
  end if;
  return v_existing;
end;
$$;
revoke all on function internal.persist_payment_acknowledgment(bigint,text,bigint,uuid) from public,anon,authenticated;

-- Preserve access to receipts for payments created before this migration. These
-- snapshots are issued now (not backdated); payment.created_at remains the
-- original settlement time in payment history.
do $$
declare r record;
begin
  for r in
    select distinct b.payment_id,'booking'::text source,b.booking_id reservation_id,null::uuid order_id
      from public.booking b where b.payment_id is not null
    union
    select distinct b.balance_payment_id,'booking'::text,b.booking_id,null::uuid
      from public.booking b where b.balance_payment_id is not null
    union
    select distinct o.payment_id,'walkin_order'::text,null::bigint,o.id
      from internal.staff_walkin_orders o where o.payment_id is not null
    union
    select distinct w.payment_id,'walkin'::text,w.walkin_id,null::uuid
      from public.walk_in_booking w where w.payment_id is not null and w.walkin_order_id is null
    union
    select distinct w.balance_payment_id,'walkin'::text,w.walkin_id,null::uuid
      from public.walk_in_booking w where w.balance_payment_id is not null
  loop
    perform internal.persist_payment_acknowledgment(r.payment_id,r.source,r.reservation_id,r.order_id);
  end loop;
end;
$$;

create or replace function internal.snapshot_reservation_payment_acknowledgment()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name='booking' then
    if new.payment_id is not null and (tg_op='INSERT' or new.payment_id is distinct from old.payment_id) then
      perform internal.persist_payment_acknowledgment(new.payment_id,'booking',new.booking_id,null);
    end if;
    if new.balance_payment_id is not null and (tg_op='INSERT' or new.balance_payment_id is distinct from old.balance_payment_id) then
      perform internal.persist_payment_acknowledgment(new.balance_payment_id,'booking',new.booking_id,null);
    end if;
  else
    if new.walkin_order_id is null then
      if new.payment_id is not null and (tg_op='INSERT' or new.payment_id is distinct from old.payment_id) then
        perform internal.persist_payment_acknowledgment(new.payment_id,'walkin',new.walkin_id,null);
      end if;
      if new.balance_payment_id is not null and (tg_op='INSERT' or new.balance_payment_id is distinct from old.balance_payment_id) then
        perform internal.persist_payment_acknowledgment(new.balance_payment_id,'walkin',new.walkin_id,null);
      end if;
    elsif new.balance_payment_id is not null and new.balance_payment_id is distinct from old.balance_payment_id then
      perform internal.persist_payment_acknowledgment(new.balance_payment_id,'walkin',new.walkin_id,null);
    end if;
  end if;
  return new;
end;
$$;
revoke all on function internal.snapshot_reservation_payment_acknowledgment() from public,anon,authenticated;
drop trigger if exists booking_snapshot_payment_ack on public.booking;
create trigger booking_snapshot_payment_ack after insert or update of payment_id,balance_payment_id on public.booking
  for each row execute function internal.snapshot_reservation_payment_acknowledgment();
drop trigger if exists walkin_snapshot_payment_ack on public.walk_in_booking;
create trigger walkin_snapshot_payment_ack after insert or update of payment_id,balance_payment_id on public.walk_in_booking
  for each row execute function internal.snapshot_reservation_payment_acknowledgment();

create or replace function public.get_payment_acknowledgment(p_source text,p_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid:=(select auth.uid()); v_customer uuid; v_order uuid;
  v_primary_payment bigint; v_balance_payment bigint; v_payment_id bigint; v_result jsonb;
begin
  if v_actor is null or not exists(select 1 from public.profiles p where p.id=v_actor
    and p.role in ('customer','staff','admin') and p.status='active') then
    raise exception 'Active account access is required' using errcode='42501';
  end if;
  if p_id is null or p_id<=0 then raise exception 'Invalid receipt reference' using errcode='22023'; end if;
  if p_source='booking' then
    select b.customer_id,b.payment_id,b.balance_payment_id into v_customer,v_primary_payment,v_balance_payment
      from public.booking b where b.booking_id=p_id;
  elsif p_source='walkin' then
    select w.customer_id,w.walkin_order_id,w.payment_id,w.balance_payment_id
      into v_customer,v_order,v_primary_payment,v_balance_payment
      from public.walk_in_booking w where w.walkin_id=p_id;
    if v_order is not null and v_customer is null then
      select o.customer_id into v_customer from internal.staff_walkin_orders o where o.id=v_order;
    end if;
  else
    raise exception 'Invalid receipt source' using errcode='22023';
  end if;
  if not found then raise exception 'Reservation not found' using errcode='P0002'; end if;
  if not (exists(select 1 from public.profiles p where p.id=v_actor and p.role in ('staff','admin'))
      or v_customer=v_actor) then raise exception 'Receipt not found' using errcode='P0002'; end if;

  select p.payment_id into v_payment_id from public.payment p
    where p.payment_id in (v_primary_payment,v_balance_payment)
    order by p.created_at desc,p.payment_id desc limit 1;
  if v_payment_id is null then raise exception 'No completed payment receipt exists' using errcode='P0002'; end if;
  if not exists(select 1 from internal.payment_acknowledgments a where a.payment_id=v_payment_id) then
    if p_source='booking' then
      perform internal.persist_payment_acknowledgment(v_payment_id,'booking',p_id,null);
    elsif v_order is not null then
      perform internal.persist_payment_acknowledgment(v_payment_id,'walkin_order',null,v_order);
    else
      perform internal.persist_payment_acknowledgment(v_payment_id,'walkin',p_id,null);
    end if;
  end if;
  select a.payload into v_result from internal.payment_acknowledgments a where a.payment_id=v_payment_id;
  return v_result;
end;
$$;
revoke all on function public.get_payment_acknowledgment(text,bigint) from public,anon;
grant execute on function public.get_payment_acknowledgment(text,bigint) to authenticated;

create or replace function public.get_walkin_order_acknowledgment(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=(select auth.uid()); v_customer uuid; v_payment_id bigint; v_result jsonb;
begin
  if v_actor is null or not exists(select 1 from public.profiles p where p.id=v_actor
    and p.role in ('customer','staff','admin') and p.status='active') then
    raise exception 'Active account access is required' using errcode='42501';
  end if;
  select o.customer_id,o.payment_id into v_customer,v_payment_id
    from internal.staff_walkin_orders o where o.id=p_order_id and o.status='paid';
  if not found or v_payment_id is null or not (v_customer=v_actor or exists(
    select 1 from public.profiles p where p.id=v_actor and p.role in ('staff','admin'))) then
    raise exception 'Receipt not found' using errcode='P0002';
  end if;
  if not exists(select 1 from internal.payment_acknowledgments a where a.payment_id=v_payment_id) then
    perform internal.persist_payment_acknowledgment(v_payment_id,'walkin_order',null,p_order_id);
  end if;
  select a.payload into v_result from internal.payment_acknowledgments a where a.payment_id=v_payment_id;
  return v_result;
end;
$$;
revoke all on function public.get_walkin_order_acknowledgment(uuid) from public,anon;
grant execute on function public.get_walkin_order_acknowledgment(uuid) to authenticated;

create or replace function public.customer_list_walkin_acknowledgments(p_offset integer default 0,p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=(select auth.uid()); result jsonb; r record;
begin
  if v_actor is null or not exists(select 1 from public.profiles p where p.id=v_actor
    and p.role='customer' and p.status='active') then
    raise exception 'Active customer access is required' using errcode='42501';
  end if;
  if p_offset<0 or p_limit not between 1 and 50 then raise exception 'Invalid receipt page' using errcode='22023'; end if;
  for r in select o.id,o.payment_id from internal.staff_walkin_orders o
    where o.customer_id=v_actor and o.status='paid' and o.payment_id is not null
      and not exists(select 1 from internal.payment_acknowledgments a where a.payment_id=o.payment_id)
  loop
    perform internal.persist_payment_acknowledgment(r.payment_id,'walkin_order',null,r.id);
  end loop;
  with filtered as (
    select o.id order_id,a.receipt_id,a.receipt_number,a.issued_at,a.payload
    from internal.staff_walkin_orders o
    join internal.payment_acknowledgments a on a.payment_id=o.payment_id
    where o.customer_id=v_actor and o.status='paid'
  ), page as (
    select * from filtered order by issued_at desc,order_id desc offset p_offset limit p_limit
  )
  select jsonb_build_object('total_count',(select count(*) from filtered),
    'rows',coalesce((select jsonb_agg(to_jsonb(page) order by issued_at desc,order_id desc) from page),'[]'::jsonb))
    into result;
  return result;
end;
$$;
revoke all on function public.customer_list_walkin_acknowledgments(integer,integer) from public,anon;
grant execute on function public.customer_list_walkin_acknowledgments(integer,integer) to authenticated;

create or replace function internal.guard_new_walkin_payment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=(select auth.uid()); v_order_staff uuid; v_order_status text;
begin
  if internal.authoritative_reservation_rate_unit(new.court_listing_id,new.court_unit_inventory_id)='/set'
    and (new.rate_quantity not between 1 and 100
      or new.end_at is distinct from new.time_date+make_interval(mins=>new.rate_quantity*60)) then
    raise exception 'Each set must reserve exactly 60 minutes on one lane' using errcode='22023';
  end if;
  if v_actor is not null and exists(select 1 from public.profiles p where p.id=v_actor
    and p.role in ('staff','admin') and p.status='active') then
    if new.walkin_order_id is not null
       and coalesce(current_setting('inigosync.staff_walkin_rpc',true),'')='on' then
      select o.staff_id,o.status into v_order_staff,v_order_status
        from internal.staff_walkin_orders o where o.id=new.walkin_order_id;
      if v_order_staff is null or v_order_staff<>v_actor then
        raise exception 'Walk-in order does not belong to this staff account' using errcode='42501';
      elsif v_order_status='awaiting_payment' and new.status='pending'
        and new.payment_method is null and new.payment_id is null and new.amount_paid=0 then
        null;
      elsif v_order_status='paid' and new.status='confirmed' and new.payment_method='Cash'
        and new.payment_id is not null and new.amount_total>0
        and new.amount_paid=new.amount_total
        and exists(select 1 from public.app_settings s where s.id=true and s.cash_enabled) then
        null;
      else
        raise exception 'Invalid staff walk-in payment state' using errcode='42501';
      end if;
    elsif new.payment_method is distinct from 'Cash'
       or not exists(select 1 from public.app_settings s where s.id=true and s.cash_enabled)
       or new.amount_total is null or new.amount_total<=0
       or new.amount_paid is distinct from new.amount_total then
      raise exception 'Only an enabled cash payment or a server-created online order can create a staff walk-in' using errcode='42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_new_walkin_payment() from public,anon,authenticated;

create or replace function public.staff_create_walkin_order(
  p_customer_id uuid,p_guest_name text,p_guest_mobile text,p_items jsonb,p_payment_method text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid:=(select auth.uid()); v_customer_name text; v_customer_mobile text;
  v_order_id uuid; v_status text; v_attempt_id uuid; v_payment_id bigint; v_receipt jsonb;
  v_item jsonb; v_prepared jsonb:='[]'::jsonb; v_item_result jsonb:='[]'::jsonb;
  v_listing public.court%rowtype; v_unit public.court_unit_inventory%rowtype;
  v_start timestamptz; v_end timestamptz; v_start_local timestamp; v_end_local timestamp;
  v_minutes integer; v_quantity integer; v_rate_unit text; v_price numeric; v_minor bigint;
  v_total_minor bigint:=0; v_walkin_id bigint; v_count integer:=0; v_rule record;
begin
  if v_actor is null or not exists(select 1 from public.profiles p where p.id=v_actor
    and p.role in ('staff','admin') and p.status='active') then
    raise exception 'Active staff access is required' using errcode='42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items)=0
     or octet_length(p_items::text)>1048576 or p_payment_method is null
     or p_payment_method not in ('cash','paymongo') then
    raise exception 'Choose at least one reservation and a valid payment method' using errcode='22023';
  end if;
  if p_payment_method='cash' and not exists(select 1 from public.app_settings s where s.id=true and s.cash_enabled) then
    raise exception 'Cash payment is disabled' using errcode='42501';
  end if;
  if p_payment_method='paymongo' and not exists(select 1 from public.app_settings s where s.id=true and (s.card_enabled or s.gcash_enabled)) then
    raise exception 'Online payment is unavailable' using errcode='22023';
  end if;
  if p_customer_id is not null then
    select p.full_name,p.contact_num into v_customer_name,v_customer_mobile
      from public.profiles p where p.id=p_customer_id and p.role='customer' and p.status='active';
    if not found then raise exception 'Select an active customer account' using errcode='22023'; end if;
  else
    v_customer_name:=nullif(btrim(p_guest_name),'');
    v_customer_mobile:=nullif(btrim(p_guest_mobile),'');
    if v_customer_name is null or length(v_customer_name)>160 then
      raise exception 'Enter the guest customer name' using errcode='22023';
    end if;
    if v_customer_mobile is not null and v_customer_mobile !~ '^(\+63|0)9[0-9]{9}$' then
      raise exception 'Enter a valid Philippine mobile number or leave it empty' using errcode='22023';
    end if;
  end if;

  -- Price and validate the complete order before inserting any reservation.
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_count:=v_count+1;
    select * into v_listing from public.court c where c.id=(v_item->>'listing_id')::uuid
      and c.is_active and c.status='Available';
    select * into v_unit from public.court_unit_inventory u where u.id=(v_item->>'unit_id')::uuid
      and u.court_id=v_listing.id and u.is_active and u.inventory_verified
      and u.availability_status='available';
    if v_listing.id is null or v_unit.id is null then
      raise exception 'A selected sport, court, or unit is unavailable' using errcode='22023';
    end if;
    v_start:=(v_item->>'starts_at')::timestamptz;
    v_end:=(v_item->>'ends_at')::timestamptz;
    v_start_local:=v_start at time zone 'Asia/Manila';
    v_end_local:=v_end at time zone 'Asia/Manila';
    v_quantity:=coalesce(nullif(v_item->>'rate_quantity','')::integer,1);
    if v_start is null or v_end is null
      or v_start_local::time<date_trunc('hour',now() at time zone 'Asia/Manila')::time
      or v_start_local::date<>(now() at time zone 'Asia/Manila')::date
      or v_end_local::date<>v_start_local::date
      or v_start_local::time<>date_trunc('hour',v_start_local)::time
      or v_end_local::time<>date_trunc('hour',v_end_local)::time
      or v_end<=v_start or v_end>v_start+interval '12 hours' or v_quantity not between 1 and 100 then
      raise exception 'Walk-in reservations must use current or future whole-hour slots today' using errcode='22023';
    end if;
    select * into v_rule from internal.booking_rule_for_date(v_start_local::date);
    if not found then
      if v_start_local::time<time '08:00' or v_end_local::time>time '20:00' then
        raise exception 'The selected time is outside business hours' using errcode='22023';
      end if;
    elsif v_rule.is_closed or v_start_local::time<v_rule.opens_at or v_end_local::time>v_rule.closes_at then
      raise exception 'The selected time is outside business hours' using errcode='22023';
    end if;
    if now()>v_start+make_interval(mins=>coalesce(v_rule.grace_minutes,30)) then
      raise exception 'Walk-in Time-In grace period has ended for this slot. Choose a later available time.'
        using errcode='55000';
    end if;
    v_minutes:=ceil(extract(epoch from (v_end-v_start))/60)::integer;
    if v_minutes%60<>0 then raise exception 'Walk-in times must use full-hour slots' using errcode='22023'; end if;
    v_rate_unit:=internal.authoritative_reservation_rate_unit(v_listing.id,v_unit.id);
    if v_rate_unit not in ('/hr','/set') then raise exception 'Court rate is unavailable' using errcode='22023'; end if;
    if v_rate_unit='/set' and (v_end<>v_start+make_interval(mins=>v_quantity*60) or v_minutes<>v_quantity*60) then
      raise exception 'Each set reserves exactly 60 minutes on one lane' using errcode='22023';
    end if;
    v_price:=internal.authoritative_reservation_amount(v_listing.id,v_unit.id,v_start,v_end,v_minutes,v_quantity);
    if v_price is null or v_price<=0 then raise exception 'Court rate is unavailable' using errcode='22023'; end if;
    v_minor:=round(v_price*100)::bigint;
    v_total_minor:=v_total_minor+v_minor;
    v_prepared:=v_prepared||jsonb_build_array(jsonb_build_object(
      'listing_id',v_listing.id,'unit_id',v_unit.id,'sport',(select s.name from public.sport s where s.id=v_listing.sport_id),
      'court',v_listing.name,'unit',v_unit.label,'starts_at',v_start,'ends_at',v_end,
      'minutes',v_minutes,'quantity',v_quantity,'rate_unit',v_rate_unit,'amount_minor',v_minor));
  end loop;

  v_status:=case when p_payment_method='cash' then 'paid' else 'awaiting_payment' end;
  insert into internal.staff_walkin_orders(staff_id,customer_id,guest_name,guest_mobile,status,subtotal_minor,gross_minor)
    values(v_actor,p_customer_id,case when p_customer_id is null then v_customer_name end,
      case when p_customer_id is null then v_customer_mobile end,v_status,v_total_minor,
      case when p_payment_method='cash' then v_total_minor else null end)
    returning id into v_order_id;
  if p_payment_method='cash' then
    perform set_config('inigosync.staff_payment_rpc','on',true);
    insert into public.payment(cost,paid,payment_method,down_full,base_minor,fee_minor,gross_minor,net_minor)
      values(v_total_minor/100.0,v_total_minor/100.0,'Cash','full',v_total_minor,0,v_total_minor,v_total_minor)
      returning payment_id into v_payment_id;
    update internal.staff_walkin_orders set payment_id=v_payment_id,updated_at=now() where id=v_order_id;
  else
    insert into internal.paymongo_checkout_attempts(booking_id,intent_id,customer_id,amount_minor,total_minor,
      payment_option,staff_id,walkin_order_id,pass_on_fees)
      values(null,null,p_customer_id,v_total_minor,v_total_minor,'full',v_actor,v_order_id,true)
      returning id into v_attempt_id;
  end if;

  perform set_config('inigosync.staff_walkin_rpc','on',true);
  for v_item in select value from jsonb_array_elements(v_prepared) loop
    insert into public.walk_in_booking(staff_id,customer_id,walkin_order_id,sports,courts,time_date,end_at,
      duration_minutes,court_unit,court_listing_id,court_unit_inventory_id,rate_quantity,rate_unit_snapshot,
      customer_name,customer_mobile,status,payment_method,payment_id,amount_total,amount_paid)
    values(v_actor,p_customer_id,v_order_id,v_item->>'sport',v_item->>'court',(v_item->>'starts_at')::timestamptz,
      (v_item->>'ends_at')::timestamptz,(v_item->>'minutes')::integer,v_item->>'unit',
      (v_item->>'listing_id')::uuid,(v_item->>'unit_id')::uuid,(v_item->>'quantity')::integer,v_item->>'rate_unit',
      v_customer_name,v_customer_mobile,
      case when p_payment_method='cash' then 'confirmed' else 'pending' end,
      case when p_payment_method='cash' then 'Cash' else null end,v_payment_id,
      (v_item->>'amount_minor')::bigint/100.0,
      case when p_payment_method='cash' then (v_item->>'amount_minor')::bigint/100.0 else 0 end)
    returning walkin_id into v_walkin_id;
    v_item_result:=v_item_result||jsonb_build_array(jsonb_build_object(
      'reservation_id',v_walkin_id,'sport',v_item->>'sport','court',v_item->>'court','unit',v_item->>'unit',
      'starts_at',v_item->>'starts_at','ends_at',v_item->>'ends_at','subtotal_minor',v_item->>'amount_minor'));
  end loop;
  if p_payment_method='cash' then
    v_receipt:=internal.persist_payment_acknowledgment(v_payment_id,'walkin_order',null,v_order_id);
    update internal.staff_walkin_orders set receipt_id=(v_receipt->>'receipt_id')::uuid where id=v_order_id;
  end if;
  insert into public.audit_log(actor_id,actor_role,action,entity_type,entity_id,details)
    values(v_actor,'staff','created_walkin_order','walkin_order',v_order_id::text,
      jsonb_build_object('customer_id',p_customer_id,'guest',p_customer_id is null,'reservation_count',v_count,
        'payment_method',case when p_payment_method='cash' then 'Cash' else 'PayMongo' end,
        'subtotal_minor',v_total_minor,'payment_id',v_payment_id,'receipt_id',v_receipt->>'receipt_id'));
  return jsonb_build_object('order_id',v_order_id,'status',v_status,'attempt_id',v_attempt_id,
    'base_minor',v_total_minor,'fee_minor',case when p_payment_method='cash' then 0 else null end,
    'gross_minor',case when p_payment_method='cash' then v_total_minor else null end,
    'receipt_id',v_receipt->>'receipt_id','receipt',v_receipt,'items',v_item_result);
exception when exclusion_violation then
  raise exception 'One of the selected physical courts is already reserved at that time' using errcode='23P01';
end;
$$;
revoke all on function public.staff_create_walkin_order(uuid,text,text,jsonb,text) from public,anon;
grant execute on function public.staff_create_walkin_order(uuid,text,text,jsonb,text) to authenticated;

create or replace function public.prepare_staff_walkin_checkout(p_order_id uuid,p_staff_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_order internal.staff_walkin_orders%rowtype; v_attempt internal.paymongo_checkout_attempts%rowtype;
begin
  if p_staff_id is null or not exists(select 1 from public.profiles p where p.id=p_staff_id
    and p.role in ('staff','admin') and p.status='active') then
    raise exception 'Active staff access is required' using errcode='42501';
  end if;
  select * into v_order from internal.staff_walkin_orders o where o.id=p_order_id for update;
  if not found or v_order.status not in ('awaiting_payment','review') then
    raise exception 'This walk-in order is not eligible for payment' using errcode='22023';
  end if;
  select * into v_attempt from internal.paymongo_checkout_attempts a
    where a.walkin_order_id=p_order_id and a.status in ('creating','ready','review')
    order by a.created_at desc limit 1 for update;
  if found then
    return jsonb_build_object('order_id',p_order_id,'attempt_id',v_attempt.id,'status',v_attempt.status,
      'checkout_url',v_attempt.checkout_url,'base_minor',v_attempt.amount_minor,'expires_at',v_order.expires_at);
  end if;
  if v_order.status<>'awaiting_payment' or v_order.expires_at<=now() then
    raise exception 'This walk-in checkout expired. Create a new walk-in order.' using errcode='55000';
  end if;
  insert into internal.paymongo_checkout_attempts(booking_id,intent_id,customer_id,amount_minor,total_minor,
    payment_option,staff_id,walkin_order_id,pass_on_fees)
    values(null,null,v_order.customer_id,v_order.subtotal_minor,v_order.subtotal_minor,
      'full',p_staff_id,p_order_id,true) returning * into v_attempt;
  return jsonb_build_object('order_id',p_order_id,'attempt_id',v_attempt.id,'status',v_attempt.status,
    'base_minor',v_attempt.amount_minor,'expires_at',v_order.expires_at);
end;
$$;
revoke all on function public.prepare_staff_walkin_checkout(uuid,uuid) from public,anon,authenticated;
grant execute on function public.prepare_staff_walkin_checkout(uuid,uuid) to service_role;

-- A balance checkout may be started only while the reservation can still be
-- checked in; confirmed sessions created before the grace deadline may settle
-- afterward, but never after the scheduled end.
create or replace function public.prepare_paymongo_balance_checkout(p_source text,p_id bigint,p_staff_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_total numeric; v_paid numeric; v_start timestamptz; v_end timestamptz;
  v_no_show boolean; v_grace integer; v_due bigint; v_attempt internal.paymongo_checkout_attempts%rowtype;
  v_order uuid;
begin
  if p_source not in ('booking','walkin') or p_id is null or p_id<=0 or not exists
    (select 1 from public.profiles p where p.id=p_staff_id and p.role in ('staff','admin') and p.status='active') then
    raise exception 'Active staff access is required' using errcode='42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
  if p_source='booking' then
    select b.amount_total,b.amount_paid,b.time_date,b.end_at,b.no_show_policy_applies
      into v_total,v_paid,v_start,v_end,v_no_show from public.booking b
      where b.booking_id=p_id and b.status='confirmed' and b.checked_in_at is null for update;
  else
    select w.amount_total,w.amount_paid,w.time_date,w.end_at,w.no_show_policy_applies,w.walkin_order_id
      into v_total,v_paid,v_start,v_end,v_no_show,v_order from public.walk_in_booking w
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
    values(null,p_staff_id,v_due,v_due,'full',p_source,p_id,p_staff_id,true) returning * into v_attempt;
  return jsonb_build_object('attempt_id',v_attempt.id,'amount_minor',v_due,'status',v_attempt.status);
end;
$$;
revoke all on function public.prepare_paymongo_balance_checkout(text,bigint,uuid) from public,anon,authenticated;
grant execute on function public.prepare_paymongo_balance_checkout(text,bigint,uuid) to service_role;

create or replace function public.prepare_paid_checkout_cart(
  p_customer_id uuid,p_items jsonb,p_payment_option text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_intent uuid; v_item jsonb; v_court public.court%rowtype; v_unit public.court_unit_inventory%rowtype;
  v_start timestamptz; v_end timestamptz; v_start_local timestamp; v_end_local timestamp;
  v_minutes integer; v_qty integer; v_rate_unit text; v_total numeric; v_charge numeric;
  v_total_minor bigint:=0; v_charge_minor bigint:=0; v_pct numeric; v_item_id uuid;
  v_count integer:=0; v_resource_count integer; v_rule record;
begin
  if p_customer_id is null or not exists(select 1 from public.profiles p where p.id=p_customer_id
    and p.role='customer' and p.status='active') then
    raise exception 'Active customer account required' using errcode='42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
  if p_payment_option not in ('full','downpayment') or jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Choose reservations and a valid payment option' using errcode='22023';
  end if;
  if jsonb_array_length(p_items)=0 or octet_length(p_items::text)>1048576 then
    raise exception 'Choose reservations and a valid payment option' using errcode='22023';
  end if;
  select coalesce(s.downpayment_pct,50) into v_pct from public.app_settings s where s.id=true;
  v_pct:=coalesce(v_pct,50);
  if not exists(select 1 from public.app_settings s where s.id=true and (s.card_enabled or s.gcash_enabled)) then
    raise exception 'Online payment is unavailable' using errcode='22023';
  end if;
  insert into internal.checkout_intents(customer_id,payment_option,downpayment_pct,amount_minor,total_minor)
    values(p_customer_id,p_payment_option,v_pct,1,1) returning id into v_intent;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_count:=v_count+1;
    select * into v_court from public.court c where c.id=(v_item->>'listing_id')::uuid
      and c.is_active and c.status='Available';
    select * into v_unit from public.court_unit_inventory u where u.id=(v_item->>'unit_id')::uuid
      and u.court_id=v_court.id and u.is_active and u.inventory_verified and u.availability_status='available';
    if v_court.id is null or v_unit.id is null then raise exception 'Court or lane is unavailable' using errcode='22023'; end if;
    v_start:=(v_item->>'starts_at')::timestamptz;
    v_end:=(v_item->>'ends_at')::timestamptz;
    v_start_local:=v_start at time zone 'Asia/Manila';
    v_end_local:=v_end at time zone 'Asia/Manila';
    v_qty:=coalesce(nullif(v_item->>'rate_quantity','')::integer,1);
    if v_start is null or v_end is null or v_start<=now()+interval '2 minutes'
      or v_end<=v_start or v_end>v_start+interval '12 hours'
      or v_start_local::date<>v_end_local::date or v_qty not between 1 and 100 then
      raise exception 'Choose a valid future court time on one local date' using errcode='22023';
    end if;
    select * into v_rule from internal.booking_rule_for_date(v_start_local::date);
    if not found then
      if v_start_local::time<time '08:00' or v_end_local::time>time '20:00' then
        raise exception 'Choose a time between 8:00 AM and 8:00 PM' using errcode='22023';
      end if;
    elsif v_rule.is_closed or v_start_local::time<v_rule.opens_at or v_end_local::time>v_rule.closes_at then
      raise exception 'Choose a time within the current business hours' using errcode='22023';
    end if;
    v_minutes:=ceil(extract(epoch from(v_end-v_start))/60)::integer;
    v_rate_unit:=internal.authoritative_reservation_rate_unit(v_court.id,v_unit.id);
    if v_rate_unit not in ('/hr','/set') then raise exception 'Court rate is unavailable' using errcode='22023'; end if;
    if v_rate_unit='/set' and (v_end<>v_start+make_interval(mins=>v_qty*60) or v_minutes<>v_qty*60) then
      raise exception 'Each bowling set reserves exactly 60 minutes' using errcode='22023';
    end if;
    v_total:=internal.authoritative_reservation_amount(v_court.id,v_unit.id,v_start,v_end,v_minutes,v_qty);
    if v_total is null or v_total<=0 then raise exception 'Court rate is unavailable' using errcode='22023'; end if;
    v_charge:=case when p_payment_option='full' then v_total else round(v_total*v_pct/100,2) end;
    if v_charge<=0 then raise exception 'Payment amount is too small' using errcode='22023'; end if;
    insert into internal.checkout_intent_items(intent_id,listing_id,unit_id,sports,courts,court_unit,
      starts_at,ends_at,duration_minutes,rate_quantity,rate_unit,total_minor,charge_minor)
    values(v_intent,v_court.id,v_unit.id,(select s.name from public.sport s where s.id=v_court.sport_id),
      v_court.name,v_unit.label,v_start,v_end,v_minutes,v_qty,v_rate_unit,
      round(v_total*100)::bigint,round(v_charge*100)::bigint) returning id into v_item_id;
    insert into internal.reservation_resource_slots(hold_item_id,resource_id,during)
    select v_item_id,m.resource_id,tstzrange(v_start,v_end,'[)')
      from public.court_unit_resource_map m join public.physical_court_resource r on r.id=m.resource_id and r.is_active
      where m.court_unit_id=v_unit.id;
    get diagnostics v_resource_count=row_count;
    if v_resource_count=0 then raise exception 'Court or lane has no available physical connection' using errcode='22023'; end if;
    v_total_minor:=v_total_minor+round(v_total*100)::bigint;
    v_charge_minor:=v_charge_minor+round(v_charge*100)::bigint;
  end loop;
  update internal.checkout_intents set total_minor=v_total_minor,amount_minor=v_charge_minor where id=v_intent;
  insert into internal.paymongo_checkout_attempts(booking_id,intent_id,customer_id,amount_minor,total_minor,payment_option,pass_on_fees)
    values(null,v_intent,p_customer_id,v_charge_minor,v_total_minor,p_payment_option,true);
  return (select jsonb_build_object('attempt_id',a.id,'intent_id',v_intent,
    'amount_minor',a.amount_minor,'total_minor',a.total_minor,'item_count',v_count,'expires_at',i.expires_at)
    from internal.paymongo_checkout_attempts a join internal.checkout_intents i on i.id=a.intent_id where i.id=v_intent);
exception when exclusion_violation then
  raise exception 'This physical court is already reserved during the selected time' using errcode='23P01';
end;
$$;
revoke all on function public.prepare_paid_checkout_cart(uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.prepare_paid_checkout_cart(uuid,jsonb,text) to service_role;

create or replace function internal.ph_mobile_to_e164(p_phone text)
returns text language plpgsql immutable set search_path = '' as $$
declare v_digits text;
begin
  if p_phone is null then return null; end if;
  v_digits:=regexp_replace(p_phone,'[^0-9]','','g');
  if v_digits ~ '^09[0-9]{9}$' then return '+63'||substr(v_digits,2); end if;
  if v_digits ~ '^639[0-9]{9}$' then return '+'||v_digits; end if;
  if v_digits ~ '^9[0-9]{9}$' then return '+63'||v_digits; end if;
  return null;
end;
$$;
revoke all on function internal.ph_mobile_to_e164(text) from public,anon,authenticated;

create table if not exists internal.abstract_phone_validation_usage (
  request_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  requested_at timestamptz not null default now()
);
create index if not exists abstract_phone_validation_user_recent_idx
  on internal.abstract_phone_validation_usage(user_id,requested_at desc);
alter table internal.abstract_phone_validation_usage enable row level security;
revoke all on internal.abstract_phone_validation_usage from public,anon,authenticated;
grant select,insert,delete on internal.abstract_phone_validation_usage to service_role;

create table if not exists internal.contact_phone_validation_proofs (
  user_id uuid not null references auth.users(id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+639[0-9]{9}$'),
  expires_at timestamptz not null,
  primary key (user_id,phone_e164)
);
alter table internal.contact_phone_validation_proofs enable row level security;
revoke all on internal.contact_phone_validation_proofs from public,anon,authenticated;
grant select,insert,update,delete on internal.contact_phone_validation_proofs to service_role;

create or replace function public.reserve_contact_phone_validation(p_user_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_role text; v_total integer; v_user integer; v_last timestamptz;
begin
  if coalesce(auth.role(),'')<>'service_role' or p_user_id is null then
    raise exception 'Invalid phone validation request' using errcode='42501';
  end if;
  select p.role into v_role from public.profiles p where p.id=p_user_id and p.status='active';
  if v_role is null or v_role not in ('staff','customer','admin') then
    raise exception 'Active account required' using errcode='42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(87499182034132372::bigint);
  delete from internal.abstract_phone_validation_usage u where u.requested_at<now()-interval '30 days';
  select count(*)::integer into v_total from internal.abstract_phone_validation_usage u
    where u.requested_at>=now()-interval '30 days';
  select count(*)::integer into v_user from internal.abstract_phone_validation_usage u
    where u.user_id=p_user_id and u.requested_at>=now()-interval '24 hours';
  select max(u.requested_at) into v_last from internal.abstract_phone_validation_usage u
    where u.requested_at>=now()-interval '30 days';
  if v_total>=80 then raise exception 'Phone validation monthly safety limit reached' using errcode='55000'; end if;
  if v_user>=3 then raise exception 'Phone validation daily rate limit reached' using errcode='55000'; end if;
  if v_last>now()-interval '1 second' then raise exception 'Phone validation request rate limit reached' using errcode='55000'; end if;
  insert into internal.abstract_phone_validation_usage(user_id) values(p_user_id);
  return true;
end;
$$;
revoke all on function public.reserve_contact_phone_validation(uuid) from public,anon,authenticated;
grant execute on function public.reserve_contact_phone_validation(uuid) to service_role;

create or replace function public.record_contact_phone_validation(p_user_id uuid,p_phone_e164 text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(),'')<>'service_role' or p_user_id is null
     or p_phone_e164 !~ '^\+639[0-9]{9}$' then
    raise exception 'Invalid phone validation proof' using errcode='42501';
  end if;
  if not exists(select 1 from public.profiles p where p.id=p_user_id and p.status='active'
      and p.role in ('staff','customer','admin')) then
    raise exception 'Active account required' using errcode='42501';
  end if;
  delete from internal.contact_phone_validation_proofs proof where proof.expires_at<=now();
  insert into internal.contact_phone_validation_proofs(user_id,phone_e164,expires_at)
    values(p_user_id,p_phone_e164,now()+interval '5 minutes')
    on conflict(user_id,phone_e164) do update set expires_at=excluded.expires_at;
  return true;
end;
$$;
revoke all on function public.record_contact_phone_validation(uuid,text) from public,anon,authenticated;
grant execute on function public.record_contact_phone_validation(uuid,text) to service_role;

create or replace function internal.guard_contact_phone_validation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_stored text; v_proof boolean:=false;
begin
  if tg_op='UPDATE' and new.contact_num is not distinct from old.contact_num then
    new.phone_verified:=old.phone_verified;
    delete from internal.contact_phone_validation_proofs proof
      where proof.user_id=new.id and proof.phone_e164=internal.ph_mobile_to_e164(new.contact_num)
        and proof.expires_at>now()
      returning true into v_proof;
    if v_proof then
      new.contact_num_validated:=true;
      new.contact_num_validated_at:=now();
    else
      new.contact_num_validated:=old.contact_num_validated;
      new.contact_num_validated_at:=old.contact_num_validated_at;
    end if;
    return new;
  end if;
  if nullif(btrim(new.contact_num),'') is null then
    new.contact_num:=null;
    new.contact_num_validated:=false;
    new.contact_num_validated_at:=null;
    new.phone_verified:=false;
    return new;
  end if;
  v_stored:=internal.ph_mobile_to_e164(new.contact_num);
  if v_stored is null then
    raise exception 'Enter a valid Philippine mobile number' using errcode='22023';
  end if;
  delete from internal.contact_phone_validation_proofs proof
    where proof.user_id=new.id and proof.phone_e164=v_stored and proof.expires_at>now()
    returning true into v_proof;
  -- DELETE ... RETURNING sets v_proof to NULL when no row matched. Treat NULL
  -- as missing proof explicitly; `IF NOT v_proof` would skip on SQL NULL.
  if v_proof is distinct from true then
    raise exception 'Validate this Philippine mobile number before saving it' using errcode='42501';
  end if;
  new.contact_num:=v_stored;
  new.contact_num_validated:=true;
  new.contact_num_validated_at:=now();
  new.phone_verified:=false;
  return new;
end;
$$;
revoke all on function internal.guard_contact_phone_validation() from public,anon,authenticated;
drop trigger if exists profiles_verified_phone_guard on public.profiles;
drop trigger if exists profiles_contact_phone_validation_guard on public.profiles;
create trigger profiles_contact_phone_validation_guard
  before insert or update of contact_num,phone_verified,contact_num_validated,contact_num_validated_at on public.profiles
  for each row execute function internal.guard_contact_phone_validation();

create or replace function public.staff_collect_cash_and_check_in(p_source text,p_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid:=(select auth.uid()); v_total numeric; v_paid numeric; v_due numeric;
  v_start timestamptz; v_end timestamptz; v_grace integer; v_no_show boolean;
  v_payment_id bigint; v_result jsonb; v_receipt jsonb; v_order uuid; v_role text;
begin
  if v_actor is null or not exists(select 1 from public.profiles p where p.id=v_actor
    and p.role in ('staff','admin') and p.status='active') then
    raise exception 'Active staff access is required' using errcode='42501';
  end if;
  if p_source not in ('booking','walkin') or p_id is null or p_id<=0 then
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
    insert into public.payment(cost,paid,payment_method,down_full,base_minor,fee_minor,gross_minor,net_minor)
      values(v_due,v_due,'Cash','full',round(v_due*100)::bigint,0,round(v_due*100)::bigint,round(v_due*100)::bigint)
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
  end if;
  select p.role into v_role from public.profiles p where p.id=v_actor;
  insert into public.audit_log(actor_id,actor_role,action,entity_type,entity_id,details)
    values(v_actor,coalesce(v_role,'staff'),'timed_in',p_source,p_id::text,
      jsonb_build_object('payment_id',v_payment_id,'cash_collected',v_due,
        'checked_in_at',now(),'receipt_id',v_receipt->>'receipt_id'));
  v_result:=jsonb_build_object('source',p_source,'id',p_id,'cash_collected',v_due,
    'payment_id',v_payment_id,'receipt',v_receipt,'checked_in',true);
  return v_result;
end;
$$;
revoke all on function public.staff_collect_cash_and_check_in(text,bigint) from public,anon;
grant execute on function public.staff_collect_cash_and_check_in(text,bigint) to authenticated;

create or replace function public.staff_record_time_out(p_source text,p_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid:=(select auth.uid()); v_checked_in timestamptz; v_checked_out timestamptz;
  v_end timestamptz; v_status text; v_customer uuid; v_order uuid; v_actual timestamptz;
begin
  if v_actor is null or not exists(select 1 from public.profiles p where p.id=v_actor
    and p.role in ('staff','admin') and p.status='active') then
    raise exception 'Active staff access is required' using errcode='42501';
  end if;
  if p_source='booking' then
    select checked_in_at,checked_out_at,end_at,status,customer_id into
      v_checked_in,v_checked_out,v_end,v_status,v_customer
      from public.booking where booking_id=p_id for update;
  elsif p_source='walkin' then
    select checked_in_at,checked_out_at,end_at,status,customer_id,walkin_order_id into
      v_checked_in,v_checked_out,v_end,v_status,v_customer,v_order
      from public.walk_in_booking where walkin_id=p_id for update;
  else
    raise exception 'Invalid reservation source' using errcode='22023';
  end if;
  if not found then raise exception 'Reservation not found' using errcode='P0002'; end if;
  if v_checked_in is null or v_status in ('cancelled','unattended','pending') then
    raise exception 'Only an active checked-in reservation can be timed out' using errcode='55000';
  end if;
  if v_checked_out is not null then
    return jsonb_build_object('source',p_source,'id',p_id,'checked_out_at',v_checked_out,
      'status',v_status,'already_timed_out',true);
  end if;
  v_actual:=least(now(),v_end);
  if p_source='booking' then
    update public.booking set checked_out_at=v_actual,
      status=case when v_end<=now() then 'completed' else status end where booking_id=p_id;
  else
    update public.walk_in_booking set checked_out_at=v_actual,
      status=case when v_end<=now() then 'completed' else status end where walkin_id=p_id;
  end if;
  insert into public.audit_log(actor_id,actor_role,action,entity_type,entity_id,details)
    values(v_actor,'staff','timed_out',p_source,p_id::text,
      jsonb_build_object('customer_id',v_customer,'walkin_order_id',v_order,
        'checked_out_at',v_actual,'scheduled_end_at',v_end,'early',v_actual<v_end));
  return jsonb_build_object('source',p_source,'id',p_id,'checked_out_at',v_actual,
    'scheduled_end_at',v_end,'status',case when v_end<=now() then 'completed' else v_status end);
end;
$$;
revoke all on function public.staff_record_time_out(text,bigint) from public,anon;
grant execute on function public.staff_record_time_out(text,bigint) to authenticated;

create or replace function internal.auto_time_out_reservations()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer:=0; v_changed integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
  with changed as (
    update public.booking b set checked_out_at=coalesce(b.checked_out_at,b.end_at),status='completed'
      where b.status='confirmed' and b.checked_in_at is not null and b.end_at<=now()
      returning b.booking_id,b.customer_id,b.checked_out_at,b.end_at
  ) insert into public.audit_log(actor_role,action,entity_type,entity_id,details)
    select 'system','auto_timed_out','booking',booking_id::text,
      jsonb_build_object('customer_id',customer_id,'checked_out_at',checked_out_at,'scheduled_end_at',end_at)
    from changed;
  get diagnostics v_changed=row_count; v_count:=v_count+v_changed;
  with changed as (
    update public.walk_in_booking w set checked_out_at=coalesce(w.checked_out_at,w.end_at),status='completed'
      where w.status='confirmed' and w.checked_in_at is not null and w.end_at<=now()
      returning w.walkin_id,w.customer_id,w.walkin_order_id,w.checked_out_at,w.end_at
  ) insert into public.audit_log(actor_role,action,entity_type,entity_id,details)
    select 'system','auto_timed_out','walkin',walkin_id::text,
      jsonb_build_object('customer_id',customer_id,'walkin_order_id',walkin_order_id,
        'checked_out_at',checked_out_at,'scheduled_end_at',end_at)
    from changed;
  get diagnostics v_changed=row_count; v_count:=v_count+v_changed;
  return v_count;
end;
$$;
revoke all on function internal.auto_time_out_reservations() from public,anon,authenticated;

create or replace function internal.cancel_no_show_bookings()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer:=0; v_changed integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
  with changed as (
    update public.booking b set status='unattended',auto_cancelled_at=now()
      where b.no_show_policy_applies and b.status in ('pending','confirmed')
        and b.checked_in_at is null and b.time_date + make_interval(mins=>coalesce((
          select r.grace_minutes from internal.booking_rule_for_date((b.time_date at time zone 'Asia/Manila')::date) r),30))<now()
        and not exists(select 1 from internal.paymongo_checkout_attempts a where
          ((a.booking_id=b.booking_id) or (a.balance_source='booking' and a.balance_id=b.booking_id))
          and a.status in ('creating','ready','review') and a.paymongo_payment_id is null)
      returning b.booking_id,b.customer_id,b.time_date,b.end_at
  ) insert into public.audit_log(actor_role,action,entity_type,entity_id,details)
    select 'system','marked_unattended','booking',booking_id::text,
      jsonb_build_object('customer_id',customer_id,'starts_at',time_date,'scheduled_end_at',end_at)
    from changed;
  get diagnostics v_changed=row_count; v_count:=v_count+v_changed;
  with changed as (
    update public.walk_in_booking w set status='unattended',auto_cancelled_at=now()
      where w.no_show_policy_applies and w.status in ('pending','confirmed')
        and w.checked_in_at is null and w.time_date + make_interval(mins=>coalesce((
          select r.grace_minutes from internal.booking_rule_for_date((w.time_date at time zone 'Asia/Manila')::date) r),30))<now()
        and not exists(select 1 from internal.paymongo_checkout_attempts a where
          ((a.balance_source='walkin' and a.balance_id=w.walkin_id) or a.walkin_order_id=w.walkin_order_id)
          and a.status in ('creating','ready','review') and a.paymongo_payment_id is null)
      returning w.walkin_id,w.customer_id,w.walkin_order_id,w.time_date,w.end_at
  ) insert into public.audit_log(actor_role,action,entity_type,entity_id,details)
    select 'system','marked_unattended','walkin',walkin_id::text,
      jsonb_build_object('customer_id',customer_id,'walkin_order_id',walkin_order_id,
        'starts_at',time_date,'scheduled_end_at',end_at)
    from changed;
  get diagnostics v_changed=row_count; v_count:=v_count+v_changed;
  return v_count;
end;
$$;
revoke all on function internal.cancel_no_show_bookings() from public,anon,authenticated;

create or replace function public.process_due_attendance()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_unattended integer; v_timed_out integer;
begin
  v_timed_out:=internal.auto_time_out_reservations();
  v_unattended:=internal.cancel_no_show_bookings();
  return jsonb_build_object('timed_out',v_timed_out,'unattended',v_unattended,'processed_at',now());
end;
$$;
revoke all on function public.process_due_attendance() from public,anon,authenticated;
grant execute on function public.process_due_attendance() to service_role;

do $$
declare v_job bigint;
begin
  for v_job in select jobid from cron.job where jobname in
    ('inigosync-cancel-no-shows','inigosync-process-due-attendance') loop
    perform cron.unschedule(v_job);
  end loop;
  perform cron.schedule('inigosync-process-due-attendance','* * * * *','select public.process_due_attendance()');
end;
$$;

-- Keep provider settlement amounts separately: the reservation receives the
-- saved base amount, while the customer-facing charge includes any passed fee.
alter table internal.paymongo_checkout_attempts
  drop constraint if exists paymongo_attempt_settlement_amounts;
alter table internal.paymongo_checkout_attempts
  add constraint paymongo_attempt_settlement_amounts check (
    fee_minor>=0 and
    ((gross_minor is null and net_minor is null) or
      (gross_minor=fee_minor+net_minor and
          ((pass_on_fees and gross_minor=amount_minor+fee_minor and net_minor=amount_minor)
            or (not pass_on_fees and gross_minor=amount_minor)
            or (status='review' and paymongo_payment_id is not null))))
  );

drop function if exists public.record_paymongo_paid(text,text,text,bigint);
create or replace function public.record_paymongo_paid(
  p_event_id text,p_session_id text,p_payment_id text,p_amount_minor bigint,
  p_fee_minor bigint,p_net_minor bigint
) returns text language plpgsql security definer set search_path = '' as $$
declare
  a internal.paymongo_checkout_attempts%rowtype;
  x internal.checkout_intent_items%rowtype;
  v_intent internal.checkout_intents%rowtype;
  v_payment_id bigint; v_booking_id bigint; v_due bigint;
  v_fee_share bigint; v_fee_allocated bigint:=0; v_base bigint; v_gross bigint; v_net bigint;
  v_last_item uuid; v_order internal.staff_walkin_orders%rowtype;
  v_order_total bigint; v_reservation_count integer; v_receipt jsonb; v_role text;
  v_balance_start timestamptz; v_balance_end timestamptz; v_balance_no_show boolean;
  v_grace integer; v_late_balance boolean;
begin
  if nullif(btrim(p_event_id),'') is null or nullif(btrim(p_session_id),'') is null
     or nullif(btrim(p_payment_id),'') is null or p_amount_minor<=0
     or p_fee_minor<0 or p_net_minor<0 or p_amount_minor<>p_fee_minor+p_net_minor then
    raise exception 'Invalid PayMongo settlement amounts' using errcode='22023';
  end if;
  select * into a from internal.paymongo_checkout_attempts
    where paymongo_session_id=p_session_id for update;
  if not found then raise exception 'Unknown PayMongo checkout session' using errcode='P0002'; end if;
  insert into internal.paymongo_webhook_events(event_id,event_type)
    values(p_event_id,'checkout_session.payment.paid') on conflict do nothing;
  if not found then return 'duplicate'; end if;
  if a.status='paid' then return 'duplicate'; end if;
  if a.paymongo_payment_id is not null then
    return case when a.paymongo_payment_id=p_payment_id then 'duplicate' else 'review' end;
  end if;

  if a.status not in ('ready','review') then
    if a.status='expired' then
      update internal.paymongo_checkout_attempts set status='review',paymongo_payment_id=p_payment_id,
        fee_minor=p_fee_minor,gross_minor=p_amount_minor,net_minor=p_net_minor,updated_at=now()
        where id=a.id;
      select p.role into v_role from public.profiles p where p.id=a.staff_id;
      insert into public.audit_log(actor_id,actor_role,action,entity_type,entity_id,details)
        values(a.staff_id,coalesce(v_role,'system'),
          'payment_after_checkout_expiry','paymongo_checkout',a.id::text,
          jsonb_build_object('paymongo_payment_id',p_payment_id,'base_minor',a.amount_minor,
            'fee_minor',p_fee_minor,'gross_minor',p_amount_minor,'net_minor',p_net_minor));
    end if;
    return 'review';
  end if;
  if (a.pass_on_fees and (p_amount_minor<>a.amount_minor+p_fee_minor or p_net_minor<>a.amount_minor)) or
     (not a.pass_on_fees and p_amount_minor<>a.amount_minor) then
    update internal.paymongo_checkout_attempts set status='review',paymongo_payment_id=p_payment_id,
      fee_minor=p_fee_minor,gross_minor=p_amount_minor,net_minor=p_net_minor,updated_at=now() where id=a.id;
    if a.intent_id is not null then
      update internal.checkout_intents set status='review',updated_at=now() where id=a.intent_id;
    end if;
    if a.walkin_order_id is not null then
      update internal.staff_walkin_orders set status='review',updated_at=now()
        where id=a.walkin_order_id and status='awaiting_payment';
    end if;
    return 'review';
  end if;

  if a.intent_id is not null then
    select * into v_intent from internal.checkout_intents where id=a.intent_id for update;
    if v_intent.status not in ('ready','review') or v_intent.customer_id<>a.customer_id
       or v_intent.amount_minor<>a.amount_minor then
      update internal.paymongo_checkout_attempts set status='review',paymongo_payment_id=p_payment_id,
        fee_minor=p_fee_minor,gross_minor=p_amount_minor,net_minor=p_net_minor,updated_at=now() where id=a.id;
      update internal.checkout_intents set status='review',updated_at=now() where id=a.intent_id;
      delete from internal.reservation_resource_slots where hold_item_id in
        (select i.id from internal.checkout_intent_items i where i.intent_id=a.intent_id);
      return 'review';
    end if;
    select i.id into v_last_item from internal.checkout_intent_items i
      where i.intent_id=a.intent_id order by i.starts_at desc,i.id desc limit 1;
    if v_last_item is null then
      update internal.checkout_intents set status='review',updated_at=now() where id=a.intent_id;
      update internal.paymongo_checkout_attempts set status='review',paymongo_payment_id=p_payment_id,
        fee_minor=p_fee_minor,gross_minor=p_amount_minor,net_minor=p_net_minor,updated_at=now() where id=a.id;
      return 'review';
    end if;
    begin
      delete from internal.reservation_resource_slots where hold_item_id in
        (select i.id from internal.checkout_intent_items i where i.intent_id=a.intent_id);
      for x in select * from internal.checkout_intent_items i
        where i.intent_id=a.intent_id order by i.starts_at,i.id loop
        v_base:=x.charge_minor;
        if x.id=v_last_item then v_fee_share:=p_fee_minor-v_fee_allocated;
        else v_fee_share:=floor(p_fee_minor::numeric*v_base/a.amount_minor)::bigint; end if;
        v_fee_allocated:=v_fee_allocated+v_fee_share;
        v_gross:=case when a.pass_on_fees then v_base+v_fee_share else v_base end;
        v_net:=case when a.pass_on_fees then v_base else v_gross-v_fee_share end;
        insert into public.payment(cost,paid,payment_method,down_full,base_minor,fee_minor,gross_minor,net_minor)
          values(x.total_minor/100.0,v_base/100.0,'PayMongo',a.payment_option,
            v_base,v_fee_share,v_gross,v_net) returning payment_id into v_payment_id;
        insert into public.booking(customer_id,sports,courts,time_date,payment_id,status,
          duration_minutes,end_at,court_unit,amount_total,amount_paid,payment_option,
          court_unit_inventory_id,court_listing_id,rate_quantity,rate_unit_snapshot)
          values(a.customer_id,x.sports,x.courts,x.starts_at,v_payment_id,'confirmed',
            x.duration_minutes,x.ends_at,x.court_unit,x.total_minor/100.0,v_base/100.0,
            a.payment_option,x.unit_id,x.listing_id,x.rate_quantity,x.rate_unit)
          returning booking_id into v_booking_id;
        update internal.checkout_intent_items set booking_id=v_booking_id where id=x.id;
      end loop;
      update internal.checkout_intents set status='paid',updated_at=now() where id=a.intent_id;
      update internal.paymongo_checkout_attempts set status='paid',paymongo_payment_id=p_payment_id,
        fee_minor=p_fee_minor,gross_minor=p_amount_minor,net_minor=p_net_minor,updated_at=now()
        where id=a.id;
      return 'paid';
    exception when others then
      update internal.checkout_intents set status='review',updated_at=now() where id=a.intent_id;
      update internal.paymongo_checkout_attempts set status='review',paymongo_payment_id=p_payment_id,
        fee_minor=p_fee_minor,gross_minor=p_amount_minor,net_minor=p_net_minor,updated_at=now() where id=a.id;
      delete from internal.reservation_resource_slots where hold_item_id in
        (select i.id from internal.checkout_intent_items i where i.intent_id=a.intent_id);
      select p.role into v_role from public.profiles p where p.id=a.staff_id;
      insert into public.audit_log(actor_id,actor_role,action,entity_type,entity_id,details)
        values(a.staff_id,coalesce(v_role,'system'),'checkout_payment_needs_review','paymongo_attempt',a.id::text,
          jsonb_build_object('paymongo_payment_id',p_payment_id,'base_minor',a.amount_minor,
            'fee_minor',p_fee_minor,'gross_minor',p_amount_minor,'net_minor',p_net_minor));
      return 'review';
    end;
  end if;

  if a.walkin_order_id is not null then
    select * into v_order from internal.staff_walkin_orders o
      where o.id=a.walkin_order_id for update;
    if not found or v_order.status not in ('awaiting_payment','review')
       or v_order.staff_id is distinct from a.staff_id then
      update internal.paymongo_checkout_attempts set status='review',paymongo_payment_id=p_payment_id,
        fee_minor=p_fee_minor,gross_minor=p_amount_minor,net_minor=p_net_minor,updated_at=now() where id=a.id;
      return 'review';
    end if;
    select round(coalesce(sum(w.amount_total),0)*100)::bigint,count(*)
      into v_order_total,v_reservation_count from public.walk_in_booking w
      where w.walkin_order_id=v_order.id and w.status='pending' and w.checked_in_at is null;
    if v_order_total is distinct from a.amount_minor or v_order_total is distinct from v_order.subtotal_minor
       or v_reservation_count=0 then
      update internal.staff_walkin_orders set status='review',updated_at=now() where id=v_order.id;
      update internal.paymongo_checkout_attempts set status='review',paymongo_payment_id=p_payment_id,
        fee_minor=p_fee_minor,gross_minor=p_amount_minor,net_minor=p_net_minor,updated_at=now() where id=a.id;
      return 'review';
    end if;
    perform set_config('inigosync.staff_payment_rpc','on',true);
    insert into public.payment(cost,paid,payment_method,down_full,base_minor,fee_minor,gross_minor,net_minor)
      values(v_order_total/100.0,a.amount_minor/100.0,'PayMongo','full',a.amount_minor,
        p_fee_minor,p_amount_minor,p_net_minor) returning payment_id into v_payment_id;
    update internal.staff_walkin_orders set status='paid',payment_id=v_payment_id,
      fee_minor=p_fee_minor,gross_minor=p_amount_minor,updated_at=now() where id=v_order.id;
    update public.walk_in_booking w set status='confirmed',payment_method='PayMongo',
      payment_id=v_payment_id,amount_paid=w.amount_total
      where w.walkin_order_id=v_order.id and w.status='pending';
    v_receipt:=internal.persist_payment_acknowledgment(v_payment_id,'walkin_order',null,v_order.id);
    update internal.staff_walkin_orders set receipt_id=(v_receipt->>'receipt_id')::uuid
      where id=v_order.id;
    update internal.paymongo_checkout_attempts set status='paid',paymongo_payment_id=p_payment_id,
      fee_minor=p_fee_minor,gross_minor=p_amount_minor,net_minor=p_net_minor,updated_at=now()
      where id=a.id;
    select p.role into v_role from public.profiles p where p.id=a.staff_id;
    insert into public.audit_log(actor_id,actor_role,action,entity_type,entity_id,details)
      values(a.staff_id,coalesce(v_role,'staff'),'collected_online_walkin','walkin_order',v_order.id::text,
        jsonb_build_object('payment_id',v_payment_id,'paymongo_payment_id',p_payment_id,
          'base_minor',a.amount_minor,'fee_minor',p_fee_minor,'gross_minor',p_amount_minor,
          'net_minor',p_net_minor,'receipt_id',v_receipt->>'receipt_id'));
    return 'paid';
  end if;

  if a.balance_id is not null then
    if a.balance_source='booking' then
      select round((b.amount_total-b.amount_paid)*100)::bigint,b.time_date,b.end_at,b.no_show_policy_applies
        into v_due,v_balance_start,v_balance_end,v_balance_no_show
        from public.booking b where b.booking_id=a.balance_id and b.status='confirmed'
          and b.checked_in_at is null for update;
    else
      select round((w.amount_total-w.amount_paid)*100)::bigint,w.time_date,w.end_at,w.no_show_policy_applies
        into v_due,v_balance_start,v_balance_end,v_balance_no_show
        from public.walk_in_booking w where w.walkin_id=a.balance_id
          and w.status in ('pending','confirmed') and w.checked_in_at is null for update;
    end if;
    if v_due is distinct from a.amount_minor then
      update internal.paymongo_checkout_attempts set status='review',paymongo_payment_id=p_payment_id,
        fee_minor=p_fee_minor,gross_minor=p_amount_minor,net_minor=p_net_minor,updated_at=now() where id=a.id;
      return 'review';
    end if;
    select r.grace_minutes into v_grace
      from internal.booking_rule_for_date((v_balance_start at time zone 'Asia/Manila')::date) r;
    v_late_balance:=v_balance_start is null or v_balance_end is null or v_balance_end<=now()
      or (coalesce(v_balance_no_show,true)
        and now()>v_balance_start+make_interval(mins=>coalesce(v_grace,30))
        and a.created_at>v_balance_start+make_interval(mins=>coalesce(v_grace,30)));
    perform set_config('inigosync.staff_payment_rpc','on',true);
    insert into public.payment(cost,paid,payment_method,down_full,base_minor,fee_minor,gross_minor,net_minor)
      values(v_due/100.0,v_due/100.0,'PayMongo','full',v_due,p_fee_minor,p_amount_minor,p_net_minor)
      returning payment_id into v_payment_id;
    update internal.paymongo_checkout_attempts set status=case when v_late_balance then 'review' else 'paid' end,
      paymongo_payment_id=p_payment_id,
      fee_minor=p_fee_minor,gross_minor=p_amount_minor,net_minor=p_net_minor,updated_at=now()
      where id=a.id;
    if a.balance_source='booking' then
      update public.booking set amount_paid=amount_total,balance_payment_id=v_payment_id,
        balance_payment_method='PayMongo',balance_paid_at=now(),
        checked_in_at=case when v_late_balance then checked_in_at else now() end,
        status=case when v_late_balance then 'unattended' else status end,
        auto_cancelled_at=case when v_late_balance then coalesce(auto_cancelled_at,now()) else auto_cancelled_at end
        where booking_id=a.balance_id;
      perform internal.persist_payment_acknowledgment(v_payment_id,'booking',a.balance_id,null);
    else
      update public.walk_in_booking set amount_paid=amount_total,balance_payment_id=v_payment_id,
        balance_payment_method='PayMongo',balance_paid_at=now(),
        checked_in_at=case when v_late_balance then checked_in_at else now() end,
        status=case when v_late_balance then 'unattended' else 'confirmed' end,
        auto_cancelled_at=case when v_late_balance then coalesce(auto_cancelled_at,now()) else auto_cancelled_at end
        where walkin_id=a.balance_id;
      perform internal.persist_payment_acknowledgment(v_payment_id,'walkin',a.balance_id,null);
    end if;
    select p.role into v_role from public.profiles p where p.id=a.staff_id;
    insert into public.audit_log(actor_id,actor_role,action,entity_type,entity_id,details)
      values(a.staff_id,coalesce(v_role,'staff'),
        case when v_late_balance then 'late_online_balance_review' else 'collected_online_balance' end,
        a.balance_source,a.balance_id::text,
        jsonb_build_object('payment_id',v_payment_id,'paymongo_payment_id',p_payment_id,
          'base_minor',v_due,'fee_minor',p_fee_minor,'gross_minor',p_amount_minor,'net_minor',p_net_minor,
          'time_in_recorded',not v_late_balance,'scheduled_end_at',v_balance_end));
    return case when v_late_balance then 'review' else 'paid' end;
  end if;

  -- Preserve support for a pending booking created before checkout intents
  -- existed, while storing newly verified PayMongo fee fields.
  if not exists(select 1 from public.booking b where b.booking_id=a.booking_id
    and b.customer_id=a.customer_id and b.status in ('pending','confirmed')
    and b.payment_id is null and b.amount_paid=0 and b.checked_in_at is null) then
    update internal.paymongo_checkout_attempts set status='review',paymongo_payment_id=p_payment_id,
      fee_minor=p_fee_minor,gross_minor=p_amount_minor,net_minor=p_net_minor,updated_at=now() where id=a.id;
    return 'review';
  end if;
  insert into public.payment(cost,paid,payment_method,down_full,base_minor,fee_minor,gross_minor,net_minor)
    values(a.total_minor/100.0,a.amount_minor/100.0,'PayMongo',a.payment_option,
      a.amount_minor,p_fee_minor,p_amount_minor,p_net_minor) returning payment_id into v_payment_id;
  update internal.paymongo_checkout_attempts set status='paid',paymongo_payment_id=p_payment_id,
    fee_minor=p_fee_minor,gross_minor=p_amount_minor,net_minor=p_net_minor,updated_at=now() where id=a.id;
  update public.booking set payment_id=v_payment_id,amount_total=a.total_minor/100.0,
    amount_paid=a.amount_minor/100.0,status='confirmed' where booking_id=a.booking_id;
  return 'paid';
end;
$$;
revoke all on function public.record_paymongo_paid(text,text,text,bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.record_paymongo_paid(text,text,text,bigint,bigint,bigint) to service_role;

create or replace function public.abort_failed_paymongo_checkout(p_attempt_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_intent uuid; v_order uuid; v_staff uuid; v_count integer; v_role text;
begin
  select a.walkin_order_id,o.staff_id into v_order,v_staff
    from internal.paymongo_checkout_attempts a
    left join internal.staff_walkin_orders o on o.id=a.walkin_order_id
    where a.id=p_attempt_id for update of a;
  update internal.paymongo_checkout_attempts set status='expired',updated_at=now()
    where id=p_attempt_id and status='creating' and paymongo_session_id is null
    returning intent_id,walkin_order_id into v_intent,v_order;
  get diagnostics v_count=row_count;
  if v_count=1 and v_intent is not null then
    update internal.checkout_intents set status='expired',updated_at=now() where id=v_intent;
    delete from internal.reservation_resource_slots where hold_item_id in
      (select i.id from internal.checkout_intent_items i where i.intent_id=v_intent);
  end if;
  if v_count=1 and v_order is not null then
    update internal.staff_walkin_orders set status='expired',updated_at=now()
      where id=v_order and status='awaiting_payment';
    update public.walk_in_booking set status='cancelled'
      where walkin_order_id=v_order and status='pending' and checked_in_at is null;
    select p.role into v_role from public.profiles p where p.id=v_staff;
    insert into public.audit_log(actor_id,actor_role,action,entity_type,entity_id,details)
      values(v_staff,coalesce(v_role,'staff'),'failed_walkin_checkout','walkin_order',v_order::text,
        jsonb_build_object('attempt_id',p_attempt_id,'released_hold',true));
  end if;
  return v_count=1;
end;
$$;
revoke all on function public.abort_failed_paymongo_checkout(uuid) from public,anon,authenticated;
grant execute on function public.abort_failed_paymongo_checkout(uuid) to service_role;

create or replace function public.mark_paymongo_checkout_abandoned(p_attempt_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare a internal.paymongo_checkout_attempts%rowtype; v_count integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
  select * into a from internal.paymongo_checkout_attempts where id=p_attempt_id for update;
  if not found or a.paymongo_session_id is not null or a.paymongo_payment_id is not null
     or a.status not in ('creating','review') then return false; end if;
  if a.created_at>now()-interval '15 minutes' then return false; end if;
  -- Idempotency keys are only valid for 24 hours. An unreturned checkout URL
  -- cannot be used by a customer; stop replaying before the key can create a
  -- second session, and release the local hold after this bounded recovery.
  if a.checkout_request is not null and a.created_at>now()-interval '20 hours' then return false; end if;
  update internal.paymongo_checkout_attempts set status='expired',updated_at=now()
    where id=a.id and status in ('creating','review') and paymongo_session_id is null
      and paymongo_payment_id is null;
  get diagnostics v_count=row_count;
  if v_count=1 and a.intent_id is not null then
    update internal.checkout_intents set status='expired',updated_at=now() where id=a.intent_id;
    delete from internal.reservation_resource_slots where hold_item_id in
      (select i.id from internal.checkout_intent_items i where i.intent_id=a.intent_id);
  end if;
  if v_count=1 and a.walkin_order_id is not null then
    update internal.staff_walkin_orders set status='expired',updated_at=now()
      where id=a.walkin_order_id and status in ('awaiting_payment','review');
    update public.walk_in_booking set status='cancelled'
      where walkin_order_id=a.walkin_order_id and status='pending' and checked_in_at is null;
    insert into public.audit_log(actor_role,action,entity_type,entity_id,details)
      values('system','abandoned_walkin_checkout','walkin_order',a.walkin_order_id::text,
        jsonb_build_object('attempt_id',a.id,'released_hold',true));
  end if;
  return v_count=1;
end;
$$;
revoke all on function public.mark_paymongo_checkout_abandoned(uuid) from public,anon,authenticated;
grant execute on function public.mark_paymongo_checkout_abandoned(uuid) to service_role;

drop function if exists public.list_paymongo_checkouts_due_for_expiry();
create function public.list_paymongo_checkouts_due_for_expiry()
returns table(attempt_id uuid,session_id text,checkout_request jsonb,should_abandon boolean)
language plpgsql security definer set search_path = '' as $$
begin
  return query
    select a.id,a.paymongo_session_id,a.checkout_request,
      (a.paymongo_session_id is null and (a.checkout_request is null
        or a.created_at<=now()-interval '20 hours')) as should_abandon
    from internal.paymongo_checkout_attempts a
      left join public.booking b on b.booking_id=a.booking_id
      left join internal.checkout_intents i on i.id=a.intent_id
      left join internal.staff_walkin_orders o on o.id=a.walkin_order_id
    where a.paymongo_payment_id is null and (
      (a.status in ('creating','review') and a.paymongo_session_id is null
        and a.created_at<=now()-interval '15 minutes')
      or (a.status in ('ready','review') and a.paymongo_session_id is not null
        and (b.time_date<=now() or i.expires_at<=now() or o.expires_at<=now()
          or (a.balance_id is not null and a.created_at<=now()-interval '15 minutes'))))
    order by a.created_at limit 50;
end;
$$;
revoke all on function public.list_paymongo_checkouts_due_for_expiry() from public,anon,authenticated;
grant execute on function public.list_paymongo_checkouts_due_for_expiry() to service_role;

create or replace function public.mark_paymongo_checkout_expired(p_attempt_id uuid,p_session_id text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_intent uuid; v_order uuid; v_count integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(87499182034132371::bigint);
  update internal.paymongo_checkout_attempts set status='expired',updated_at=now()
    where id=p_attempt_id and paymongo_session_id=p_session_id and status in ('ready','review')
      and paymongo_payment_id is null
    returning intent_id,walkin_order_id into v_intent,v_order;
  get diagnostics v_count=row_count;
  if v_count=1 and v_intent is not null then
    update internal.checkout_intents set status='expired',updated_at=now() where id=v_intent;
    delete from internal.reservation_resource_slots where hold_item_id in
      (select i.id from internal.checkout_intent_items i where i.intent_id=v_intent);
  end if;
  if v_count=1 and v_order is not null then
    update internal.staff_walkin_orders set status='expired',updated_at=now()
      where id=v_order and status in ('awaiting_payment','review');
    update public.walk_in_booking set status='cancelled'
      where walkin_order_id=v_order and status='pending' and checked_in_at is null;
    insert into public.audit_log(actor_role,action,entity_type,entity_id,details)
      values('system','expired_walkin_checkout','walkin_order',v_order::text,
        jsonb_build_object('attempt_id',p_attempt_id,'released_hold',true));
  end if;
  return v_count=1;
end;
$$;
revoke all on function public.mark_paymongo_checkout_expired(uuid,text) from public,anon,authenticated;
grant execute on function public.mark_paymongo_checkout_expired(uuid,text) to service_role;

-- The expiry worker can safely recover a lost create response by replaying the
-- provider request with its original idempotency key and exact request body.
create or replace function public.register_paymongo_checkout_request(p_attempt_id uuid,p_request jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare a internal.paymongo_checkout_attempts%rowtype; v_item jsonb;
begin
  if jsonb_typeof(p_request) is distinct from 'object'
     or p_request->>'pass_on_fees' is distinct from 'true'
     or jsonb_typeof(p_request->'line_items') is distinct from 'array'
     or jsonb_array_length(p_request->'line_items')<>1 then
    raise exception 'Invalid checkout request payload' using errcode='22023';
  end if;
  select * into a from internal.paymongo_checkout_attempts where id=p_attempt_id for update;
  if not found or not a.pass_on_fees or a.status<>'creating' or a.paymongo_session_id is not null then
    return false;
  end if;
  v_item:=p_request->'line_items'->0;
  if nullif(v_item->>'amount','')::bigint is distinct from a.amount_minor
     or upper(coalesce(v_item->>'currency',''))<>'PHP'
     or jsonb_typeof(p_request->'payment_method_types') is distinct from 'array'
     or nullif(p_request->>'success_url','') is null
     or nullif(p_request->>'cancel_url','') is null
     or nullif(p_request->>'reference_number','') is null then
    raise exception 'Checkout payload does not match the saved payment' using errcode='22023';
  end if;
  if a.checkout_request is not null then return a.checkout_request=p_request; end if;
  update internal.paymongo_checkout_attempts set checkout_request=p_request,updated_at=now()
    where id=a.id and status='creating' and paymongo_session_id is null;
  return found;
end;
$$;
revoke all on function public.register_paymongo_checkout_request(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.register_paymongo_checkout_request(uuid,jsonb) to service_role;

create or replace function public.staff_get_transaction_payment_history(p_source text,p_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=(select auth.uid()); result jsonb; r record;
begin
  if v_actor is null or not exists(select 1 from public.profiles p where p.id=v_actor
    and p.role in ('staff','admin') and p.status='active') then
    raise exception 'Active staff access is required' using errcode='42501';
  end if;
  if p_source not in ('booking','walkin') or p_id is null or p_id<=0 then
    raise exception 'Invalid transaction reference' using errcode='22023';
  end if;
  if p_source='booking' then
    if not exists(select 1 from public.booking b where b.booking_id=p_id) then
      raise exception 'Transaction not found' using errcode='P0002';
    end if;
    for r in select distinct p.payment_id from public.booking b
      join public.payment p on p.payment_id in (b.payment_id,b.balance_payment_id)
      left join internal.payment_acknowledgments a on a.payment_id=p.payment_id
      where b.booking_id=p_id and a.payment_id is null
    loop
      perform internal.persist_payment_acknowledgment(r.payment_id,'booking',p_id,null);
    end loop;
    select jsonb_build_object('source',p_source,'id',p_id,'payment_history',coalesce(jsonb_agg(
      jsonb_build_object('payment_id',p.payment_id,'created_at',p.created_at,'method',p.payment_method,
        'base_minor',p.base_minor,'fee_minor',p.fee_minor,'gross_minor',p.gross_minor,
        'net_minor',p.net_minor,'receipt_id',a.receipt_id,'receipt_number',a.receipt_number,
        'acknowledgment',a.payload)
      order by p.created_at,p.payment_id),'[]'::jsonb)) into result
    from public.booking b
    join public.payment p on p.payment_id in (b.payment_id,b.balance_payment_id)
    left join internal.payment_acknowledgments a on a.payment_id=p.payment_id
    where b.booking_id=p_id;
  else
    if not exists(select 1 from public.walk_in_booking w where w.walkin_id=p_id) then
      raise exception 'Transaction not found' using errcode='P0002';
    end if;
    for r in
      select distinct p.payment_id,
        case when p.payment_id=o.payment_id then 'walkin_order' else 'walkin' end source,
        case when p.payment_id=o.payment_id then null::bigint else w.walkin_id end reservation_id,
        case when p.payment_id=o.payment_id then o.id else null::uuid end order_id
      from public.walk_in_booking w
      left join internal.staff_walkin_orders o on o.id=w.walkin_order_id
      join public.payment p on p.payment_id in (w.payment_id,w.balance_payment_id,o.payment_id)
      left join internal.payment_acknowledgments a on a.payment_id=p.payment_id
      where a.payment_id is null and w.walkin_id=p_id
    loop
      perform internal.persist_payment_acknowledgment(r.payment_id,r.source,r.reservation_id,r.order_id);
    end loop;
    select jsonb_build_object('source',p_source,'id',p_id,'payment_history',coalesce(jsonb_agg(
      jsonb_build_object('payment_id',q.payment_id,'created_at',q.created_at,'method',q.payment_method,
        'base_minor',q.base_minor,'fee_minor',q.fee_minor,'gross_minor',q.gross_minor,
        'net_minor',q.net_minor,'receipt_id',a.receipt_id,'receipt_number',a.receipt_number,
        'acknowledgment',a.payload)
      order by q.created_at,q.payment_id),'[]'::jsonb)) into result
    from (
      select distinct p.payment_id,p.created_at,p.payment_method,p.base_minor,p.fee_minor,
        p.gross_minor,p.net_minor
      from public.walk_in_booking w
      left join internal.staff_walkin_orders o on o.id=w.walkin_order_id
      join public.payment p on p.payment_id in (w.payment_id,w.balance_payment_id,o.payment_id)
      where w.walkin_id=p_id
    ) q left join internal.payment_acknowledgments a on a.payment_id=q.payment_id;
  end if;
  return coalesce(result,jsonb_build_object('source',p_source,'id',p_id,'payment_history','[]'::jsonb));
end;
$$;
revoke all on function public.staff_get_transaction_payment_history(text,bigint) from public,anon;
grant execute on function public.staff_get_transaction_payment_history(text,bigint) to authenticated;

