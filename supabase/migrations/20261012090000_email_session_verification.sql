-- Email second-step proof is not Supabase AAL2. This binds a completed email
-- OTP to the exact live Auth session that passed password/OAuth authentication.
-- The Edge Function verifies the OTP with a temporary Auth client, revokes that
-- temporary session, then calls email_mfa_finish for the original session.

create schema if not exists internal;
grant usage on schema internal to service_role;

create table if not exists internal.email_mfa_challenges (
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null,
  challenge_id uuid not null,
  email text not null,
  attempts integer not null default 0 check (attempts between 0 and 5),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (user_id, session_id),
  unique (challenge_id)
);

create table if not exists internal.email_mfa_verified_sessions (
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null,
  verified_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  primary key (user_id, session_id)
);
alter table internal.email_mfa_verified_sessions add column if not exists last_activity_at timestamptz not null default now();

create table if not exists internal.email_mfa_trusted_devices (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_hash bytea not null,
  last_verified_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (user_id, device_hash)
);

create table if not exists internal.email_mfa_attempt_windows (
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null,
  window_started_at timestamptz not null default now(),
  attempts integer not null default 0,
  primary key (user_id, session_id)
);

alter table internal.email_mfa_challenges enable row level security;
alter table internal.email_mfa_verified_sessions enable row level security;
alter table internal.email_mfa_trusted_devices enable row level security;
alter table internal.email_mfa_attempt_windows enable row level security;
revoke all on internal.email_mfa_challenges, internal.email_mfa_verified_sessions,
  internal.email_mfa_trusted_devices, internal.email_mfa_attempt_windows from public, anon, authenticated;
grant select, insert, update, delete on internal.email_mfa_challenges,
  internal.email_mfa_verified_sessions, internal.email_mfa_trusted_devices,
  internal.email_mfa_attempt_windows to service_role;
grant usage on schema internal to authenticated, authenticator;

create or replace function internal.email_mfa_live_session(p_user_id uuid, p_session_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, auth
as $$
  select exists (
    select 1 from auth.sessions s
    where s.id = p_session_id and s.user_id = p_user_id
      and (s.not_after is null or s.not_after > now())
  );
$$;

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
          and p.status = 'active' and p.role in ('customer','staff','admin'))
        and internal.email_mfa_live_session(v.user_id, v.session_id)
    )
  end;
$$;

create or replace function public.email_mfa_begin(
  p_user_id uuid, p_session_id uuid, p_email text, p_challenge_id uuid,
  p_remember boolean, p_device_hash bytea
) returns table(verified boolean, challenge_id uuid, send_email boolean, remembered boolean)
language plpgsql security definer
set search_path = pg_catalog, internal
as $$
declare v_existing internal.email_mfa_challenges%rowtype;
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
  if exists (select 1 from internal.email_mfa_verified_sessions v
      where v.user_id = p_user_id and v.session_id = p_session_id
        and v.last_activity_at > now() - interval '7 days') then
    if p_remember and p_device_hash is not null then
      update internal.email_mfa_trusted_devices set last_verified_at = now(), expires_at = now() + interval '7 days'
        where user_id = p_user_id and device_hash = p_device_hash and expires_at > now();
    end if;
    return query select true, null::uuid, false, p_remember;
    return;
  end if;
  delete from internal.email_mfa_verified_sessions where user_id = p_user_id and session_id = p_session_id;
  if not p_remember and p_device_hash is not null then
    delete from internal.email_mfa_trusted_devices where user_id = p_user_id and device_hash = p_device_hash;
  end if;
  if p_remember and p_device_hash is not null and exists (
    select 1 from internal.email_mfa_trusted_devices d
    where d.user_id = p_user_id and d.device_hash = p_device_hash and d.expires_at > now()
  ) then
    insert into internal.email_mfa_verified_sessions(user_id, session_id)
    values (p_user_id, p_session_id) on conflict (user_id, session_id) do update set verified_at = now();
    update internal.email_mfa_trusted_devices
      set last_verified_at = now(), expires_at = now() + interval '7 days'
      where user_id = p_user_id and device_hash = p_device_hash;
    return query select true, null::uuid, false, true;
    return;
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

