-- The contact-number flow checks Philippine mobile format and database
-- availability only. Keep a small authenticated request limiter, without
-- enforcing or recording a paid-provider quota.
create or replace function public.reserve_contact_phone_check(p_user_id uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_role text;
  v_total integer;
  v_user integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' or p_user_id is null then
    raise exception 'Invalid phone check request' using errcode = '42501';
  end if;
  select p.role into v_role from public.profiles p
    where p.id = p_user_id and p.status = 'active';
  if v_role is null or v_role not in ('staff', 'customer', 'admin') then
    raise exception 'Active account required' using errcode = '42501';
  end if;

  -- Serialize only this narrow counter operation so parallel calls cannot
  -- bypass either cap. The table contains account IDs and timestamps only.
  perform pg_catalog.pg_advisory_xact_lock(87499182034132372::bigint);
  delete from internal.abstract_phone_validation_usage u
    where u.requested_at < now() - interval '1 hour';
  select count(*)::integer into v_total from internal.abstract_phone_validation_usage u
    where u.requested_at >= now() - interval '1 minute';
  select count(*)::integer into v_user from internal.abstract_phone_validation_usage u
    where u.user_id = p_user_id and u.requested_at >= now() - interval '1 minute';
  if v_total >= 300 or v_user >= 30 then
    raise exception 'Phone check rate limit reached' using errcode = '55000';
  end if;
  insert into internal.abstract_phone_validation_usage(user_id) values (p_user_id);
  return true;
end;
$$;
revoke all on function public.reserve_contact_phone_check(uuid) from public, anon, authenticated;
grant execute on function public.reserve_contact_phone_check(uuid) to service_role;

-- Service-role-only contact availability for active accounts.
create or replace function public.contact_phone_in_use(
  p_user_id uuid,
  p_phone_e164 text
) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     or p_user_id is null
     or p_phone_e164 is null
     or p_phone_e164 !~ '^\+639[0-9]{9}$' then
    raise exception 'Invalid phone availability request' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles p
    where p.id = p_user_id and p.status = 'active'
      and p.role in ('staff', 'customer', 'admin')
  ) then raise exception 'Eligible account required' using errcode = '42501'; end if;

  return exists (
    select 1 from public.profiles p
    where p.id <> p_user_id and p.contact_num is not null
      and internal.ph_mobile_to_e164(p.contact_num) = p_phone_e164
  );
end;
$$;
revoke all on function public.contact_phone_in_use(uuid, text) from public, anon, authenticated;
grant execute on function public.contact_phone_in_use(uuid, text) to service_role;

