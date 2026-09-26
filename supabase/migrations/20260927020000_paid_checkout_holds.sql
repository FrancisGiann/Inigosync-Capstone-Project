-- Customer reservations begin as short-lived, physically constrained checkout
-- holds. They become bookings only in the signed PayMongo settlement transaction.
create table internal.checkout_intents (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id) on delete restrict,
  status text not null default 'creating' check (status in ('creating','ready','paid','expired','review')),
  payment_option text not null check (payment_option in ('full','downpayment')),
  downpayment_pct numeric(5,2) not null,
  amount_minor bigint not null check (amount_minor > 0),
  total_minor bigint not null check (total_minor >= amount_minor),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table internal.checkout_intent_items (
  id uuid primary key default gen_random_uuid(),
  intent_id uuid not null references internal.checkout_intents(id) on delete restrict,
  listing_id uuid not null references public.court(id) on delete restrict,
  unit_id uuid not null references public.court_unit_inventory(id) on delete restrict,
  sports text not null,
  courts text not null,
  court_unit text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  duration_minutes integer not null check (duration_minutes > 0),
  rate_quantity integer not null check (rate_quantity between 1 and 100),
  rate_unit text not null check (rate_unit in ('/hr','/set')),
  total_minor bigint not null check (total_minor > 0),
  charge_minor bigint not null check (charge_minor > 0),
  booking_id bigint unique references public.booking(booking_id) on delete restrict,
  check (ends_at > starts_at)
);
create index checkout_intent_items_intent_idx on internal.checkout_intent_items(intent_id);
alter table internal.checkout_intents enable row level security;
alter table internal.checkout_intent_items enable row level security;
revoke all on internal.checkout_intents, internal.checkout_intent_items from public,anon,authenticated;

alter table internal.reservation_resource_slots add column hold_item_id uuid
  references internal.checkout_intent_items(id) on delete cascade;
alter table internal.reservation_resource_slots drop constraint reservation_resource_slots_one_source;
alter table internal.reservation_resource_slots add constraint reservation_resource_slots_one_source
  check (num_nonnulls(booking_id,walkin_id,maintenance_id,hold_item_id)=1);
create unique index reservation_resource_slots_hold_resource_uidx
  on internal.reservation_resource_slots(hold_item_id,resource_id) where hold_item_id is not null;

alter table internal.paymongo_checkout_attempts alter column booking_id drop not null;
alter table internal.paymongo_checkout_attempts add column intent_id uuid unique
  references internal.checkout_intents(id) on delete restrict;
alter table internal.paymongo_checkout_attempts add column balance_source text
  check (balance_source in ('booking','walkin'));
alter table internal.paymongo_checkout_attempts add column balance_id bigint;
alter table internal.paymongo_checkout_attempts add column staff_id uuid references public.profiles(id);
alter table internal.paymongo_checkout_attempts add constraint paymongo_attempt_one_target
  check (num_nonnulls(booking_id,intent_id,balance_id)=1);
alter table internal.paymongo_checkout_attempts add constraint paymongo_attempt_balance_fields
  check ((balance_id is null and balance_source is null and staff_id is null)
      or (balance_id is not null and balance_source is not null and staff_id is not null));
create unique index paymongo_one_active_balance_attempt
  on internal.paymongo_checkout_attempts(balance_source,balance_id)
  where balance_id is not null and status in ('creating','ready','review');

-- Legacy pending bookings are retained, but customers can no longer create a
-- calendar-blocking row without a confirmed payment. Edge service role writes
-- the confirmed row after the webhook validates the saved session and amount.
drop policy if exists booking_insert on public.booking;
create policy booking_insert on public.booking for insert to authenticated
  with check (internal.is_staff_or_admin((select auth.uid())));