create or replace function public.email_mfa_get_challenge(p_user_id uuid, p_session_id uuid, p_challenge_id uuid)
returns table(email text) language sql security definer
set search_path = pg_catalog, internal
as $$
  select c.email from internal.email_mfa_challenges c
  where c.user_id = p_user_id and c.session_id = p_session_id
    and c.challenge_id = p_challenge_id and c.expires_at > now() and c.attempts < 5
    and internal.email_mfa_live_session(c.user_id, c.session_id)
$$;

create or replace function public.email_mfa_record_attempt(p_user_id uuid, p_session_id uuid, p_challenge_id uuid)
returns boolean language plpgsql security definer
set search_path = pg_catalog, internal
as $$
declare v_attempts integer; v_total integer;
begin
  update internal.email_mfa_challenges c set attempts = attempts + 1
  where c.user_id = p_user_id and c.session_id = p_session_id
    and c.challenge_id = p_challenge_id and c.expires_at > now() and c.attempts < 5
    and internal.email_mfa_live_session(c.user_id, c.session_id)
  returning attempts into v_attempts;
  if v_attempts is null or v_attempts > 5 then return false; end if;
  insert into internal.email_mfa_attempt_windows(user_id, session_id, window_started_at, attempts)
  values (p_user_id, p_session_id, now(), 1)
  on conflict (user_id, session_id) do update set
    attempts = case when internal.email_mfa_attempt_windows.window_started_at < now() - interval '15 minutes'
      then 1 else internal.email_mfa_attempt_windows.attempts + 1 end,
    window_started_at = case when internal.email_mfa_attempt_windows.window_started_at < now() - interval '15 minutes'
      then now() else internal.email_mfa_attempt_windows.window_started_at end
  returning attempts into v_total;
  return v_total <= 10;
end;
$$;

create or replace function public.email_mfa_cancel_challenge(p_user_id uuid, p_session_id uuid, p_challenge_id uuid)
returns boolean language sql security definer
set search_path = pg_catalog, internal
as $$
  with removed as (delete from internal.email_mfa_challenges c
    where c.user_id = p_user_id and c.session_id = p_session_id and c.challenge_id = p_challenge_id returning 1)
  select exists(select 1 from removed)
$$;

create or replace function public.email_mfa_finish(
  p_user_id uuid, p_session_id uuid, p_challenge_id uuid,
  p_remember boolean, p_device_hash bytea
) returns boolean language plpgsql security definer
set search_path = pg_catalog, internal
as $$
declare v_valid boolean;
begin
  select exists (select 1 from internal.email_mfa_challenges c
    where c.user_id = p_user_id and c.session_id = p_session_id
      and c.challenge_id = p_challenge_id and c.expires_at > now() and c.attempts between 1 and 5)
    and internal.email_mfa_live_session(p_user_id, p_session_id) into v_valid;
  if not v_valid then return false; end if;
  insert into internal.email_mfa_verified_sessions(user_id, session_id)
    values (p_user_id, p_session_id) on conflict (user_id, session_id)
    do update set verified_at = now(), last_activity_at = now();
  delete from internal.email_mfa_challenges where user_id = p_user_id and session_id = p_session_id;
  if p_remember and p_device_hash is not null then
    insert into internal.email_mfa_trusted_devices(user_id, device_hash, last_verified_at, expires_at)
    values (p_user_id, p_device_hash, now(), now() + interval '7 days')
    on conflict (user_id, device_hash) do update
      set last_verified_at = excluded.last_verified_at, expires_at = excluded.expires_at;
  end if;
  return true;
end;
$$;

