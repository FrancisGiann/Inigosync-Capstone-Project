-- Let new staff omit a middle name and require age 18 or older at setup.
-- Keep the existing optional-mobile and service-only completion behavior.
-- Existing completed staff profiles are unchanged.
create or replace function public.complete_staff_onboarding_profile(
  p_user_id uuid,
  p_full_name text,
  p_first_name text,
  p_middle_name text,
  p_last_name text,
  p_contact_num text,
  p_address text,
  p_birthdate date,
  p_gender text,
  p_emergency_contact_name text,
  p_emergency_contact_number text,
  p_civil_status text
) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare
  v_updated_id uuid;
  v_emergency_proof boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Staff onboarding completion is server-only' using errcode = '42501';
  end if;
  if p_user_id is null or nullif(btrim(p_full_name), '') is null
     or char_length(btrim(p_full_name)) > 120
     or nullif(btrim(p_first_name), '') is null
     or nullif(btrim(p_last_name), '') is null or nullif(btrim(p_address), '') is null
     or p_birthdate is null or p_birthdate < date '1900-01-01'
     or p_birthdate > ((current_timestamp at time zone 'Asia/Manila')::date - interval '18 years')::date
     or p_civil_status is null
     or p_civil_status not in ('Single', 'Married', 'Separated', 'Widowed', 'Prefer not to say')
     or (p_contact_num is not null and p_contact_num !~ '^\+639[0-9]{9}$')
     or p_gender is null or p_gender not in ('Male', 'Female', 'Prefer not to say')
     or (p_emergency_contact_number is not null and p_emergency_contact_number !~ '^\+639[0-9]{9}$') then
    raise exception 'Staff personal details are invalid' using errcode = '22023';
  end if;

  -- Service-role profile updates bypass the authenticated-user emergency
  -- trigger, so consume its purpose-specific proof explicitly here.
  if p_emergency_contact_number is not null then
    delete from internal.contact_phone_validation_proofs proof
    where proof.user_id = p_user_id
      and proof.phone_e164 = p_emergency_contact_number
      and proof.purpose = 'emergency'
      and proof.expires_at > now()
    returning true into v_emergency_proof;
    if v_emergency_proof is distinct from true then
      raise exception 'Validate the emergency contact mobile number before finishing setup' using errcode = '42501';
    end if;
  end if;

  update public.profiles set
    full_name = btrim(p_full_name),
    first_name = nullif(btrim(p_first_name), ''),
    middle_name = nullif(btrim(p_middle_name), ''),
    last_name = nullif(btrim(p_last_name), ''),
    contact_num = p_contact_num,
    address = nullif(btrim(p_address), ''),
    birthdate = p_birthdate,
    gender = nullif(p_gender, ''),
    emergency_contact_name = nullif(btrim(p_emergency_contact_name), ''),
    emergency_contact_number = nullif(p_emergency_contact_number, ''),
    status = 'active',
    onboarding_complete = true
  where id = p_user_id and role = 'staff' and status = 'pending' and onboarding_complete is false
  returning id into v_updated_id;
  if v_updated_id is null then return false; end if;

  insert into public.staff_private_details(user_id, civil_status)
    values (p_user_id, p_civil_status)
    on conflict (user_id) do update set civil_status = excluded.civil_status;
  return true;
end;
$$;
revoke all on function public.complete_staff_onboarding_profile(uuid, text, text, text, text, text, text, date, text, text, text, text) from public, anon, authenticated;
grant execute on function public.complete_staff_onboarding_profile(uuid, text, text, text, text, text, text, date, text, text, text, text) to service_role;

notify pgrst, 'reload schema';
