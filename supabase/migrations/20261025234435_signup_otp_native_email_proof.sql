-- Confirming a new email signup with verifyOtp({ type: 'signup' }) creates
-- an Auth session whose AMR is `otp` (observed in production), not
-- `email/signup`. Accept that OTP only when the same session was created
-- alongside the user's first email confirmation on an email-only Auth
-- account. An older confirmed email or a phone OTP cannot satisfy it.

create or replace function internal.email_mfa_live_session(
  p_user_id uuid,
  p_session_id uuid
) returns boolean
language sql stable security definer
set search_path = pg_catalog, auth, internal
as $$
  select exists (
    select 1
    from auth.sessions s
    join auth.mfa_amr_claims m on m.session_id = s.id
    join auth.users u on u.id = s.user_id
    where s.id = p_session_id
      and s.user_id = p_user_id
      and (s.not_after is null or s.not_after > now())
      and (
        m.authentication_method in ('password', 'oauth', 'sso/saml', 'email/signup')
        or (
          m.authentication_method = 'otp'
          and u.email_confirmed_at is not null
          and u.confirmation_sent_at is not null
          and u.phone is null
          and u.phone_confirmed_at is null
          and not exists (
            select 1 from auth.identities i
            where i.user_id = u.id and i.provider = 'phone'
          )
          and u.confirmation_sent_at <= u.email_confirmed_at
          and u.email_confirmed_at between s.created_at - interval '30 seconds'
            and s.created_at + interval '30 seconds'
        )
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
        or (
          m.authentication_method = 'otp'
          and u.confirmation_sent_at is not null
          and u.phone is null
          and u.phone_confirmed_at is null
          and not exists (
            select 1 from auth.identities i
            where i.user_id = u.id and i.provider = 'phone'
          )
          and u.confirmation_sent_at <= u.email_confirmed_at
          and u.email_confirmed_at between s.created_at - interval '30 seconds'
            and s.created_at + interval '30 seconds'
        )
      )
  );
$$;

comment on function internal.email_mfa_live_session(uuid, uuid) is
  'True for a live primary Auth session, including an email-only signup OTP session created alongside first email confirmation; phone and later OTP sessions are excluded.';
comment on function internal.email_mfa_session_has_native_proof(uuid, uuid) is
  'True for an exact live OAuth, confirmed email/signup, or email-only signup OTP session with confirmed canonical email and eligible profile; phone and later OTP sessions are excluded.';

notify pgrst, 'reload config';
