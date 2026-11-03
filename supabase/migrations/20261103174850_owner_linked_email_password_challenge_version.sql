-- Bind every password set/change challenge to the credential version that was
-- trusted by the Edge Function, then serialize challenge creation and saves
-- per alias so concurrent sessions cannot overwrite a newer credential.
alter table internal.owner_email_enrollment_challenges
  add column credential_version integer,
  add column password_change boolean,
  add constraint owner_email_enrollment_password_version_check check (
    (credential_version is null and password_change is null)
    or (credential_version is not null and credential_version > 0 and password_change is not null)
  );

-- Keep a still-valid first-time setup proof for aliases without a password,
-- binding it to that alias's current credential version. Email verification
-- proofs have alias_code_hash still present and are intentionally untouched.
update internal.owner_email_enrollment_challenges c
set credential_version = a.credential_version,
    password_change = false
from internal.owner_email_aliases a
where a.alias_id = c.alias_id
  and a.password_hash is null
  and c.alias_code_hash is null
  and c.alias_verified_at > now() - interval '5 minutes'
  and c.owner_code_hash is null
  and c.owner_verified_at is null
  and c.expires_at > now();

-- These rows were created by the previous password-change flow. They were
-- not bound to the credential version checked by the Edge Function and must
-- not remain usable. This leaves original email-verification proofs and
-- passwordless first-time setup proofs intact.
delete from internal.owner_email_enrollment_challenges c
using internal.owner_email_aliases a
where a.alias_id = c.alias_id
  and a.password_hash is not null
  and c.alias_code_hash is null
  and c.alias_verified_at is not null
  and c.expires_at > now();

create or replace function public.owner_email_get_alias_credential(p_user_id uuid, p_alias_id uuid)
returns table(alias_id uuid, user_id uuid, email text, password_salt text, password_hash text,
  password_iterations integer, credential_version integer)
language sql security definer set search_path=pg_catalog,internal as $$
 select a.alias_id,a.user_id,a.email,
  case when a.password_salt is null then null else chr(92)||'x'||encode(a.password_salt,'hex') end,
  case when a.password_hash is null then null else chr(92)||'x'||encode(a.password_hash,'hex') end,
  a.password_iterations,a.credential_version
 from internal.owner_email_aliases a
 where a.user_id=p_user_id and a.alias_id=p_alias_id and a.email_verified_at is not null
$$;

revoke all on function public.owner_email_get_alias_credential(uuid,uuid) from public,anon,authenticated;
grant execute on function public.owner_email_get_alias_credential(uuid,uuid) to service_role;

