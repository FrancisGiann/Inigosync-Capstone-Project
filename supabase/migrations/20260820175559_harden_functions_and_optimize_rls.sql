
-- Pin search_path on the trigger helper functions (mutable search_path lint)
alter function public.set_updated_at() set search_path = public;
alter function public.prevent_role_change() set search_path = public;

-- Move internal-only helpers out of the PostgREST-exposed "public" schema so they
-- can't be called directly via /rest/v1/rpc/... by anon/authenticated clients.
-- They keep working inside RLS policies and the auth trigger (Postgres binds
-- those references by function OID, not by name, so moving schema doesn't
-- break the existing trigger or policies).
create schema if not exists internal;
alter function public.handle_new_user() set schema internal;
alter function public.is_admin(uuid) set schema internal;
alter function public.is_staff_or_admin(uuid) set schema internal;

-- handle_new_user only ever needs to run as the auth.users trigger, never as a
-- directly-callable RPC.
revoke execute on function internal.handle_new_user() from public, anon, authenticated;

-- --- Re-create policies using (select auth.<fn>()) so the planner evaluates it
-- --- once per query instead of once per row, and merge the "own row" / "staff or
-- --- owner" checks into a single policy per action instead of two overlapping ones.

drop policy profiles_select_own on public.profiles;
drop policy profiles_select_staff_admin on public.profiles;
create policy profiles_select on public.profiles
  for select using (
    id = (select auth.uid()) or internal.is_staff_or_admin((select auth.uid()))
  );

drop policy profiles_update_own on public.profiles;
drop policy profiles_update_staff_admin on public.profiles;
create policy profiles_update on public.profiles
  for update using (
    id = (select auth.uid()) or internal.is_staff_or_admin((select auth.uid()))
  );

drop policy booking_select on public.booking;
create policy booking_select on public.booking
  for select using (
    customer_id = (select auth.uid()) or internal.is_staff_or_admin((select auth.uid()))
  );

drop policy booking_insert on public.booking;
create policy booking_insert on public.booking
  for insert with check (
    customer_id = (select auth.uid()) or internal.is_staff_or_admin((select auth.uid()))
  );

drop policy booking_update on public.booking;
create policy booking_update on public.booking
  for update using (
    customer_id = (select auth.uid()) or internal.is_staff_or_admin((select auth.uid()))
  );

drop policy booking_delete on public.booking;
create policy booking_delete on public.booking
  for delete using (internal.is_staff_or_admin((select auth.uid())));

drop policy payment_select_own on public.payment;
drop policy payment_select_staff_admin on public.payment;
create policy payment_select on public.payment
  for select using (
    internal.is_staff_or_admin((select auth.uid()))
    or exists (
      select 1 from public.booking b
      where b.payment_id = payment.payment_id
        and b.customer_id = (select auth.uid())
    )
  );

drop policy payment_insert_staff_admin on public.payment;
create policy payment_insert on public.payment
  for insert with check (internal.is_staff_or_admin((select auth.uid())));

drop policy payment_update_staff_admin on public.payment;
create policy payment_update on public.payment
  for update using (internal.is_staff_or_admin((select auth.uid())));

drop policy payment_delete_staff_admin on public.payment;
create policy payment_delete on public.payment
  for delete using (internal.is_staff_or_admin((select auth.uid())));

drop policy walk_in_booking_all_staff_admin on public.walk_in_booking;
create policy walk_in_booking_all_staff_admin on public.walk_in_booking
  for all using (internal.is_staff_or_admin((select auth.uid())))
  with check (internal.is_staff_or_admin((select auth.uid())));

drop policy assets_write_admin on public.assets;
create policy assets_write_admin on public.assets
  for insert with check (internal.is_admin((select auth.uid())));

drop policy assets_update_admin on public.assets;
create policy assets_update_admin on public.assets
  for update using (internal.is_admin((select auth.uid())));

drop policy assets_delete_admin on public.assets;
create policy assets_delete_admin on public.assets
  for delete using (internal.is_admin((select auth.uid())));

-- Missing covering indexes on FK columns
create index idx_booking_payment_id on public.booking(payment_id);
create index idx_walk_in_booking_payment_id on public.walk_in_booking(payment_id);
