-- Defer customer profile creation and email reservation until the 6-digit
-- signup authentication code has been verified (auth.users.email_confirmed_at
-- is not null). An unverified signup must not create a public.profiles row or
-- lock the email address as taken.

create or replace function internal.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.user_role;
begin
  v_role := coalesce((new.raw_app_meta_data->>'role')::public.user_role, 'customer');

  -- Public customer signups are only created once the 6-digit email
  -- authentication code has been verified. Staff/admin accounts provisioned
  -- via service_role keep immediate profile creation.
  if v_role = 'customer' and new.email_confirmed_at is null then
    return new;
  end if;

  insert into public.profiles (id, email, full_name, contact_num, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    new.raw_user_meta_data->>'contact_num',
    v_role
  )
  on conflict (id) do update
  set
    email = excluded.email,
    full_name = case
      when excluded.full_name <> '' then excluded.full_name
      else public.profiles.full_name
    end,
    contact_num = coalesce(public.profiles.contact_num, excluded.contact_num);

  return new;
end;
$$;

revoke execute on function internal.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update of email_confirmed_at, raw_user_meta_data, email on auth.users
  for each row execute function internal.handle_new_user();

-- Remove any premature customer profile rows created for unconfirmed signups
-- that have no bookings or activity so unverified accounts do not persist.
delete from public.profiles p
where p.role = 'customer'
  and exists (
    select 1 from auth.users u
    where u.id = p.id
      and u.email_confirmed_at is null
  )
  and not exists (
    select 1 from public.booking b
    where b.customer_id = p.id
  );

-- Only confirmed accounts (or provisioned staff/admin accounts and owner
-- linked aliases) count as taken during signup email checks. Also purge stale
-- unconfirmed customer Auth rows older than 15 minutes so abandoned signups do
-- not accumulate.
create or replace function signup_private.email_availability(email_address text)
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
    normalized text := pg_catalog.lower(pg_catalog.btrim(email_address));
    current_minute timestamptz := pg_catalog.date_trunc('minute', pg_catalog.clock_timestamp());
    request_headers jsonb := coalesce(nullif(pg_catalog.current_setting('request.headers', true), ''), '{}')::jsonb;
    caller_bucket text;
    used integer;
begin
    if normalized is null or length(normalized) > 254 or normalized !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
        return 'invalid';
    end if;
    delete from signup_private.email_check_limits where minute < current_minute - interval '5 minutes';

    insert into signup_private.email_check_limits as limits (bucket, minute, hits)
    values ('global', current_minute, 1)
    on conflict (bucket, minute) do update set hits = limits.hits + 1 where limits.hits < 300
    returning hits into used;
    if used is null then return 'rate_limited'; end if;

    caller_bucket := 'ip:' || pg_catalog.md5(coalesce(nullif(request_headers->>'x-forwarded-for', ''), nullif(request_headers->>'x-real-ip', ''), 'unknown'));
    used := null;
    insert into signup_private.email_check_limits as limits (bucket, minute, hits)
    values (caller_bucket, current_minute, 1)
    on conflict (bucket, minute) do update set hits = limits.hits + 1 where limits.hits < 20
    returning hits into used;
    if used is null then return 'rate_limited'; end if;

    delete from auth.users u
    where pg_catalog.lower(u.email) = normalized
      and u.email_confirmed_at is null
      and coalesce(u.confirmation_sent_at, u.created_at) < pg_catalog.clock_timestamp() - interval '15 minutes'
      and not exists (
        select 1 from public.profiles p
        where p.id = u.id and p.role in ('staff', 'admin')
      )
      and not exists (
        select 1 from public.booking b
        where b.customer_id = u.id
      );

    if exists (
      select 1 from auth.users u
      where pg_catalog.lower(u.email) = normalized
        and (
          u.email_confirmed_at is not null
          or exists (
            select 1 from public.profiles p
            where p.id = u.id and p.role in ('staff', 'admin')
          )
        )
    ) or exists (
      select 1 from internal.owner_email_aliases a
      where pg_catalog.lower(a.email) = normalized
    ) then
        return 'taken';
    end if;
    return 'available';
end;
$$;

revoke all on function signup_private.email_availability(text) from public;
grant execute on function signup_private.email_availability(text) to anon, authenticated;

-- Allows the browser that initiated an unverified signup to immediately discard
-- the unconfirmed auth.users row if the visitor backs out or closes the verify
-- dialog before completing the 6-digit authentication code.
create or replace function public.cancel_unverified_signup(
  p_user_id uuid default null,
  p_email text default null
)
returns boolean
language plpgsql volatile security definer
set search_path = pg_catalog, auth, public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_deleted boolean := false;
begin
  if v_email = '' or length(v_email) > 254 then
    return false;
  end if;

  if p_user_id is not null then
    delete from auth.users u
    where u.id = p_user_id
      and lower(u.email) = v_email
      and u.email_confirmed_at is null
      and not exists (
        select 1 from public.profiles p
        where p.id = u.id and p.role in ('staff', 'admin')
      )
      and not exists (
        select 1 from public.booking b
        where b.customer_id = u.id
      );
    v_deleted := found;
  end if;

  return v_deleted;
end;
$$;

revoke all on function public.cancel_unverified_signup(uuid, text) from public;
grant execute on function public.cancel_unverified_signup(uuid, text) to anon, authenticated;

comment on function public.cancel_unverified_signup(uuid, text) is
  'Deletes an unconfirmed customer auth.users row matching both user ID and email when signup OTP verification is cancelled before completion.';

notify pgrst, 'reload schema';
