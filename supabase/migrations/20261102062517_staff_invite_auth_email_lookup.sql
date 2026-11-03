-- Server-only, owner-authorized exact Auth email lookup for staff invitations.
-- Unlike the public signup availability function, this path is not subject to
-- public signup traffic's rate limiter and returns no account identifiers.
create or replace function public.owner_auth_email_exists(
    p_owner_id uuid,
    p_email text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    normalized text := pg_catalog.lower(pg_catalog.btrim(p_email));
begin
    if p_owner_id is null then
        raise exception 'Active owner authorization required.' using errcode = '42501';
    end if;

    if normalized is null
        or pg_catalog.length(normalized) > 254
        or normalized !~ '^[^[:space:]@]+@[^[:space:]@.]+(\.[^[:space:]@.]+)+$' then
        raise exception 'A valid email address is required.' using errcode = '22023';
    end if;

    if not exists (
        select 1
        from public.profiles as owner_profile
        join auth.users as owner_auth on owner_auth.id = owner_profile.id
        where owner_profile.id = p_owner_id
          and owner_profile.role = 'admin'
          and owner_profile.status = 'active'
          and owner_auth.email_confirmed_at is not null
    ) then
        raise exception 'Active owner authorization required.' using errcode = '42501';
    end if;

    -- Match the exact-address comparison used by signup_email_availability.
    return exists (
        select 1
        from auth.users as existing_auth
        where pg_catalog.lower(existing_auth.email) = normalized
    );
end;
$$;

revoke all on function public.owner_auth_email_exists(uuid, text) from public, anon, authenticated;
grant execute on function public.owner_auth_email_exists(uuid, text) to service_role;
comment on function public.owner_auth_email_exists(uuid, text) is
    'Service-role-only exact Auth email check. Revalidates active confirmed owner and returns only a boolean.';