create or replace function public.email_mfa_check_session(p_user_id uuid, p_session_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, internal
as $$
  select exists (select 1 from internal.email_mfa_verified_sessions v
    where v.user_id = p_user_id and v.session_id = p_session_id
      and v.last_activity_at > now() - interval '7 days'
      and internal.email_mfa_live_session(v.user_id, v.session_id))
$$;

create or replace function public.email_mfa_touch_session(p_user_id uuid, p_session_id uuid)
returns boolean language plpgsql security definer
set search_path = pg_catalog, internal
as $$
begin
  update internal.email_mfa_verified_sessions v set last_activity_at = now()
  where v.user_id = p_user_id and v.session_id = p_session_id
    and v.last_activity_at > now() - interval '7 days'
    and internal.email_mfa_live_session(v.user_id, v.session_id);
  return found;
end;
$$;

create or replace function public.email_mfa_touch_device(p_user_id uuid, p_device_hash bytea)
returns boolean language plpgsql security definer
set search_path = pg_catalog, internal
as $$
begin
  update internal.email_mfa_trusted_devices set last_verified_at = now(), expires_at = now() + interval '7 days'
  where user_id = p_user_id and device_hash = p_device_hash and expires_at > now();
  return found;
end;
$$;

create or replace function public.email_mfa_revoke_session(p_user_id uuid, p_session_id uuid)
returns boolean language plpgsql security definer
set search_path = pg_catalog, internal
as $$
begin
  delete from internal.email_mfa_verified_sessions where user_id = p_user_id and session_id = p_session_id;
  delete from internal.email_mfa_challenges where user_id = p_user_id and session_id = p_session_id;
  return true;
end;
$$;

revoke all on function public.email_mfa_begin(uuid,uuid,text,uuid,boolean,bytea),
  public.email_mfa_get_challenge(uuid,uuid,uuid), public.email_mfa_record_attempt(uuid,uuid,uuid),
  public.email_mfa_cancel_challenge(uuid,uuid,uuid), public.email_mfa_finish(uuid,uuid,uuid,boolean,bytea),
  public.email_mfa_check_session(uuid,uuid), public.email_mfa_touch_device(uuid,bytea),
  public.email_mfa_touch_session(uuid,uuid),
  public.email_mfa_revoke_session(uuid,uuid) from public, anon, authenticated;
grant execute on function public.email_mfa_begin(uuid,uuid,text,uuid,boolean,bytea),
  public.email_mfa_get_challenge(uuid,uuid,uuid), public.email_mfa_record_attempt(uuid,uuid,uuid),
  public.email_mfa_cancel_challenge(uuid,uuid,uuid), public.email_mfa_finish(uuid,uuid,uuid,boolean,bytea),
  public.email_mfa_check_session(uuid,uuid), public.email_mfa_touch_device(uuid,bytea),
  public.email_mfa_touch_session(uuid,uuid),
  public.email_mfa_revoke_session(uuid,uuid) to service_role;

revoke all on function internal.email_mfa_live_session(uuid,uuid), internal.has_verified_email_session() from public, anon, authenticated;
grant execute on function internal.email_mfa_live_session(uuid,uuid), internal.has_verified_email_session() to service_role, authenticated;

-- RLS independently protects private rows, and prevents an unverified staff
-- token from using the own-profile bootstrap exception to enumerate profiles.
drop policy if exists profiles_email_mfa_select on public.profiles;
create policy profiles_email_mfa_select on public.profiles as restrictive for select to authenticated
  using (id = auth.uid() or internal.has_verified_email_session());
drop policy if exists profiles_email_mfa_update on public.profiles;
create policy profiles_email_mfa_update on public.profiles as restrictive for update to authenticated
  using (internal.has_verified_email_session()) with check (internal.has_verified_email_session());

do $$
declare t text;
begin
  foreach t in array array[
    'active_session','audit_log','booking','booking_review','customer_private_details',
    'feedback','owner_activity','payment','walk_in_booking'
  ] loop
    execute format('drop policy if exists email_mfa_required on public.%I', t);
    execute format('create policy email_mfa_required on public.%I as restrictive for all to authenticated using (internal.has_verified_email_session()) with check (internal.has_verified_email_session())', t);
  end loop;
  foreach t in array array['assets','court','court_unit_inventory','court_unit_maintenance',
    'court_unit_resource_map','event','physical_court_resource','public_booking_reviews',
    'sport','testimonial','app_settings'] loop
    execute format('drop policy if exists email_mfa_required_write on public.%I', t);
    execute format('drop policy if exists email_mfa_required_insert on public.%I', t);
    execute format('drop policy if exists email_mfa_required_update on public.%I', t);
    execute format('drop policy if exists email_mfa_required_delete on public.%I', t);
    execute format('create policy email_mfa_required_insert on public.%I as restrictive for insert to authenticated with check (internal.has_verified_email_session())', t);
    execute format('create policy email_mfa_required_update on public.%I as restrictive for update to authenticated using (internal.has_verified_email_session()) with check (internal.has_verified_email_session())', t);
    execute format('create policy email_mfa_required_delete on public.%I as restrictive for delete to authenticated using (internal.has_verified_email_session())', t);
  end loop;
end $$;

-- Storage does not run db_pre_request. Preserve existing read policies while
-- requiring proof for any authenticated object creation, change, or deletion.
drop policy if exists email_mfa_required_storage_write on storage.objects;
drop policy if exists email_mfa_required_storage_insert on storage.objects;
drop policy if exists email_mfa_required_storage_update on storage.objects;
drop policy if exists email_mfa_required_storage_delete on storage.objects;
create policy email_mfa_required_storage_insert on storage.objects as restrictive
  for insert to authenticated with check (internal.has_verified_email_session());
create policy email_mfa_required_storage_update on storage.objects as restrictive
  for update to authenticated using (internal.has_verified_email_session()) with check (internal.has_verified_email_session());
create policy email_mfa_required_storage_delete on storage.objects as restrictive
  for delete to authenticated using (internal.has_verified_email_session());

-- Apply a narrow PostgREST allowlist for unauthenticated-by-email sessions.
-- Public catalog reads and own-profile bootstrap remain available; all RPCs,
-- private table/view reads, and writes require the matching session proof.
create or replace function internal.enforce_email_mfa_pre_request()
returns void language plpgsql security definer
set search_path = pg_catalog, auth, internal
as $$
declare v_role text := coalesce(auth.jwt()->>'role', ''); v_path text := coalesce(current_setting('request.path', true), '');
  v_method text := upper(coalesce(current_setting('request.method', true), 'GET'));
begin
  if v_role is distinct from 'authenticated' then return; end if;
  if internal.has_verified_email_session() then
    if v_method not in ('GET','HEAD') then
      update internal.email_mfa_verified_sessions set last_activity_at = now()
      where user_id = auth.uid() and session_id = (auth.jwt()->>'session_id')::uuid;
    end if;
    return;
  end if;
  if v_method in ('GET','HEAD') and v_path in (
    'profiles', 'app_settings', 'assets', 'court', 'court_unit_inventory',
    'court_unit_resource_map', 'event', 'physical_court_resource',
    'public_booking_reviews', 'sport', 'testimonial'
  ) then return; end if;
  if v_path = 'rpc/signup_email_availability' or v_path = 'rpc/court_occupancy'
     or v_path = 'rpc/booking_rules_for_date' then return; end if;
  raise sqlstate '42501' using message = 'Email verification required for this session.';
end;
$$;
revoke all on function internal.enforce_email_mfa_pre_request() from public, anon, authenticated;
grant execute on function internal.enforce_email_mfa_pre_request() to authenticator;
alter role authenticator set pgrst.db_pre_request = 'internal.enforce_email_mfa_pre_request';
notify pgrst, 'reload config';

comment on function internal.has_verified_email_session() is
  'True only when this JWT session_id has server-recorded email proof and remains live in auth.sessions. This is not an AAL2 claim.';
