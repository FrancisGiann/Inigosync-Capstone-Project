-- Legacy single-booking checkouts predate checkout intents and already have a
-- public pending booking row. Once provider expiry is confirmed, cancel only
-- that unpaid, unchecked-in reservation so it cannot remain visible as booked.
do $migration$
declare v_definition text; v_updated text;
begin
  v_definition:=pg_catalog.pg_get_functiondef('public.mark_paymongo_checkout_expired(uuid,text)'::regprocedure);
  if position('returning intent_id,walkin_order_id into v_intent,v_order;' in v_definition)=0
     or position('return v_count=1;' in v_definition)=0 then
    raise exception 'PayMongo expiry RPC changed; review legacy booking cleanup';
  end if;
  v_updated:=replace(v_definition,
    'declare v_intent uuid; v_order uuid; v_count integer;',
    'declare v_intent uuid; v_order uuid; v_booking bigint; v_count integer;');
  v_updated:=replace(v_updated,
    'returning intent_id,walkin_order_id into v_intent,v_order;',
    'returning intent_id,walkin_order_id,booking_id into v_intent,v_order,v_booking;');
  v_updated:=replace(v_updated,
    '  return v_count=1;',
    '  if v_count=1 and v_booking is not null then
    update public.booking set status=''cancelled''
      where booking_id=v_booking and status in (''pending'',''confirmed'') and payment_id is null
        and amount_paid=0 and checked_in_at is null;
  end if;
  return v_count=1;');
  if v_updated=v_definition or position('v_booking bigint' in v_updated)=0
     or position('status=''cancelled''' in v_updated)=0 then
    raise exception 'Could not add safe legacy booking expiry cleanup';
  end if;
  execute v_updated;
end;
$migration$;
