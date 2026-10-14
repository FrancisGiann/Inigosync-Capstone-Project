-- This private definer helper can see all profile rows, including staff and
-- admin profiles hidden by profiles_select RLS. It checks the caller's active
-- staff role itself and returns only one boolean for the exact normalized
-- number. The internal schema is not exposed through PostgREST.
create or replace function internal.staff_guest_phone_is_registered(p_phone text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_phone_digits text;
  v_phone_e164 text;
begin
  if v_actor is null or not exists (
    select 1 from public.profiles p
    where p.id = v_actor and p.role in ('staff', 'admin') and p.status = 'active'
  ) then
    raise exception 'Active staff access is required' using errcode = '42501';
  end if;

  v_phone_digits := pg_catalog.regexp_replace(p_phone, '[^0-9]', '', 'g');
  v_phone_e164 := case
    when v_phone_digits ~ '^09[0-9]{9}$' then '+63' || pg_catalog.substr(v_phone_digits, 2)
    when v_phone_digits ~ '^639[0-9]{9}$' then '+' || v_phone_digits
    when v_phone_digits ~ '^9[0-9]{9}$' then '+63' || v_phone_digits
    else null
  end;
  if v_phone_e164 is null then
    raise exception 'Enter a valid Philippine mobile number.' using errcode = '22023';
  end if;

  return exists (
    select 1
    from public.profiles p
    cross join lateral (
      select pg_catalog.regexp_replace(p.contact_num, '[^0-9]', '', 'g') as digits
    ) raw_phone
    cross join lateral (
      select case
        when raw_phone.digits ~ '^09[0-9]{9}$' then '+63' || pg_catalog.substr(raw_phone.digits, 2)
        when raw_phone.digits ~ '^639[0-9]{9}$' then '+' || raw_phone.digits
        when raw_phone.digits ~ '^9[0-9]{9}$' then '+63' || raw_phone.digits
        else null
      end as phone_e164
    ) normalized_phone
    where p.contact_num is not null
      and normalized_phone.phone_e164 = v_phone_e164
  );
end;
$$;
revoke all on function internal.staff_guest_phone_is_registered(text) from public, anon, authenticated;
grant execute on function internal.staff_guest_phone_is_registered(text) to authenticated;
comment on function internal.staff_guest_phone_is_registered(text) is
  'Active-staff-only exact Guest mobile collision check. Returns only whether the normalized number exists.';

-- Keep the browser-callable RPC in public as a thin invoker wrapper. The
-- privileged profile scan stays in the non-exposed internal schema.
create or replace function public.staff_guest_phone_is_registered(p_phone text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select internal.staff_guest_phone_is_registered(p_phone);
$$;
revoke all on function public.staff_guest_phone_is_registered(text) from public, anon;
grant execute on function public.staff_guest_phone_is_registered(text) to authenticated;
comment on function public.staff_guest_phone_is_registered(text) is
  'Active-staff-only exact Guest mobile collision check. Returns only whether the normalized number exists.';

-- Retain the final order-time guard so stale browser state or direct RPC calls
-- cannot create a Guest order with an invalid or already registered number.
create or replace function public.staff_create_walkin_order_quoted(
  p_customer_id uuid,p_guest_name text,p_guest_mobile text,
  p_items jsonb,p_payment_method text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_guest_phone_e164 text;
  v_result jsonb;
  v_index integer;
  v_quote bigint;
  v_actual bigint;
begin
  if v_actor is null or not exists (
    select 1 from public.profiles p
    where p.id = v_actor and p.role in ('staff','admin') and p.status = 'active'
  ) then
    raise exception 'Active staff access is required' using errcode = '42501';
  end if;

  if p_customer_id is null and p_guest_mobile is not null and btrim(p_guest_mobile) <> '' then
    v_guest_phone_e164 := internal.ph_mobile_to_e164(p_guest_mobile);
    if v_guest_phone_e164 is null then
      raise exception 'Enter a valid Philippine mobile number.' using errcode = '22023';
    end if;
    if exists (
      select 1 from public.profiles p
      where p.contact_num is not null
        and internal.ph_mobile_to_e164(p.contact_num) = v_guest_phone_e164
    ) then
      raise exception 'This number is already registered. Enter another mobile number.'
        using errcode = '23505';
    end if;
  end if;

  v_result := public.staff_create_walkin_order(
    p_customer_id,p_guest_name,p_guest_mobile,p_items,p_payment_method);
  if jsonb_array_length(p_items) <> jsonb_array_length(v_result->'items') then
    raise exception 'The order changed. Refresh availability and review it again' using errcode = '22023';
  end if;
  for v_index in 0..jsonb_array_length(p_items)-1 loop
    v_quote := nullif(p_items->v_index->>'quoted_minor','')::bigint;
    v_actual := (v_result->'items'->v_index->>'subtotal_minor')::bigint;
    if v_quote is null or v_quote <= 0 or v_actual is distinct from v_quote then
      raise exception 'A court price changed. Refresh availability and review the order again'
        using errcode = '22023';
    end if;
  end loop;
  return v_result;
end;
$$;
revoke all on function public.staff_create_walkin_order_quoted(uuid,text,text,jsonb,text)
  from public,anon;
grant execute on function public.staff_create_walkin_order_quoted(uuid,text,text,jsonb,text)
  to authenticated,service_role;

-- The proof requirement belonged to the retired third-party active-number
-- validation flow. Remove its server-only storage and privileged RPC.
drop function if exists public.record_staff_walkin_phone_validation(uuid,text);
drop table if exists internal.staff_walkin_phone_validation_proofs;
revoke execute on function public.signup_phone_availability(text) from service_role;
revoke execute on function signup_private.phone_availability(text) from service_role;
revoke usage on schema signup_private from service_role;
notify pgrst, 'reload schema';
