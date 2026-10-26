-- OAuth sessions and confirmed email/signup sessions already
-- establish the account's email proof. Keep the proof bound to the exact live
-- Auth session, canonical Auth email, and an eligible profile. Password,
-- passwordless OTP, recovery, and invite sessions still use
-- the existing custom email-MFA challenge path.

create or replace function internal.email_mfa_session_has_native_proof(
  p_user_id uuid,
  p_session_id uuid
) returns boolean
language sql stable security definer
set search_path = pg_catalog, auth, internal, public
as $$
  select exists (
    select 1
    from auth.sessions s
    join auth.mfa_amr_claims m on m.session_id = s.id
    join auth.users u on u.id = s.user_id
    join public.profiles p on p.id = s.user_id
    where s.id = p_session_id
      and s.user_id = p_user_id
      and (s.not_after is null or s.not_after > now())
      and u.email_confirmed_at is not null
      and u.email is not null
      and p.email is not null
      and lower(u.email) = lower(p.email)
      and (p.status = 'active' and p.role in ('customer', 'staff', 'admin')
        or p.role = 'staff' and p.status = 'pending' and p.onboarding_complete is false)
      and (
        m.authentication_method = 'oauth'
        or (m.authentication_method = 'email/signup' and u.confirmation_sent_at is not null)
      )
  );
$$;

revoke all on function internal.email_mfa_session_has_native_proof(uuid, uuid)
  from public, anon, authenticated;
grant execute on function internal.email_mfa_session_has_native_proof(uuid, uuid)
  to service_role;

-- Preserve the existing session-bound custom MFA proof and pending-staff
-- onboarding rule, while accepting only the narrowly defined native proof.
create or replace function internal.has_verified_email_session()
returns boolean language sql stable security definer
set search_path = pg_catalog, auth, internal
as $$
  select case
    when auth.uid() is null then false
    when coalesce(auth.jwt()->>'session_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then false
    else internal.email_mfa_session_has_native_proof(auth.uid(), (auth.jwt()->>'session_id')::uuid)
      or exists (
        select 1 from internal.email_mfa_verified_sessions v
        where v.user_id = auth.uid()
          and v.session_id = (auth.jwt()->>'session_id')::uuid
          and v.last_activity_at > now() - interval '7 days'
          and exists (select 1 from public.profiles p where p.id = v.user_id
            and (p.status = 'active' and p.role in ('customer','staff','admin')
              or p.role = 'staff' and p.status = 'pending' and p.onboarding_complete is false))
          and internal.email_mfa_live_session(v.user_id, v.session_id)
      )
  end;
$$;

-- Edge checks and dashboard guards share the same server-derived proof rule.
create or replace function public.email_mfa_check_session(p_user_id uuid, p_session_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, internal, public
as $$
  select internal.email_mfa_session_has_native_proof(p_user_id, p_session_id)
    or exists (
      select 1 from internal.email_mfa_verified_sessions v
      where v.user_id = p_user_id and v.session_id = p_session_id
        and v.last_activity_at > now() - interval '7 days'
        and internal.email_mfa_live_session(v.user_id, v.session_id)
        and exists (select 1 from public.profiles p
          where p.id = v.user_id
            and (p.status = 'active' and p.role in ('customer', 'staff', 'admin')
              or p.role = 'staff' and p.status = 'pending' and p.onboarding_complete is false))
    )
$$;

-- Keep this RPC service-only, matching the existing deployment contract.
revoke all on function public.email_mfa_check_session(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.email_mfa_check_session(uuid, uuid)
  to service_role;

comment on function internal.email_mfa_session_has_native_proof(uuid, uuid) is
  'True only for an exact live Auth session with confirmed canonical email and active eligible profile, authenticated by OAuth or by email/signup after an email confirmation was sent.';
comment on function internal.has_verified_email_session() is
  'True for exact-session native email proof or server-recorded email MFA proof; this is not an AAL2 claim.';
comment on function public.email_mfa_check_session(uuid, uuid) is
  'Service-only check for exact-session native email proof or recent server-recorded email MFA proof.';

notify pgrst, 'reload config';
