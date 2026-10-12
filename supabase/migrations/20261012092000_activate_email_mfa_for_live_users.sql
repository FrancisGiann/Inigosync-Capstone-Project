-- Apply only after the email-mfa function and updated login pages are live and verified.
-- The earlier migration prepares private tables and RPCs; the defer migration leaves
-- enforcement off for the live rollout. This migration activates the gate.

-- Edge functions are deployed before this migration. Enable their session proof
-- requirement in the same transaction as the PostgREST hook and restrictive RLS.
do $$
begin
  update internal.email_mfa_enforcement set enabled = true, updated_at = now()
    where singleton;
  if not found then
    raise exception 'email MFA enforcement flag was not staged';
  end if;
end $$;

-- PostgREST runs the pre-request hook after switching to anon/authenticated.
-- Keep these grants here so activation is safe even when the original
-- preparatory migration was applied before its grant correction.
grant usage on schema internal to anon, authenticated, service_role, authenticator;
grant execute on function internal.has_verified_email_session() to authenticated, service_role;

-- RLS independently protects private rows, and prevents an unverified staff
-- token from using the own-profile bootstrap exception to enumerate profiles.
drop policy if exists profiles_email_mfa_select on public.profiles;
create policy profiles_email_mfa_select on public.profiles as restrictive for select to authenticated
  using (
    case
      when coalesce(auth.jwt()->>'session_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then id = auth.uid() and internal.email_mfa_live_session(auth.uid(), (auth.jwt()->>'session_id')::uuid)
      else false
    end
    or internal.has_verified_email_session()
  );
drop policy if exists profiles_email_mfa_update on public.profiles;
create policy profiles_email_mfa_update on public.profiles as restrictive for update to authenticated
  using (internal.has_verified_email_session()) with check (internal.has_verified_email_session());

do $$
declare t text;
begin
  foreach t in array array[
    'active_session','audit_log','booking','booking_review','customer_private_details',
    'feedback','owner_activity','payment','walk_in_booking'
  ] loop
    execute format('drop policy if exists email_mfa_required on public.%I', t);
    execute format('create policy email_mfa_required on public.%I as restrictive for all to authenticated using (internal.has_verified_email_session()) with check (internal.has_verified_email_session())', t);
  end loop;
  foreach t in array array['assets','court','court_unit_inventory','court_unit_maintenance',
    'court_unit_resource_map','event','physical_court_resource','public_booking_reviews',
    'sport','testimonial','app_settings'] loop
    execute format('drop policy if exists email_mfa_required_write on public.%I', t);
    execute format('drop policy if exists email_mfa_required_insert on public.%I', t);
    execute format('drop policy if exists email_mfa_required_update on public.%I', t);
    execute format('drop policy if exists email_mfa_required_delete on public.%I', t);
    execute format('create policy email_mfa_required_insert on public.%I as restrictive for insert to authenticated with check (internal.has_verified_email_session())', t);
    execute format('create policy email_mfa_required_update on public.%I as restrictive for update to authenticated using (internal.has_verified_email_session()) with check (internal.has_verified_email_session())', t);
    execute format('create policy email_mfa_required_delete on public.%I as restrictive for delete to authenticated using (internal.has_verified_email_session())', t);
  end loop;
end $$;

-- Storage does not run db_pre_request. Preserve existing read policies while
-- requiring proof for any authenticated object creation, change, or deletion.
drop policy if exists email_mfa_required_storage_write on storage.objects;
drop policy if exists email_mfa_required_storage_insert on storage.objects;
drop policy if exists email_mfa_required_storage_update on storage.objects;
drop policy if exists email_mfa_required_storage_delete on storage.objects;
create policy email_mfa_required_storage_insert on storage.objects as restrictive
  for insert to authenticated with check (internal.has_verified_email_session());
create policy email_mfa_required_storage_update on storage.objects as restrictive
  for update to authenticated using (internal.has_verified_email_session()) with check (internal.has_verified_email_session());
create policy email_mfa_required_storage_delete on storage.objects as restrictive
  for delete to authenticated using (internal.has_verified_email_session());

-- Apply a narrow PostgREST allowlist for unauthenticated-by-email sessions.
-- Public catalog reads and own-profile bootstrap remain available; all RPCs,
-- private table/view reads, and writes require the matching session proof.
create or replace function internal.enforce_email_mfa_pre_request()
returns void language plpgsql security definer
set search_path = pg_catalog, auth, internal
as $$
declare v_role text := coalesce(auth.jwt()->>'role', ''); v_path text := ltrim(coalesce(current_setting('request.path', true), ''), '/');
  v_method text := upper(coalesce(current_setting('request.method', true), 'GET'));
begin
  if v_role is distinct from 'authenticated' then return; end if;
  if internal.has_verified_email_session() then
    if v_method not in ('GET','HEAD') then
      update internal.email_mfa_verified_sessions set last_activity_at = now()
      where user_id = auth.uid() and session_id = (auth.jwt()->>'session_id')::uuid;
    end if;
    return;
  end if;
  if v_method in ('GET','HEAD') and v_path in (
    'profiles', 'app_settings', 'assets', 'court', 'court_unit_inventory',
    'court_unit_resource_map', 'event', 'physical_court_resource',
    'public_booking_reviews', 'sport', 'testimonial'
  ) then return; end if;
  if v_path = 'rpc/signup_email_availability' or v_path = 'rpc/court_occupancy'
     or v_path = 'rpc/booking_rules_for_date' then return; end if;
  raise sqlstate '42501' using message = 'Email verification required for this session.';
end;
$$;
revoke all on function internal.enforce_email_mfa_pre_request() from public, anon, authenticated;
grant execute on function internal.enforce_email_mfa_pre_request()
  to anon, authenticated, service_role, authenticator;
alter role authenticator set pgrst.db_pre_request = 'internal.enforce_email_mfa_pre_request';
notify pgrst, 'reload config';

comment on function internal.has_verified_email_session() is
  'True only when this JWT session_id has server-recorded email proof and remains live in auth.sessions. This is not an AAL2 claim.';
