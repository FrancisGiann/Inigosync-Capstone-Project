-- Staff may save an emergency contact number only after the authenticated
-- phone-validation Edge Function has recorded a matching, one-use proof.
-- Customer private-detail proofs keep their existing behavior. Other clients
-- (owner/admin edits and service-role invite flows) remain outside this
-- self-service guard.

create or replace function public.reserve_contact_phone_validation(
  p_user_id uuid,
  p_purpose text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_total integer;
  v_user integer;
  v_last timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     or p_user_id is null
     or p_purpose is null
     or p_purpose not in ('contact', 'emergency') then
    raise exception 'Invalid phone validation request' using errcode = '42501';
  end if;

  select p.role into v_role
  from public.profiles p
  where p.id = p_user_id and p.status = 'active';
  if v_role is null or v_role not in ('staff', 'customer', 'admin') then
    raise exception 'Active account required' using errcode = '42501';
  end if;
  if p_purpose = 'emergency' and v_role not in ('customer', 'staff') then
    raise exception 'Emergency contact validation is not available for this account' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(87499182034132372::bigint);
  delete from internal.abstract_phone_validation_usage u
  where u.requested_at < now() - interval '30 days';
  select count(*)::integer into v_total
  from internal.abstract_phone_validation_usage u
  where u.requested_at >= now() - interval '30 days';
  select count(*)::integer into v_user
  from internal.abstract_phone_validation_usage u
  where u.user_id = p_user_id and u.requested_at >= now() - interval '24 hours';
  select max(u.requested_at) into v_last
  from internal.abstract_phone_validation_usage u
  where u.requested_at >= now() - interval '30 days';

  if v_total >= 80 then
    raise exception 'Phone validation monthly safety limit reached' using errcode = '55000';
  end if;
  if v_user >= 3 then
    raise exception 'Phone validation daily rate limit reached' using errcode = '55000';
  end if;
  if v_last > now() - interval '1 second' then
    raise exception 'Phone validation request rate limit reached' using errcode = '55000';
  end if;

  insert into internal.abstract_phone_validation_usage(user_id, purpose)
  values (p_user_id, p_purpose);
  return true;
end;
$$;
revoke all on function public.reserve_contact_phone_validation(uuid, text) from public, anon, authenticated;
grant execute on function public.reserve_contact_phone_validation(uuid, text) to service_role;

create or replace function public.record_contact_phone_validation(
  p_user_id uuid,
  p_phone_e164 text,
  p_purpose text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     or p_user_id is null
     or p_phone_e164 !~ '^\+639[0-9]{9}$'
     or p_purpose is null
     or p_purpose not in ('contact', 'emergency') then
    raise exception 'Invalid phone validation proof' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles p
    where p.id = p_user_id
      and p.status = 'active'
      and p.role in ('staff', 'customer', 'admin')
      and (p_purpose <> 'emergency' or p.role in ('customer', 'staff'))
  ) then
    raise exception 'Active account required' using errcode = '42501';
  end if;

  delete from internal.contact_phone_validation_proofs proof
  where proof.expires_at <= now();
  insert into internal.contact_phone_validation_proofs(user_id, phone_e164, purpose, expires_at)
  values (p_user_id, p_phone_e164, p_purpose, now() + interval '5 minutes')
  on conflict (user_id, phone_e164, purpose)
  do update set expires_at = excluded.expires_at;
  return true;
end;
$$;
revoke all on function public.record_contact_phone_validation(uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_contact_phone_validation(uuid, text, text) to service_role;

-- Serialize writes that claim the same normalized phone number. The sorted
-- acquisition order also prevents deadlocks when one profile update changes
-- both its contact and emergency numbers.
create or replace function internal.lock_profile_phone_numbers(p_numbers text[])
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_number text;
begin
  for v_number in
    select distinct numbers.phone_number
    from pg_catalog.unnest(p_numbers) as numbers(phone_number)
    where numbers.phone_number is not null
    order by numbers.phone_number
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('profile-contact-phone:' || v_number, 0)
    );
  end loop;
end;
$$;
revoke all on function internal.lock_profile_phone_numbers(text[]) from public, anon, authenticated;

-- Keep the existing contact proof and normalization rules while taking the
-- same per-number transaction lock used by the emergency write guard.
create or replace function internal.guard_contact_phone_validation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stored text;
  v_emergency_stored text;
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

  delete from internal.contact_phone_validation_proofs proof
  where proof.user_id = new.id
    and proof.phone_e164 = v_stored
    and proof.purpose = 'contact'
    and proof.expires_at > now()
  returning true into v_proof;
  if v_proof is distinct from true then
    raise exception 'Validate this Philippine mobile number before saving it' using errcode = '42501';
  end if;

  new.contact_num := v_stored;
  new.contact_num_validated := true;
  new.contact_num_validated_at := now();
  new.phone_verified := false;
  return new;
end;
$$;
revoke all on function internal.guard_contact_phone_validation() from public, anon, authenticated;
drop trigger if exists profiles_contact_phone_validation_guard on public.profiles;
create trigger profiles_contact_phone_validation_guard
before insert or update of contact_num, phone_verified, contact_num_validated, contact_num_validated_at on public.profiles
for each row execute function internal.guard_contact_phone_validation();

create or replace function internal.guard_staff_emergency_phone_validation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stored text;
  v_proof boolean := false;
begin
  if new.emergency_contact_number is not distinct from old.emergency_contact_number then return new; end if;
  if nullif(btrim(new.emergency_contact_number), '') is null then
    new.emergency_contact_number := null;
    return new;
  end if;
  v_stored := internal.ph_mobile_to_e164(new.emergency_contact_number);
  if v_stored is null then
    raise exception 'Enter a valid Philippine emergency contact mobile number' using errcode = '22023';
  end if;

  -- Every changed value is format-checked above. Only active staff changing
  -- their own row require the purpose-specific self-service proof.
  if coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or auth.uid() is distinct from new.id
     or old.role is distinct from 'staff'
     or old.status is distinct from 'active' then
    new.emergency_contact_number := v_stored;
    return new;
  end if;

  -- Treat equivalent legacy local/E.164 formatting as unchanged, normalize
  -- it, and avoid requiring a new proof for an existing saved number.
  if internal.ph_mobile_to_e164(old.emergency_contact_number) = v_stored then
    new.emergency_contact_number := v_stored;
    return new;
  end if;

  -- Shared family emergency numbers are allowed. Availability is advisory
  -- in the UI and must not block this purpose-specific proof/write.
  delete from internal.contact_phone_validation_proofs proof
  where proof.user_id = new.id
    and proof.phone_e164 = v_stored
    and proof.purpose = 'emergency'
    and proof.expires_at > now()
  returning true into v_proof;
  if v_proof is distinct from true then
    raise exception 'Validate the emergency contact mobile number before saving it' using errcode = '42501';
  end if;

  new.emergency_contact_number := v_stored;
  return new;
end;
$$;
revoke all on function internal.guard_staff_emergency_phone_validation() from public, anon, authenticated;
drop trigger if exists profiles_staff_emergency_phone_validation_guard on public.profiles;
create trigger profiles_staff_emergency_phone_validation_guard
before update of emergency_contact_number on public.profiles
for each row execute function internal.guard_staff_emergency_phone_validation();
