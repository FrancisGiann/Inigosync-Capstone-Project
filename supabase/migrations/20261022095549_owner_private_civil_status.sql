-- Keep owner civil status separate from public.profiles, which staff and
-- other owner-facing queries can read for account operations.
create table if not exists public.owner_private_details (
  user_id uuid primary key references auth.users(id) on delete cascade,
  civil_status text,
  constraint owner_private_details_civil_status_valid
    check (civil_status is null or civil_status in
      ('Single', 'Married', 'Separated', 'Widowed', 'Prefer not to say'))
);

alter table public.owner_private_details enable row level security;
revoke all on public.owner_private_details from public, anon;
grant select, insert, update on public.owner_private_details to authenticated;

drop policy if exists owner_private_details_owner_select on public.owner_private_details;
create policy owner_private_details_owner_select on public.owner_private_details
  for select to authenticated
  using (user_id = (select auth.uid()) and internal.is_active_owner((select auth.uid())));

drop policy if exists owner_private_details_owner_insert on public.owner_private_details;
create policy owner_private_details_owner_insert on public.owner_private_details
  for insert to authenticated
  with check (user_id = (select auth.uid()) and internal.is_active_owner((select auth.uid())));

drop policy if exists owner_private_details_owner_update on public.owner_private_details;
create policy owner_private_details_owner_update on public.owner_private_details
  for update to authenticated
  using (user_id = (select auth.uid()) and internal.is_active_owner((select auth.uid())))
  with check (user_id = (select auth.uid()) and internal.is_active_owner((select auth.uid())));

comment on table public.owner_private_details is
  'Private owner-only profile details. Rows are readable and writable only by the active owner who owns them.';
