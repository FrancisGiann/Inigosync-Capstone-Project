-- Email proof is a second step only when it is bound to a session that first
-- authenticated with an accepted primary method. Supabase OTP/magic-link and
-- recovery sessions are Auth sessions too, so session liveness alone is not
-- sufficient. Keep this check tied to the exact Auth session across refreshes.
create or replace function internal.email_mfa_live_session(p_user_id uuid, p_session_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, auth
as $$
  select exists (
    select 1
    from auth.sessions s
    join auth.mfa_amr_claims m on m.session_id = s.id
    where s.id = p_session_id
      and s.user_id = p_user_id
      and (s.not_after is null or s.not_after > now())
      and m.authentication_method in ('password', 'oauth', 'sso/saml', 'email/signup')
  );
$$;

revoke all on function internal.email_mfa_live_session(uuid, uuid) from public, anon, authenticated;
grant execute on function internal.email_mfa_live_session(uuid, uuid) to service_role, authenticated;

-- This service-only RPC lets the Edge MFA endpoint reject passwordless Auth
-- sessions before it sends or verifies the separate email challenge.
create or replace function public.email_mfa_has_primary_auth(p_user_id uuid, p_session_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, internal
as $$
  select internal.email_mfa_live_session(p_user_id, p_session_id)
$$;

revoke all on function public.email_mfa_has_primary_auth(uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_mfa_has_primary_auth(uuid, uuid) to service_role;

comment on function internal.email_mfa_live_session(uuid, uuid) is
  'True only for a live exact Auth session with a password, OAuth, SAML SSO, or confirmed email/signup AMR. OTP, magiclink, invite, and recovery-only sessions fail closed.';
comment on function public.email_mfa_has_primary_auth(uuid, uuid) is
  'Service-only primary authentication check used before custom email MFA begins or verifies.';

notify pgrst, 'reload schema';
