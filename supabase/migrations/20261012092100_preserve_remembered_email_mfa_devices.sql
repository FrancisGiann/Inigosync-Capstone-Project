-- Remember me trusts a device after a successful email-code verification.
-- Once trusted, that device remains trusted for seven days of activity even
-- when the user leaves Remember me unchecked on a later sign-in.
create or replace function public.email_mfa_begin(
  p_user_id uuid, p_session_id uuid, p_email text, p_challenge_id uuid,
  p_remember boolean, p_device_hash bytea
) returns table(verified boolean, challenge_id uuid, send_email boolean, remembered boolean)
language plpgsql security definer
set search_path = pg_catalog, internal
as $$
declare
  v_existing internal.email_mfa_challenges%rowtype;
  v_remembered boolean := false;
begin
  if not internal.email_mfa_live_session(p_user_id, p_session_id) then
    raise exception 'session is no longer active' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || p_session_id::text, 0));
  delete from internal.email_mfa_verified_sessions v where v.user_id = p_user_id
    and (v.last_activity_at <= now() - interval '7 days' or not internal.email_mfa_live_session(v.user_id, v.session_id));
  delete from internal.email_mfa_challenges c where c.user_id = p_user_id and c.expires_at <= now();
  delete from internal.email_mfa_attempt_windows a where a.user_id = p_user_id
    and a.window_started_at <= now() - interval '15 minutes';

  -- An already verified session can refresh a matching trust record, but an
  -- unchecked sign-in never creates a record when it is missing or expired.
  if exists (select 1 from internal.email_mfa_verified_sessions v
      where v.user_id = p_user_id and v.session_id = p_session_id
        and v.last_activity_at > now() - interval '7 days') then
    if p_device_hash is not null then
      update internal.email_mfa_trusted_devices
        set last_verified_at = now(), expires_at = now() + interval '7 days'
        where user_id = p_user_id and device_hash = p_device_hash and expires_at > now();
      v_remembered := found;
    end if;
    return query select true, null::uuid, false, v_remembered;
    return;
  end if;
  delete from internal.email_mfa_verified_sessions where user_id = p_user_id and session_id = p_session_id;

  if p_device_hash is not null then
    -- Expired trust must not authorize this session. Remove the stale hash so
    -- only a later checked, successful verification can renew it.
    delete from internal.email_mfa_trusted_devices
      where user_id = p_user_id and device_hash = p_device_hash and expires_at <= now();
    if exists (select 1 from internal.email_mfa_trusted_devices d
        where d.user_id = p_user_id and d.device_hash = p_device_hash and d.expires_at > now()) then
      insert into internal.email_mfa_verified_sessions(user_id, session_id)
        values (p_user_id, p_session_id) on conflict (user_id, session_id)
        do update set verified_at = now(), last_activity_at = now();
      update internal.email_mfa_trusted_devices
        set last_verified_at = now(), expires_at = now() + interval '7 days'
        where user_id = p_user_id and device_hash = p_device_hash and expires_at > now();
      return query select true, null::uuid, false, true;
      return;
    end if;
  end if;

  select * into v_existing from internal.email_mfa_challenges c
    where c.user_id = p_user_id and c.session_id = p_session_id and c.expires_at > now();
  if found and v_existing.created_at > now() - interval '60 seconds' then
    return query select false, v_existing.challenge_id, false, false;
    return;
  end if;
  delete from internal.email_mfa_challenges where user_id = p_user_id and session_id = p_session_id;
  insert into internal.email_mfa_challenges(user_id, session_id, challenge_id, email, expires_at)
    values (p_user_id, p_session_id, p_challenge_id, lower(p_email), now() + interval '5 minutes');
  return query select false, p_challenge_id, true, false;
end;
$$;
