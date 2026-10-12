-- The currently deployed staff invite flow completes password setup within
-- an Auth `invite` session. Keep that flow usable during staging only; once
-- email MFA is activated, invite-only sessions must sign in again with the
-- newly-set password and are rejected by this predicate.
create or replace function internal.email_mfa_live_session(p_user_id uuid, p_session_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, auth, internal
as $$
  select exists (
    select 1
    from auth.sessions s
    join auth.mfa_amr_claims m on m.session_id = s.id
    where s.id = p_session_id
      and s.user_id = p_user_id
      and (s.not_after is null or s.not_after > now())
      and (
        m.authentication_method in ('password', 'oauth', 'sso/saml', 'email/signup')
        or (
          m.authentication_method = 'invite'
          and exists (
            select 1 from internal.email_mfa_enforcement e
            where e.singleton and e.enabled is false
          )
        )
      )
  );
$$;

revoke all on function internal.email_mfa_live_session(uuid, uuid) from public, anon, authenticated;
grant execute on function internal.email_mfa_live_session(uuid, uuid) to service_role, authenticated;

comment on function internal.email_mfa_live_session(uuid, uuid) is
  'True for live exact sessions with password, OAuth, SAML SSO, or confirmed email/signup AMR. Invite AMR qualifies only while the staged enforcement singleton explicitly says false; all other methods fail closed.';
