-- Bind the one-use broker ticket to the fresh email OTP session created by
-- redeeming its magic-link token hash. Supabase records token-hash verification
-- through verifyOtp({ type: 'email' }) as an `otp` AMR, not necessarily
-- `magiclink`; the session creation window ties that proof to this ticket.
create or replace function public.owner_email_begin_login_challenge(
  p_user_id uuid,
  p_session_id uuid,
  p_ticket_hash bytea,
  p_challenge_id uuid,
  p_code_hash bytea,
  p_expires_at timestamptz,
  p_force boolean default false
)
returns table(email text, sent boolean, challenge_id uuid)
language plpgsql security definer
set search_path=pg_catalog,auth,internal as $$
declare
  t internal.owner_email_login_tickets%rowtype;
  c internal.owner_email_login_challenges%rowtype;
  v_alias_id uuid;
begin
  if p_ticket_hash is null or octet_length(p_ticket_hash)<>32
    or p_code_hash is null or octet_length(p_code_hash)<>32
    or p_expires_at is null or p_expires_at<=now()
    or p_expires_at>now()+interval '6 minutes'
    or not internal.owner_email_auth_session_is_live(p_user_id,p_session_id) then
    return query select null::text,false,null::uuid;
    return;
  end if;

  select * into t
  from internal.owner_email_login_tickets
  where ticket_hash=p_ticket_hash and user_id=p_user_id and expires_at>now()
  for update;

  if found then
    -- The session must have been created while this ticket was valid and must
    -- carry email OTP/magic-link proof. This rejects pre-existing sessions and
    -- non-email sign-in methods while supporting verifyOtp token-hash sessions.
    if not exists (
      select 1
      from auth.sessions s
      join auth.mfa_amr_claims m on m.session_id=s.id
      where s.id=p_session_id
        and s.user_id=p_user_id
        and s.created_at>=t.created_at
        and s.created_at<=t.expires_at
        and m.authentication_method in ('magiclink','otp')
    ) then
      delete from internal.owner_email_login_tickets where ticket_hash=p_ticket_hash;
      return query select null::text,false,null::uuid;
      return;
    end if;

    if not internal.owner_email_alias_is_live(p_user_id,t.alias_id,t.credential_version) then
      delete from internal.owner_email_login_tickets where ticket_hash=p_ticket_hash;
      return query select null::text,false,null::uuid;
      return;
    end if;

    insert into internal.owner_email_sessions(user_id,session_id,alias_id,credential_version)
    values(p_user_id,p_session_id,t.alias_id,t.credential_version)
    on conflict(user_id,session_id) do update
      set alias_id=excluded.alias_id,
          credential_version=excluded.credential_version,
          verified_at=null,
          created_at=now();
    delete from internal.owner_email_login_tickets where ticket_hash=p_ticket_hash;
  end if;

  if not exists (
    select 1
    from internal.owner_email_sessions s
    where s.user_id=p_user_id and s.session_id=p_session_id and s.verified_at is null
      and internal.owner_email_alias_is_live(s.user_id,s.alias_id,s.credential_version)
  ) then
    return query select null::text,false,null::uuid;
    return;
  end if;

  select * into c
  from internal.owner_email_login_challenges
  where user_id=p_user_id and session_id=p_session_id and expires_at>now();
  if found then
    if not p_force or c.created_at>now()-interval '60 seconds' then
      return query
        select (select a.email from internal.owner_email_aliases a where a.alias_id=c.alias_id),false,c.challenge_id;
      return;
    end if;
    delete from internal.owner_email_login_challenges
    where user_id=p_user_id and session_id=p_session_id;
  end if;

  delete from internal.owner_email_login_challenges
  where user_id=p_user_id and session_id=p_session_id;
  select alias_id into v_alias_id
  from internal.owner_email_sessions
  where user_id=p_user_id and session_id=p_session_id;
  if v_alias_id is null or not internal.owner_email_record_code_attempt(p_user_id,v_alias_id,'login') then
    return query select null::text,false,null::uuid;
    return;
  end if;

  insert into internal.owner_email_login_challenges(user_id,session_id,alias_id,challenge_id,code_hash,expires_at)
  select p_user_id,p_session_id,s.alias_id,p_challenge_id,p_code_hash,p_expires_at
  from internal.owner_email_sessions s
  where s.user_id=p_user_id and s.session_id=p_session_id;
  return query
    select (select a.email from internal.owner_email_aliases a
      join internal.owner_email_sessions s on s.alias_id=a.alias_id
      where s.user_id=p_user_id and s.session_id=p_session_id),true,p_challenge_id;
end $$;
