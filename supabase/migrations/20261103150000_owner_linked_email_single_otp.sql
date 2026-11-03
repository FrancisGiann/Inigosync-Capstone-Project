-- Use the initial linked-email proof for enrollment. Later password setup uses
-- the exact active owner session and its existing email-MFA proof without an OTP.
create or replace function public.owner_email_begin_password_challenge(
 p_user_id uuid,p_session_id uuid,p_alias_id uuid,p_challenge_id uuid,p_code_hash bytea,p_expires_at timestamptz
)
returns boolean language plpgsql security definer set search_path=pg_catalog,auth,internal,public as $$
declare e text;
begin
 if (p_code_hash is not null and octet_length(p_code_hash)<>32) or p_expires_at is null or p_expires_at<=now() or p_expires_at>now()+interval '6 minutes'
  or not internal.owner_email_auth_session_is_live(p_user_id,p_session_id) or not public.email_mfa_check_session(p_user_id,p_session_id)
  or not exists(select 1 from public.profiles p where p.id=p_user_id and p.role='admin' and p.status='active') then return false; end if;
 select email into e from internal.owner_email_aliases where alias_id=p_alias_id and user_id=p_user_id and email_verified_at is not null;
 if e is null then return false; end if;
 if p_code_hash is not null and not internal.owner_email_record_code_attempt(p_user_id,p_alias_id,'alias_verify') then return false; end if;
 insert into internal.owner_email_enrollment_challenges(user_id,session_id,alias_id,email,challenge_id,alias_code_hash,alias_attempts,alias_verified_at,owner_code_hash,owner_attempts,owner_verified_at,expires_at,created_at)
 values(p_user_id,p_session_id,p_alias_id,e,p_challenge_id,p_code_hash,0,case when p_code_hash is null then now() else null end,null,0,null,p_expires_at,now())
 on conflict(user_id,session_id,alias_id) do update set email=excluded.email,challenge_id=excluded.challenge_id,
  alias_code_hash=excluded.alias_code_hash,alias_attempts=0,alias_verified_at=excluded.alias_verified_at,owner_code_hash=null,owner_attempts=0,
  owner_verified_at=null,expires_at=excluded.expires_at,created_at=now();
 return true;
end $$;

-- Retire the former canonical-owner OTP verifier. Old challenge rows cannot
-- authorize the new password-save path because they retain owner_code_hash.
create or replace function public.owner_email_verify_owner_code(p_user_id uuid,p_session_id uuid,p_alias_id uuid,p_challenge_id uuid,p_code_hash bytea)
returns boolean language sql security definer set search_path=pg_catalog as $$ select false $$;

create or replace function public.owner_email_save_password(p_user_id uuid,p_session_id uuid,p_alias_id uuid,p_challenge_id uuid,p_salt bytea,p_hash bytea,p_iterations integer)
returns boolean language plpgsql security definer set search_path=pg_catalog,auth,internal,public as $$
declare c internal.owner_email_enrollment_challenges%rowtype;
begin
 if p_salt is null or octet_length(p_salt)<>16 or p_hash is null or octet_length(p_hash)<>32 or p_iterations is null or p_iterations not between 600000 and 1000000 then return false; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||p_session_id::text||p_alias_id::text,0));
 select * into c from internal.owner_email_enrollment_challenges where user_id=p_user_id and session_id=p_session_id and alias_id=p_alias_id
  and challenge_id=p_challenge_id and expires_at>now() and alias_verified_at>now()-interval '5 minutes'
  and owner_code_hash is null and owner_verified_at is null for update;
 if not found or not internal.owner_email_auth_session_is_live(p_user_id,p_session_id) or not public.email_mfa_check_session(p_user_id,p_session_id)
  or not exists(select 1 from public.profiles p where p.id=p_user_id and p.role='admin' and p.status='active')
  or not exists(select 1 from internal.owner_email_aliases a where a.alias_id=p_alias_id and a.user_id=p_user_id and lower(a.email)=lower(c.email) and a.email_verified_at is not null) then return false; end if;
 update internal.owner_email_aliases set password_salt=p_salt,password_hash=p_hash,password_iterations=p_iterations,credential_version=credential_version+1,updated_at=now()
  where alias_id=p_alias_id and user_id=p_user_id;
 delete from internal.owner_email_sessions where user_id=p_user_id and alias_id=p_alias_id;
 delete from internal.owner_email_login_tickets where user_id=p_user_id and alias_id=p_alias_id;
 delete from internal.owner_email_enrollment_challenges where user_id=p_user_id and session_id=p_session_id and alias_id=p_alias_id;
 return true;
end $$;

revoke all on function public.owner_email_begin_password_challenge(uuid,uuid,uuid,uuid,bytea,timestamptz),public.owner_email_verify_owner_code(uuid,uuid,uuid,uuid,bytea),public.owner_email_save_password(uuid,uuid,uuid,uuid,bytea,bytea,integer) from public,anon,authenticated;
grant execute on function public.owner_email_begin_password_challenge(uuid,uuid,uuid,uuid,bytea,timestamptz),public.owner_email_verify_owner_code(uuid,uuid,uuid,uuid,bytea),public.owner_email_save_password(uuid,uuid,uuid,uuid,bytea,bytea,integer) to service_role;

comment on function public.owner_email_begin_password_challenge(uuid,uuid,uuid,uuid,bytea,timestamptz) is 'Creates a short-lived password-setup challenge for an already verified email alias. Enrollment passes its single verified alias challenge; later setup uses only the exact active owner session and email-MFA proof.';
