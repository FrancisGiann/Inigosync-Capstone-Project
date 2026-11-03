-- Secondary verified email aliases keep one canonical Supabase Auth user while
-- allowing an alias email plus an independent password to broker a session.
create table internal.owner_email_aliases (
  alias_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  email_verified_at timestamptz not null,
  password_salt bytea,
  password_hash bytea,
  password_iterations integer,
  credential_version integer not null default 1 check (credential_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((password_salt is null and password_hash is null and password_iterations is null)
    or (password_salt is not null and password_hash is not null and password_iterations is not null
      and octet_length(password_salt) = 16 and octet_length(password_hash) = 32
      and password_iterations between 600000 and 1000000))
);
create unique index owner_email_aliases_normalized_email_uidx on internal.owner_email_aliases(lower(email));
create index owner_email_aliases_user_idx on internal.owner_email_aliases(user_id);

create table internal.owner_email_login_tickets (
  ticket_hash bytea primary key check (octet_length(ticket_hash) = 32),
  user_id uuid not null references auth.users(id) on delete cascade,
  alias_id uuid not null references internal.owner_email_aliases(alias_id) on delete cascade,
  credential_version integer not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table internal.owner_email_sessions (
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references auth.sessions(id) on delete cascade,
  alias_id uuid not null references internal.owner_email_aliases(alias_id) on delete cascade,
  credential_version integer not null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  primary key(user_id, session_id)
);
create table internal.owner_email_login_challenges (
  user_id uuid not null,
  session_id uuid not null,
  alias_id uuid not null references internal.owner_email_aliases(alias_id) on delete cascade,
  challenge_id uuid not null unique,
  code_hash bytea not null check (octet_length(code_hash) = 32),
  attempts integer not null default 0 check (attempts between 0 and 5),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key(user_id, session_id),
  foreign key(user_id, session_id) references internal.owner_email_sessions(user_id, session_id) on delete cascade
);
create table internal.owner_email_enrollment_challenges (
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references auth.sessions(id) on delete cascade,
  alias_id uuid not null,
  email text not null,
  challenge_id uuid not null unique,
  alias_code_hash bytea,
  alias_attempts integer not null default 0 check (alias_attempts between 0 and 5),
  alias_verified_at timestamptz,
  owner_code_hash bytea,
  owner_attempts integer not null default 0 check (owner_attempts between 0 and 5),
  owner_verified_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key(user_id, session_id, alias_id),
  check (alias_code_hash is null or octet_length(alias_code_hash) = 32),
  check (owner_code_hash is null or octet_length(owner_code_hash) = 32)
);
create table internal.owner_email_auth_attempts (
  key_kind text not null check (key_kind in ('email','ip')),
  key_hash bytea not null check (octet_length(key_hash) = 32),
  window_started_at timestamptz not null default now(),
  attempts integer not null default 0,
  primary key(key_kind, key_hash)
);
create index owner_email_auth_attempts_window_idx on internal.owner_email_auth_attempts(window_started_at);
create table internal.owner_email_code_attempts (
  user_id uuid not null references auth.users(id) on delete cascade,
  alias_id uuid not null,
  purpose text not null check (purpose in ('login','alias_verify','owner_verify')),
  window_started_at timestamptz not null default now(),
  attempts integer not null default 0,
  primary key(user_id, alias_id, purpose)
);
create index owner_email_code_attempts_window_idx on internal.owner_email_code_attempts(window_started_at);
create index owner_email_enrollment_challenges_expiry_idx on internal.owner_email_enrollment_challenges(expires_at);
create index owner_email_login_challenges_expiry_idx on internal.owner_email_login_challenges(expires_at);
create index owner_email_login_tickets_expiry_idx on internal.owner_email_login_tickets(expires_at);
create table internal.owner_email_link_notices (
  alias_id uuid primary key references internal.owner_email_aliases(alias_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  delivery_status text not null default 'pending' check (delivery_status in ('pending','sent','uncertain','failed')),
  last_attempt_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

alter table internal.owner_email_aliases enable row level security;
alter table internal.owner_email_login_tickets enable row level security;
alter table internal.owner_email_sessions enable row level security;
alter table internal.owner_email_login_challenges enable row level security;
alter table internal.owner_email_enrollment_challenges enable row level security;
alter table internal.owner_email_auth_attempts enable row level security;
alter table internal.owner_email_code_attempts enable row level security;
alter table internal.owner_email_link_notices enable row level security;
revoke all on internal.owner_email_aliases, internal.owner_email_login_tickets, internal.owner_email_sessions,
  internal.owner_email_login_challenges, internal.owner_email_enrollment_challenges, internal.owner_email_auth_attempts,
  internal.owner_email_code_attempts, internal.owner_email_link_notices from public, anon, authenticated;
grant select, insert, update, delete on internal.owner_email_aliases, internal.owner_email_login_tickets,
  internal.owner_email_sessions, internal.owner_email_login_challenges, internal.owner_email_enrollment_challenges,
  internal.owner_email_auth_attempts, internal.owner_email_code_attempts, internal.owner_email_link_notices to service_role;

create or replace function internal.owner_email_alias_is_live(p_user_id uuid,p_alias_id uuid,p_version integer default null)
returns boolean language sql stable security definer set search_path=pg_catalog,auth,internal,public as $$
 select exists(select 1 from internal.owner_email_aliases a join auth.users u on u.id=a.user_id join public.profiles p on p.id=a.user_id
  where a.alias_id=p_alias_id and a.user_id=p_user_id and a.email_verified_at is not null and a.password_hash is not null
   and lower(a.email)<>lower(u.email) and p.role='admin' and p.status='active'
   and (p_version is null or a.credential_version=p_version))
$$;
create or replace function internal.owner_email_auth_session_is_live(p_user_id uuid,p_session_id uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,auth as $$
 select exists(select 1 from auth.sessions s where s.id=p_session_id and s.user_id=p_user_id
  and (s.not_after is null or s.not_after>now()))
$$;
create or replace function internal.owner_email_session_is_verified(p_user_id uuid,p_session_id uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,auth,internal as $$
 select exists(select 1 from internal.owner_email_sessions s where s.user_id=p_user_id and s.session_id=p_session_id
  and s.verified_at>now()-interval '7 days' and internal.owner_email_auth_session_is_live(s.user_id,s.session_id)
  and internal.owner_email_alias_is_live(s.user_id,s.alias_id,s.credential_version))
$$;
create or replace function internal.owner_email_record_code_attempt(p_user_id uuid,p_alias_id uuid,p_purpose text)
returns boolean language plpgsql security definer set search_path=pg_catalog,internal as $$
declare n integer;
begin
 if p_user_id is null or p_alias_id is null or p_purpose not in ('login','alias_verify','owner_verify') then return false; end if;
 delete from internal.owner_email_code_attempts where window_started_at<now()-interval '24 hours';
 insert into internal.owner_email_code_attempts(user_id,alias_id,purpose,attempts) values(p_user_id,p_alias_id,p_purpose,1)
 on conflict(user_id,alias_id,purpose) do update set
  attempts=case when internal.owner_email_code_attempts.window_started_at<now()-interval '15 minutes' then 1 else internal.owner_email_code_attempts.attempts+1 end,
  window_started_at=case when internal.owner_email_code_attempts.window_started_at<now()-interval '15 minutes' then now() else internal.owner_email_code_attempts.window_started_at end
 returning attempts into n;
 return n<=10;
end $$;

create or replace function public.owner_email_login_rate_limit(p_email_hash bytea,p_ip_hash bytea)
returns boolean language plpgsql security definer set search_path=pg_catalog,internal as $$
declare e integer; i integer;
begin
 if p_email_hash is null or octet_length(p_email_hash)<>32 or p_ip_hash is null or octet_length(p_ip_hash)<>32 then return false; end if;
 delete from internal.owner_email_auth_attempts where window_started_at<now()-interval '24 hours';
 delete from internal.owner_email_login_tickets where expires_at<=now();
 delete from internal.owner_email_login_challenges where expires_at<=now();
 delete from internal.owner_email_enrollment_challenges where expires_at<=now();
 delete from internal.owner_email_sessions s
  where not exists(select 1 from auth.sessions a where a.id=s.session_id and a.user_id=s.user_id and (a.not_after is null or a.not_after>now()))
   or (s.verified_at is not null and s.verified_at<=now()-interval '7 days')
   or (s.verified_at is null and not exists(select 1 from internal.owner_email_login_challenges c
     where c.user_id=s.user_id and c.session_id=s.session_id and c.expires_at>now()));
 insert into internal.owner_email_auth_attempts(key_kind,key_hash,attempts) values('email',p_email_hash,1)
 on conflict(key_kind,key_hash) do update set attempts=case when internal.owner_email_auth_attempts.window_started_at<now()-interval '15 minutes' then 1 else internal.owner_email_auth_attempts.attempts+1 end,
 window_started_at=case when internal.owner_email_auth_attempts.window_started_at<now()-interval '15 minutes' then now() else internal.owner_email_auth_attempts.window_started_at end returning attempts into e;
 insert into internal.owner_email_auth_attempts(key_kind,key_hash,attempts) values('ip',p_ip_hash,1)
 on conflict(key_kind,key_hash) do update set attempts=case when internal.owner_email_auth_attempts.window_started_at<now()-interval '15 minutes' then 1 else internal.owner_email_auth_attempts.attempts+1 end,
 window_started_at=case when internal.owner_email_auth_attempts.window_started_at<now()-interval '15 minutes' then now() else internal.owner_email_auth_attempts.window_started_at end returning attempts into i;
 return e<=5 and i<=30;
end $$;
create or replace function public.owner_email_reset_login_limit(p_email_hash bytea)
returns boolean language plpgsql security definer set search_path=pg_catalog,internal as $$
begin delete from internal.owner_email_auth_attempts where key_kind='email' and key_hash=p_email_hash; return true; end $$;
create or replace function public.owner_email_get_credential(p_email text)
returns table(alias_id uuid,user_id uuid,email text,password_salt text,password_hash text,password_iterations integer,credential_version integer)
language sql security definer set search_path=pg_catalog,internal as $$
 select a.alias_id,a.user_id,a.email,chr(92)||'x'||encode(a.password_salt,'hex'),chr(92)||'x'||encode(a.password_hash,'hex'),a.password_iterations,a.credential_version
 from internal.owner_email_aliases a where lower(a.email)=lower(p_email) and a.password_hash is not null and a.email_verified_at is not null
$$;
create or replace function public.owner_email_list_aliases(p_user_id uuid)
returns table(alias_id uuid,email text,has_password boolean,delivery_status text)
language sql security definer set search_path=pg_catalog,internal as $$
 select a.alias_id,a.email,a.password_hash is not null,n.delivery_status from internal.owner_email_aliases a
 left join internal.owner_email_link_notices n on n.alias_id=a.alias_id where a.user_id=p_user_id and a.email_verified_at is not null order by a.created_at
$$;

create or replace function public.owner_email_begin_alias_verification(p_user_id uuid,p_session_id uuid,p_alias_id uuid,p_email text,p_challenge_id uuid,p_code_hash bytea,p_expires_at timestamptz)
returns boolean language plpgsql security definer set search_path=pg_catalog,auth,internal,public as $$
declare e text:=lower(trim(p_email));
begin
 if p_email is null or length(e)>254 or e !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' or p_code_hash is null or octet_length(p_code_hash)<>32
  or p_expires_at is null or p_expires_at<=now() or p_expires_at>now()+interval '6 minutes' or not internal.owner_email_auth_session_is_live(p_user_id,p_session_id)
  or not public.email_mfa_check_session(p_user_id,p_session_id) or not exists(select 1 from public.profiles p where p.id=p_user_id and p.role='admin' and p.status='active') then return false; end if;
 perform pg_advisory_xact_lock(hashtextextended(e,0));
 if exists(select 1 from auth.users u where lower(u.email)=e) or exists(select 1 from internal.owner_email_aliases a where lower(a.email)=e) then return false; end if;
 if not internal.owner_email_record_code_attempt(p_user_id,p_alias_id,'alias_verify') then return false; end if;
 delete from internal.owner_email_enrollment_challenges where user_id=p_user_id and session_id=p_session_id and alias_id=p_alias_id;
 insert into internal.owner_email_enrollment_challenges(user_id,session_id,alias_id,email,challenge_id,alias_code_hash,expires_at)
 values(p_user_id,p_session_id,p_alias_id,e,p_challenge_id,p_code_hash,p_expires_at); return true;
end $$;
create or replace function public.owner_email_verify_alias_code(p_user_id uuid,p_session_id uuid,p_alias_id uuid,p_challenge_id uuid,p_code_hash bytea)
returns boolean language plpgsql security definer set search_path=pg_catalog,auth,internal,public as $$
declare c internal.owner_email_enrollment_challenges%rowtype;
begin
 select * into c from internal.owner_email_enrollment_challenges where user_id=p_user_id and session_id=p_session_id and alias_id=p_alias_id and challenge_id=p_challenge_id and expires_at>now() and alias_verified_at is null for update;
 if not found or not internal.owner_email_auth_session_is_live(p_user_id,p_session_id) or not public.email_mfa_check_session(p_user_id,p_session_id)
  or not exists(select 1 from public.profiles p where p.id=p_user_id and p.role='admin' and p.status='active')
  or not internal.owner_email_record_code_attempt(p_user_id,p_alias_id,'alias_verify') then return false; end if;
 if c.alias_attempts>=5 or c.alias_code_hash is distinct from p_code_hash then
  update internal.owner_email_enrollment_challenges set alias_attempts=least(5,alias_attempts+1) where user_id=p_user_id and session_id=p_session_id and alias_id=p_alias_id; return false;
 end if;
 perform pg_advisory_xact_lock(hashtextextended(c.email,0));
 if exists(select 1 from auth.users u where lower(u.email)=lower(c.email)) then return false; end if;
 insert into internal.owner_email_aliases(alias_id,user_id,email,email_verified_at) values(p_alias_id,p_user_id,c.email,now());
 update internal.owner_email_enrollment_challenges set alias_verified_at=now(),alias_code_hash=null where user_id=p_user_id and session_id=p_session_id and alias_id=p_alias_id and challenge_id=p_challenge_id;
 return true;
exception when unique_violation then return false;
end $$;
create or replace function public.owner_email_begin_password_challenge(p_user_id uuid,p_session_id uuid,p_alias_id uuid,p_challenge_id uuid,p_code_hash bytea,p_expires_at timestamptz)
returns boolean language plpgsql security definer set search_path=pg_catalog,auth,internal,public as $$
declare e text;
begin
 if p_code_hash is null or octet_length(p_code_hash)<>32 or p_expires_at is null or p_expires_at<=now() or p_expires_at>now()+interval '6 minutes'
  or not internal.owner_email_auth_session_is_live(p_user_id,p_session_id) or not public.email_mfa_check_session(p_user_id,p_session_id)
  or not exists(select 1 from public.profiles p where p.id=p_user_id and p.role='admin' and p.status='active') then return false; end if;
 select email into e from internal.owner_email_aliases where alias_id=p_alias_id and user_id=p_user_id and email_verified_at is not null;
 if e is null then return false; end if;
 if not internal.owner_email_record_code_attempt(p_user_id,p_alias_id,'owner_verify') then return false; end if;
 insert into internal.owner_email_enrollment_challenges(user_id,session_id,alias_id,email,challenge_id,alias_verified_at,owner_code_hash,expires_at)
 values(p_user_id,p_session_id,p_alias_id,e,p_challenge_id,now(),p_code_hash,p_expires_at)
 on conflict(user_id,session_id,alias_id) do update set email=excluded.email,challenge_id=excluded.challenge_id,alias_code_hash=null,alias_attempts=0,
 alias_verified_at=now(),owner_code_hash=excluded.owner_code_hash,owner_attempts=0,owner_verified_at=null,expires_at=excluded.expires_at,created_at=now();
 return true;
end $$;
create or replace function public.owner_email_verify_owner_code(p_user_id uuid,p_session_id uuid,p_alias_id uuid,p_challenge_id uuid,p_code_hash bytea)
returns boolean language plpgsql security definer set search_path=pg_catalog,auth,internal,public as $$
declare c internal.owner_email_enrollment_challenges%rowtype;
begin
 select * into c from internal.owner_email_enrollment_challenges where user_id=p_user_id and session_id=p_session_id and alias_id=p_alias_id and challenge_id=p_challenge_id and expires_at>now() and alias_verified_at is not null and owner_verified_at is null for update;
 if not found or not internal.owner_email_auth_session_is_live(p_user_id,p_session_id) or not public.email_mfa_check_session(p_user_id,p_session_id)
  or not exists(select 1 from public.profiles p where p.id=p_user_id and p.role='admin' and p.status='active')
  or not internal.owner_email_record_code_attempt(p_user_id,p_alias_id,'owner_verify') then return false; end if;
 if c.owner_attempts>=5 or c.owner_code_hash is distinct from p_code_hash then
  update internal.owner_email_enrollment_challenges set owner_attempts=least(5,owner_attempts+1) where user_id=p_user_id and session_id=p_session_id and alias_id=p_alias_id; return false;
 end if;
 update internal.owner_email_enrollment_challenges set owner_verified_at=now() where user_id=p_user_id and session_id=p_session_id and alias_id=p_alias_id and challenge_id=p_challenge_id; return true;
end $$;
create or replace function public.owner_email_save_password(p_user_id uuid,p_session_id uuid,p_alias_id uuid,p_challenge_id uuid,p_salt bytea,p_hash bytea,p_iterations integer)
returns boolean language plpgsql security definer set search_path=pg_catalog,auth,internal,public as $$
declare c internal.owner_email_enrollment_challenges%rowtype;
begin
 if p_salt is null or octet_length(p_salt)<>16 or p_hash is null or octet_length(p_hash)<>32 or p_iterations is null or p_iterations not between 600000 and 1000000 then return false; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||p_session_id::text||p_alias_id::text,0));
 select * into c from internal.owner_email_enrollment_challenges where user_id=p_user_id and session_id=p_session_id and alias_id=p_alias_id and challenge_id=p_challenge_id and expires_at>now() and owner_verified_at>now()-interval '5 minutes' for update;
 if not found or not internal.owner_email_auth_session_is_live(p_user_id,p_session_id) or not public.email_mfa_check_session(p_user_id,p_session_id)
  or not exists(select 1 from public.profiles p where p.id=p_user_id and p.role='admin' and p.status='active')
  or not exists(select 1 from internal.owner_email_aliases a where a.alias_id=p_alias_id and a.user_id=p_user_id and lower(a.email)=lower(c.email) and a.email_verified_at is not null) then return false; end if;
 update internal.owner_email_aliases set password_salt=p_salt,password_hash=p_hash,password_iterations=p_iterations,credential_version=credential_version+1,updated_at=now() where alias_id=p_alias_id and user_id=p_user_id;
 delete from internal.owner_email_sessions where user_id=p_user_id and alias_id=p_alias_id;
 delete from internal.owner_email_login_tickets where user_id=p_user_id and alias_id=p_alias_id;
 delete from internal.owner_email_enrollment_challenges where user_id=p_user_id and session_id=p_session_id and alias_id=p_alias_id; return true;
end $$;
create or replace function public.owner_email_remove_alias(p_user_id uuid,p_session_id uuid,p_alias_id uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,auth,internal,public as $$
begin
 if not internal.owner_email_auth_session_is_live(p_user_id,p_session_id) or not public.email_mfa_check_session(p_user_id,p_session_id)
  or not exists(select 1 from public.profiles p where p.id=p_user_id and p.role='admin' and p.status='active') then return false; end if;
 delete from internal.owner_email_enrollment_challenges where user_id=p_user_id and alias_id=p_alias_id;
 delete from internal.owner_email_code_attempts where user_id=p_user_id and alias_id=p_alias_id;
 delete from internal.owner_email_aliases where user_id=p_user_id and alias_id=p_alias_id; return found;
end $$;

create or replace function public.owner_email_begin_link_notice(p_user_id uuid,p_alias_id uuid)
returns table(email text,should_send boolean,delivery_status text) language plpgsql security definer set search_path=pg_catalog,auth,internal,public as $$
declare e text; n internal.owner_email_link_notices%rowtype;
begin
 select a.email into e from internal.owner_email_aliases a join public.profiles p on p.id=a.user_id where a.alias_id=p_alias_id and a.user_id=p_user_id and p.role='admin' and p.status='active';
 if e is null then raise exception 'verified email alias unavailable' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||p_alias_id::text,0));
 insert into internal.owner_email_link_notices(alias_id,user_id,email,delivery_status,last_attempt_at) values(p_alias_id,p_user_id,e,'pending',null) on conflict(alias_id) do nothing;
 select * into n from internal.owner_email_link_notices where alias_id=p_alias_id and user_id=p_user_id for update;
 if n.delivery_status='sent' then return query select e,false,'sent'; return; end if;
 if n.last_attempt_at>now()-interval '60 seconds' then return query select e,false,n.delivery_status; return; end if;
 update internal.owner_email_link_notices set email=e,delivery_status='pending',last_attempt_at=now() where alias_id=p_alias_id and user_id=p_user_id;
 return query select e,true,'pending';
end $$;
create or replace function public.owner_email_finish_link_notice(p_user_id uuid,p_alias_id uuid,p_delivery_status text)
returns boolean language plpgsql security definer set search_path=pg_catalog,internal as $$
begin if p_delivery_status is null or p_delivery_status not in ('sent','uncertain','failed') then return false; end if;
 update internal.owner_email_link_notices set delivery_status=p_delivery_status,sent_at=case when p_delivery_status='sent' then now() else null end where user_id=p_user_id and alias_id=p_alias_id; return found; end $$;

create or replace function public.owner_email_create_ticket(p_ticket_hash bytea,p_user_id uuid,p_alias_id uuid,p_version integer,p_expires_at timestamptz)
returns boolean language plpgsql security definer set search_path=pg_catalog,auth,internal as $$
begin if octet_length(p_ticket_hash)<>32 or p_expires_at<=now() or p_expires_at>now()+interval '2 minutes' or not internal.owner_email_alias_is_live(p_user_id,p_alias_id,p_version) then return false; end if;
 delete from internal.owner_email_login_tickets where expires_at<=now();
 insert into internal.owner_email_login_tickets(ticket_hash,user_id,alias_id,credential_version,expires_at) values(p_ticket_hash,p_user_id,p_alias_id,p_version,p_expires_at); return true; end $$;
create or replace function public.owner_email_begin_login_challenge(p_user_id uuid,p_session_id uuid,p_ticket_hash bytea,p_challenge_id uuid,p_code_hash bytea,p_expires_at timestamptz,p_force boolean default false)
returns table(email text,sent boolean,challenge_id uuid) language plpgsql security definer set search_path=pg_catalog,auth,internal as $$
declare t internal.owner_email_login_tickets%rowtype; c internal.owner_email_login_challenges%rowtype; v_alias_id uuid;
begin
 if octet_length(p_code_hash)<>32 or p_expires_at<=now() or p_expires_at>now()+interval '6 minutes' or not internal.owner_email_auth_session_is_live(p_user_id,p_session_id) then return query select null::text,false,null::uuid; return; end if;
 select * into t from internal.owner_email_login_tickets where ticket_hash=p_ticket_hash and user_id=p_user_id and expires_at>now() for update;
 if found then
  if not exists(select 1 from auth.mfa_amr_claims m where m.session_id=p_session_id and m.authentication_method='magiclink') then
   delete from internal.owner_email_login_tickets where ticket_hash=p_ticket_hash;
   return query select null::text,false,null::uuid; return;
  end if;
  if not internal.owner_email_alias_is_live(p_user_id,t.alias_id,t.credential_version) then delete from internal.owner_email_login_tickets where ticket_hash=p_ticket_hash; return query select null::text,false,null::uuid; return; end if;
  insert into internal.owner_email_sessions(user_id,session_id,alias_id,credential_version) values(p_user_id,p_session_id,t.alias_id,t.credential_version)
   on conflict(user_id,session_id) do update set alias_id=excluded.alias_id,credential_version=excluded.credential_version,verified_at=null,created_at=now();
  delete from internal.owner_email_login_tickets where ticket_hash=p_ticket_hash;
 end if;
 if not exists(select 1 from internal.owner_email_sessions s where s.user_id=p_user_id and s.session_id=p_session_id and s.verified_at is null and internal.owner_email_alias_is_live(s.user_id,s.alias_id,s.credential_version)) then return query select null::text,false,null::uuid; return; end if;
 select * into c from internal.owner_email_login_challenges where user_id=p_user_id and session_id=p_session_id and expires_at>now();
 if found then
  if not p_force or c.created_at>now()-interval '60 seconds' then return query select (select a.email from internal.owner_email_aliases a where a.alias_id=c.alias_id),false,c.challenge_id; return; end if;
  delete from internal.owner_email_login_challenges where user_id=p_user_id and session_id=p_session_id;
 end if;
 delete from internal.owner_email_login_challenges where user_id=p_user_id and session_id=p_session_id;
 select alias_id into v_alias_id from internal.owner_email_sessions where user_id=p_user_id and session_id=p_session_id;
 if v_alias_id is null or not internal.owner_email_record_code_attempt(p_user_id,v_alias_id,'login') then return query select null::text,false,null::uuid; return; end if;
 insert into internal.owner_email_login_challenges(user_id,session_id,alias_id,challenge_id,code_hash,expires_at)
 select p_user_id,p_session_id,s.alias_id,p_challenge_id,p_code_hash,p_expires_at from internal.owner_email_sessions s where s.user_id=p_user_id and s.session_id=p_session_id;
 return query select (select a.email from internal.owner_email_aliases a join internal.owner_email_sessions s on s.alias_id=a.alias_id where s.user_id=p_user_id and s.session_id=p_session_id),true,p_challenge_id;
end $$;
create or replace function public.owner_email_verify_login_code(p_user_id uuid,p_session_id uuid,p_challenge_id uuid,p_code_hash bytea)
returns boolean language plpgsql security definer set search_path=pg_catalog,auth,internal as $$
declare c internal.owner_email_login_challenges%rowtype;
begin
 select * into c from internal.owner_email_login_challenges where user_id=p_user_id and session_id=p_session_id and challenge_id=p_challenge_id and expires_at>now() for update;
 if not found or not internal.owner_email_record_code_attempt(p_user_id,c.alias_id,'login') then return false; end if;
 if c.attempts>=5 or c.code_hash is distinct from p_code_hash then update internal.owner_email_login_challenges set attempts=least(5,attempts+1) where user_id=p_user_id and session_id=p_session_id; return false; end if;
 if not internal.owner_email_auth_session_is_live(p_user_id,p_session_id) or not exists(select 1 from internal.owner_email_sessions s where s.user_id=p_user_id and s.session_id=p_session_id and s.alias_id=c.alias_id and s.verified_at is null and internal.owner_email_alias_is_live(s.user_id,s.alias_id,s.credential_version)) then return false; end if;
 update internal.owner_email_sessions set verified_at=now() where user_id=p_user_id and session_id=p_session_id and alias_id=c.alias_id;
 delete from internal.owner_email_login_challenges where user_id=p_user_id and session_id=p_session_id; return true;
end $$;

create or replace function internal.has_verified_email_session()
returns boolean language sql stable security definer set search_path=pg_catalog,auth,internal,public as $$
 select case when auth.uid() is null then false when coalesce(auth.jwt()->>'session_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then false
 else internal.email_mfa_session_has_native_proof(auth.uid(),(auth.jwt()->>'session_id')::uuid)
  or internal.owner_email_session_is_verified(auth.uid(),(auth.jwt()->>'session_id')::uuid)
  or exists(select 1 from internal.email_mfa_verified_sessions v where v.user_id=auth.uid() and v.session_id=(auth.jwt()->>'session_id')::uuid and v.last_activity_at>now()-interval '7 days' and internal.email_mfa_live_session(v.user_id,v.session_id)
   and exists(select 1 from public.profiles p where p.id=v.user_id and (p.status='active' and p.role in ('customer','staff','admin') or p.role='staff' and p.status='pending' and p.onboarding_complete is false))) end
$$;
create or replace function public.email_mfa_check_session(p_user_id uuid,p_session_id uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,auth,internal,public as $$
 select internal.email_mfa_session_has_native_proof(p_user_id,p_session_id) or internal.owner_email_session_is_verified(p_user_id,p_session_id)
  or exists(select 1 from internal.email_mfa_verified_sessions v where v.user_id=p_user_id and v.session_id=p_session_id and v.last_activity_at>now()-interval '7 days' and internal.email_mfa_live_session(v.user_id,v.session_id)
   and exists(select 1 from public.profiles p where p.id=v.user_id and (p.status='active' and p.role in ('customer','staff','admin') or p.role='staff' and p.status='pending' and p.onboarding_complete is false)))
$$;

revoke all on function internal.owner_email_alias_is_live(uuid,uuid,integer),internal.owner_email_auth_session_is_live(uuid,uuid),internal.owner_email_session_is_verified(uuid,uuid),internal.owner_email_record_code_attempt(uuid,uuid,text) from public,anon,authenticated;
grant execute on function internal.owner_email_alias_is_live(uuid,uuid,integer),internal.owner_email_auth_session_is_live(uuid,uuid),internal.owner_email_session_is_verified(uuid,uuid),internal.owner_email_record_code_attempt(uuid,uuid,text) to service_role;
revoke all on function public.owner_email_login_rate_limit(bytea,bytea),public.owner_email_reset_login_limit(bytea),public.owner_email_get_credential(text),public.owner_email_list_aliases(uuid),public.owner_email_begin_alias_verification(uuid,uuid,uuid,text,uuid,bytea,timestamptz),public.owner_email_verify_alias_code(uuid,uuid,uuid,uuid,bytea),public.owner_email_begin_password_challenge(uuid,uuid,uuid,uuid,bytea,timestamptz),public.owner_email_verify_owner_code(uuid,uuid,uuid,uuid,bytea),public.owner_email_save_password(uuid,uuid,uuid,uuid,bytea,bytea,integer),public.owner_email_remove_alias(uuid,uuid,uuid),public.owner_email_begin_link_notice(uuid,uuid),public.owner_email_finish_link_notice(uuid,uuid,text),public.owner_email_create_ticket(bytea,uuid,uuid,integer,timestamptz),public.owner_email_begin_login_challenge(uuid,uuid,bytea,uuid,bytea,timestamptz,boolean),public.owner_email_verify_login_code(uuid,uuid,uuid,bytea) from public,anon,authenticated;
grant execute on function public.owner_email_login_rate_limit(bytea,bytea),public.owner_email_reset_login_limit(bytea),public.owner_email_get_credential(text),public.owner_email_list_aliases(uuid),public.owner_email_begin_alias_verification(uuid,uuid,uuid,text,uuid,bytea,timestamptz),public.owner_email_verify_alias_code(uuid,uuid,uuid,uuid,bytea),public.owner_email_begin_password_challenge(uuid,uuid,uuid,uuid,bytea,timestamptz),public.owner_email_verify_owner_code(uuid,uuid,uuid,uuid,bytea),public.owner_email_save_password(uuid,uuid,uuid,uuid,bytea,bytea,integer),public.owner_email_remove_alias(uuid,uuid,uuid),public.owner_email_begin_link_notice(uuid,uuid),public.owner_email_finish_link_notice(uuid,uuid,text),public.owner_email_create_ticket(bytea,uuid,uuid,integer,timestamptz),public.owner_email_begin_login_challenge(uuid,uuid,bytea,uuid,bytea,timestamptz,boolean),public.owner_email_verify_login_code(uuid,uuid,uuid,bytea) to service_role;
revoke all on function internal.has_verified_email_session() from public,anon;
grant execute on function internal.has_verified_email_session() to authenticated,service_role;
revoke all on function public.email_mfa_check_session(uuid,uuid) from public,anon,authenticated;
grant execute on function public.email_mfa_check_session(uuid,uuid) to service_role;
comment on table internal.owner_email_aliases is 'Verified secondary email aliases for one canonical owner UUID; password material is private and PBKDF2 hashed.';
comment on function internal.owner_email_session_is_verified(uuid,uuid) is 'True only for a live Auth session admitted by a linked-email password and OTP delivered to that alias.';
notify pgrst,'reload config';