-- Serialize a resend/start-over for one enrollment alias before it locks the
-- normalized email and before it replaces that alias's challenge row.
create or replace function public.owner_email_begin_alias_verification(
 p_user_id uuid,p_session_id uuid,p_alias_id uuid,p_email text,p_challenge_id uuid,p_code_hash bytea,p_expires_at timestamptz
)
returns boolean language plpgsql security definer set search_path=pg_catalog,auth,internal,public as $$
declare e text:=lower(trim(p_email));
begin
 if p_user_id is null or p_session_id is null or p_alias_id is null or p_challenge_id is null
  or p_email is null or length(e)>254 or e !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  or p_code_hash is null or octet_length(p_code_hash)<>32
  or p_expires_at is null or p_expires_at<=now() or p_expires_at>now()+interval '6 minutes'
  or not internal.owner_email_auth_session_is_live(p_user_id,p_session_id)
  or not public.email_mfa_check_session(p_user_id,p_session_id)
  or not exists(select 1 from public.profiles p where p.id=p_user_id and p.role='admin' and p.status='active') then return false; end if;

 perform pg_advisory_xact_lock(hashtextextended(p_alias_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended(e,0));
 if exists(select 1 from auth.users u where lower(u.email)=e)
  or exists(select 1 from internal.owner_email_aliases a where lower(a.email)=e) then return false; end if;
 if not internal.owner_email_record_code_attempt(p_user_id,p_alias_id,'alias_verify') then return false; end if;
 delete from internal.owner_email_enrollment_challenges
 where user_id=p_user_id and session_id=p_session_id and alias_id=p_alias_id;
 insert into internal.owner_email_enrollment_challenges(user_id,session_id,alias_id,email,challenge_id,alias_code_hash,expires_at)
 values(p_user_id,p_session_id,p_alias_id,e,p_challenge_id,p_code_hash,p_expires_at);
 return true;
end $$;

-- The verified new-email proof is also the first-time password setup proof.
-- Bind it to the new alias's initial version so the existing immediate-save
-- UI path remains valid without treating an unverified email challenge as a
-- password challenge.
create or replace function public.owner_email_verify_alias_code(
 p_user_id uuid,p_session_id uuid,p_alias_id uuid,p_challenge_id uuid,p_code_hash bytea
)
returns boolean language plpgsql security definer set search_path=pg_catalog,auth,internal,public as $$
declare c internal.owner_email_enrollment_challenges%rowtype; e text;
begin
 if p_user_id is null or p_session_id is null or p_alias_id is null or p_challenge_id is null
  or p_code_hash is null or octet_length(p_code_hash)<>32 then return false; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_alias_id::text,0));
 select ec.email into e from internal.owner_email_enrollment_challenges ec
 where user_id=p_user_id and session_id=p_session_id and alias_id=p_alias_id
  and challenge_id=p_challenge_id and expires_at>now() and alias_verified_at is null;
 if not found or e is null then return false; end if;
 perform pg_advisory_xact_lock(hashtextextended(lower(e),0));
 select * into c from internal.owner_email_enrollment_challenges
 where user_id=p_user_id and session_id=p_session_id and alias_id=p_alias_id
  and challenge_id=p_challenge_id and email=e and expires_at>now() and alias_verified_at is null
 for update;
 if not found or not internal.owner_email_auth_session_is_live(p_user_id,p_session_id)
  or not public.email_mfa_check_session(p_user_id,p_session_id)
  or not exists(select 1 from public.profiles p where p.id=p_user_id and p.role='admin' and p.status='active')
  or not internal.owner_email_record_code_attempt(p_user_id,p_alias_id,'alias_verify') then return false; end if;
 if c.alias_attempts>=5 or c.alias_code_hash is distinct from p_code_hash then
  update internal.owner_email_enrollment_challenges set alias_attempts=least(5,alias_attempts+1)
  where user_id=p_user_id and session_id=p_session_id and alias_id=p_alias_id;
  return false;
 end if;
 if exists(select 1 from auth.users u where lower(u.email)=lower(c.email)) then return false; end if;
 insert into internal.owner_email_aliases(alias_id,user_id,email,email_verified_at)
 values(p_alias_id,p_user_id,c.email,now());
 update internal.owner_email_enrollment_challenges set alias_verified_at=now(),alias_code_hash=null,
  credential_version=(select a.credential_version from internal.owner_email_aliases a
   where a.alias_id=p_alias_id and a.user_id=p_user_id),password_change=false
 where user_id=p_user_id and session_id=p_session_id and alias_id=p_alias_id and challenge_id=p_challenge_id;
 return true;
exception when unique_violation then return false;
end $$;

-- Retire the old RPC signature so it cannot create an unversioned challenge.
drop function public.owner_email_begin_password_challenge(uuid,uuid,uuid,uuid,bytea,timestamptz);
drop function public.owner_email_save_password(uuid,uuid,uuid,uuid,bytea,bytea,integer);

create function public.owner_email_begin_password_challenge(
 p_user_id uuid,p_session_id uuid,p_alias_id uuid,p_challenge_id uuid,p_code_hash bytea,
 p_expires_at timestamptz,p_credential_version integer,p_password_change boolean
)
returns boolean language plpgsql security definer set search_path=pg_catalog,auth,internal,public as $$
declare e text; actual_version integer; has_password boolean;
begin
 if p_credential_version is null or p_credential_version <= 0
  or p_password_change is null
  or (p_code_hash is not null and octet_length(p_code_hash)<>32)
  or p_expires_at is null or p_expires_at<=now() or p_expires_at>now()+interval '6 minutes'
  or not internal.owner_email_auth_session_is_live(p_user_id,p_session_id)
  or not public.email_mfa_check_session(p_user_id,p_session_id)
  or not exists(select 1 from public.profiles p where p.id=p_user_id and p.role='admin' and p.status='active') then return false; end if;

 perform pg_advisory_xact_lock(hashtextextended(p_alias_id::text,0));
 select a.email,a.credential_version,(a.password_hash is not null)
 into e,actual_version,has_password
 from internal.owner_email_aliases a
 where a.alias_id=p_alias_id and a.user_id=p_user_id and a.email_verified_at is not null
 for update;
 if not found or actual_version<>p_credential_version or has_password<>p_password_change then return false; end if;
 if p_code_hash is not null and not internal.owner_email_record_code_attempt(p_user_id,p_alias_id,'alias_verify') then return false; end if;

 insert into internal.owner_email_enrollment_challenges(user_id,session_id,alias_id,email,challenge_id,
  alias_code_hash,alias_attempts,alias_verified_at,owner_code_hash,owner_attempts,owner_verified_at,
  expires_at,created_at,credential_version,password_change)
 values(p_user_id,p_session_id,p_alias_id,e,p_challenge_id,p_code_hash,0,
  case when p_code_hash is null then now() else null end,null,0,null,p_expires_at,now(),
  p_credential_version,p_password_change)
 on conflict(user_id,session_id,alias_id) do update set email=excluded.email,challenge_id=excluded.challenge_id,
  alias_code_hash=excluded.alias_code_hash,alias_attempts=0,alias_verified_at=excluded.alias_verified_at,
  owner_code_hash=null,owner_attempts=0,owner_verified_at=null,expires_at=excluded.expires_at,
  created_at=now(),credential_version=excluded.credential_version,password_change=excluded.password_change;
 return true;
