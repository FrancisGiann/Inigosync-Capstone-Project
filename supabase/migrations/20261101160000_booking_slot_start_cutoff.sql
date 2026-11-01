-- Owner-configurable close time for an unbooked slot after it starts.
-- No-show grace remains a separate rule and is not changed by this migration.
alter table public.booking_rule_sets
  add column if not exists slot_cutoff_minutes integer not null default 10;

do $migration$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.booking_rule_sets'::regclass
      and conname='booking_rule_sets_slot_cutoff_minutes_check'
  ) then
    alter table public.booking_rule_sets
      add constraint booking_rule_sets_slot_cutoff_minutes_check
      check (slot_cutoff_minutes between 0 and 59);
  end if;
end;
$migration$;

-- One source of truth for fallback rules and dates before the first ruleset.
create or replace function internal.booking_slot_cutoff_for_date(p_date date)
returns integer language sql stable security definer set search_path = '' as $$
  select coalesce((select s.slot_cutoff_minutes from public.booking_rule_sets s
    where s.effective_from<=p_date order by s.effective_from desc limit 1),10)
$$;
revoke all on function internal.booking_slot_cutoff_for_date(date) from public,anon,authenticated;

-- PostgREST exposes this shared date reader to customer, staff, and owner clients.
drop function public.booking_rules_for_date(date);
create function public.booking_rules_for_date(p_date date)
returns table(open_hour smallint,close_hour smallint,is_closed boolean,grace_minutes integer,
  slot_cutoff_minutes integer,timezone text)
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
    return query select 8::smallint,20::smallint,false,30,10,'Asia/Manila'::text;
  else
    return query select extract(hour from r.opens_at)::smallint,
      extract(hour from r.closes_at)::smallint,r.is_closed,r.grace_minutes,
      internal.booking_slot_cutoff_for_date(p_date),'Asia/Manila'::text;
  end if;
end;
$$;
revoke all on function public.booking_rules_for_date(date) from public,anon;
grant execute on function public.booking_rules_for_date(date) to authenticated,service_role;

