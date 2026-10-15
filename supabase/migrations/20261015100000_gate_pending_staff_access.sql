-- Retire permissive policies left by the early profile RLS migration. The
-- current policies in 20261015070000 own normal profile access; these legacy
-- grants otherwise OR together and let pending staff read every customer.
drop policy if exists "users_can_read_own_profile" on public.profiles;
drop policy if exists "staff_can_read_customer_profiles" on public.profiles;
drop policy if exists "admin_can_read_all_profiles" on public.profiles;
drop policy if exists "users_can_update_own_profile" on public.profiles;
drop policy if exists "admin_can_update_all_profiles" on public.profiles;

-- Defense in depth: even a future permissive SELECT policy cannot allow a
-- pending staff member to enumerate profiles beyond their own bootstrap row.
create or replace function internal.is_pending_staff_onboarding(uid uuid)
returns boolean language sql stable security definer
set search_path = '' set row_security = off as $$
  select exists (select 1 from public.profiles p
    where uid = (select auth.uid()) and p.id = uid and p.role = 'staff' and p.status = 'pending'
      and p.onboarding_complete is false);
$$;
revoke all on function internal.is_pending_staff_onboarding(uuid) from public, anon;
grant execute on function internal.is_pending_staff_onboarding(uuid) to authenticated;

drop policy if exists profiles_pending_staff_select_own on public.profiles;
create policy profiles_pending_staff_select_own on public.profiles as restrictive
  for select to authenticated
  using (not internal.is_pending_staff_onboarding((select auth.uid()))
    or id = (select auth.uid()));

-- A staff profile must never become operationally active before server-owned
-- onboarding is complete. This also protects SECURITY DEFINER operations that
-- authorize active staff directly instead of using the shared RLS helper.
create or replace function internal.validate_staff_profile_details()
returns trigger language plpgsql security definer set search_path = '' as $$
declare is_new_staff boolean; title_changed boolean;
begin
  if tg_op = 'INSERT' then
    is_new_staff := new.role = 'staff';
    title_changed := true;
  else
    is_new_staff := old.role is distinct from 'staff' and new.role = 'staff';
    title_changed := old.position is distinct from new.position;
  end if;

  if new.role = 'staff' and title_changed
    and coalesce(new.position, '') not in ('Secretary', 'Court Attendant') then
    raise exception 'Staff position must be Secretary or Court Attendant' using errcode = '22023';
  end if;
  if new.role = 'staff' and new.status = 'active' and new.onboarding_complete is not true then
    raise exception 'Staff onboarding must be complete before activation' using errcode = '23514';
  end if;
  if new.role = 'staff' and new.onboarding_complete is true
    and (is_new_staff or (tg_op = 'UPDATE' and old.birthdate is distinct from new.birthdate and new.birthdate is null)) then
    raise exception 'A staff birthdate is required' using errcode = '22023';
  end if;
  if new.role = 'staff' and new.birthdate is not null
    and (new.birthdate > (current_timestamp at time zone 'Asia/Manila')::date or new.birthdate < date '1900-01-01') then
    raise exception 'Staff birthdate is invalid' using errcode = '22023';
  end if;
  if new.role = 'staff' and new.onboarding_complete is true and tg_op = 'UPDATE'
    and old.onboarding_complete is false and (new.birthdate is null or nullif(btrim(new.full_name), '') is null) then
    raise exception 'Name and birthdate are required to complete staff onboarding' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function internal.validate_staff_profile_details() from public, anon, authenticated;

notify pgrst, 'reload schema';
