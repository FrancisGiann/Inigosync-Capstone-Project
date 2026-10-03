
-- Central profile table, 1 row per auth.users, holds the role for all 3 user types
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.user_role not null default 'customer',
  full_name text not null default '',
  email text not null unique,
  contact_num text,
  avatar_url text,
  status text not null default 'active' check (status in ('active','pending','disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is 'One row per auth.users account; role/status drive access for all 3 user types (customer/staff/admin=owner).';

alter table public.profiles enable row level security;

-- keep updated_at fresh
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

-- Block role escalation: only server-side (service_role) callers may change role,
-- never a user updating their own profile through the anon/authenticated API.
create or replace function public.prevent_role_change()
returns trigger
language plpgsql
as $$
begin
  if new.role <> old.role and auth.role() <> 'service_role' then
    raise exception 'role cannot be changed directly';
  end if;
  return new;
end;
$$;

create trigger trg_profiles_prevent_role_change
before update on public.profiles
for each row execute function public.prevent_role_change();

-- Fixes the previously-broken trigger (it referenced a public.profiles table that
-- did not exist, so every signup was failing). Role comes from raw_app_meta_data,
-- which a client can never set on itself (only settable via the service_role admin
-- API), so public self-signup can only ever produce role='customer'.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.user_role;
begin
  v_role := coalesce((new.raw_app_meta_data->>'role')::public.user_role, 'customer');
  insert into public.profiles (id, email, full_name, contact_num, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    new.raw_user_meta_data->>'contact_num',
    v_role
  );
  return new;
end;
$$;

-- Helper for RLS policies: is this uid staff or the owner?
create or replace function public.is_staff_or_admin(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = uid and role in ('staff','admin')
  );
$$;
