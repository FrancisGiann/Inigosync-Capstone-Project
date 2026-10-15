-- A newly created staff member must complete email MFA before first-time
-- setup. Allow only that specific pending state through the existing session
-- proof checks; disabled, incomplete customer/admin, and other pending
-- accounts continue to fail closed.
create or replace function internal.has_verified_email_session()
returns boolean language sql stable security definer
set search_path = pg_catalog, auth, internal
as $$
  select case
    when auth.uid() is null then false
    when coalesce(auth.jwt()->>'session_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then false
    else exists (
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

-- Edge Functions use this service-only check; retain the active-account gate
-- and admit only pending staff that still need first-time setup.
create or replace function public.email_mfa_check_session(p_user_id uuid, p_session_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, internal, public
as $$
  select exists (select 1 from internal.email_mfa_verified_sessions v
    where v.user_id = p_user_id and v.session_id = p_session_id
      and v.last_activity_at > now() - interval '7 days'
      and internal.email_mfa_live_session(v.user_id, v.session_id)
      and exists (select 1 from public.profiles p
        where p.id = v.user_id
          and (p.status = 'active' and p.role in ('customer', 'staff', 'admin')
            or p.role = 'staff' and p.status = 'pending' and p.onboarding_complete is false)))
$$;

notify pgrst, 'reload config';