end $$;

create function public.owner_email_save_password(
 p_user_id uuid,p_session_id uuid,p_alias_id uuid,p_challenge_id uuid,p_salt bytea,p_hash bytea,
 p_iterations integer,p_credential_version integer
)
returns boolean language plpgsql security definer set search_path=pg_catalog,auth,internal,public as $$
declare c internal.owner_email_enrollment_challenges%rowtype; a internal.owner_email_aliases%rowtype;
begin
 if p_salt is null or octet_length(p_salt)<>16 or p_hash is null or octet_length(p_hash)<>32
  or p_iterations is null or p_iterations not between 600000 and 1000000
  or p_credential_version is null or p_credential_version<=0 then return false; end if;

 perform pg_advisory_xact_lock(hashtextextended(p_alias_id::text,0));
 select * into a from internal.owner_email_aliases where alias_id=p_alias_id and user_id=p_user_id for update;
 select * into c from internal.owner_email_enrollment_challenges
 where user_id=p_user_id and session_id=p_session_id and alias_id=p_alias_id and challenge_id=p_challenge_id
  and expires_at>now() and alias_verified_at>now()-interval '5 minutes'
  and owner_code_hash is null and owner_verified_at is null
 for update;
 if not found or a.alias_id is null or c.credential_version is null
  or c.credential_version<>a.credential_version or c.credential_version<>p_credential_version
  or c.password_change is distinct from (a.password_hash is not null)
  or not internal.owner_email_auth_session_is_live(p_user_id,p_session_id)
  or not public.email_mfa_check_session(p_user_id,p_session_id)
  or not exists(select 1 from public.profiles p where p.id=p_user_id and p.role='admin' and p.status='active')
  or a.email_verified_at is null or lower(a.email)<>lower(c.email) then return false; end if;

 update internal.owner_email_aliases set password_salt=p_salt,password_hash=p_hash,password_iterations=p_iterations,
  credential_version=credential_version+1,updated_at=now()
 where alias_id=p_alias_id and user_id=p_user_id and credential_version=c.credential_version;
 if not found then return false; end if;
 delete from internal.owner_email_sessions where user_id=p_user_id and alias_id=p_alias_id;
 delete from internal.owner_email_login_tickets where user_id=p_user_id and alias_id=p_alias_id;
 delete from internal.owner_email_enrollment_challenges where alias_id=p_alias_id;
 return true;
end $$;

revoke all on function public.owner_email_begin_password_challenge(uuid,uuid,uuid,uuid,bytea,timestamptz,integer,boolean),
  public.owner_email_save_password(uuid,uuid,uuid,uuid,bytea,bytea,integer,integer),
  public.owner_email_begin_alias_verification(uuid,uuid,uuid,text,uuid,bytea,timestamptz),
  public.owner_email_verify_alias_code(uuid,uuid,uuid,uuid,bytea) from public,anon,authenticated;
grant execute on function public.owner_email_begin_password_challenge(uuid,uuid,uuid,uuid,bytea,timestamptz,integer,boolean),
  public.owner_email_save_password(uuid,uuid,uuid,uuid,bytea,bytea,integer,integer),
  public.owner_email_begin_alias_verification(uuid,uuid,uuid,text,uuid,bytea,timestamptz),
  public.owner_email_verify_alias_code(uuid,uuid,uuid,uuid,bytea) to service_role;

comment on function public.owner_email_begin_password_challenge(uuid,uuid,uuid,uuid,bytea,timestamptz,integer,boolean) is
 'Creates a short-lived password set/change challenge only when the trusted credential version and password-exists state still match. Begin and save serialize on the alias id.';
comment on function public.owner_email_save_password(uuid,uuid,uuid,uuid,bytea,bytea,integer,integer) is
 'Atomically saves a password only for the challenge credential version, increments that version, and invalidates every outstanding enrollment/password challenge for the alias.';

notify pgrst, 'reload config';
