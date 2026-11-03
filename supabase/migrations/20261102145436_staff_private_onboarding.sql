-- Staff onboarding personal fields and pending-account phone validation.
-- Apply only after reviewing the existing profile phone-proof functions.

-- Civil status is private HR data, kept away from profiles which other staff
-- can read. Existing staff have no civil-status value to convert.
create table if not exists public.staff_private_details (
  user_id uuid primary key references auth.users(id) on delete cascade,
  civil_status text not null,
  constraint staff_private_details_civil_status_valid
    check (civil_status in
      ('Single', 'Married', 'Separated', 'Widowed', 'Prefer not to say')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.staff_private_details enable row level security;
revoke all on public.staff_private_details from public, anon;
grant select on public.staff_private_details to authenticated;
grant select, insert, update, delete on public.staff_private_details to service_role;

drop policy if exists staff_private_details_self_read on public.staff_private_details;
create policy staff_private_details_self_read on public.staff_private_details
  for select to authenticated
  using (user_id = (select auth.uid()) and exists (
    select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'staff'
  ));
drop policy if exists staff_private_details_owner_read on public.staff_private_details;
create policy staff_private_details_owner_read on public.staff_private_details
  for select to authenticated
  using (internal.is_active_owner((select auth.uid())));

create or replace function public.set_staff_private_details_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.set_staff_private_details_updated_at() from public, anon, authenticated;
drop trigger if exists staff_private_details_updated_at on public.staff_private_details;
create trigger staff_private_details_updated_at before update on public.staff_private_details
  for each row execute function public.set_staff_private_details_updated_at();

-- Phone validation stays server-issued and single-use. Permit its existing
-- service-only check/proof RPCs for a staff account only while it is pending
-- and onboarding is incomplete; other pending account types remain rejected.
create or replace function public.reserve_contact_phone_check(p_user_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_role text;
begin
  if coalesce(auth.role(), '') <> 'service_role' or p_user_id is null then
    raise exception 'Invalid phone check request' using errcode = '42501';
  end if;
  select p.role into v_role from public.profiles p
   where p.id = p_user_id and (
     p.status = 'active' or (p.role = 'staff' and p.status = 'pending' and p.onboarding_complete is false)
   );
  if v_role is null or v_role not in ('staff', 'customer', 'admin') then
    raise exception 'Eligible account required' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(87499182034132372::bigint);
  delete from internal.abstract_phone_validation_usage u where u.requested_at < now() - interval '1 hour';
  if (select count(*) from internal.abstract_phone_validation_usage u where u.requested_at >= now() - interval '1 minute') >= 300
     or (select count(*) from internal.abstract_phone_validation_usage u where u.user_id = p_user_id and u.requested_at >= now() - interval '1 minute') >= 30 then
    raise exception 'Phone check rate limit reached' using errcode = '55000';
  end if;
  insert into internal.abstract_phone_validation_usage(user_id) values (p_user_id);
  return true;
end;
$$;
revoke all on function public.reserve_contact_phone_check(uuid) from public, anon, authenticated;
grant execute on function public.reserve_contact_phone_check(uuid) to service_role;

create or replace function public.contact_phone_in_use(p_user_id uuid, p_phone_e164 text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' or p_user_id is null
     or p_phone_e164 is null or p_phone_e164 !~ '^\+639[0-9]{9}$' then
    raise exception 'Invalid phone availability request' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_user_id
    and p.role in ('staff', 'customer', 'admin')
    and (p.status = 'active' or (p.role = 'staff' and p.status = 'pending' and p.onboarding_complete is false))) then
    raise exception 'Eligible account required' using errcode = '42501';
  end if;
  return exists (select 1 from public.profiles p where p.id <> p_user_id
    and p.contact_num is not null and internal.ph_mobile_to_e164(p.contact_num) = p_phone_e164);
end;
$$;
revoke all on function public.contact_phone_in_use(uuid, text) from public, anon, authenticated;
grant execute on function public.contact_phone_in_use(uuid, text) to service_role;

create or replace function public.contact_phone_exists(p_user_id uuid, p_phone_e164 text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' or p_user_id is null
     or p_phone_e164 is null or p_phone_e164 !~ '^\+639[0-9]{9}$' then
    raise exception 'Invalid phone availability request' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_user_id
    and p.role in ('staff', 'customer', 'admin')
    and (p.status = 'active' or (p.role = 'staff' and p.status = 'pending' and p.onboarding_complete is false))) then
    raise exception 'Eligible account required' using errcode = '42501';
  end if;
  return exists (
    select 1 from public.profiles p where p.contact_num is not null
      and internal.ph_mobile_to_e164(p.contact_num) = p_phone_e164
    union all
    select 1 from public.profiles p where p.emergency_contact_number is not null
      and internal.ph_mobile_to_e164(p.emergency_contact_number) = p_phone_e164
    union all
    select 1 from public.customer_private_details d where d.emergency_contact_number is not null
      and internal.ph_mobile_to_e164(d.emergency_contact_number) = p_phone_e164
  );
end;
$$;
revoke all on function public.contact_phone_exists(uuid, text) from public, anon, authenticated;
grant execute on function public.contact_phone_exists(uuid, text) to service_role;

create or replace function public.record_contact_phone_validation(
  p_user_id uuid, p_phone_e164 text, p_purpose text
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' or p_user_id is null
     or p_phone_e164 is null or p_phone_e164 !~ '^\+639[0-9]{9}$'
     or p_purpose is null or p_purpose not in ('contact', 'emergency') then
    raise exception 'Invalid phone validation proof' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_user_id
    and p.role in ('staff', 'customer', 'admin')
    and (p.status = 'active' or (p.role = 'staff' and p.status = 'pending' and p.onboarding_complete is false))
    and (p_purpose <> 'emergency' or p.role in ('customer', 'staff'))) then
    raise exception 'Eligible account required' using errcode = '42501';
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

-- Make profile activation and private civil-status persistence one database
-- transaction. This function is invoker (no RLS bypass) and service-only.
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
     or nullif(btrim(p_first_name), '') is null or nullif(btrim(p_last_name), '') is null
     or p_birthdate is null or p_birthdate < date '1900-01-01'
     or p_birthdate > (current_timestamp at time zone 'Asia/Manila')::date
     or p_civil_status is null
     or p_civil_status not in ('Single', 'Married', 'Separated', 'Widowed', 'Prefer not to say')
     or p_contact_num is null or p_contact_num !~ '^\+639[0-9]{9}$'
     or (p_gender is not null and p_gender not in ('Male', 'Female', 'Prefer not to say'))
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
