-- Keep the public customer profile email aligned with the address Auth has
-- accepted. Browser clients cannot write auth.users; this trigger runs only
-- after Supabase Auth changes auth.users.email following confirmation.
create or replace function internal.sync_profile_email_after_auth_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is distinct from old.email then
    update public.profiles
       set email = new.email
     where id = new.id
       and email is distinct from new.email;
  end if;
  return new;
end;
$$;

revoke all on function internal.sync_profile_email_after_auth_change() from public, anon, authenticated;

drop trigger if exists trg_sync_profile_email_after_auth_change on auth.users;
create trigger trg_sync_profile_email_after_auth_change
after update of email on auth.users
for each row
when (new.email is distinct from old.email)
execute function internal.sync_profile_email_after_auth_change();

-- A profile email is valid only when it exactly matches that same user's
-- canonical Auth email. This permits the trusted trigger above but prevents
-- a browser update from forging a pending/unverified address.
create or replace function internal.guard_profile_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id or new.created_at is distinct from old.created_at then
    if (select auth.role()) is distinct from 'service_role' then
      raise exception 'Account identity fields cannot be changed directly' using errcode='42501';
    end if;
  end if;

  if new.email is distinct from old.email and not exists (
    select 1 from auth.users u where u.id = new.id and u.email is not distinct from new.email
  ) then
    raise exception 'Profile email must match the confirmed Auth email' using errcode='42501';
  end if;

  if new.role is distinct from old.role and (select auth.role()) is distinct from 'service_role' then
    raise exception 'Account role cannot be changed directly' using errcode='42501';
  end if;
  if new.position is distinct from old.position and (select auth.role()) is distinct from 'service_role'
    and not internal.is_active_owner((select auth.uid())) then
    raise exception 'Only an active owner can change staff position' using errcode='42501';
  end if;
  if new.status is distinct from old.status and (select auth.role()) is distinct from 'service_role'
    and not internal.is_active_owner((select auth.uid())) then
    raise exception 'Only an active owner can change account status' using errcode='42501';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_profile_status_change() from public,anon,authenticated;
