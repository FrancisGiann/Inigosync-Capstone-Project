-- Staff accounts created by invite-staff remain pending and cannot use
-- staff/admin policy helpers until their server-owned onboarding is complete.
alter table public.profiles
  add column if not exists onboarding_complete boolean not null default true;

comment on column public.profiles.onboarding_complete is
  'Server-owned gate set false for newly-created staff; only the onboarding Edge Function may mark it complete.';

create table if not exists public.staff_onboarding_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  temporary_password_hash text not null check (temporary_password_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now()
);
alter table public.staff_onboarding_credentials enable row level security;
revoke all on public.staff_onboarding_credentials from public, anon, authenticated;
grant select, insert, update, delete on public.staff_onboarding_credentials to service_role;
comment on table public.staff_onboarding_credentials is
  'Service-only SHA-256 digest of the random initial staff password, used to require a distinct password during first-login setup.';

create or replace function internal.is_staff_or_admin(uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles p where p.id=uid
    and p.role in ('staff','admin') and p.status='active'
    and (p.role='admin' or p.onboarding_complete is true));
$$;
revoke all on function internal.is_staff_or_admin(uuid) from public, anon;
grant execute on function internal.is_staff_or_admin(uuid) to authenticated;

create or replace function public.inigosync_is_staff_or_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles p where p.id=(select auth.uid())
    and p.role in ('staff','admin') and p.status='active'
    and (p.role='admin' or p.onboarding_complete is true));
$$;
revoke all on function public.inigosync_is_staff_or_admin() from public, anon;
grant execute on function public.inigosync_is_staff_or_admin() to authenticated;

-- Permit a pending staff member to read only their own bootstrap profile so
-- authGuard can route them to setup. They still cannot update it from a client.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using((id=(select auth.uid()) and (status='active' or (role='staff' and status='pending' and onboarding_complete is false)))
    or (role='customer' and internal.is_staff_or_admin((select auth.uid())))
    or internal.is_active_owner((select auth.uid())));

create or replace function internal.guard_profile_status_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.id is distinct from old.id or new.created_at is distinct from old.created_at
      or new.email is distinct from old.email)
    and coalesce((select auth.jwt()->>'role'), '') is distinct from 'service_role' then
    raise exception 'Account identity fields cannot be changed directly' using errcode='42501';
  end if;
  if new.onboarding_complete is distinct from old.onboarding_complete
    and coalesce((select auth.jwt()->>'role'), '') is distinct from 'service_role' then
    raise exception 'Staff onboarding can only be completed by the server' using errcode='42501';
  end if;
  if new.position is distinct from old.position and coalesce((select auth.jwt()->>'role'), '') is distinct from 'service_role'
    and not internal.is_active_owner((select auth.uid())) then
    raise exception 'Only an active owner can change staff position' using errcode='42501';
  end if;
  if new.status is distinct from old.status and coalesce((select auth.jwt()->>'role'), '') is distinct from 'service_role'
    and not internal.is_active_owner((select auth.uid())) then
    raise exception 'Only an active owner can change account status' using errcode='42501';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_profile_status_change() from public, anon, authenticated;

create or replace function internal.validate_staff_profile_details()
returns trigger language plpgsql security definer set search_path = '' as $$
declare is_new_staff boolean; title_changed boolean;
begin
  if tg_op='INSERT' then is_new_staff:=new.role='staff'; title_changed:=true;
  else is_new_staff:=old.role is distinct from 'staff' and new.role='staff'; title_changed:=old.position is distinct from new.position; end if;
  if new.role='staff' and title_changed and coalesce(new.position,'') not in ('Secretary','Court Attendant') then
    raise exception 'Staff position must be Secretary or Court Attendant' using errcode='22023';
  end if;
  if new.role='staff' and new.onboarding_complete is true
    and (is_new_staff or (tg_op='UPDATE' and old.birthdate is distinct from new.birthdate and new.birthdate is null)) then
    raise exception 'A staff birthdate is required' using errcode='22023';
  end if;
  if new.role='staff' and new.birthdate is not null
    and (new.birthdate>(current_timestamp at time zone 'Asia/Manila')::date or new.birthdate<date '1900-01-01') then
    raise exception 'Staff birthdate is invalid' using errcode='22023';
  end if;
  if new.role='staff' and new.onboarding_complete is true and tg_op='UPDATE'
    and old.onboarding_complete is false and (new.birthdate is null or nullif(btrim(new.full_name),'') is null) then
    raise exception 'Name and birthdate are required to complete staff onboarding' using errcode='22023';
  end if;
  return new;
end;
$$;
revoke all on function internal.validate_staff_profile_details() from public, anon, authenticated;
drop trigger if exists profiles_validate_staff_details on public.profiles;
create trigger profiles_validate_staff_details before insert or update of role, position, birthdate, status, onboarding_complete, full_name on public.profiles
  for each row execute function internal.validate_staff_profile_details();

notify pgrst, 'reload schema';
