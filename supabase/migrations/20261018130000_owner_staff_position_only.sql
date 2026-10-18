-- Owners may update a staff member's position or account status. Other profile
-- columns remain under the staff member's control, including legacy fields.
create or replace function internal.prevent_owner_staff_personal_edits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role = 'staff'
    and coalesce((select auth.jwt()->>'role'), '') is distinct from 'service_role'
    and internal.is_active_owner((select auth.uid()))
    and (to_jsonb(new) - array['position', 'status', 'updated_at'])
      is distinct from (to_jsonb(old) - array['position', 'status', 'updated_at']) then
    raise exception 'Owners may only change staff position or status' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function internal.prevent_owner_staff_personal_edits() from public, anon, authenticated;

drop trigger if exists profiles_prevent_owner_staff_personal_edits on public.profiles;
create trigger profiles_prevent_owner_staff_personal_edits
  before update on public.profiles
  for each row execute function internal.prevent_owner_staff_personal_edits();
