-- Enable RLS on profiles table
alter table public.profiles enable row level security;

-- Helper function to check if user is admin
create function public.is_admin(user_id uuid) returns boolean as $$
begin
  return exists (
    select 1 from public.profiles
    where id = user_id and role = 'admin'
  );
end;
$$ language plpgsql security definer set search_path = public;

-- Policy 1: Users can read their own profile
create policy "users_can_read_own_profile" on public.profiles
  for select using (auth.uid() = id);

-- Policy 2: Users can update their own profile (except role)
create policy "users_can_update_own_profile" on public.profiles
  for update using (auth.uid() = id)
  with check (auth.uid() = id and role = (select role from public.profiles where id = auth.uid()));

-- Policy 3: Staff can read all customer profiles (for walk-in/booking)
create policy "staff_can_read_customer_profiles" on public.profiles
  for select using (
    (select role from public.profiles where id = auth.uid()) in ('staff', 'admin')
    or auth.uid() = id
  );

-- Policy 4: Admin can read all profiles
create policy "admin_can_read_all_profiles" on public.profiles
  for select using (public.is_admin(auth.uid()));

-- Policy 5: Admin can update all profiles (including role and status)
create policy "admin_can_update_all_profiles" on public.profiles
  for update using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- Policy 6: Admin can delete profiles
create policy "admin_can_delete_profiles" on public.profiles
  for delete using (public.is_admin(auth.uid()));
