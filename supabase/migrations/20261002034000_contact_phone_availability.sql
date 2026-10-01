-- Let the authenticated, quota-limited phone validation Edge Function check
-- whether an active PH mobile number is already used by another profile.
-- Only a boolean leaves the database; profile IDs and numbers stay private.
create index if not exists profiles_contact_num_e164_idx
  on public.profiles (internal.ph_mobile_to_e164(contact_num))
  where contact_num is not null;

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
  ) then
    raise exception 'Active account required' using errcode = '42501';
  end if;

  return exists (
    select 1 from public.profiles p
    where p.id <> p_user_id
      and p.contact_num is not null
      and internal.ph_mobile_to_e164(p.contact_num) = p_phone_e164
  );
end;
$$;

revoke all on function public.contact_phone_in_use(uuid, text) from public, anon, authenticated;
grant execute on function public.contact_phone_in_use(uuid, text) to service_role;