-- Owner reader includes the independent cutoff in current and future summaries.
do $migration$
declare v_definition text; v_updated text;
begin
  v_definition:=pg_catalog.pg_get_functiondef('public.owner_get_booking_rules()'::regprocedure);
  if position('''effective_from'',s.effective_from,''grace_minutes'',s.grace_minutes,' in v_definition)=0 then
    raise exception 'Owner booking rules reader changed; review slot cutoff output';
  end if;
  v_updated:=replace(v_definition,
    '''effective_from'',s.effective_from,''grace_minutes'',s.grace_minutes,',
    '''effective_from'',s.effective_from,''grace_minutes'',s.grace_minutes,''slot_cutoff_minutes'',s.slot_cutoff_minutes,');
  if v_updated=v_definition then raise exception 'Could not update owner booking rules reader'; end if;
  execute v_updated;
end;
$migration$;

-- Retain the existing owner save validation/conflict checks and add a four-arg
-- overload for the new setting. Legacy three-arg saves inherit the cutoff
-- effective on their date; a same-date update leaves its current value intact.
do $migration$
declare v_definition text; v_updated text;
begin
  v_definition:=pg_catalog.pg_get_functiondef('public.owner_save_booking_rules(jsonb,integer,date)'::regprocedure);
  if position('p_grace_minutes is null or p_grace_minutes not between 0 and 720' in v_definition)=0
     or position('booking_rule_sets(effective_from,grace_minutes,created_by,updated_at)' in v_definition)=0
     or position('''grace_minutes'',p_grace_minutes,''timezone'',''Asia/Manila''' in v_definition)=0 then
    raise exception 'Owner booking rules save function changed; review slot cutoff validation';
  end if;
  v_updated:=replace(v_definition,
    'owner_save_booking_rules(p_weekly_hours jsonb, p_grace_minutes integer, p_effective_from date)',
    'owner_save_booking_rules(p_weekly_hours jsonb, p_grace_minutes integer, p_slot_cutoff_minutes integer, p_effective_from date)');
  v_updated:=replace(v_updated,
    'p_grace_minutes is null or p_grace_minutes not between 0 and 720',
    'p_grace_minutes is null or p_grace_minutes not between 0 and 720 or p_slot_cutoff_minutes is null or p_slot_cutoff_minutes not between 0 and 59');
  v_updated:=replace(v_updated,
    'a grace period from 0 to 720 minutes',
    'a no-show grace period from 0 to 720 minutes and an unbooked slot cutoff from 0 to 59 minutes');
  v_updated:=replace(v_updated,
    'booking_rule_sets(effective_from,grace_minutes,created_by,updated_at)',
    'booking_rule_sets(effective_from,grace_minutes,slot_cutoff_minutes,created_by,updated_at)');
  v_updated:=replace(v_updated,
    'values(p_effective_from,p_grace_minutes,v_actor,now())',
    'values(p_effective_from,p_grace_minutes,p_slot_cutoff_minutes,v_actor,now())');
  v_updated:=replace(v_updated,
    'do update set grace_minutes=excluded.grace_minutes,',
    'do update set grace_minutes=excluded.grace_minutes,slot_cutoff_minutes=excluded.slot_cutoff_minutes,');
  v_updated:=replace(v_updated,
    '''grace_minutes'',p_grace_minutes,''timezone'',''Asia/Manila''',
    '''grace_minutes'',p_grace_minutes,''slot_cutoff_minutes'',p_slot_cutoff_minutes,''timezone'',''Asia/Manila''');
  if v_updated=v_definition or position('p_slot_cutoff_minutes' in v_updated)=0
     or position('slot_cutoff_minutes=excluded.slot_cutoff_minutes' in v_updated)=0 then
    raise exception 'Could not create owner booking rules save overload';
  end if;
  execute v_updated;

  v_definition:=pg_catalog.pg_get_functiondef('public.owner_save_booking_rules(jsonb,integer,date)'::regprocedure);
  v_updated:=replace(v_definition,
    'booking_rule_sets(effective_from,grace_minutes,created_by,updated_at)',
    'booking_rule_sets(effective_from,grace_minutes,slot_cutoff_minutes,created_by,updated_at)');
  v_updated:=replace(v_updated,
    'values(p_effective_from,p_grace_minutes,v_actor,now())',
    'values(p_effective_from,p_grace_minutes,internal.booking_slot_cutoff_for_date(p_effective_from),v_actor,now())');
  if v_updated=v_definition or position('internal.booking_slot_cutoff_for_date(p_effective_from)' in v_updated)=0 then
    raise exception 'Could not preserve configured cutoff in legacy owner booking rules save';
  end if;
  execute v_updated;

  revoke all on function public.owner_save_booking_rules(jsonb,integer,integer,date) from public,anon;
  grant execute on function public.owner_save_booking_rules(jsonb,integer,integer,date) to authenticated,service_role;
end;
$migration$;

-- Convert the old checks in the trusted customer checkout and staff walk-in
-- order RPCs to the shared configurable deadline. Leave no-show Time-In grace
-- checks untouched.
do $migration$
declare v_function regprocedure; v_definition text; v_updated text;
begin
  v_function:='public.prepare_paid_checkout_cart(uuid,jsonb,text)'::regprocedure;
  v_definition:=pg_catalog.pg_get_functiondef(v_function);
  if position('v_start<=now()+interval ''2 minutes''' in v_definition)=0 then
    raise exception 'Customer checkout cutoff source changed; review slot-start cutoff';
  end if;
  v_updated:=replace(v_definition,
    'v_start<=now()+interval ''2 minutes''',
    'v_start+make_interval(mins=>internal.booking_slot_cutoff_for_date(v_start_local::date))<=now()');
  if v_updated=v_definition then raise exception 'Could not update customer checkout cutoff'; end if;
  execute v_updated;

  v_function:='public.staff_create_walkin_order(uuid,text,text,jsonb,text)'::regprocedure;
  v_definition:=pg_catalog.pg_get_functiondef(v_function);
  if position('v_start_local::time<date_trunc(''hour'',now() at time zone ''Asia/Manila'')::time' in v_definition)=0
     or position('now()>v_start+make_interval(mins=>coalesce(v_rule.grace_minutes,30))' in v_definition)=0 then
    raise exception 'Staff walk-in cutoff source changed; review slot-start cutoff';
  end if;
  v_updated:=replace(v_definition,
    'v_start_local::time<date_trunc(''hour'',now() at time zone ''Asia/Manila'')::time',
    'v_start+make_interval(mins=>internal.booking_slot_cutoff_for_date(v_start_local::date))<=now()');
  v_updated:=replace(v_updated,
    'now()>v_start+make_interval(mins=>coalesce(v_rule.grace_minutes,30))',
    'v_start+make_interval(mins=>internal.booking_slot_cutoff_for_date(v_start_local::date))<=now()');
  if v_updated=v_definition or position('internal.booking_slot_cutoff_for_date(v_start_local::date)' in v_updated)=0 then
    raise exception 'Could not update staff walk-in cutoff';
  end if;
  execute v_updated;
end;
$migration$;
