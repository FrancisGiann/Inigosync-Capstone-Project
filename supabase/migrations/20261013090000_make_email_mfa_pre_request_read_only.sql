-- PostgREST can execute STABLE RPCs (including the schedule and booking-rule
-- readers) in a read-only transaction. The pre-request hook must therefore
-- enforce email proof without writing to the verified-session table.
--
-- Verified-session inactivity is still refreshed by the authenticated
-- email-mfa Edge Function's explicit `check` action, which calls the
-- service-role-only email_mfa_touch_session RPC after real user activity.
create or replace function internal.enforce_email_mfa_pre_request()
returns void language plpgsql stable security definer
set search_path = pg_catalog, auth, internal
as $$
declare
  v_role text := coalesce(auth.jwt()->>'role', '');
  v_path text := ltrim(coalesce(current_setting('request.path', true), ''), '/');
  v_method text := upper(coalesce(current_setting('request.method', true), 'GET'));
begin
  if v_role is distinct from 'authenticated' then return; end if;
  if internal.has_verified_email_session() then return; end if;

  if v_method in ('GET','HEAD') and v_path in (
    'profiles', 'app_settings', 'assets', 'court', 'court_unit_inventory',
    'court_unit_resource_map', 'event', 'physical_court_resource',
    'public_booking_reviews', 'sport', 'testimonial'
  ) then return; end if;
  if v_path in (
    'rpc/signup_email_availability', 'rpc/signup_phone_availability',
    'rpc/court_occupancy', 'rpc/booking_rules_for_date'
  ) then return; end if;
  raise sqlstate '42501' using message = 'Email verification required for this session.';
end;
$$;

revoke all on function internal.enforce_email_mfa_pre_request() from public, anon, authenticated;
grant execute on function internal.enforce_email_mfa_pre_request()
  to anon, authenticated, service_role, authenticator;
alter role authenticator set pgrst.db_pre_request = 'internal.enforce_email_mfa_pre_request';
notify pgrst, 'reload config';
