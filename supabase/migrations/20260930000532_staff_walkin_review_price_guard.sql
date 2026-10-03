-- The staff must see the authoritative amount before an atomic cash payment
-- or online hold is committed. A changed rate rolls the whole order back.
create or replace function public.staff_create_walkin_order_quoted(
  p_customer_id uuid,p_guest_name text,p_guest_mobile text,
  p_items jsonb,p_payment_method text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb; v_index integer; v_quote bigint; v_actual bigint;
begin
  v_result:=public.staff_create_walkin_order(
    p_customer_id,p_guest_name,p_guest_mobile,p_items,p_payment_method);
  if jsonb_array_length(p_items)<>jsonb_array_length(v_result->'items') then
    raise exception 'The order changed. Refresh availability and review it again' using errcode='22023';
  end if;
  for v_index in 0..jsonb_array_length(p_items)-1 loop
    v_quote:=nullif(p_items->v_index->>'quoted_minor','')::bigint;
    v_actual:=(v_result->'items'->v_index->>'subtotal_minor')::bigint;
    if v_quote is null or v_quote<=0 or v_actual is distinct from v_quote then
      raise exception 'A court price changed. Refresh availability and review the order again'
        using errcode='22023';
    end if;
  end loop;
  return v_result;
end;
$$;
revoke all on function public.staff_create_walkin_order_quoted(uuid,text,text,jsonb,text)
  from public,anon;
grant execute on function public.staff_create_walkin_order_quoted(uuid,text,text,jsonb,text)
  to authenticated,service_role;

-- The Edge Function still supplies an active staff identity, but now uses
-- the same reviewed-price path as a cash walk-in.
create or replace function public.staff_create_walkin_order_service(
  p_staff_id uuid,p_customer_id uuid,p_guest_name text,p_guest_mobile text,
  p_items jsonb,p_payment_method text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_prior_sub text:=current_setting('request.jwt.claim.sub',true); v_result jsonb;
begin
  if (select auth.role()) is distinct from 'service_role' or p_staff_id is null then
    raise exception 'Service access is required' using errcode='42501';
  end if;
  perform set_config('request.jwt.claim.sub',p_staff_id::text,true);
  v_result:=public.staff_create_walkin_order_quoted(
    p_customer_id,p_guest_name,p_guest_mobile,p_items,p_payment_method);
  perform set_config('request.jwt.claim.sub',coalesce(v_prior_sub,''),true);
  return v_result;
end;
$$;
revoke all on function public.staff_create_walkin_order_service(uuid,uuid,text,text,jsonb,text)
  from public,anon,authenticated;
grant execute on function public.staff_create_walkin_order_service(uuid,uuid,text,text,jsonb,text)
  to service_role;
