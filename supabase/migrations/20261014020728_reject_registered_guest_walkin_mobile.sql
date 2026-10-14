-- Enforce Guest mobile registration and active-number proof inside the
-- reviewed-order RPC. The service checkout path also calls this wrapper, so
-- the guard covers cash and online Guest orders. Account-linked orders keep
-- their existing behavior.
create table if not exists internal.staff_walkin_phone_validation_proofs (
  staff_id uuid not null references auth.users(id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+639[0-9]{9}$'),
  expires_at timestamptz not null,
  primary key (staff_id, phone_e164)
);
alter table internal.staff_walkin_phone_validation_proofs enable row level security;
revoke all on internal.staff_walkin_phone_validation_proofs from public,anon,authenticated;
grant select,insert,update,delete on internal.staff_walkin_phone_validation_proofs to service_role;

create or replace function public.record_staff_walkin_phone_validation(p_staff_id uuid,p_phone_e164 text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(),'') <> 'service_role' or p_staff_id is null
     or p_phone_e164 !~ '^\+639[0-9]{9}$' then
    raise exception 'Invalid Guest mobile validation proof' using errcode='42501';
  end if;
  if not exists(select 1 from public.profiles p where p.id=p_staff_id
      and p.role in ('staff','admin') and p.status='active') then
    raise exception 'Active staff access is required' using errcode='42501';
  end if;
  delete from internal.staff_walkin_phone_validation_proofs proof where proof.expires_at<=now();
  insert into internal.staff_walkin_phone_validation_proofs(staff_id,phone_e164,expires_at)
    values(p_staff_id,p_phone_e164,now()+interval '5 minutes')
    on conflict(staff_id,phone_e164) do update set expires_at=excluded.expires_at;
  return true;
end;
$$;
revoke all on function public.record_staff_walkin_phone_validation(uuid,text) from public,anon,authenticated;
grant execute on function public.record_staff_walkin_phone_validation(uuid,text) to service_role;

-- The authenticated staff Edge Function uses the service role to invoke this
-- existing, rate-limited lookup. No browser role receives this grant.
grant usage on schema signup_private to service_role;
grant execute on function signup_private.phone_availability(text) to service_role;
grant execute on function public.signup_phone_availability(text) to service_role;

create or replace function public.staff_create_walkin_order_quoted(
  p_customer_id uuid,p_guest_name text,p_guest_mobile text,
  p_items jsonb,p_payment_method text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_guest_phone_e164 text;
  v_phone_proof boolean;
  v_result jsonb;
  v_index integer;
  v_quote bigint;
  v_actual bigint;
begin
  -- Do not expose phone registration state to callers without active staff access.
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
    if v_guest_phone_e164 is not null and exists (
      select 1 from public.profiles p
      where p.contact_num is not null
        and internal.ph_mobile_to_e164(p.contact_num) = v_guest_phone_e164
    ) then
      raise exception 'This number is already registered. Enter another mobile number.'
        using errcode = '23505';
    end if;
    delete from internal.staff_walkin_phone_validation_proofs proof
      where proof.staff_id=v_actor and proof.phone_e164=v_guest_phone_e164
        and proof.expires_at>now()
      returning true into v_phone_proof;
    if coalesce(v_phone_proof,false) is not true then
      raise exception 'Validate that this Guest mobile is an active Philippine mobile number before continuing.'
        using errcode = '22023';
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
