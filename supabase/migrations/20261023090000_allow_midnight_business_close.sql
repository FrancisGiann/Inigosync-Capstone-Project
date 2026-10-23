-- A 24:00 business close means the local midnight immediately after the
-- business date. Permit the final 23:00–24:00 slot while still rejecting
-- reservations that run past the configured close or cross any other date.
do $migration$
declare
  v_function regprocedure;
  v_definition text;
  v_updated text;
begin
  v_function := 'internal.guard_reservation_business_hours()'::regprocedure;
  v_definition := pg_catalog.pg_get_functiondef(v_function);
  if position('if v_start_local::date<>v_end_local::date then' in v_definition)=0
     or position('v_end_local::time>time ''20:00''' in v_definition)=0
     or position('v_end_local::time>v_rule.closes_at' in v_definition)=0 then
    raise exception 'Reservation business-hours guard source has changed; review midnight-close patch';
  end if;
  v_updated := replace(v_definition,
    'if v_start_local::date<>v_end_local::date then',
    'if v_end_local::date<>v_start_local::date and (v_end_local::date<>v_start_local::date+1 or v_end_local::time<>time ''00:00'') then');
  v_updated := replace(v_updated, 'v_end_local::time>time ''20:00''',
    'v_end_local>v_start_local::date+time ''20:00''');
  v_updated := replace(v_updated, 'v_end_local::time>v_rule.closes_at',
    'v_end_local>v_start_local::date+v_rule.closes_at');
  if v_updated = v_definition then
    raise exception 'Could not update the reservation business-hours guard';
  end if;
  execute v_updated;

  v_function := 'public.owner_save_booking_rules(jsonb,integer,date)'::regprocedure;
  v_definition := pg_catalog.pg_get_functiondef(v_function);
  if position('(r.ends_at at time zone ''Asia/Manila'')::time>nullif(j.value->>''closes_at'','''')::time' in v_definition)=0 then
    raise exception 'Booking-rules conflict check source has changed; review midnight-close patch';
  end if;
  v_updated := replace(v_definition,
    '(r.ends_at at time zone ''Asia/Manila'')::time>nullif(j.value->>''closes_at'','''')::time',
    '(r.ends_at at time zone ''Asia/Manila'')>(r.starts_at at time zone ''Asia/Manila'')::date+nullif(j.value->>''closes_at'','''')::time');
  if v_updated = v_definition then
    raise exception 'Could not update scheduled-hours conflict checks';
  end if;
  execute v_updated;

  foreach v_function in array array[
    'public.staff_create_walkin_order(uuid,text,text,jsonb,text)'::regprocedure,
    'public.prepare_paid_checkout_cart(uuid,jsonb,text)'::regprocedure
  ] loop
    v_definition := pg_catalog.pg_get_functiondef(v_function);
    if position('or v_end_local::date<>v_start_local::date' in v_definition)=0
       and position('or v_start_local::date<>v_end_local::date' in v_definition)=0 then
      raise exception 'Business-hours date check source changed in %; review midnight-close patch', v_function;
    end if;
    if position('v_end_local::time>time ''20:00''' in v_definition)=0
       or position('v_end_local::time>v_rule.closes_at' in v_definition)=0 then
      raise exception 'Business-hours validation source changed in %; review midnight-close patch', v_function;
    end if;
    v_updated := replace(v_definition,
      'or v_end_local::date<>v_start_local::date',
      'or (v_end_local::date<>v_start_local::date and (v_end_local::date<>v_start_local::date+1 or v_end_local::time<>time ''00:00''))');
    v_updated := replace(v_updated,
      'or v_start_local::date<>v_end_local::date',
      'or (v_end_local::date<>v_start_local::date and (v_end_local::date<>v_start_local::date+1 or v_end_local::time<>time ''00:00''))');
    v_updated := replace(v_updated, 'v_end_local::time>time ''20:00''',
      'v_end_local>v_start_local::date+time ''20:00''');
    v_updated := replace(v_updated, 'v_end_local::time>v_rule.closes_at',
      'v_end_local>v_start_local::date+v_rule.closes_at');
    if v_updated = v_definition then
      raise exception 'Could not update business-hours checks in %', v_function;
    end if;
    execute v_updated;
  end loop;
end;
$migration$;