create or replace function public.prepare_paid_checkout_cart(
  p_customer_id uuid,p_items jsonb,p_payment_option text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_intent uuid; v_item jsonb; v_court public.court%rowtype; v_unit public.court_unit_inventory%rowtype;
  v_start timestamptz; v_end timestamptz; v_minutes integer; v_qty integer; v_rate_unit text;
  v_total numeric; v_charge numeric; v_total_minor bigint:=0; v_charge_minor bigint:=0;
  v_pct numeric; v_item_id uuid; v_count integer:=0; v_resource_count integer;
begin
  if p_customer_id is null or not exists (select 1 from public.profiles p where p.id=p_customer_id and p.role='customer' and p.status='active') then
    raise exception 'Active customer account required' using errcode='42501';
  end if;
  if p_payment_option not in ('full','downpayment') or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) not between 1 and 8 then
    raise exception 'Choose one to eight reservations and a payment option' using errcode='22023';
  end if;
  select coalesce(s.downpayment_pct,50) into v_pct from public.app_settings s where s.id=true;
  v_pct:=coalesce(v_pct,50);
  if not exists (select 1 from public.app_settings s where s.id=true and (s.card_enabled or s.gcash_enabled)) then
    raise exception 'Online payment is unavailable' using errcode='22023';
  end if;
  insert into internal.checkout_intents(customer_id,payment_option,downpayment_pct,amount_minor,total_minor)
    values(p_customer_id,p_payment_option,v_pct,1,1) returning id into v_intent;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_count:=v_count+1;
    select * into v_court from public.court c
      where c.id=(v_item->>'listing_id')::uuid and c.is_active and c.status='Available';
    select * into v_unit from public.court_unit_inventory u
      where u.id=(v_item->>'unit_id')::uuid and u.court_id=v_court.id and u.is_active and u.inventory_verified;
    if v_court.id is null or v_unit.id is null then raise exception 'Court or lane is unavailable' using errcode='22023'; end if;
    v_start:=(v_item->>'starts_at')::timestamptz;
    v_end:=(v_item->>'ends_at')::timestamptz;
    v_qty:=coalesce((v_item->>'rate_quantity')::integer,1);
    if v_start is null or v_end is null or v_start<=now()+interval '2 minutes'
      or v_end<=v_start or v_end>v_start+interval '12 hours' or v_qty not between 1 and 100 then
      raise exception 'Choose a future court time' using errcode='22023';
    end if;
    v_minutes:=ceil(extract(epoch from (v_end-v_start))/60)::integer;
    v_rate_unit:=internal.authoritative_reservation_rate_unit(v_court.id,v_unit.id);
    if v_rate_unit not in ('/hr','/set') then raise exception 'Court rate is unavailable' using errcode='22023'; end if;
    if v_rate_unit='/set' and (v_end <> v_start+make_interval(mins=>v_qty*60) or v_minutes<>v_qty*60) then
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
    if v_resource_count=0 then raise exception 'Court or lane has no available connection' using errcode='22023'; end if;
    v_total_minor:=v_total_minor+round(v_total*100)::bigint;
    v_charge_minor:=v_charge_minor+round(v_charge*100)::bigint;
  end loop;
  update internal.checkout_intents set total_minor=v_total_minor,amount_minor=v_charge_minor where id=v_intent;
  insert into internal.paymongo_checkout_attempts(booking_id,intent_id,customer_id,amount_minor,total_minor,payment_option)
    values(null,v_intent,p_customer_id,v_charge_minor,v_total_minor,p_payment_option);
  return (select jsonb_build_object('attempt_id',a.id,'intent_id',v_intent,'amount_minor',a.amount_minor,
    'total_minor',a.total_minor,'item_count',v_count,'expires_at',i.expires_at)
    from internal.paymongo_checkout_attempts a join internal.checkout_intents i on i.id=a.intent_id where a.intent_id=v_intent);
exception when exclusion_violation then
  raise exception 'This physical court is already reserved during the selected time' using errcode='23P01';