create or replace function public.record_contact_phone_validation(
  p_user_id uuid,
  p_phone_e164 text,
  p_purpose text
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_role text; v_status text;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     or p_user_id is null
     or p_phone_e164 is null or p_phone_e164 !~ '^\+639[0-9]{9}$'
     or p_purpose is null or p_purpose not in ('contact', 'emergency') then
    raise exception 'Invalid phone validation proof' using errcode = '42501';
  end if;
  select p.role, p.status
    into v_role, v_status
    from public.profiles p where p.id = p_user_id;
  if v_status <> 'active' or v_role not in ('staff', 'customer', 'admin') then
    raise exception 'Active account required' using errcode = '42501';
  end if;
  if p_purpose = 'emergency' and v_role not in ('customer', 'staff') then
    raise exception 'Emergency contact validation is not available for this account' using errcode = '42501';
  end if;

  delete from internal.contact_phone_validation_proofs proof where proof.expires_at <= now();
  insert into internal.contact_phone_validation_proofs(user_id, phone_e164, purpose, expires_at)
  values (p_user_id, p_phone_e164, p_purpose, now() + interval '5 minutes')
  on conflict (user_id, phone_e164, purpose) do update set expires_at = excluded.expires_at;
  return true;
end;
$$;
revoke all on function public.record_contact_phone_validation(uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_contact_phone_validation(uuid, text, text) to service_role;

-- Emergency contacts can be shared by relatives. Report a collision only as
-- an advisory signal, checking all saved contact-number locations while
-- returning no profile IDs or phone values.
create or replace function public.contact_phone_exists(
  p_user_id uuid,
  p_phone_e164 text
) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     or p_user_id is null
     or p_phone_e164 is null
     or p_phone_e164 !~ '^\+639[0-9]{9}$' then
    raise exception 'Invalid phone availability request' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles p where p.id = p_user_id
      and p.status = 'active' and p.role in ('staff', 'customer', 'admin')
  ) then raise exception 'Active account required' using errcode = '42501'; end if;

  return exists (
    select 1 from public.profiles p
    where (
      (p.contact_num is not null and internal.ph_mobile_to_e164(p.contact_num) = p_phone_e164)
      or (p.emergency_contact_number is not null and internal.ph_mobile_to_e164(p.emergency_contact_number) = p_phone_e164)
    )
  ) or exists (
    select 1 from public.customer_private_details d
    where d.emergency_contact_number is not null
      and internal.ph_mobile_to_e164(d.emergency_contact_number) = p_phone_e164
  );
end;
$$;
revoke all on function public.contact_phone_exists(uuid, text) from public, anon, authenticated;
grant execute on function public.contact_phone_exists(uuid, text) to service_role;

-- Admin-only duplicate hint for owner-managed staff emergency contacts. The
-- same public signup limiter bounds calls; the response contains no PII.
create or replace function public.admin_phone_number_exists(p_phone_e164 text)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_admin boolean;
  v_contact_state text;
begin
  if coalesce(auth.role(), '') <> 'authenticated'
     or p_phone_e164 is null or p_phone_e164 !~ '^\+639[0-9]{9}$' then
    raise exception 'Invalid phone availability request' using errcode = '42501';
  end if;
  select exists (select 1 from public.profiles p where p.id = auth.uid()
    and p.role = 'admin' and p.status = 'active') into v_admin;
  if not v_admin then raise exception 'Administrator access required' using errcode = '42501'; end if;

  v_contact_state := signup_private.phone_availability(p_phone_e164);
  if v_contact_state = 'rate_limited' then
    raise exception 'Phone check rate limit reached' using errcode = '55000';
  end if;
  if v_contact_state = 'in_use' then return true; end if;
  return exists (
    select 1 from public.profiles p
    where p.emergency_contact_number is not null
      and internal.ph_mobile_to_e164(p.emergency_contact_number) = p_phone_e164
  ) or exists (
    select 1 from public.customer_private_details d
    where d.emergency_contact_number is not null
      and internal.ph_mobile_to_e164(d.emergency_contact_number) = p_phone_e164
  );
end;
$$;
revoke all on function public.admin_phone_number_exists(text) from public, anon;
grant execute on function public.admin_phone_number_exists(text) to authenticated;

-- Preserve a one-use proof tied to each user's purpose and enforce uniqueness
-- at write time as well as in the availability response. The advisory lock
-- closes races between two users claiming the same number concurrently.
create or replace function internal.guard_contact_phone_validation()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_stored text;
  v_emergency_stored text;
  v_duplicate boolean := false;
  v_proof boolean := false;
begin
  if tg_op = 'UPDATE' and new.contact_num is not distinct from old.contact_num then
    new.phone_verified := old.phone_verified;
    delete from internal.contact_phone_validation_proofs proof
      where proof.user_id = new.id
        and proof.phone_e164 = internal.ph_mobile_to_e164(new.contact_num)
        and proof.purpose = 'contact'
        and proof.expires_at > now()
      returning true into v_proof;
    if v_proof then
      new.contact_num_validated := true;
      new.contact_num_validated_at := now();
    else
      new.contact_num_validated := old.contact_num_validated;
      new.contact_num_validated_at := old.contact_num_validated_at;
    end if;
    return new;
  end if;

  if nullif(btrim(new.contact_num), '') is null then
    new.contact_num := null;
    new.contact_num_validated := false;
    new.contact_num_validated_at := null;
    new.phone_verified := false;
    return new;
  end if;

  v_stored := internal.ph_mobile_to_e164(new.contact_num);
  if v_stored is null then
    raise exception 'Enter a valid Philippine mobile number' using errcode = '22023';
  end if;
  v_emergency_stored := internal.ph_mobile_to_e164(new.emergency_contact_number);
  perform internal.lock_profile_phone_numbers(array[v_stored, v_emergency_stored]);

  select exists (
    select 1 from public.profiles p
    where p.id <> new.id and p.contact_num is not null
      and internal.ph_mobile_to_e164(p.contact_num) = v_stored
  ) into v_duplicate;
  if v_duplicate then
    raise exception 'This contact number is already in use' using errcode = '23505';
  end if;

  delete from internal.contact_phone_validation_proofs proof
    where proof.user_id = new.id and proof.phone_e164 = v_stored
      and proof.purpose = 'contact' and proof.expires_at > now()
    returning true into v_proof;
  if v_proof is distinct from true then
    raise exception 'Check that this Philippine mobile number is available before saving it' using errcode = '42501';
  end if;
  new.contact_num := v_stored;
  new.contact_num_validated := true;
  new.contact_num_validated_at := now();
  new.phone_verified := false;
  return new;
end;
$$;
revoke all on function internal.guard_contact_phone_validation() from public, anon, authenticated;

comment on function public.contact_phone_in_use(uuid, text) is
  'Service-role-only boolean availability check; excludes the requesting user and exposes no profile values.';
comment on function public.contact_phone_exists(uuid, text) is
  'Service-role-only boolean existence signal for emergency contact warnings; shared emergency numbers remain valid.';
comment on function public.admin_phone_number_exists(text) is
  'Rate-limited admin-only boolean existence signal for emergency contact warnings; reveals no profile data.';
notify pgrst, 'reload schema';
