-- Stage the service-only Edge Function gate before deploying updated function
-- versions. It defaults OFF so Auth-validated user JWTs keep current behavior
-- until the activation migration enables proof checks.
create table if not exists internal.email_mfa_enforcement (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into internal.email_mfa_enforcement(singleton, enabled)
values (true, false)
on conflict (singleton) do nothing;

-- The flag is read only through this narrow RPC. No client role can read or
-- modify the table or invoke the function; service_role is used by Edge admin.
revoke all on internal.email_mfa_enforcement from public, anon, authenticated, service_role;

create or replace function public.email_mfa_enforcement_enabled()
returns boolean language sql stable security definer
set search_path = pg_catalog, internal
as $$
  -- Preserve NULL when the singleton is missing so the Edge helper fails
  -- closed instead of interpreting broken configuration as enforcement OFF.
  select (select enabled from internal.email_mfa_enforcement where singleton)
$$;

revoke all on function public.email_mfa_enforcement_enabled() from public, anon, authenticated;
grant execute on function public.email_mfa_enforcement_enabled() to service_role;

comment on function public.email_mfa_enforcement_enabled() is
  'Service-role-only switch for the six user-JWT Edge Functions guarded by email MFA.';