end;
$$;
revoke all on function public.prepare_paid_checkout_cart(uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.prepare_paid_checkout_cart(uuid,jsonb,text) to service_role;

-- Mapping edits rebuild current holds as well as bookings and maintenance.
create or replace function internal.refresh_reservation_resource_slots()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from internal.reservation_resource_slots;
  insert into internal.reservation_resource_slots(booking_id,walkin_id,resource_id,during)
  select s.booking_id,null::bigint,m.resource_id,s.during
    from internal.reservation_slots s join public.booking b on b.booking_id=s.booking_id and b.status in ('pending','confirmed')
    join public.court_unit_inventory u on u.court_id=b.court_listing_id and u.is_active and u.inventory_verified
    join public.court_unit_resource_map m on m.court_unit_id=u.id
    join public.physical_court_resource r on r.id=m.resource_id and r.is_active
   where (b.court_unit_inventory_id is not null and u.id=b.court_unit_inventory_id)
      or (b.court_unit_inventory_id is null and (nullif(btrim(b.court_unit),'') is null or lower(btrim(u.label))=lower(btrim(b.court_unit))))
  union all
  select null::bigint,s.walkin_id,m.resource_id,s.during
    from internal.reservation_slots s join public.walk_in_booking w on w.walkin_id=s.walkin_id and w.status in ('pending','confirmed')
    join public.court_unit_inventory u on u.court_id=w.court_listing_id and u.is_active and u.inventory_verified
    join public.court_unit_resource_map m on m.court_unit_id=u.id
    join public.physical_court_resource r on r.id=m.resource_id and r.is_active
   where (w.court_unit_inventory_id is not null and u.id=w.court_unit_inventory_id)
      or (w.court_unit_inventory_id is null and (nullif(btrim(w.court_unit),'') is null or lower(btrim(u.label))=lower(btrim(w.court_unit))));
  insert into internal.reservation_resource_slots(maintenance_id,resource_id,during)
    select x.id,m.resource_id,tstzrange(x.starts_at,x.ends_at,'[)') from public.court_unit_maintenance x
    join public.court_unit_resource_map m on m.court_unit_id=x.court_unit_id
    join public.physical_court_resource r on r.id=m.resource_id and r.is_active;
  insert into internal.reservation_resource_slots(hold_item_id,resource_id,during)
    select x.id,m.resource_id,tstzrange(x.starts_at,x.ends_at,'[)') from internal.checkout_intent_items x
    join internal.checkout_intents i on i.id=x.intent_id and i.status in ('creating','ready','review')
    join public.court_unit_resource_map m on m.court_unit_id=x.unit_id
    join public.physical_court_resource r on r.id=m.resource_id and r.is_active;
  if exists(select 1 from internal.reservation_slots s where
    (s.booking_id is not null and not exists(select 1 from internal.reservation_resource_slots r where r.booking_id=s.booking_id)) or
    (s.walkin_id is not null and not exists(select 1 from internal.reservation_resource_slots r where r.walkin_id=s.walkin_id)))
    or exists(select 1 from public.court_unit_maintenance x where not exists(select 1 from internal.reservation_resource_slots r where r.maintenance_id=x.id))
    or exists(select 1 from internal.checkout_intent_items x join internal.checkout_intents i on i.id=x.intent_id and i.status in ('creating','ready','review')
      where not exists(select 1 from internal.reservation_resource_slots r where r.hold_item_id=x.id)) then
    raise exception 'Every active reservation, maintenance period and payment hold needs a physical resource' using errcode='23503';
  end if;
  return null;
exception when exclusion_violation then
  raise exception 'The resource mapping conflicts with an active reservation, hold or maintenance period' using errcode='23P01';
end;
$$;

create or replace function public.court_occupancy(from_at timestamptz,to_at timestamptz)
returns table(source text,courts text,court_unit text,time_date timestamptz,end_at timestamptz,duration_minutes integer,status text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then raise exception 'Sign in to check court availability' using errcode='42501'; end if;
  if from_at is null or to_at is null or not isfinite(from_at) or not isfinite(to_at)
    or to_at<=from_at or to_at-from_at>interval '31 days' then raise exception 'Availability range must be between 0 and 31 days' using errcode='22023'; end if;
  return query
  select distinct on(rs.resource_id,rs.booking_id,rs.walkin_id,rs.maintenance_id,rs.hold_item_id,c.id,u.id)
    case when rs.maintenance_id is not null then 'maintenance' when rs.hold_item_id is not null then 'checkout_hold'
      when rs.booking_id is not null then 'online' else 'walkin' end,
    c.name,u.label,lower(rs.during),upper(rs.during),
    greatest(1,ceil(extract(epoch from (upper(rs.during)-lower(rs.during)))/60)::integer),
    case when rs.hold_item_id is not null then 'pending' else coalesce(b.status,w.status,'maintenance') end
  from internal.reservation_resource_slots rs join public.court_unit_resource_map tm on tm.resource_id=rs.resource_id
    join public.court_unit_inventory u on u.id=tm.court_unit_id and u.is_active
    join public.court c on c.id=u.court_id and c.is_active
    left join public.booking b on b.booking_id=rs.booking_id
    left join public.walk_in_booking w on w.walkin_id=rs.walkin_id
  where rs.during && tstzrange(from_at,to_at,'[)')
  order by rs.resource_id,rs.booking_id,rs.walkin_id,rs.maintenance_id,rs.hold_item_id,c.id,u.id;
end;
$$;
revoke all on function public.court_occupancy(timestamptz,timestamptz) from public,anon;
grant execute on function public.court_occupancy(timestamptz,timestamptz) to authenticated;
