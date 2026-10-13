-- Anonymous signup may check whether a normalized PH mobile number is already
-- used. Only the three-state result leaves the database; no profile fields or
-- identifiers are exposed. Shared and per-IP minute caps bound enumeration.
create schema if not exists signup_private;
revoke all on schema signup_private from public;
grant usage on schema signup_private to anon, authenticated;

create table signup_private.phone_check_limits (
  bucket text not null,
  minute timestamptz not null,
  hits integer not null check (hits > 0),
  primary key (bucket, minute)
);
create index phone_check_limits_expiry on signup_private.phone_check_limits (minute);
alter table signup_private.phone_check_limits enable row level security;
revoke all on signup_private.phone_check_limits from public, anon, authenticated;

create function signup_private.phone_availability(phone_e164 text)
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  current_minute timestamptz := pg_catalog.date_trunc('minute', pg_catalog.clock_timestamp());
  request_headers jsonb := coalesce(nullif(pg_catalog.current_setting('request.headers', true), ''), '{}')::jsonb;
  caller_bucket text;
  used integer;
begin
  if phone_e164 is null or phone_e164 !~ '^\+639[0-9]{9}$' then
    return 'invalid';
  end if;
  delete from signup_private.phone_check_limits where minute < current_minute - interval '5 minutes';

  -- A global cap still applies if a caller forges forwarded-IP headers.
  insert into signup_private.phone_check_limits as limits (bucket, minute, hits)
  values ('global', current_minute, 1)
  on conflict (bucket, minute) do update set hits = limits.hits + 1 where limits.hits < 300
  returning hits into used;
  if used is null then return 'rate_limited'; end if;

  -- Keep raw IPs and phone numbers out of the limiter table.
  caller_bucket := 'ip:' || pg_catalog.md5(coalesce(
    nullif(request_headers->>'x-forwarded-for', ''),
    nullif(request_headers->>'x-real-ip', ''),
    'unknown'
  ));
  used := null;
  insert into signup_private.phone_check_limits as limits (bucket, minute, hits)
  values (caller_bucket, current_minute, 1)
  on conflict (bucket, minute) do update set hits = limits.hits + 1 where limits.hits < 20
  returning hits into used;
  if used is null then return 'rate_limited'; end if;

  if exists (
    select 1 from public.profiles p
    where p.contact_num is not null
      and internal.ph_mobile_to_e164(p.contact_num) = phone_e164
  ) then
    return 'in_use';
  end if;
  return 'available';
end;
$$;
revoke all on function signup_private.phone_availability(text) from public;
grant execute on function signup_private.phone_availability(text) to anon, authenticated;

create function public.signup_phone_availability(phone_e164 text)
returns text
language sql volatile security invoker
set search_path = ''
as $$ select signup_private.phone_availability(phone_e164); $$;
revoke all on function public.signup_phone_availability(text) from public;
grant execute on function public.signup_phone_availability(text) to anon, authenticated;
comment on function public.signup_phone_availability(text) is
  'Rate-limited signup phone check. Returns in_use/available/invalid/rate_limited only; exposes no profile data.';

-- Allow this narrow signup RPC through the existing email proof request gate.
-- Keep every other path and the verified-session behavior unchanged.
create or replace function internal.enforce_email_mfa_pre_request()
returns void language plpgsql security definer
set search_path = pg_catalog, auth, internal
as $$
declare v_role text := coalesce(auth.jwt()->>'role', ''); v_path text := ltrim(coalesce(current_setting('request.path', true), ''), '/');
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
  if v_path in (
    'rpc/signup_email_availability', 'rpc/signup_phone_availability',
    'rpc/court_occupancy', 'rpc/booking_rules_for_date'
  ) then return; end if;
  raise sqlstate '42501' using message = 'Email verification required for this session.';
end;
$$;
revoke all on function internal.enforce_email_mfa_pre_request() from public, anon, authenticated;
grant execute on function internal.enforce_email_mfa_pre_request()
  to anon, authenticated, service_role, authenticator;
notify pgrst, 'reload config';
