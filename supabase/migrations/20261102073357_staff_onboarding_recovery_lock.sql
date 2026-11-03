-- Serialize owner email/password recovery with pending staff activation.
-- Existing credential records receive NULL lock fields and remain valid.
alter table public.staff_onboarding_credentials
  add column if not exists recovery_lock_id uuid,
  add column if not exists recovery_lock_until timestamptz;

do $migration$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.staff_onboarding_credentials'::regclass
      and conname = 'staff_onboarding_credentials_recovery_lock_pair_check'
  ) then
    alter table public.staff_onboarding_credentials
      add constraint staff_onboarding_credentials_recovery_lock_pair_check
      check ((recovery_lock_id is null) = (recovery_lock_until is null));
  end if;
end;
$migration$;

create or replace function public.claim_pending_staff_recovery(
  p_staff_id uuid,
  p_lock_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if p_staff_id is null or p_lock_id is null then return false; end if;

  -- This row lock serializes the claim with the pending-to-active UPDATE.
  select p.status into v_status
  from public.profiles as p
  where p.id = p_staff_id and p.role = 'staff' and p.onboarding_complete is false
  for update;
  if not found or v_status <> 'pending' then return false; end if;

  update public.staff_onboarding_credentials as c
  set recovery_lock_id = p_lock_id,
      recovery_lock_until = pg_catalog.clock_timestamp() + interval '10 minutes'
  where c.user_id = p_staff_id
    and (c.recovery_lock_id is null or c.recovery_lock_until <= pg_catalog.clock_timestamp());
  return found;
end;
$$;

revoke all on function public.claim_pending_staff_recovery(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_pending_staff_recovery(uuid, uuid) to service_role;
comment on function public.claim_pending_staff_recovery(uuid, uuid) is
  'Service-only, ten-minute lease that atomically claims a still-pending staff profile before Auth email/password recovery.';

create or replace function internal.prevent_staff_activation_during_recovery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role = 'staff'
     and new.status = 'active'
     and new.onboarding_complete is true
     and (old.status is distinct from 'active' or old.onboarding_complete is distinct from true)
     and exists (
       select 1 from public.staff_onboarding_credentials as c
       where c.user_id = new.id
         and c.recovery_lock_id is not null
         and c.recovery_lock_until > pg_catalog.clock_timestamp()
     ) then
    raise exception 'Staff email recovery is in progress; onboarding cannot be activated yet.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function internal.prevent_staff_activation_during_recovery() from public, anon, authenticated;

drop trigger if exists profiles_prevent_staff_activation_during_recovery on public.profiles;
create trigger profiles_prevent_staff_activation_during_recovery
  before update of status, onboarding_complete on public.profiles
  for each row execute function internal.prevent_staff_activation_during_recovery();
