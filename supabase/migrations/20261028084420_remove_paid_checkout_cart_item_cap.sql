-- Customer booking carts have no count-based maximum. Keep the nonempty-array
-- requirement and payload-size guard in the trusted checkout RPC.
do $migration$
declare
  v_function regprocedure := 'public.prepare_paid_checkout_cart(uuid,jsonb,text)'::regprocedure;
  v_definition text;
  v_updated text;
begin
  v_definition := pg_catalog.pg_get_functiondef(v_function);
  if position('jsonb_array_length(p_items) not between 1 and 8' in v_definition)=0 then
    raise exception 'Paid checkout cart validation source has changed; review item-cap removal';
  end if;
  v_updated := replace(v_definition,
    'jsonb_array_length(p_items) not between 1 and 8',
    'jsonb_array_length(p_items)=0');
  v_updated := replace(v_updated,
    'Choose one to eight reservations and a valid payment option',
    'Choose at least one reservation and a valid payment option');
  if v_updated = v_definition or position('octet_length(p_items::text)>1048576' in v_updated)=0 then
    raise exception 'Could not safely update paid checkout cart validation';
  end if;
  execute v_updated;
end;
$migration$;
