-- Serialize pending staff cancellation with recovery and onboarding activation.
-- A cancellation claim reuses the existing private ten-minute recovery lease;
-- the activation trigger therefore blocks onboarding until Auth deletion ends.
create or replace function public.claim_pending_staff_cancellation(
  p_staff_id uuid,
  p_lock_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_onboarding_complete boolean;
begin
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role'
     or p_staff_id is null or p_lock_id is null then
    raise exception 'Invalid pending staff cancellation claim' using errcode = '42501';
  end if;

  -- Same row-lock order as recovery: a completed onboarding transition wins
  -- before a claim, or activation observes the live claim and is rejected.
  select p.status, p.onboarding_complete
    into v_status, v_onboarding_complete
  from public.profiles as p
  where p.id = p_staff_id and p.role = 'staff'
  for update;
  if not found or v_status <> 'pending' or v_onboarding_complete is distinct from false then
    return 'not_pending';
  end if;

  -- walk_in_booking.staff_id uses ON DELETE SET NULL. Preserve historical
  -- staff attribution by refusing cancellation whenever any row references
  -- this profile, including completed or cancelled walk-ins.
  if exists (
    select 1 from public.walk_in_booking as w where w.staff_id = p_staff_id
  ) then
    return 'walk_in_activity';
  end if;

  -- Require the existing credential record and an unclaimed/expired lease.
  -- This serializes against recovery and prevents deleting an account while
  -- recovery may be replacing its email/password or onboarding credential.
  update public.staff_onboarding_credentials as c
  set recovery_lock_id = p_lock_id,
      recovery_lock_until = pg_catalog.clock_timestamp() + interval '10 minutes'
  where c.user_id = p_staff_id
    and (c.recovery_lock_id is null or c.recovery_lock_until <= pg_catalog.clock_timestamp());
  if found then return 'claimed'; end if;
  return 'busy';
end;
$$;

revoke all on function public.claim_pending_staff_cancellation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_pending_staff_cancellation(uuid, uuid) to service_role;
comment on function public.claim_pending_staff_cancellation(uuid, uuid) is
  'Service-only claim for deleting a still-pending, incomplete staff account. Returns walk_in_activity if walk-in history references the profile, preserving staff attribution; otherwise shares the recovery lease to serialize cancellation with recovery and onboarding activation.';

-- The Edge preflight is for a clear owner-facing response. This trigger is the
-- final database guard against a walk-in being linked after that preflight:
-- profiles.id is otherwise ON DELETE SET NULL for walk_in_booking.staff_id.
create or replace function internal.block_pending_staff_delete_with_walkins()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role = 'staff'
     and old.status = 'pending'
     and old.onboarding_complete is false
     and exists (
       select 1 from public.walk_in_booking as w where w.staff_id = old.id
     ) then
    raise exception 'Pending staff account has walk-in records; preserve staff attribution before deletion.'
      using errcode = '23503';
  end if;
  return old;
end;
$$;
revoke all on function internal.block_pending_staff_delete_with_walkins() from public, anon, authenticated;

drop trigger if exists profiles_block_pending_staff_delete_with_walkins on public.profiles;
create trigger profiles_block_pending_staff_delete_with_walkins
  before delete on public.profiles
  for each row execute function internal.block_pending_staff_delete_with_walkins();

-- Disabled staff can be permanently removed only when doing so cannot delete
-- business history or detach its public attribution. This executes inside the
-- same transaction as Auth's ON DELETE CASCADE into profiles, so it also
-- rechecks role/status after waiting on any concurrent profile update.
-- Pending accounts remain eligible for the existing cancellation and invite
-- rollback paths; the preceding trigger continues to guard pending walk-ins.
create or replace function internal.guard_disabled_staff_auth_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role is distinct from 'staff' then
    return old;
  end if;

  -- Pending accounts are deleted by the existing cancellation and invite
  -- compensation flows. Active staff must first be deactivated, including
  -- when deletion races with a concurrent reactivation.
  if old.status = 'pending' and old.onboarding_complete is false then
    return old;
  end if;
  if old.status is distinct from 'disabled' then
    raise exception 'Only a disabled staff account can be permanently deleted.'
      using errcode = '23514';
  end if;

  -- Mirror the Edge preflight inside the Auth cascade transaction. In
  -- addition to rows that cascade, these checks block ON DELETE SET NULL from
  -- erasing customer, staff, creator, or audit actor attribution.
  if exists (select 1 from public.booking b where b.customer_id = old.id)
     or exists (select 1 from public.feedback f where f.profile_id = old.id)
     or exists (select 1 from public.customer_review r where r.customer_id = old.id)
     or exists (select 1 from public.walk_in_booking w where w.staff_id = old.id)
     or exists (select 1 from public.walk_in_booking w where w.customer_id = old.id)
     or exists (select 1 from public.audit_log a where a.actor_id = old.id)
     or exists (select 1 from public.court_unit_maintenance m where m.created_by = old.id)
     or exists (select 1 from public.booking_rule_sets br where br.created_by = old.id) then
    raise exception 'Staff account has linked business or audit history; preserve its records and attribution.'
      using errcode = '23503';
  end if;

  return old;
end;
$$;
revoke all on function internal.guard_disabled_staff_auth_delete() from public, anon, authenticated;

drop trigger if exists profiles_guard_disabled_staff_auth_delete on public.profiles;
create trigger profiles_guard_disabled_staff_auth_delete
  before delete on public.profiles
  for each row execute function internal.guard_disabled_staff_auth_delete();

-- customer_review references auth.users directly, so its Auth cascade can be
-- scheduled before the profiles cascade. Guard that child as well so a review
-- cannot disappear before guard_disabled_staff_auth_delete rechecks it.
create or replace function internal.guard_disabled_staff_review_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.profiles as p
    where p.id = old.customer_id and p.role = 'staff' and p.status = 'disabled'
  ) then
    raise exception 'Disabled staff account has customer review history; preserve the review before deletion.'
      using errcode = '23503';
  end if;
  return old;
end;
$$;
revoke all on function internal.guard_disabled_staff_review_delete() from public, anon, authenticated;

drop trigger if exists customer_review_guard_disabled_staff_delete on public.customer_review;
create trigger customer_review_guard_disabled_staff_delete
  before delete on public.customer_review
  for each row execute function internal.guard_disabled_staff_review_delete();

notify pgrst, 'reload schema';
