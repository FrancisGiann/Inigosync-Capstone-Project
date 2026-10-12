-- Edge Functions use this service-only check; disable proof immediately when
-- an account is suspended or its profile no longer has an application role.
create or replace function public.email_mfa_check_session(p_user_id uuid, p_session_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, internal, public
as $$
  select exists (select 1 from internal.email_mfa_verified_sessions v
    where v.user_id = p_user_id and v.session_id = p_session_id
      and v.last_activity_at > now() - interval '7 days'
      and internal.email_mfa_live_session(v.user_id, v.session_id)
      and exists (select 1 from public.profiles p
        where p.id = v.user_id and p.status = 'active'
          and p.role in ('customer', 'staff', 'admin')))
$$;
