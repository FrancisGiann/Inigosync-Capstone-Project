
-- profiles: everyone can see their own row; staff/owner can see everyone (for dashboards)
create policy profiles_select_own on public.profiles
  for select using (id = auth.uid());

create policy profiles_select_staff_admin on public.profiles
  for select using (public.is_staff_or_admin(auth.uid()));

-- users can edit their own non-role fields (role changes blocked by trigger)
create policy profiles_update_own on public.profiles
  for update using (id = auth.uid());

create policy profiles_update_staff_admin on public.profiles
  for update using (public.is_staff_or_admin(auth.uid()));

-- no direct insert policy: rows are created only by handle_new_user() (SECURITY DEFINER)

-- booking: customers manage their own bookings; staff/owner manage all
create policy booking_select on public.booking
  for select using (customer_id = auth.uid() or public.is_staff_or_admin(auth.uid()));

create policy booking_insert on public.booking
  for insert with check (customer_id = auth.uid() or public.is_staff_or_admin(auth.uid()));

create policy booking_update on public.booking
  for update using (customer_id = auth.uid() or public.is_staff_or_admin(auth.uid()));

create policy booking_delete on public.booking
  for delete using (public.is_staff_or_admin(auth.uid()));

-- payment: customers can view payments tied to their own bookings; staff/owner manage all
create policy payment_select_own on public.payment
  for select using (
    exists (
      select 1 from public.booking b
      where b.payment_id = payment.payment_id
        and b.customer_id = auth.uid()
    )
  );

create policy payment_select_staff_admin on public.payment
  for select using (public.is_staff_or_admin(auth.uid()));

create policy payment_insert_staff_admin on public.payment
  for insert with check (public.is_staff_or_admin(auth.uid()));

create policy payment_update_staff_admin on public.payment
  for update using (public.is_staff_or_admin(auth.uid()));

create policy payment_delete_staff_admin on public.payment
  for delete using (public.is_staff_or_admin(auth.uid()));

-- walk_in_booking: staff/owner only (customers never see walk-ins)
create policy walk_in_booking_all_staff_admin on public.walk_in_booking
  for all using (public.is_staff_or_admin(auth.uid()))
  with check (public.is_staff_or_admin(auth.uid()));

-- assets: public read (landing page images/courts), writes restricted to the owner
create policy assets_select_public on public.assets
  for select using (true);

create policy assets_write_admin on public.assets
  for insert with check (public.is_admin(auth.uid()));

create policy assets_update_admin on public.assets
  for update using (public.is_admin(auth.uid()));

create policy assets_delete_admin on public.assets
  for delete using (public.is_admin(auth.uid()));
