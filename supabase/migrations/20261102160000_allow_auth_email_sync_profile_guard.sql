-- Keep profile identity fields protected while allowing the trusted
-- auth.users email-sync trigger to copy its canonical value into profiles.
-- The trigger nesting check distinguishes that internal sync from a direct
-- profile update; the value must still match the same user's Auth email.
create or replace function internal.guard_profile_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.id is distinct from old.id or new.created_at is distinct from old.created_at)
    and coalesce((select auth.jwt()->>'role'), '') is distinct from 'service_role' then
    raise exception 'Account identity fields cannot be changed directly' using errcode='42501';
  end if;

  if new.email is distinct from old.email and (
    pg_catalog.pg_trigger_depth() < 2
    or not exists (
      select 1 from auth.users as auth_user
      where auth_user.id = new.id
        and auth_user.email is not distinct from new.email
    )
  ) then
    raise exception 'Account identity fields cannot be changed directly' using errcode='42501';
  end if;

  if new.role is distinct from old.role and coalesce((select auth.jwt()->>'role'), '') is distinct from 'service_role' then
    raise exception 'Account role cannot be changed directly' using errcode='42501';
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
