-- Availability is exposed only through the authenticated owner-linked-auth
-- Edge Function; the check is advisory and begin-alias-verification remains
-- the authoritative, serialized uniqueness check.
create or replace function public.owner_email_check_availability(
 p_user_id uuid,p_session_id uuid,p_email text
)
returns boolean language plpgsql security definer set search_path=pg_catalog,auth,internal,public as $$
declare e text:=lower(trim(p_email));
begin
 if p_email is null or length(e)>254 or e !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  or not internal.owner_email_auth_session_is_live(p_user_id,p_session_id)
  or not public.email_mfa_check_session(p_user_id,p_session_id)
  or not exists(select 1 from public.profiles p where p.id=p_user_id and p.role='admin' and p.status='active') then
  return false;
 end if;
 return not exists(select 1 from auth.users u where lower(u.email)=e)
  and not exists(select 1 from internal.owner_email_aliases a where lower(a.email)=e);
end $$;

revoke all on function public.owner_email_check_availability(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.owner_email_check_availability(uuid,uuid,text) to service_role;

comment on function public.owner_email_check_availability(uuid,uuid,text) is
 'Checks canonical and secondary email availability for an active owner with an exact live Auth session and email-MFA proof; service role only.';
