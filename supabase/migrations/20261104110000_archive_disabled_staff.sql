-- Archive disabled staff in place so Auth identities, transaction links, and
-- audit attribution remain attached to the original profile.
alter table public.profiles
  add column if not exists archived_at timestamptz null;

alter table public.profiles
  drop constraint if exists profiles_archived_staff_must_be_disabled;
alter table public.profiles
  add constraint profiles_archived_staff_must_be_disabled
  check (archived_at is null or (role = 'staff' and status = 'disabled'));

create or replace function internal.guard_staff_archive_marker()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.archived_at is distinct from old.archived_at
     and coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then
    raise exception 'Staff archive state can only be changed by the authorized staff-management service.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_staff_archive_marker() from public, anon, authenticated;

drop trigger if exists profiles_guard_staff_archive_marker on public.profiles;
create trigger profiles_guard_staff_archive_marker
  before update of archived_at on public.profiles
  for each row execute function internal.guard_staff_archive_marker();

comment on column public.profiles.archived_at is
  'Nullable staff visibility archive marker. Archived accounts remain disabled; only the verified-owner staff-management Edge Function may change this marker.';

notify pgrst, 'reload schema';
