-- A brokered owner linked-email login creates an OTP Auth session. That
-- session is not a primary authentication method by itself; admit it only
-- after the exact same session has completed the linked-email OTP challenge.
create or replace function public.email_mfa_has_primary_auth(p_user_id uuid, p_session_id uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, internal
as $$
  select internal.email_mfa_live_session(p_user_id, p_session_id)
    or internal.owner_email_session_is_verified(p_user_id, p_session_id)
$$;

revoke all on function public.email_mfa_has_primary_auth(uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_mfa_has_primary_auth(uuid, uuid) to service_role;

comment on function public.email_mfa_has_primary_auth(uuid, uuid) is
  'Service-only check for an accepted primary Auth session or an exact live owner linked-email session with verified alias OTP.';

notify pgrst, 'reload schema';
