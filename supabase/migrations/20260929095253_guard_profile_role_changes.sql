-- Carry the role-change guard in versioned schema, independent of legacy
-- triggers that may be present only in an existing project database.
create or replace function internal.guard_profile_status_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.id is distinct from old.id or new.created_at is distinct from old.created_at
      or new.email is distinct from old.email)
    and (select auth.role()) is distinct from 'service_role' then
    raise exception 'Account identity fields cannot be changed directly' using errcode='42501';
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
